PRAGMA foreign_keys = ON;
CREATE TABLE sessions (
 id INTEGER PRIMARY KEY, token_digest TEXT NOT NULL UNIQUE CHECK(length(token_digest)=64), csrf_digest TEXT NOT NULL CHECK(length(csrf_digest)=64),
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 revoked_at TEXT, ip_prefix_digest TEXT, user_agent_digest TEXT
);
CREATE TABLE login_attempts (
 id INTEGER PRIMARY KEY, identifier_digest TEXT NOT NULL, ip_prefix_digest TEXT NOT NULL, succeeded INTEGER NOT NULL CHECK(succeeded IN(0,1)), created_at TEXT NOT NULL
);
CREATE TABLE idempotency_keys (
 id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), action TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('PENDING','COMMITTED','FAILED')), result_type TEXT, result_id INTEGER, response_status INTEGER, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 UNIQUE(user_id,action,idempotency_key)
);
CREATE TABLE migration_manifest (
 id INTEGER PRIMARY KEY, source_snapshot_id TEXT NOT NULL UNIQUE, source_database_digest TEXT NOT NULL, snapshot_at TEXT NOT NULL,
 table_counts_json TEXT NOT NULL CHECK(json_valid(table_counts_json)), control_totals_json TEXT NOT NULL CHECK(json_valid(control_totals_json)),
 imported_at TEXT, verified_at TEXT, verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(verification_status IN('PENDING','VERIFIED','REJECTED'))
);
CREATE TABLE r2_objects (
 id INTEGER PRIMARY KEY, object_key TEXT NOT NULL UNIQUE, company_id INTEGER NOT NULL REFERENCES companies(id), owner_user_id INTEGER REFERENCES users(id),
 content_type TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes>=0), sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN('PENDING','READY','SOFT_DELETED','ORPHANED')), created_at TEXT NOT NULL, ready_at TEXT, deleted_at TEXT
);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at,id) WHERE revoked_at IS NULL;
CREATE INDEX idx_login_attempts_identifier_time ON login_attempts(identifier_digest,created_at DESC);
CREATE INDEX idx_login_attempts_ip_time ON login_attempts(ip_prefix_digest,created_at DESC);
CREATE INDEX idx_idempotency_expiry ON idempotency_keys(expires_at,id);
CREATE INDEX idx_r2_objects_company_state ON r2_objects(company_id,lifecycle_state,created_at,id);
