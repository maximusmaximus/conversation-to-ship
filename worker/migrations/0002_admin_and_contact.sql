-- Migration 0002: User Validation Queue & Contact Submissions
-- Admin identity is enforced dynamically by comparing verified Google email against env.ADMIN_EMAIL secret.

ALTER TABLE users ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE users ADD COLUMN google_verified INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN verified_by TEXT;
ALTER TABLE users ADD COLUMN verified_at TEXT;
ALTER TABLE users ADD COLUMN last_login_at TEXT;

-- Fail-closed reset of any non-secret-matched roles; Worker re-promotes env.ADMIN_EMAIL on login
UPDATE users SET role = 'user';

CREATE INDEX IF NOT EXISTS idx_users_approval
  ON users(approval_status, created_at DESC);

CREATE TABLE IF NOT EXISTS contact_messages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new', -- new | reviewed
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_messages_created
  ON contact_messages(created_at DESC);
