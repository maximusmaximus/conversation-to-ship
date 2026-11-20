-- Migration 0003: Inline User Actions Log & 1-Click OAuth Integration States

CREATE TABLE IF NOT EXISTS user_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  user_email TEXT,
  user_name TEXT,
  action_type TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_actions_user_created
  ON user_actions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_actions_created
  ON user_actions(created_at DESC);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  category TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

ALTER TABLE user_integrations ADD COLUMN encrypted_secret TEXT;
ALTER TABLE user_integrations ADD COLUMN oauth_account_label TEXT;
ALTER TABLE user_integrations ADD COLUMN token_expires_at TEXT;
