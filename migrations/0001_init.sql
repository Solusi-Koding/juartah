CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'baru',
  revision_note TEXT NOT NULL DEFAULT '',
  admin_note TEXT NOT NULL DEFAULT '',
  drive_folder_id TEXT,
  notes_dirty INTEGER NOT NULL DEFAULT 0,
  has_new INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_upload_at INTEGER,
  finished_at INTEGER,
  trashed_at INTEGER
);
CREATE INDEX idx_orders_status ON orders(status, updated_at);
CREATE INDEX idx_orders_updated ON orders(updated_at);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_notes_order ON notes(order_id, created_at);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'uploading',
  session_uri TEXT,
  drive_file_id TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX idx_files_order ON files(order_id, created_at);
CREATE UNIQUE INDEX idx_files_fp ON files(order_id, fingerprint) WHERE state IN ('uploading', 'done');

CREATE TABLE admins (email TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
