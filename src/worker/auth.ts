import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomId, sha256, signToken, unb64url, verifyToken } from "./crypto";
import { saveRefreshToken } from "./drive";
import type { Env } from "./types";

export type AdminVars = { email: string; isOwner: boolean; canDelete: boolean };
type App = { Bindings: Env; Variables: AdminVars };

const SESSION_MS = 30 * 86400_000;
export const owners = (env: Env) => env.OWNER_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
export const isOwner = (env: Env, email: string) => owners(env).includes(email);

async function allowed(env: Env, email: string): Promise<boolean> {
  if (isOwner(env, email)) return true;
  return !!(await env.DB.prepare("SELECT 1 FROM admins WHERE email=?").bind(email).first());
}

const secure = (c: Context<App>) => c.env.APP_URL.startsWith("https://");

export async function currentEmail(c: Context<App>): Promise<string | null> {
  const tok = getCookie(c, "jp_session");
  if (!tok) return null;
  const row = await c.env.DB.prepare("SELECT email FROM sessions WHERE token_hash=? AND expires_at>?")
    .bind(await sha256(tok), Date.now()).first<{ email: string }>();
  // Dicek ulang tiap request supaya staf yang dikeluarkan langsung kehilangan akses.
  return row && (await allowed(c.env, row.email)) ? row.email : null;
}

/**
 * Penangkal permintaan lintas situs. Diterima bila Origin sama dengan APP_URL atau dengan alamat permintaan itu sendiri.
 * Yang kedua diperlukan karena `wrangler dev` menulis ulang alamat ke domain di `routes`.
 */
function sameOrigin(c: Context<App>): boolean {
  const o = c.req.header("origin");
  return !!o && (o === new URL(c.env.APP_URL).origin || o === new URL(c.req.url).origin);
}

export const requireAdmin: MiddlewareHandler<App> = async (c, next) => {
  if (!["GET", "HEAD"].includes(c.req.method) && !sameOrigin(c)) {
    return c.json({ error: "Permintaan ditolak." }, 403);
  }
  const email = await currentEmail(c);
  if (!email) return c.json({ error: "Silakan masuk dulu." }, 401);
  c.set("email", email);
  const owner = isOwner(c.env, email);
  c.set("isOwner", owner);
  const row = owner ? null : await c.env.DB.prepare("SELECT can_delete FROM admins WHERE email=?").bind(email).first<{ can_delete: number }>();
  c.set("canDelete", owner || row?.can_delete === 1);
  await next();
};

export const requireOwner: MiddlewareHandler<App> = async (c, next) => {
  if (!c.get("isOwner")) return c.json({ error: "Hanya pemilik yang bisa mengubah ini." }, 403);
  await next();
};

export const auth = new Hono<App>();

const redirectUri = (env: Env) => `${env.APP_URL}/auth/callback`;

async function begin(c: Context<App>, mode: "login" | "drive") {
  const nonce = randomId();
  const state = await signToken(c.env.SESSION_SECRET, "oauth", { mode, nonce }, 10 * 60_000);
  setCookie(c, "jp_oauth", nonce, { httpOnly: true, secure: secure(c), sameSite: "Lax", path: "/auth", maxAge: 600 });
  const q = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(c.env),
    response_type: "code",
    scope: mode === "drive" ? "openid email https://www.googleapis.com/auth/drive.file" : "openid email",
    state,
    prompt: mode === "drive" ? "consent select_account" : "select_account",
    ...(mode === "drive" ? { access_type: "offline" } : {}),
  });
  return c.redirect(`${c.env.GOOGLE_AUTH_URL ?? "https://accounts.google.com/o/oauth2/v2/auth"}?${q}`);
}

auth.get("/login", (c) => begin(c, "login"));
auth.get("/drive", async (c) => {
  const email = await currentEmail(c);
  if (!email || !isOwner(c.env, email)) return c.redirect("/admin/?e=owner");
  return begin(c, "drive");
});

auth.get("/callback", async (c) => {
  const st = await verifyToken<{ mode: "login" | "drive"; nonce: string }>(c.env.SESSION_SECRET, "oauth", c.req.query("state"));
  const nonce = getCookie(c, "jp_oauth");
  deleteCookie(c, "jp_oauth", { path: "/auth" });
  if (!st || !nonce || st.nonce !== nonce) return c.redirect("/admin/?e=state");
  const code = c.req.query("code");
  if (!code) return c.redirect("/admin/?e=batal");

  const res = await fetch(c.env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: c.env.GOOGLE_CLIENT_ID, client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(c.env), grant_type: "authorization_code",
    }),
  });
  if (!res.ok) return c.redirect("/admin/?e=google");
  const tok = await res.json<{ id_token: string; refresh_token?: string; scope: string }>();
  // id_token diterima langsung dari Google lewat TLS, jadi cukup periksa klaimnya.
  const claims = JSON.parse(new TextDecoder().decode(unb64url(tok.id_token.split(".")[1]))) as
    { aud: string; exp: number; email?: string; email_verified?: boolean };
  if (claims.aud !== c.env.GOOGLE_CLIENT_ID || claims.exp * 1000 < Date.now() || !claims.email || !claims.email_verified) {
    return c.redirect("/admin/?e=google");
  }
  const email = claims.email.toLowerCase();

  if (st.mode === "drive") {
    const me = await currentEmail(c);
    if (!me || !isOwner(c.env, me)) return c.redirect("/admin/?e=owner");
    if (!tok.refresh_token || !tok.scope.includes("drive.file")) return c.redirect("/admin/?e=izin#pengaturan");
    await saveRefreshToken(c.env, tok.refresh_token, email);
    return c.redirect("/admin/#pengaturan");
  }

  if (!(await allowed(c.env, email))) return c.redirect("/admin/?e=akses");
  const token = randomId(32);
  await c.env.DB.prepare("INSERT INTO sessions(token_hash,email,expires_at) VALUES(?,?,?)")
    .bind(await sha256(token), email, Date.now() + SESSION_MS).run();
  setCookie(c, "jp_session", token, { httpOnly: true, secure: secure(c), sameSite: "Lax", path: "/", maxAge: SESSION_MS / 1000 });
  return c.redirect("/admin/");
});

auth.post("/logout", async (c) => {
  if (!sameOrigin(c)) return c.json({ error: "Permintaan ditolak." }, 403);
  const tok = getCookie(c, "jp_session");
  if (tok) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(tok)).run();
  deleteCookie(c, "jp_session", { path: "/" });
  return c.json({ ok: true });
});
