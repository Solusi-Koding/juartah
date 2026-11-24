import { Hono } from "hono";
import type { Context } from "hono";
import { randomId, signToken, verifyToken } from "./crypto";
import * as drive from "./drive";
import { syncNotes } from "./notes";
import { loadSettings } from "./settings";
import {
  ALLOWED_EXT, CHUNK_SIZE, MAX_FILES_PER_ORDER, MAX_NOTE, cleanFileName, extOf, isAcceptableOrderNo, normalizeOrderNo, parseContentRange,
} from "../shared";
import type { Env, FileRow, Order } from "./types";

type App = { Bindings: Env };
export const pub = new Hono<App>();

const TOKEN_MS = 30 * 86400_000;
const ip = (c: Context<App>) => c.req.header("cf-connecting-ip") ?? "local";
const now = () => Date.now();
const text = (v: unknown, max = MAX_NOTE) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function limited(rl: RateLimit | undefined, key: string): Promise<boolean> {
  return rl ? !(await rl.limit({ key })).success : false;
}

pub.get("/config", async (c) => {
  const s = await loadSettings(c.env);
  return c.json({ shopName: s.shopName, intro: s.intro, maxFileMb: s.maxFileMb, turnstileKey: c.env.TURNSTILE_SITE_KEY ?? null });
});

pub.get("/status", async (c) => {
  if (await limited(c.env.RL_STATUS, ip(c))) return c.json({ error: "Terlalu sering mengecek. Coba lagi satu menit lagi." }, 429);
  const no = normalizeOrderNo(c.req.query("no") ?? "");
  if (!isAcceptableOrderNo(no)) return c.json({ error: "Nomor pesanan tidak valid." }, 400);
  const o = await c.env.DB.prepare(
    "SELECT status,revision_note,last_upload_at,(SELECT COUNT(*) FROM files f WHERE f.order_id=o.id AND f.state='done') AS n FROM orders o WHERE order_no=?",
  ).bind(no).first<{ status: string; revision_note: string; last_upload_at: number | null; n: number }>();
  if (!o || !o.last_upload_at) return c.json({ found: false });
  return c.json({ found: true, status: o.status, revisionNote: o.status === "revisi" ? o.revision_note : "", fileCount: o.n, lastUploadAt: o.last_upload_at });
});

async function turnstileOk(c: Context<App>, token: unknown): Promise<boolean> {
  if (!c.env.TURNSTILE_SECRET) return true;
  if (typeof token !== "string" || !token) return false;
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret: c.env.TURNSTILE_SECRET, response: token, remoteip: ip(c) }),
  });
  return (await res.json<{ success: boolean }>()).success;
}

pub.post("/start", async (c) => {
  if (await limited(c.env.RL_START, ip(c))) return c.json({ error: "Terlalu banyak percobaan. Tunggu satu menit, lalu kirim lagi." }, 429);
  const b = await c.req.json<{ orderNo?: string; note?: string; turnstile?: string }>().catch(() => null);
  const no = normalizeOrderNo(String(b?.orderNo ?? ""));
  if (!isAcceptableOrderNo(no)) return c.json({ error: "Nomor pesanan tidak valid." }, 400);
  if (!(await turnstileOk(c, b?.turnstile))) return c.json({ error: "Pemeriksaan keamanan gagal. Muat ulang halaman, lalu coba lagi." }, 403);

  const t = now();
  await c.env.DB.prepare("INSERT INTO orders(id,order_no,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(order_no) DO NOTHING")
    .bind(randomId(), no, t, t).run();
  const order = (await c.env.DB.prepare("SELECT * FROM orders WHERE order_no=?").bind(no).first<Order>())!;
  const settings = await loadSettings(c.env);
  await drive.ensureOrderFolder(c.env, order, settings.shopName);

  const note = text(b?.note);
  if (note) {
    const last = await c.env.DB.prepare("SELECT body FROM notes WHERE order_id=? ORDER BY created_at DESC LIMIT 1").bind(order.id).first<{ body: string }>();
    if (last?.body !== note) {
      await c.env.DB.batch([
        c.env.DB.prepare("INSERT INTO notes(id,order_id,body,created_at) VALUES(?,?,?,?)").bind(randomId(), order.id, note, t),
        c.env.DB.prepare("UPDATE orders SET notes_dirty=1 WHERE id=?").bind(order.id),
      ]);
    }
  }
  return c.json({ token: await signToken(c.env.SESSION_SECRET, "upload", { oid: order.id }, TOKEN_MS), chunkSize: CHUNK_SIZE });
});

async function orderOf(c: Context<App>): Promise<Order | null> {
  const h = c.req.header("authorization")?.replace(/^Bearer /, "");
  const t = await verifyToken<{ oid: string }>(c.env.SESSION_SECRET, "upload", h);
  return t ? c.env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(t.oid).first<Order>() : null;
}
const EXPIRED = { error: "Sesi upload sudah berakhir. Tekan kirim sekali lagi.", code: "token" };

pub.post("/files", async (c) => {
  const order = await orderOf(c);
  if (!order) return c.json(EXPIRED, 401);
  const b = await c.req.json<{ name?: string; size?: number; mime?: string; note?: string; modified?: number }>().catch(() => null);
  const name = cleanFileName(String(b?.name ?? ""));
  const size = Number(b?.size);
  const settings = await loadSettings(c.env);
  if (!Number.isSafeInteger(size) || size <= 0) return c.json({ error: "File kosong, tidak bisa dikirim." }, 400);
  if (size > settings.maxFileMb * 1048576) return c.json({ error: `Ukuran file melebihi batas ${settings.maxFileMb} MB.` }, 400);
  if (!ALLOWED_EXT.includes(extOf(name))) return c.json({ error: "Jenis file ini belum didukung. Kirim dalam bentuk ZIP." }, 400);

  const note = text(b?.note, 1000);
  const fp = `${name}|${size}|${Number(b?.modified) || 0}`;
  const existing = await c.env.DB.prepare("SELECT * FROM files WHERE order_id=? AND fingerprint=? AND state IN ('uploading','done')")
    .bind(order.id, fp).first<FileRow>();
  if (existing) {
    if (note && note !== existing.note) {
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE files SET note=? WHERE id=?").bind(note, existing.id),
        c.env.DB.prepare("UPDATE orders SET notes_dirty=1 WHERE id=?").bind(order.id),
      ]);
    }
    if (existing.state === "done") return c.json({ id: existing.id, done: true, offset: size });
    return c.json(await resume(c.env, existing, order));
  }

  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE order_id=? AND state!='trashed'").bind(order.id).first<{ n: number }>();
  if (count!.n >= MAX_FILES_PER_ORDER) return c.json({ error: "Jumlah file pesanan ini sudah maksimal. Kirim sisanya dalam bentuk ZIP." }, 400);

  // Tipe google-apps akan membuat Drive mengubah file menjadi dokumen Google, jadi ditolak.
  const given = b?.mime ?? "";
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(given) && !given.startsWith("application/vnd.google-apps") ? given : "application/octet-stream";
  const folder = await drive.ensureOrderFolder(c.env, order, settings.shopName);
  const uri = await drive.startUpload(c.env, folder, { name, mime, size, note });
  const id = randomId();
  const ins = await c.env.DB.prepare(
    "INSERT INTO files(id,order_id,name,size,mime,note,fingerprint,session_uri,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
  ).bind(id, order.id, name, size, mime, note, fp, uri, now()).run();
  if (!ins.meta.changes) return c.json({ error: "File ini sedang dikirim dari perangkat lain.", retry: true }, 409);
  return c.json({ id, done: false, offset: 0 });
});

async function complete(env: Env, f: FileRow, driveId: string) {
  const t = now();
  const upd = await env.DB.prepare("UPDATE files SET state='done',drive_file_id=?,session_uri=NULL,completed_at=? WHERE id=? AND state='uploading'")
    .bind(driveId, t, f.id).run();
  if (!upd.meta.changes) return;
  // File baru setelah revisi atau selesai harus kembali terlihat sebagai pekerjaan baru.
  await env.DB.prepare(
    `UPDATE orders SET has_new=1,last_upload_at=?,updated_at=?,notes_dirty=1,finished_at=NULL,trashed_at=NULL,
     status=CASE WHEN status IN ('revisi','selesai') THEN 'baru' ELSE status END WHERE id=?`,
  ).bind(t, t, f.order_id).run();
}

async function resume(env: Env, f: FileRow, order: Order): Promise<{ id: string; done: boolean; offset: number }> {
  const r = f.session_uri ? await drive.queryUpload(f.session_uri, f.size) : ({ expired: true } as const);
  if ("expired" in r) return restart(env, f, order);
  if (r.done) { await complete(env, f, r.id); return { id: f.id, done: true, offset: f.size }; }
  return { id: f.id, done: false, offset: r.offset };
}

async function restart(env: Env, f: FileRow, order: Order) {
  const settings = await loadSettings(env);
  const folder = await drive.ensureOrderFolder(env, order, settings.shopName);
  const uri = await drive.startUpload(env, folder, f);
  await env.DB.prepare("UPDATE files SET session_uri=? WHERE id=?").bind(uri, f.id).run();
  return { id: f.id, done: false, offset: 0 };
}

async function fileOf(c: Context<App>, order: Order) {
  return c.env.DB.prepare("SELECT * FROM files WHERE id=? AND order_id=? AND state IN ('uploading','done')").bind(c.req.param("id")!, order.id).first<FileRow>();
}

pub.get("/files/:id", async (c) => {
  const order = await orderOf(c);
  if (!order) return c.json(EXPIRED, 401);
  const f = await fileOf(c, order);
  if (!f) return c.json({ error: "File tidak ditemukan." }, 404);
  if (f.state === "done") return c.json({ id: f.id, done: true, offset: f.size });
  return c.json(await resume(c.env, f, order));
});

pub.put("/files/:id", async (c) => {
  const order = await orderOf(c);
  if (!order) return c.json(EXPIRED, 401);
  const f = await fileOf(c, order);
  if (!f) return c.json({ error: "File tidak ditemukan." }, 404);
  if (f.state === "done") return c.json({ id: f.id, done: true, offset: f.size });
  const r = parseContentRange(c.req.header("content-range"));
  const body = c.req.raw.body;
  if (!r || !body || r.total !== f.size || r.end - r.start + 1 > CHUNK_SIZE) return c.json({ error: "Potongan file tidak valid." }, 400);
  if (Number(c.req.header("content-length")) !== r.end - r.start + 1) return c.json({ error: "Potongan file tidak utuh." }, 400);
  if (!f.session_uri) return c.json(await restart(c.env, f, order));
  const res = await drive.putChunk(f.session_uri, body, r.start, r.end, r.total);
  if ("expired" in res) return c.json(await restart(c.env, f, order));
  if (res.done) { await complete(c.env, f, res.id); return c.json({ id: f.id, done: true, offset: f.size }); }
  return c.json({ id: f.id, done: false, offset: res.offset });
});

pub.post("/finish", async (c) => {
  const order = await orderOf(c);
  if (!order) return c.json(EXPIRED, 401);
  c.executionCtx.waitUntil(syncNotes(c.env, order.id).catch((e) => console.error("catatan", e)));
  const files = await c.env.DB.prepare("SELECT name,size FROM files WHERE order_id=? AND state='done'").bind(order.id).all();
  return c.json({ ok: true, fileCount: files.results.length });
});
