import { describe, expect, it } from "vitest";
import { canCrop, imageSize, inspect } from "../src/web/filecheck";

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
const be32 = (n: number) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const png = (w: number, h: number) => bytes([0x89], "PNG", [13, 10, 26, 10, 0, 0, 0, 13], "IHDR", be32(w), be32(h), new Array(20).fill(0));
// JPEG dengan segmen APP1 di depan, lalu SOF0
const jpeg = (w: number, h: number) =>
  bytes([0xff, 0xd8, 0xff, 0xe1, 0, 8], "Exif", [0, 0], [0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3], new Array(20).fill(0));

describe("imageSize", () => {
  it("membaca PNG", () => expect(imageSize(png(3000, 2000), "png")).toEqual({ w: 3000, h: 2000 }));
  it("membaca JPEG melewati EXIF", () => expect(imageSize(jpeg(4032, 3024), "jpg")).toEqual({ w: 4032, h: 3024, ch: 3 }));
  it("membaca WebP VP8X", () => {
    const b = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8X", [10, 0, 0, 0, 0, 0, 0, 0], [0x7f, 0x07, 0], [0x37, 0x04, 0], new Array(10).fill(0));
    expect(imageSize(b, "webp")).toEqual({ w: 1920, h: 1080 });
  });
});

describe("inspect", () => {
  it("gambar besar lolos tanpa peringatan", () => expect(inspect("poster.png", png(4000, 6000), new Uint8Array()).warn).toEqual([]));
  it("gambar kecil diberi perkiraan ukuran cetak", () => {
    const w = inspect("logo.jpg", jpeg(800, 600), new Uint8Array()).warn;
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("800 × 600 px");
    expect(w[0]).toContain("14 × 10 cm");
  });
  it("menandai foto WhatsApp", () => expect(inspect("IMG-20261124-WA0012.jpg", jpeg(1600, 1600), new Uint8Array()).warn[0]).toContain("WhatsApp"));
  it("isi tidak cocok dengan ekstensi", () => expect(inspect("desain.pdf", bytes("PK", [3, 4, 0, 0]), new Uint8Array()).warn[0]).toContain("tidak cocok"));
  it("file berisi nol (belum terunduh dari cloud)", () => expect(inspect("a.pdf", new Uint8Array(64), new Uint8Array()).warn[0]).toContain("kosong"));
  it("PDF berpassword", () => expect(inspect("a.pdf", bytes("%PDF-1.7\n"), bytes("trailer << /Encrypt 5 0 R >>")).warn[0]).toContain("password"));
  it("PDF biasa lolos", () => expect(inspect("a.pdf", bytes("%PDF-1.7\n"), bytes("trailer << /Root 1 0 R >>")).warn).toEqual([]));
  it("jenis tanpa tanda awal tidak diperiksa", () => expect(inspect("a.cdr", bytes("apa saja"), new Uint8Array()).warn).toEqual([]));
});

describe("canCrop", () => {
  const f = (name: string) => new File([new Uint8Array(4)], name);
  it("JPEG, PNG, WebP bisa dipotong", () => expect(["a.jpg", "b.JPEG", "c.png", "d.webp"].every((n) => canCrop(f(n)))).toBe(true));
  it("JPEG CMYK tidak dipotong agar warna tidak berubah", () => expect(canCrop(f("a.jpg"), 4)).toBe(false));
  it("PDF, TIFF, PSD tidak dipotong", () => expect(["a.pdf", "b.tif", "c.psd", "d.heic"].some((n) => canCrop(f(n)))).toBe(false));
});
