import * as drive from "./drive";
import { syncNotes } from "./notes";
import { loadSettings } from "./settings";
import type { Env } from "./types";

const DAY = 86400_000;

export async function hourly(env: Env): Promise<void> {
  const now = Date.now();
  // Sesi upload Drive berlaku sekitar seminggu, jadi sisa yang lebih tua tidak bisa dilanjutkan.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(now),
    env.DB.prepare("DELETE FROM files WHERE state='uploading' AND created_at<?").bind(now - 8 * DAY),
  ]);

  const dirty = await env.DB.prepare("SELECT id FROM orders WHERE notes_dirty=1 AND drive_folder_id IS NOT NULL AND updated_at<? LIMIT 5")
    .bind(now - 5 * 60_000).all<{ id: string }>();
  for (const o of dirty.results) await syncNotes(env, o.id).catch((e) => console.error("catatan", o.id, e));

  // Pesanan yang dibuka tapi tidak pernah berisi file: foldernya kosong, pindahkan ke Trash.
  const empty = await env.DB.prepare(
    "SELECT id,drive_folder_id FROM orders o WHERE last_upload_at IS NULL AND created_at<? AND NOT EXISTS(SELECT 1 FROM files f WHERE f.order_id=o.id) LIMIT 5",
  ).bind(now - 9 * DAY).all<{ id: string; drive_folder_id: string | null }>();
  for (const o of empty.results) {
    try {
      if (o.drive_folder_id) await drive.trash(env, o.drive_folder_id);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM notes WHERE order_id=?").bind(o.id),
        env.DB.prepare("DELETE FROM orders WHERE id=? AND last_upload_at IS NULL").bind(o.id),
      ]);
    } catch (e) { console.error("folder kosong", o.id, e); }
  }

  const { autoTrashDays } = await loadSettings(env);
  if (autoTrashDays > 0) {
    const old = await env.DB.prepare(
      "SELECT id,drive_folder_id FROM orders WHERE status='selesai' AND finished_at<? AND trashed_at IS NULL AND drive_folder_id IS NOT NULL LIMIT 10",
    ).bind(now - autoTrashDays * DAY).all<{ id: string; drive_folder_id: string }>();
    for (const o of old.results) {
      try {
        await drive.trash(env, o.drive_folder_id);
        await env.DB.batch([
          env.DB.prepare("UPDATE orders SET trashed_at=?,drive_folder_id=NULL WHERE id=?").bind(now, o.id),
          env.DB.prepare("UPDATE files SET state='trashed' WHERE order_id=? AND state='done'").bind(o.id),
        ]);
      } catch (e) { console.error("hapus otomatis", o.id, e); }
    }
  }
}
