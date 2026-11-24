import type { Env } from "./types";

export type PublicSettings = {
  shopName: string;
  intro: string;
  maxFileMb: number;
  autoTrashDays: number;
  revisionTemplates: string[];
};
const DEFAULTS: PublicSettings = {
  shopName: "Juartah Printing", intro: "", maxFileMb: 2048, autoTrashDays: 0,
  revisionTemplates: [
    "Resolusi gambar terlalu kecil, hasil cetak akan pecah. Mohon kirim file asli yang lebih besar.",
    "Ukuran file belum sesuai ukuran cetak yang dipesan.",
    "Belum ada bleed 3 mm di setiap sisi.",
    "Teks terlalu dekat ke tepi potong. Beri jarak minimal 3 mm.",
    "Font belum di-outline. Mohon outline semua teks atau kirim PDF.",
    "File tidak bisa dibuka. Mohon kirim ulang dalam bentuk PDF.",
  ],
};

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}
export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, value).run();
}
export async function delSetting(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM settings WHERE key=?").bind(key).run();
}
export async function loadSettings(env: Env): Promise<PublicSettings> {
  const raw = await getSetting(env, "app");
  return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
}
