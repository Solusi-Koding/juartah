import { decrypt, encrypt } from "./crypto";
import { delSetting, getSetting, setSetting } from "./settings";
import { offsetFromRange } from "../shared";
import type { Env, Order } from "./types";

export class DriveDisconnected extends Error {}
export class DriveError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const api = (env: Env) => env.GOOGLE_API_URL ?? "https://www.googleapis.com";
const tokenUrl = (env: Env) => env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
const FOLDER = "application/vnd.google-apps.folder";

export async function saveRefreshToken(env: Env, refreshToken: string, email: string) {
  // Akun lain punya folder lain, jadi folder yang diingat tidak berlaku lagi.
  const prev = await getSetting(env, "drive_email");
  if (prev && prev !== email) await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'folder:%'").run();
  await setSetting(env, "drive_refresh", await encrypt(env.SESSION_SECRET, refreshToken));
  await setSetting(env, "drive_email", email);
  await delSetting(env, "drive_access");
  await delSetting(env, "drive_broken");
}

export async function accessToken(env: Env, force = false): Promise<string> {
  if (!force) {
    const cached = await getSetting(env, "drive_access");
    if (cached) {
      const { t, exp } = JSON.parse(cached);
      if (exp > Date.now() + 120_000) return decrypt(env.SESSION_SECRET, t);
    }
  }
  const stored = await getSetting(env, "drive_refresh");
  if (!stored) throw new DriveDisconnected("Drive belum tersambung");
  const res = await fetch(tokenUrl(env), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: await decrypt(env.SESSION_SECRET, stored),
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 && body.includes("invalid_grant")) {
      await setSetting(env, "drive_broken", "1");
      throw new DriveDisconnected("Izin Drive sudah tidak berlaku");
    }
    throw new DriveError(res.status, "Gagal memperbarui token Drive");
  }
  const data = await res.json<{ access_token: string; expires_in: number }>();
  await setSetting(env, "drive_access", JSON.stringify({
    t: await encrypt(env.SESSION_SECRET, data.access_token),
    exp: Date.now() + data.expires_in * 1000,
  }));
  return data.access_token;
}

async function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(env, attempt > 0);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    const res = await fetch(`${api(env)}${path}`, { ...init, headers });
    if (res.status === 401 && attempt === 0) continue;
    return res;
  }
}
async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new DriveError(res.status, `${what}: ${(await res.text()).slice(0, 300)}`);
  return res.json<T>();
}

async function createFolder(env: Env, name: string, parent?: string): Promise<string> {
  const res = await call(env, "/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) }),
  });
  return (await json<{ id: string }>(res, "Gagal membuat folder")).id;
}

export async function trash(env: Env, id: string): Promise<void> {
  const res = await call(env, `/drive/v3/files/${id}?fields=id`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  });
  if (res.status === 404) return;
  await json(res, "Gagal memindahkan ke Trash");
}

/** Folder yang dihapus atau masuk Trash di Drive harus dibuat ulang, bukan dipakai terus. */
async function folderUsable(env: Env, id: string): Promise<boolean> {
  const res = await call(env, `/drive/v3/files/${id}?fields=id,trashed`);
  if (res.status === 404) return false;
  return !(await json<{ trashed?: boolean }>(res, "Gagal memeriksa folder")).trashed;
}

async function sharedFolder(env: Env, key: string, name: string, parent?: string): Promise<string> {
  const k = `folder:${key}`;
  const known = await getSetting(env, k);
  if (known && (await folderUsable(env, known))) return known;
  const id = await createFolder(env, name, parent);
  if (known) {
    await env.DB.prepare("UPDATE settings SET value=? WHERE key=? AND value=?").bind(id, k, known).run();
  } else {
    await env.DB.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING").bind(k, id).run();
  }
  const winner = (await getSetting(env, k))!;
  if (winner !== id) await trash(env, id);
  return winner;
}

export async function ensureOrderFolder(env: Env, order: Order, shopName: string): Promise<string> {
  if (order.drive_folder_id && (await folderUsable(env, order.drive_folder_id))) return order.drive_folder_id;
  const root = await sharedFolder(env, "root", `${shopName} - File Pelanggan`);
  const month = new Date(order.created_at + 7 * 3600_000).toISOString().slice(0, 7);
  const parent = await sharedFolder(env, `month:${root}:${month}`, month, root);
  const id = await createFolder(env, order.order_no, parent);
  await env.DB.prepare("UPDATE orders SET drive_folder_id=? WHERE id=? AND drive_folder_id IS ?")
    .bind(id, order.id, order.drive_folder_id).run();
  const row = await env.DB.prepare("SELECT drive_folder_id AS f FROM orders WHERE id=?").bind(order.id).first<{ f: string }>();
  if (row!.f !== id) await trash(env, id);
  return row!.f;
}

export async function startUpload(env: Env, folder: string, f: { name: string; mime: string; size: number; note: string }): Promise<string> {
  const res = await call(env, "/upload/drive/v3/files?uploadType=resumable&fields=id", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": f.mime,
      "x-upload-content-length": String(f.size),
    },
    body: JSON.stringify({ name: f.name, parents: [folder], description: f.note || undefined }),
  });
  if (!res.ok) throw new DriveError(res.status, `Gagal memulai upload: ${(await res.text()).slice(0, 300)}`);
  const loc = res.headers.get("location");
  if (!loc) throw new DriveError(502, "Drive tidak memberi alamat upload");
  return loc;
}

export type ChunkResult = { done: true; id: string } | { done: false; offset: number } | { expired: true };

async function readUploadResponse(res: Response): Promise<ChunkResult> {
  if (res.status === 308) {
    await res.body?.cancel();
    return { done: false, offset: offsetFromRange(res.headers.get("range")) };
  }
  if (res.status === 200 || res.status === 201) return { done: true, id: (await res.json<{ id: string }>()).id };
  if (res.status === 404 || res.status === 410) { await res.body?.cancel(); return { expired: true }; }
  throw new DriveError(res.status, `Drive menolak potongan file: ${(await res.text()).slice(0, 300)}`);
}

export async function putChunk(uri: string, body: ReadableStream, start: number, end: number, total: number): Promise<ChunkResult> {
  const len = end - start + 1;
  const fixed = new FixedLengthStream(len);
  const pump = body.pipeTo(fixed.writable).catch(() => {});
  const res = await fetch(uri, {
    method: "PUT",
    redirect: "manual",
    headers: { "content-range": `bytes ${start}-${end}/${total}` },
    body: fixed.readable,
  });
  await pump;
  return readUploadResponse(res);
}

export async function queryUpload(uri: string, total: number): Promise<ChunkResult> {
  const res = await fetch(uri, {
    method: "PUT",
    redirect: "manual",
    headers: { "content-range": `bytes */${total}`, "content-length": "0" },
  });
  return readUploadResponse(res);
}

export async function writeTextFile(env: Env, folder: string, name: string, text: string): Promise<void> {
  const q = encodeURIComponent(`'${folder}' in parents and name='${name}' and trashed=false`);
  const found = await json<{ files: { id: string }[] }>(await call(env, `/drive/v3/files?q=${q}&fields=files(id)`), "Gagal mencari catatan");
  let id = found.files[0]?.id;
  if (!id) {
    const res = await call(env, "/drive/v3/files?fields=id", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, parents: [folder], mimeType: "text/plain" }),
    });
    id = (await json<{ id: string }>(res, "Gagal membuat catatan")).id;
  }
  const res = await call(env, `/upload/drive/v3/files/${id}?uploadType=media&fields=id`, {
    method: "PATCH",
    headers: { "content-type": "text/plain; charset=UTF-8" },
    body: text,
  });
  await json(res, "Gagal menulis catatan");
}

export const renameFile = async (env: Env, id: string, name: string) =>
  json(await call(env, `/drive/v3/files/${id}?fields=id`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
  }), "Gagal mengganti nama");

export const moveFile = async (env: Env, id: string, from: string, to: string) =>
  json(await call(env, `/drive/v3/files/${id}?addParents=${to}&removeParents=${from}&fields=id`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: "{}",
  }), "Gagal memindahkan file");

export const downloadFile = (env: Env, id: string, range?: string) =>
  call(env, `/drive/v3/files/${id}?alt=media`, range ? { headers: { range } } : {});

export async function thumbnail(env: Env, id: string, size: number): Promise<Response | null> {
  const meta = await call(env, `/drive/v3/files/${id}?fields=thumbnailLink`);
  if (!meta.ok) return null;
  const link = (await meta.json<{ thumbnailLink?: string }>()).thumbnailLink;
  if (!link) return null;
  const url = new URL(link.replace(/=s\d+$/, `=s${size}`));
  const trusted = /(^|\.)(googleusercontent|google)\.com$/.test(url.hostname) || url.origin === new URL(api(env)).origin;
  if (!trusted) return null;
  const res = await fetch(url, { headers: { authorization: `Bearer ${await accessToken(env)}` } });
  return res.ok ? res : null;
}

export async function storage(env: Env): Promise<{ limit: number | null; usage: number }> {
  const d = await json<{ storageQuota: { limit?: string; usage: string } }>(await call(env, "/drive/v3/about?fields=storageQuota"), "Gagal membaca kuota");
  return { limit: d.storageQuota.limit ? Number(d.storageQuota.limit) : null, usage: Number(d.storageQuota.usage) };
}
