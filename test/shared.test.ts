import { describe, expect, it } from "vitest";
import { buildNotesText, cleanFileName, extOf, formatBytes, isAcceptableOrderNo, looksLikeShopee, normalizeOrderNo, offsetFromRange, parseContentRange } from "../src/shared";
import { decrypt, encrypt, signToken, verifyToken } from "../src/worker/crypto";

describe("nomor pesanan", () => {
  it("menerima tulisan yang bervariasi", () => expect(normalizeOrderNo(" #241124-abc1 23xy ")).toBe("241124ABC123XY"));
  it("menolak terlalu pendek atau panjang", () => {
    expect(isAcceptableOrderNo("ABC")).toBe(false);
    expect(isAcceptableOrderNo("A".repeat(25))).toBe(false);
  });
  it("mengenali pola Shopee", () => {
    expect(looksLikeShopee("241124ABC123XY")).toBe(true);
    expect(looksLikeShopee("241324ABC123XY")).toBe(false);
    expect(looksLikeShopee("241124ABC123X")).toBe(false);
  });
});
describe("potongan file", () => {
  it("membaca Content-Range", () => {
    expect(parseContentRange("bytes 0-9/10")).toEqual({ start: 0, end: 9, total: 10 });
    expect(parseContentRange("bytes 0-10/10")).toBeNull();
    expect(parseContentRange("bytes */10")).toBeNull();
  });
  it("menghitung posisi lanjut", () => {
    expect(offsetFromRange("bytes=0-262143")).toBe(262144);
    expect(offsetFromRange(null)).toBe(0);
  });
});
describe("nama file", () => {
  it("membuang garis miring dan karakter kontrol", () => expect(cleanFileName("../a\\b\n.pdf")).toBe(".._a_b_.pdf"));
  it("membaca ekstensi", () => { expect(extOf("A.PDF")).toBe("pdf"); expect(extOf(".pdf")).toBe(""); expect(extOf("x")).toBe(""); });
  it("format ukuran", () => expect(formatBytes(1536)).toBe("1,5 KB"));
});
it("CATATAN.txt memuat dua jenis catatan", () => {
  const t = buildNotesText("X", [{ body: "umum", created_at: 0 }], [{ name: "a.pdf", note: "2 lembar" }, { name: "b.pdf", note: "" }]);
  expect(t).toContain("umum"); expect(t).toContain("a.pdf:"); expect(t).not.toContain("b.pdf");
});
describe("token", () => {
  it("tidak bisa dipakai lintas tujuan, diubah, atau setelah kedaluwarsa", async () => {
    const t = await signToken("s", "upload", { oid: "1" }, 1000);
    expect(await verifyToken("s", "upload", t)).toMatchObject({ oid: "1" });
    expect(await verifyToken("s", "oauth", t)).toBeNull();
    expect(await verifyToken("lain", "upload", t)).toBeNull();
    expect(await verifyToken("s", "upload", "x" + t)).toBeNull();
    expect(await verifyToken("s", "upload", await signToken("s", "upload", {}, -1))).toBeNull();
  });
  it("enkripsi bolak-balik", async () => expect(await decrypt("s", await encrypt("s", "rahasia"))).toBe("rahasia"));
});
