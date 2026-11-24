export type Started = { token: string; chunkSize: number };
type FileState = { id: string; done: boolean; offset: number };
type Opts = { onProgress: (sent: number) => void; onWait: (waiting: boolean) => void; signal: AbortSignal };

export class UploadError extends Error {
  constructor(message: string, public code = "", public status = 0) { super(message); }
}

async function parse<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new UploadError(data.error ?? "Ada gangguan di server.", data.code, res.status);
  return data as T;
}

export const api = async <T>(path: string, init?: RequestInit) => parse<T>(await fetch(`/api${path}`, init));
export const post = <T>(path: string, body: unknown, token?: string) =>
  api<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

// XHR dipakai karena fetch tidak melaporkan progres pengiriman.
function putChunk(id: string, token: string, blob: Blob, start: number, total: number, o: Opts): Promise<FileState> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", `/api/files/${id}`);
    x.setRequestHeader("authorization", `Bearer ${token}`);
    x.setRequestHeader("content-range", `bytes ${start}-${start + blob.size - 1}/${total}`);
    x.timeout = 180_000;
    x.upload.onprogress = (e) => o.onProgress(start + Math.min(e.loaded, blob.size));
    x.onload = () => {
      let data: FileState & { error?: string; code?: string };
      try { data = JSON.parse(x.responseText); } catch { return reject(new UploadError("Jawaban server tidak terbaca.", "", 502)); }
      if (x.status >= 200 && x.status < 300) resolve(data);
      else reject(new UploadError(data.error ?? "Gagal mengirim.", data.code, x.status));
    };
    x.onerror = x.ontimeout = () => reject(new UploadError("Koneksi terputus.", "net"));
    x.onabort = () => reject(new UploadError("Dibatalkan.", "abort"));
    o.signal.addEventListener("abort", () => x.abort(), { once: true });
    x.send(blob);
  });
}

const transient = (e: unknown) =>
  !(e instanceof UploadError) || e.code === "net" || e.code === "drive_error" || (e.status >= 500 && e.code !== "full" && e.code !== "drive") || e.status === 429 || e.status === 409;

function pause(attempt: number): Promise<void> {
  if (!navigator.onLine) return new Promise((r) => window.addEventListener("online", () => r(), { once: true }));
  const ms = Math.min(20_000, 800 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
  return new Promise((r) => setTimeout(r, ms));
}

/** Kirim satu file. Setelah gangguan, posisi terakhir selalu ditanyakan ke server sebelum lanjut. */
export async function uploadFile(file: File, note: string, s: Started, o: Opts): Promise<void> {
  let state: FileState | null = null;
  let fails = 0;
  for (;;) {
    if (o.signal.aborted) throw new UploadError("Dibatalkan.", "abort");
    try {
      if (!state) {
        state = await post<FileState>("/files", { name: file.name, size: file.size, mime: file.type, note, modified: file.lastModified }, s.token);
      } else if (fails > 0) {
        state = await api<FileState>(`/files/${state.id}`, { headers: { authorization: `Bearer ${s.token}` } });
      }
      o.onWait(false);
      while (!state.done) {
        o.onProgress(state.offset);
        const blob = file.slice(state.offset, state.offset + s.chunkSize);
        const before: number = state.offset;
        state = await putChunk(state.id, s.token, blob, before, file.size, o);
        if (state.done || state.offset > before) fails = 0;
        else throw new UploadError("Belum ada kemajuan.", "net");
      }
      o.onProgress(file.size);
      return;
    } catch (e) {
      if (!transient(e) || ++fails > 9) throw e;
      o.onWait(true);
      await pause(fails);
    }
  }
}
