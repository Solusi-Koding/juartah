import { Hono } from "hono";
import { isOwner, owners, requireAdmin, requireOwner, type AdminVars } from "./auth";
import * as drive from "./drive";
import { syncNotes } from "./notes";
import { getSetting, loadSettings, setSetting } from "./settings";
import { STATUSES, isAcceptableOrderNo, normalizeOrderNo } from "../shared";
import type { Env, FileRow, Order } from "./types";

type App = { Bindings: Env; Variables: AdminVars };
export const admin = new Hono<App>();
admin.use("*", requireAdmin);

const PAGE = 40;

admin.get("/me", async (c) => {
  const s = await loadSettings(c.env);
  const connected = !!(await getSetting(c.env, "drive_refresh"));
  return c.json({
    email: c.get("email"), isOwner: c.get("isOwner"), canDelete: c.get("canDelete"), appUrl: c.env.APP_URL, settings: s,
    drive: { connected, broken: !!(await getSetting(c.env, "drive_broken")), email: c.get("isOwner") ? await getSetting(c.env, "drive_email") : null },
    turnstile: !!c.env.TURNSTILE_SECRET,
  });
});

admin.get("/storage", async (c) => c.json(await drive.storage(c.env)));

admin.get("/orders", async (c) => {
  const status = c.req.query("status") ?? "";
  const q = normalizeOrderNo(c.req.query("q") ?? "");
  const before = Number(c.req.query("before")) || Number.MAX_SAFE_INTEGER;
  const where = ["o.last_upload_at IS NOT NULL", "o.updated_at<?"];
  const args: unknown[] = [before];
  if ((STATUSES as readonly string[]).includes(status)) { where.push("o.status=?"); args.push(status); }
  if (q) { where.push("instr(o.order_no, ?)>0"); args.push(q); }
  const rows = await c.env.DB.prepare(
    `SELECT o.id,o.order_no,o.status,o.has_new,o.updated_at,o.last_upload_at,o.trashed_at,
      (SELECT COUNT(*) FROM files f WHERE f.order_id=o.id AND f.state='done') AS file_count,
      (SELECT COALESCE(SUM(size),0) FROM files f WHERE f.order_id=o.id AND f.state='done') AS bytes,
      (SELECT COUNT(*) FROM files f WHERE f.order_id=o.id AND f.state='done' AND f.note!='') AS file_notes,
      (SELECT COUNT(*) FROM notes n WHERE n.order_id=o.id) AS note_count
     FROM orders o WHERE ${where.join(" AND ")} ORDER BY o.updated_at DESC LIMIT ${PAGE + 1}`,
  ).bind(...args).all<{ updated_at: number }>();
  const counts = await c.env.DB.prepare("SELECT status,COUNT(*) AS n FROM orders WHERE last_upload_at IS NOT NULL GROUP BY status").all<{ status: string; n: number }>();
  const list = rows.results.slice(0, PAGE);
  return c.json({
    orders: list,
    next: rows.results.length > PAGE ? list[list.length - 1].updated_at : null,
    counts: Object.fromEntries(counts.results.map((r) => [r.status, r.n])),
  });
});

const getOrder = (env: Env, id: string) => env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(id).first<Order>();

admin.get("/orders/:id", async (c) => {
  const o = await getOrder(c.env, c.req.param("id"));
  if (!o) return c.json({ error: "Pesanan tidak ditemukan." }, 404);
  const files = await c.env.DB.prepare(
    "SELECT id,name,size,mime,note,state,drive_file_id,created_at,completed_at FROM files WHERE order_id=? AND state!='trashed' ORDER BY created_at",
  ).bind(o.id).all();
  const notes = await c.env.DB.prepare("SELECT id,body,created_at FROM notes WHERE order_id=? ORDER BY created_at").bind(o.id).all();
  return c.json({ order: o, files: files.results, notes: notes.results });
});

admin.post("/orders/:id/seen", async (c) => {
  await c.env.DB.prepare("UPDATE orders SET has_new=0 WHERE id=?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

admin.patch("/orders/:id", async (c) => {
  const o = await getOrder(c.env, c.req.param("id"));
  if (!o) return c.json({ error: "Pesanan tidak ditemukan." }, 404);
  const b = await c.req.json<{ status?: string; revisionNote?: string; adminNote?: string; orderNo?: string }>();
  const t = Date.now();

  if (b.orderNo !== undefined) {
    const no = normalizeOrderNo(b.orderNo);
    if (!isAcceptableOrderNo(no)) return c.json({ error: "Nomor pesanan harus 8 sampai 24 huruf atau angka." }, 400);
    if (no !== o.order_no) {
      const other = await c.env.DB.prepare("SELECT id FROM orders WHERE order_no=?").bind(no).first<{ id: string }>();
      if (other) return c.json({ error: "Nomor itu sudah dipakai pesanan lain.", code: "exists", otherId: other.id }, 409);
      if (o.drive_folder_id) await drive.renameFile(c.env, o.drive_folder_id, no);
      await c.env.DB.prepare("UPDATE orders SET order_no=?,notes_dirty=1,updated_at=? WHERE id=?").bind(no, t, o.id).run();
    }
  }
  if (b.status !== undefined) {
    if (!(STATUSES as readonly string[]).includes(b.status)) return c.json({ error: "Status tidak dikenal." }, 400);
    const rev = b.status === "revisi" ? (b.revisionNote ?? "").trim().slice(0, 2000) : "";
    if (b.status === "revisi" && !rev) return c.json({ error: "Tulis apa yang perlu direvisi agar pelanggan tahu." }, 400);
    await c.env.DB.prepare("UPDATE orders SET status=?,revision_note=?,has_new=0,updated_at=?,finished_at=? WHERE id=?")
      .bind(b.status, rev, t, b.status === "selesai" ? t : null, o.id).run();
  }
  if (b.adminNote !== undefined) {
    await c.env.DB.prepare("UPDATE orders SET admin_note=? WHERE id=?").bind(b.adminNote.trim().slice(0, 2000), o.id).run();
  }
  return c.json({ ok: true });
});

/** Ubah status banyak pesanan sekaligus. Revisi tidak bisa massal karena tiap pesanan butuh pesan sendiri. */
admin.post("/orders/bulk", async (c) => {
  const b = await c.req.json<{ ids?: unknown; status?: string }>();
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.filter((x): x is string => typeof x === "string"))] : [];
  if (!ids.length || ids.length > 500) return c.json({ error: "Pilih 1 sampai 500 pesanan." }, 400);
  if (b.status === "revisi") return c.json({ error: "Revisi diisi satu per satu, karena tiap pesanan butuh pesan sendiri." }, 400);
  if (!(STATUSES as readonly string[]).includes(b.status ?? "")) return c.json({ error: "Status tidak dikenal." }, 400);
  const t = Date.now();
  const r = await c.env.DB.prepare(
    "UPDATE orders SET status=?,revision_note='',has_new=0,updated_at=?,finished_at=? WHERE id IN (SELECT value FROM json_each(?)) AND status!=?",
  ).bind(b.status, t, b.status === "selesai" ? t : null, JSON.stringify(ids), b.status).run();
  return c.json({ changed: r.meta.changes });
});

/** Gabungkan pesanan salah ketik ke pesanan yang benar. Semua file dipindah, tidak ada yang dihapus. */
admin.post("/orders/:id/merge", async (c) => {
  const from = await getOrder(c.env, c.req.param("id"));
  const { intoId } = await c.req.json<{ intoId: string }>();
  const into = await getOrder(c.env, intoId);
  if (!from || !into || from.id === into.id) return c.json({ error: "Pesanan tujuan tidak valid." }, 400);
  const busy = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE order_id=? AND state='uploading' AND created_at>?")
    .bind(from.id, Date.now() - 3600_000).first<{ n: number }>();
  if (busy!.n) return c.json({ error: "Masih ada file yang sedang dikirim. Coba lagi nanti." }, 409);
  const settings = await loadSettings(c.env);
  const target = await drive.ensureOrderFolder(c.env, into, settings.shopName);
  const files = await c.env.DB.prepare("SELECT * FROM files WHERE order_id=? AND state='done'").bind(from.id).all<FileRow>();
  for (const f of files.results) {
    if (f.drive_file_id && from.drive_folder_id) await drive.moveFile(c.env, f.drive_file_id, from.drive_folder_id, target);
    await c.env.DB.prepare("UPDATE files SET order_id=?,fingerprint=fingerprint||'|'||id WHERE id=?").bind(into.id, f.id).run();
  }
  const t = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE notes SET order_id=? WHERE order_id=?").bind(into.id, from.id),
    c.env.DB.prepare("DELETE FROM files WHERE order_id=?").bind(from.id),
    c.env.DB.prepare("DELETE FROM orders WHERE id=?").bind(from.id),
    c.env.DB.prepare("UPDATE orders SET has_new=1,notes_dirty=1,updated_at=?,last_upload_at=COALESCE(last_upload_at,?) WHERE id=?").bind(t, t, into.id),
  ]);
  if (from.drive_folder_id) await drive.trash(c.env, from.drive_folder_id);
  c.executionCtx.waitUntil(syncNotes(c.env, into.id).catch((e) => console.error("catatan", e)));
  return c.json({ ok: true });
});

const doneFile = (env: Env, id: string) => env.DB.prepare("SELECT * FROM files WHERE id=? AND state='done'").bind(id).first<FileRow>();

admin.get("/files/:id/download", async (c) => {
  const f = await doneFile(c.env, c.req.param("id"));
  if (!f?.drive_file_id) return c.json({ error: "File tidak ditemukan." }, 404);
  const res = await drive.downloadFile(c.env, f.drive_file_id, c.req.header("range"));
  if (!res.ok) return c.json({ error: "File tidak bisa diambil dari Drive." }, res.status === 404 ? 404 : 502);
  const h = new Headers();
  for (const k of ["content-length", "content-range", "accept-ranges"]) { const v = res.headers.get(k); if (v) h.set(k, v); }
  // Selalu diunduh, tidak pernah dirender: isi file berasal dari pelanggan.
  h.set("content-type", "application/octet-stream");
  h.set("x-content-type-options", "nosniff");
  h.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(f.name).replace(/['()*]/g, (x) => "%" + x.charCodeAt(0).toString(16).toUpperCase())}`);
  h.set("cache-control", "private, no-store");
  return new Response(res.body, { status: res.status, headers: h });
});

admin.get("/files/:id/thumb", async (c) => {
  const f = await doneFile(c.env, c.req.param("id"));
  if (!f?.drive_file_id) return c.body(null, 404);
  const res = await drive.thumbnail(c.env, f.drive_file_id, c.req.query("besar") ? 1600 : 240);
  const type = res?.headers.get("content-type") ?? "";
  if (!res || !/^image\/(png|jpeg|webp|gif)$/.test(type)) return c.body(null, 404);
  return new Response(res.body, { headers: { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "private, max-age=3600" } });
});

admin.delete("/files/:id", async (c) => {
  if (!c.get("canDelete")) return c.json({ error: "Anda belum diberi izin menghapus file. Minta admin utama." }, 403);
  const f = await doneFile(c.env, c.req.param("id"));
  if (!f?.drive_file_id) return c.json({ error: "File tidak ditemukan." }, 404);
  await drive.trash(c.env, f.drive_file_id);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE files SET state='trashed' WHERE id=?").bind(f.id),
    c.env.DB.prepare("UPDATE orders SET notes_dirty=1 WHERE id=?").bind(f.order_id),
  ]);
  return c.json({ ok: true });
});

admin.put("/settings", requireOwner, async (c) => {
  const b = await c.req.json<{ shopName?: string; intro?: string; maxFileMb?: number; autoTrashDays?: number; revisionTemplates?: unknown }>();
  const cur = await loadSettings(c.env);
  const next = {
    shopName: (b.shopName ?? cur.shopName).trim().slice(0, 60) || cur.shopName,
    intro: (b.intro ?? cur.intro).trim().slice(0, 400),
    maxFileMb: Math.min(10240, Math.max(1, Math.round(Number(b.maxFileMb ?? cur.maxFileMb)) || cur.maxFileMb)),
    autoTrashDays: Math.min(3650, Math.max(0, Math.round(Number(b.autoTrashDays ?? cur.autoTrashDays)) || 0)),
    revisionTemplates: Array.isArray(b.revisionTemplates)
      ? [...new Set(b.revisionTemplates.map((t) => String(t).trim().slice(0, 200)).filter(Boolean))].slice(0, 15)
      : cur.revisionTemplates,
  };
  await setSetting(c.env, "app", JSON.stringify(next));
  return c.json(next);
});

admin.get("/admins", requireOwner, async (c) =>
  c.json({
    owners: owners(c.env),
    staff: (await c.env.DB.prepare("SELECT email,created_at,can_delete FROM admins ORDER BY email").all()).results,
  }));
admin.post("/admins", requireOwner, async (c) => {
  const email = String((await c.req.json<{ email: string }>()).email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: "Alamat email tidak valid." }, 400);
  if (isOwner(c.env, email)) return c.json({ error: "Email itu sudah menjadi pemilik." }, 409);
  await c.env.DB.prepare("INSERT INTO admins(email,created_at) VALUES(?,?) ON CONFLICT DO NOTHING").bind(email, Date.now()).run();
  return c.json({ ok: true });
});
admin.patch("/admins/:email", requireOwner, async (c) => {
  const { canDelete } = await c.req.json<{ canDelete: boolean }>();
  if (typeof canDelete !== "boolean") return c.json({ error: "Pilihan izin tidak valid." }, 400);
  const r = await c.env.DB.prepare("UPDATE admins SET can_delete=? WHERE email=?")
    .bind(canDelete ? 1 : 0, decodeURIComponent(c.req.param("email")).toLowerCase()).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "Staf tidak ditemukan." }, 404);
});
admin.delete("/admins/:email", requireOwner, async (c) => {
  const email = decodeURIComponent(c.req.param("email")).toLowerCase();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM admins WHERE email=?").bind(email),
    c.env.DB.prepare("DELETE FROM sessions WHERE email=?").bind(email),
  ]);
  return c.json({ ok: true });
});
