export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  RL_START?: RateLimit;
  RL_STATUS?: RateLimit;
  APP_URL: string;
  SESSION_SECRET: string;
  OWNER_EMAILS: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  GOOGLE_AUTH_URL?: string;
  GOOGLE_TOKEN_URL?: string;
  GOOGLE_API_URL?: string;
}

export type Order = {
  id: string; order_no: string; status: string; revision_note: string; admin_note: string;
  drive_folder_id: string | null; notes_dirty: number; has_new: number; created_at: number;
  updated_at: number; last_upload_at: number | null; finished_at: number | null; trashed_at: number | null;
};

export type FileRow = {
  id: string; order_id: string; name: string; size: number; mime: string; note: string;
  fingerprint: string; state: "uploading" | "done" | "trashed"; session_uri: string | null;
  drive_file_id: string | null; created_at: number; completed_at: number | null;
};
