import { buildNotesText } from "../shared";
import * as drive from "./drive";
import type { Env, Order } from "./types";

export async function syncNotes(env: Env, orderId: string): Promise<void> {
  const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(orderId).first<Order>();
  if (!order?.drive_folder_id || order.trashed_at) return;
  const notes = await env.DB.prepare("SELECT body,created_at FROM notes WHERE order_id=? ORDER BY created_at").bind(orderId).all<{ body: string; created_at: number }>();
  const files = await env.DB.prepare("SELECT name,note FROM files WHERE order_id=? AND state='done' ORDER BY created_at").bind(orderId).all<{ name: string; note: string }>();
  if (notes.results.length || files.results.some((f) => f.note)) {
    await drive.writeTextFile(env, order.drive_folder_id, "CATATAN.txt", buildNotesText(order.order_no, notes.results, files.results));
  }
  await env.DB.prepare("UPDATE orders SET notes_dirty=0 WHERE id=?").bind(orderId).run();
}
