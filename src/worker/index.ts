import { Hono } from "hono";
import { admin } from "./admin";
import { auth } from "./auth";
import { hourly } from "./cron";
import { DriveDisconnected, DriveError } from "./drive";
import { pub } from "./public";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "same-origin");
  c.header("x-frame-options", "DENY");
  if (!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
});

app.route("/api/admin", admin);
app.route("/api", pub);
app.route("/auth", auth);
app.notFound((c) => c.json({ error: "Tidak ditemukan." }, 404));

app.onError((e, c) => {
  console.error(c.req.method, new URL(c.req.url).pathname, e.message);
  if (e instanceof DriveDisconnected) {
    return c.json({ error: "Penyimpanan toko sedang tidak tersambung. Beri tahu toko lewat chat, lalu coba lagi nanti.", code: "drive" }, 503);
  }
  if (e instanceof DriveError) {
    if (e.status === 403 && /storageQuotaExceeded/.test(e.message)) return c.json({ error: "Penyimpanan toko sedang penuh. Beri tahu toko lewat chat.", code: "full" }, 507);
    return c.json({ error: "Google Drive sedang bermasalah. Coba lagi sebentar.", code: "drive_error", retry: true }, 502);
  }
  return c.json({ error: "Ada gangguan di server. Coba lagi sebentar.", retry: true }, 500);
});

/**
 * Akun Cloudflare gratis dibatasi 5 cron per akun. Sebagai gantinya, perawatan berkala
 * menumpang permintaan yang masuk: paling sering sekali per jam, diklaim lewat D1 agar tidak dobel.
 */
let nextCheck = 0;
async function maybeHourly(env: Env): Promise<void> {
  const now = Date.now();
  if (now < nextCheck) return;
  nextCheck = now + 5 * 60_000;
  const r = await env.DB.prepare(
    "INSERT INTO settings(key,value) VALUES('maint_at',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(settings.value AS INTEGER) < ?2",
  ).bind(String(now), now - 3600_000).run();
  if (r.meta.changes) await hourly(env);
}

export default {
  fetch(req, env, ctx) {
    ctx.waitUntil(maybeHourly(env).catch((e) => console.error("perawatan", e)));
    return app.fetch(req, env, ctx);
  },
  scheduled: (_e, env, ctx) => ctx.waitUntil(hourly(env)),
} satisfies ExportedHandler<Env>;
