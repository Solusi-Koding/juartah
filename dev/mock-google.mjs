// Tiruan Google (login + Drive) untuk uji lokal. Tidak ikut di-deploy.
// FLAKY=1 membuat sebagian potongan gagal atau hanya tersimpan separuh, seperti sinyal buruk.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.MOCK_PORT) || 8799;
const BASE = `http://localhost:${PORT}`;
const FLAKY = process.env.FLAKY === "1";
const owners = (() => {
  try { return /^OWNER_EMAILS=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))[1].split(",").map((s) => s.trim()); } catch { return ["owner@example.test"]; }
})();
const files = new Map();
const sessions = new Map();
let revoked = false;
let n = 0;

const read = async (req) => { const p = []; for await (const c of req) p.push(c); return Buffer.concat(p); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const send = (res, code, body, h = {}) => {
  res.writeHead(code, { "content-type": "application/json", ...h });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

createServer(async (req, res) => {
  const u = new URL(req.url, BASE);
  const p = u.pathname;
  const body = await read(req);
  const M = req.method;

  if (p === "/__state") return send(res, 200, [...files.values()].map(({ data, ...f }) => ({ ...f, size: data?.length ?? 0, text: f.mimeType === "text/plain" ? data?.toString() : undefined })));
  if (p === "/__revoke") { revoked = u.searchParams.get("v") !== "0"; return send(res, 200, { revoked }); }
  if (p === "/__expire") { sessions.clear(); return send(res, 200, {}); }
  if (p.startsWith("/__raw/")) return send(res, 200, files.get(p.slice(7)).data, { "content-type": "application/octet-stream" });

  if (p === "/o/oauth2/v2/auth") {
    const link = (e) => `<p><a href="${u.searchParams.get("redirect_uri")}?${new URLSearchParams({ code: e, state: u.searchParams.get("state") })}">${e}</a></p>`;
    return send(res, 200, `<meta name=viewport content="width=device-width"><h1>Google tiruan</h1><p>Pilih akun:</p>${[...owners, "staf@example.test", "asing@example.test"].map(link).join("")}<form action="${u.searchParams.get("redirect_uri")}"><input type="hidden" name="state" value="${u.searchParams.get("state")}"><label>Akun lain: <input type="email" name="code" required></label> <button>Masuk</button></form>`, { "content-type": "text/html" });
  }
  if (p === "/token") {
    const f = new URLSearchParams(body.toString());
    if (f.get("grant_type") === "refresh_token") {
      return revoked ? send(res, 400, { error: "invalid_grant" }) : send(res, 200, { access_token: "at", expires_in: 3600 });
    }
    revoked = false;
    const id = `${b64({})}.${b64({ aud: f.get("client_id"), exp: Date.now() / 1000 + 600, email: f.get("code"), email_verified: true })}.x`;
    return send(res, 200, { id_token: id, access_token: "at", refresh_token: "rt", scope: "openid email https://www.googleapis.com/auth/drive.file" });
  }

  if (p.startsWith("/session/")) {
    const s = sessions.get(p.slice(9));
    if (!s) return send(res, 404, { error: "expired" });
    const partial = () => send(res, 308, "", s.data.length ? { range: `bytes=0-${s.data.length - 1}` } : {});
    const cr = req.headers["content-range"];
    if (cr.startsWith("bytes */")) return s.done ? send(res, 200, { id: s.id }) : partial();
    const [, start, , total] = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr).map(Number);
    if (start !== s.data.length) return partial();
    n++;
    if (FLAKY && n % 3 === 0) return send(res, 503, { error: "flaky" });
    let part = body;
    if (FLAKY && n % 4 === 0 && part.length > 262144) part = part.subarray(0, 262144);
    s.data = Buffer.concat([s.data, part]);
    if (s.data.length < total) return partial();
    s.done = true;
    files.set(s.id, { id: s.id, name: s.meta.name, parents: s.meta.parents, description: s.meta.description, mimeType: s.mime, data: s.data });
    return send(res, 200, { id: s.id });
  }
  if (p.startsWith("/thumb/")) {
    const f = files.get(p.slice(7).split("=")[0]);
    return f ? send(res, 200, f.data, { "content-type": f.mimeType }) : send(res, 404, {});
  }

  if (req.headers.authorization !== "Bearer at" || revoked) return send(res, 401, { error: "unauthorized" });
  if (p === "/drive/v3/about") return send(res, 200, { storageQuota: { limit: String(100 * 1024 ** 3), usage: String(37.4 * 1024 ** 3 | 0) } });
  if (p === "/upload/drive/v3/files" && M === "POST") {
    const sid = randomUUID();
    sessions.set(sid, { id: randomUUID(), meta: JSON.parse(body), mime: req.headers["x-upload-content-type"], data: Buffer.alloc(0) });
    return send(res, 200, "", { location: `${BASE}/session/${sid}` });
  }
  if (p.startsWith("/upload/drive/v3/files/") && M === "PATCH") { files.get(p.split("/").pop()).data = body; return send(res, 200, {}); }
  if (p === "/drive/v3/files" && M === "POST") {
    const f = { id: randomUUID(), ...JSON.parse(body) };
    files.set(f.id, f);
    return send(res, 200, { id: f.id });
  }
  if (p === "/drive/v3/files") {
    const [, parent, name] = /'(.+?)' in parents and name='(.+?)'/.exec(u.searchParams.get("q"));
    return send(res, 200, { files: [...files.values()].filter((f) => f.parents?.includes(parent) && f.name === name && !f.trashed).map((f) => ({ id: f.id })) });
  }
  const f = files.get(p.split("/").pop());
  if (!f) return send(res, 404, {});
  if (M === "PATCH") {
    Object.assign(f, JSON.parse(body));
    const add = u.searchParams.get("addParents");
    if (add) f.parents = [add];
    return send(res, 200, { id: f.id });
  }
  if (u.searchParams.get("alt") === "media") return send(res, 200, f.data, { "content-type": f.mimeType, "content-length": f.data.length });
  return send(res, 200, { id: f.id, trashed: !!f.trashed, thumbnailLink: f.mimeType?.startsWith("image/") ? `${BASE}/thumb/${f.id}=s220` : undefined });
}).listen(PORT, () => console.log(`Google tiruan di ${BASE}${FLAKY ? " (mode sinyal buruk)" : ""}`));
