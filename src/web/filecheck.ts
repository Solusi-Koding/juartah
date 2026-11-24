import { extOf } from "../shared";

/** ch: jumlah kanal warna JPEG, 4 berarti CMYK. */
export type Dims = { w: number; h: number; ch?: number };
export type Check = { warn: string[]; dims: Dims | null };

const HEAD = 512 * 1024; // cukup untuk melewati EXIF besar sebelum ukuran JPEG
const TAIL = 64 * 1024;
const SMALL_SIDE = 1200; // di bawah ini gambar hanya tajam untuk cetakan kecil
const GOOD_DPI = 150;

/** Jenis gambar yang bisa dipotong dan disimpan ulang di browser, beserta tipe hasilnya. */
export const CROP_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
export const canCrop = (f: File, ch?: number) => extOf(f.name) in CROP_TYPES && ch !== 4;

const ascii = (b: Uint8Array, at: number, s: string) => [...s].every((ch, i) => b[at + i] === ch.charCodeAt(0));
const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const le24 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

function findAscii(b: Uint8Array, s: string, limit = b.length): boolean {
  const end = Math.min(limit, b.length) - s.length;
  for (let i = b.indexOf(s.charCodeAt(0)); i !== -1 && i <= end; i = b.indexOf(s.charCodeAt(0), i + 1)) if (ascii(b, i, s)) return true;
  return false;
}

/** Tanda awal file per jenis. Jenis yang tidak ada di sini tidak diperiksa. */
const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  pdf: (b) => findAscii(b, "%PDF", 1024),
  ai: (b) => findAscii(b, "%PDF", 1024) || ascii(b, 0, "%!PS"),
  eps: (b) => ascii(b, 0, "%!PS") || (b[0] === 0xc5 && b[1] === 0xd0 && b[2] === 0xd3 && b[3] === 0xc6),
  png: (b) => b[0] === 0x89 && ascii(b, 1, "PNG"),
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8,
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8,
  gif: (b) => ascii(b, 0, "GIF8"),
  webp: (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP"),
  bmp: (b) => ascii(b, 0, "BM"),
  tif: (b) => ascii(b, 0, "II*\0") || ascii(b, 0, "MM\0*"),
  tiff: (b) => ascii(b, 0, "II*\0") || ascii(b, 0, "MM\0*"),
  psd: (b) => ascii(b, 0, "8BPS"),
  zip: (b) => ascii(b, 0, "PK"),
  docx: (b) => ascii(b, 0, "PK"),
  xlsx: (b) => ascii(b, 0, "PK"),
  pptx: (b) => ascii(b, 0, "PK"),
  rar: (b) => ascii(b, 0, "Rar!"),
  "7z": (b) => b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf,
};

export function imageSize(b: Uint8Array, ext: string): Dims | null {
  if (b.length < 32) return null;
  if (ext === "png" && ascii(b, 12, "IHDR")) return { w: be32(b, 16), h: be32(b, 20) };
  if (ext === "gif") return { w: le16(b, 6), h: le16(b, 8) };
  if (ext === "bmp") return { w: Math.abs(new DataView(b.buffer, b.byteOffset).getInt32(18, true)), h: Math.abs(new DataView(b.buffer, b.byteOffset).getInt32(22, true)) };
  if (ext === "webp") {
    if (ascii(b, 12, "VP8 ")) return { w: le16(b, 26) & 0x3fff, h: le16(b, 28) & 0x3fff };
    if (ascii(b, 12, "VP8L")) return { w: 1 + (((b[22] & 0x3f) << 8) | b[21]), h: 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
    if (ascii(b, 12, "VP8X")) return { w: 1 + le24(b, 24), h: 1 + le24(b, 27) };
    return null;
  }
  if (ext === "jpg" || ext === "jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: be16(b, i + 7), h: be16(b, i + 5), ch: b[i + 9] };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      i += 2 + be16(b, i + 2);
    }
  }
  return null;
}

const cm = (px: number) => Math.max(1, Math.round((px / GOOD_DPI) * 2.54));

/** Pemeriksaan tanpa jaringan dari potongan awal dan akhir file. Hasilnya peringatan, bukan larangan. */
export function inspect(name: string, head: Uint8Array, tail: Uint8Array): Check {
  const ext = extOf(name);
  const warn: string[] = [];
  if (head.length >= 4 && head.every((x) => x === 0)) {
    warn.push("Isi file kosong. Kalau file ada di Google Drive atau iCloud, unduh dulu ke HP, lalu pilih lagi.");
    return { warn, dims: null };
  }
  const magic = MAGIC[ext];
  if (magic && head.length >= 4 && !magic(head)) {
    warn.push(`Isi file tidak cocok dengan jenisnya (.${ext}). Mungkin file rusak atau namanya diganti. Coba buka dulu di HP Anda.`);
    return { warn, dims: null };
  }
  const dims = imageSize(head, ext);
  if (dims && dims.w > 0 && dims.h > 0 && Math.min(dims.w, dims.h) < SMALL_SIDE) {
    warn.push(`Gambar ini kecil (${dims.w} × ${dims.h} px), hanya tajam kalau dicetak sampai sekitar ${cm(dims.w)} × ${cm(dims.h)} cm. Untuk ukuran lebih besar, kirim file aslinya.`);
  }
  if (/^IMG-\d{8}-WA\d+|^WhatsApp (Image|Video)/i.test(name)) {
    warn.push("File dari WhatsApp biasanya sudah diperkecil. Kalau ada, kirim file aslinya.");
  }
  if (ext === "pdf" && (findAscii(tail, "/Encrypt") || findAscii(head, "/Encrypt"))) {
    warn.push("PDF ini dikunci password. Kirim versi tanpa password supaya bisa dicetak.");
  }
  return { warn, dims };
}

export async function checkFile(f: File): Promise<Check> {
  try {
    const head = new Uint8Array(await f.slice(0, HEAD).arrayBuffer());
    const tail = f.size > HEAD ? new Uint8Array(await f.slice(Math.max(HEAD, f.size - TAIL)).arrayBuffer()) : new Uint8Array();
    return inspect(f.name, head, tail);
  } catch {
    return { warn: ["File tidak bisa dibaca. Kalau file ada di Google Drive atau iCloud, unduh dulu ke HP, lalu pilih lagi."], dims: null };
  }
}
