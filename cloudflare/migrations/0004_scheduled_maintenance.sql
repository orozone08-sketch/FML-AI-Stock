PRAGMA foreign_keys = ON;

CREATE TABLE maintenance_cursors (
 job_name TEXT PRIMARY KEY,
 phase TEXT NOT NULL,
 cursor_company_id INTEGER NOT NULL DEFAULT 0,
 cursor_stock_book_id INTEGER NOT NULL DEFAULT 0,
 cursor_item_id INTEGER NOT NULL DEFAULT 0,
 cursor_ledger_id INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX idx_login_attempts_created ON login_attempts(created_at,id);
CREATE INDEX idx_sessions_retention ON sessions(expires_at,id);
CREATE INDEX idx_r2_objects_state_created ON r2_objects(lifecycle_state,created_at,id);
