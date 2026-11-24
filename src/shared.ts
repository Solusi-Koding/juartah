export const STATUSES = ["baru", "dicek", "revisi", "cetak", "selesai"] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<Status, string> = {
  baru: "Baru",
  dicek: "Dicek",
  revisi: "Perlu revisi",
  cetak: "Cetak",
  selesai: "Selesai",
};

export const CHUNK_SIZE = 4 * 1024 * 1024;
export const MAX_FILES_PER_ORDER = 200;
export const MAX_NOTE = 2000;

export const ALLOWED_EXT = [
  "pdf", "ai", "eps", "psd", "cdr", "svg", "indd", "afdesign", "afphoto", "xcf",
  "png", "jpg", "jpeg", "tif", "tiff", "webp", "heic", "heif", "bmp", "gif",
  "zip", "rar", "7z", "doc", "docx", "xls", "xlsx", "csv", "ppt", "pptx", "txt", "ttf", "otf",
];

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function normalizeOrderNo(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Batas keras: di luar ini ditolak. */
export function isAcceptableOrderNo(no: string): boolean {
  return /^[A-Z0-9]{8,24}$/.test(no);
}

/** Pola lazim Shopee: tanggal YYMMDD lalu 8 huruf/angka. Di luar ini pelanggan diminta memastikan. */
export function looksLikeShopee(no: string): boolean {
  const m = /^\d{2}(\d{2})(\d{2})[A-Z0-9]{8}$/.exec(no);
  if (!m) return false;
  const month = Number(m[1]);
  const day = Number(m[2]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString("id-ID", { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

export function cleanFileName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim();
  return cleaned.length > 180 ? cleaned.slice(0, 140) + "~" + cleaned.slice(-39) : cleaned || "file";
}

export type ChunkRange = { start: number; end: number; total: number };
export function parseContentRange(h: string | undefined | null): ChunkRange | null {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(h ?? "");
  if (!m) return null;
  const r = { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
  return r.start <= r.end && r.end < r.total ? r : null;
}

/** Header Range dari Drive "bytes=0-N" berarti N+1 byte sudah tersimpan. Tanpa header: belum ada. */
export function offsetFromRange(h: string | null): number {
  const m = /^bytes=0-(\d+)$/.exec(h ?? "");
  return m ? Number(m[1]) + 1 : 0;
}

/** Catatan untuk CATATAN.txt di folder Drive. */
export function buildNotesText(
  orderNo: string,
  notes: { body: string; created_at: number }[],
  files: { name: string; note: string }[],
): string {
  const fmt = (t: number) =>
    new Date(t).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" });
  const lines = [`PESANAN ${orderNo}`, ""];
  lines.push("CATATAN UMUM");
  if (notes.length === 0) lines.push("(tidak ada)");
  for (const n of notes) lines.push(`[${fmt(n.created_at)} WIB]`, n.body, "");
  lines.push("", "CATATAN PER FILE");
  const withNote = files.filter((f) => f.note);
  if (withNote.length === 0) lines.push("(tidak ada)");
  for (const f of withNote) lines.push(`${f.name}:`, `  ${f.note.replace(/\n/g, "\n  ")}`, "");
  return lines.join("\r\n") + "\r\n";
}
