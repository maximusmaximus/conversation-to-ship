-- Conversation-to-Ship Cloudflare D1 Schema (Initial Migration)

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  github_username TEXT,
  role TEXT NOT NULL DEFAULT 'creator', -- creator | studio_admin
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_integrations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  category TEXT NOT NULL, -- booking | calendar | meeting | transcript | repo | deploy | antigravity_bridge
  active_provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'configured', -- connected | configured | needs_setup | error
  config_json TEXT NOT NULL DEFAULT '{}', -- non-secret settings (e.g. default org, permission, bucket, fallback mode)
  secret_configured INTEGER NOT NULL DEFAULT 0, -- 1 if secret token/key stored, never returned in GET
  secret_fingerprint TEXT, -- last-4/hash marker only
  last_tested_at TEXT,
  last_test_message TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, category)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  owner_display_name TEXT NOT NULL,
  owner_avatar_url TEXT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'INTAKE', -- INTAKE | TRANSCRIPT_PARSED | RESEARCHING | GATE_1_PENDING | SPEC_LOCKED | BUILDING | QA_VERIFYING | GATE_2_PENDING | DEPLOYED | FAILED
  visibility TEXT NOT NULL DEFAULT 'private', -- public | private | hidden
  lifecycle TEXT NOT NULL DEFAULT 'current', -- current | past
  golden_stack TEXT NOT NULL DEFAULT 'nextjs_cloudflare', -- nextjs_cloudflare | fastapi_react
  github_repo_url TEXT,
  cloudflare_live_url TEXT,
  cloudflare_preview_url TEXT,
  claim_path TEXT,
  participant_count INTEGER NOT NULL DEFAULT 1,
  active_matrix_week TEXT,
  active_matrix_model TEXT,
  active_matrix_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_public_feed
  ON projects(visibility, lifecycle, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_projects_owner
  ON projects(owner_user_id, visibility, updated_at DESC);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  provider TEXT NOT NULL,
  r2_object_key TEXT NOT NULL,
  received_at TEXT NOT NULL
);
