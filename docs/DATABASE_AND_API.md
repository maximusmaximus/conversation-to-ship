# Database Schema & API Contract

## 1. Relational Schema (Cloudflare D1 / SQLite & Postgres Compatible)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  github_username TEXT,
  role TEXT NOT NULL DEFAULT 'user', -- admin (secret ADMIN_EMAIL only) | user
  approval_status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  google_verified INTEGER NOT NULL DEFAULT 1,
  verified_by TEXT,
  verified_at TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_actions (
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

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  category TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE contact_messages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new', -- new | reviewed
  created_at TEXT NOT NULL
);

CREATE TABLE user_integrations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  category TEXT NOT NULL, -- booking | calendar | meeting | transcript | repo | deploy | antigravity_bridge
  active_provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'configured', -- connected | configured | needs_setup | error
  config_json TEXT NOT NULL DEFAULT '{}',
  secret_configured INTEGER NOT NULL DEFAULT 0,
  secret_fingerprint TEXT,
  last_tested_at TEXT,
  last_test_message TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, category)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id),
  owner_display_name TEXT,
  owner_avatar_url TEXT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL, -- INTAKE | TRANSCRIPT_PARSED | RESEARCHING | GATE_1_PENDING | SPEC_LOCKED | BUILDING | QA_VERIFYING | GATE_2_PENDING | DEPLOYED | FAILED
  visibility TEXT NOT NULL DEFAULT 'private', -- public | private | hidden
  lifecycle TEXT NOT NULL DEFAULT 'current', -- current | past
  golden_stack TEXT NOT NULL DEFAULT 'nextjs_cloudflare', -- nextjs_cloudflare | fastapi_react
  github_owner TEXT,
  github_repo_name TEXT,
  github_repo_url TEXT,
  repo_visibility TEXT NOT NULL DEFAULT 'private',
  default_joiner_role TEXT NOT NULL DEFAULT 'push',
  cloudflare_preview_url TEXT,
  cloudflare_prod_url TEXT,
  claim_path TEXT,
  participant_count INTEGER NOT NULL DEFAULT 1,
  active_matrix_week TEXT,
  active_matrix_schema TEXT,
  active_matrix_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  kind TEXT NOT NULL DEFAULT 'mvp', -- mvp | update
  booking_provider TEXT,
  calendar_provider TEXT,
  meeting_provider TEXT,
  transcript_provider TEXT,
  meet_url_code TEXT,
  calendar_ical_uid TEXT,
  calendly_event_uri TEXT,
  booked_objective TEXT,
  hypothesis_match TEXT, -- confirmed | drifted | unresolved | never_discussed
  start_time_iso TEXT,
  r2_raw_transcript_key TEXT,
  r2_normalized_transcript_key TEXT,
  claim_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_meetings_correlation
  ON meetings(meet_url_code, calendar_ical_uid, calendly_event_uri);

CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  meeting_id TEXT REFERENCES meetings(id),
  display_name TEXT,
  email TEXT,
  github_username TEXT,
  github_user_id TEXT,
  source TEXT NOT NULL, -- calendar | meet_api | read_ai | oauth_claim
  role TEXT NOT NULL DEFAULT 'joiner', -- host | joiner
  repo_permission TEXT NOT NULL DEFAULT 'push', -- pull | triage | push | maintain
  invite_status TEXT NOT NULL DEFAULT 'pending_gate', -- pending_claim | pending_gate | invited | active | skipped
  claimed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE requirements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  code TEXT NOT NULL, -- REQ-001 | OPEN-001 | OOS-001
  category TEXT NOT NULL, -- consensus | contested | out_of_scope
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  verbatim_quote TEXT NOT NULL,
  speaker TEXT NOT NULL,
  utterance_ref TEXT,
  research_ref TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE research_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  code TEXT NOT NULL, -- RES-001
  question TEXT NOT NULL,
  trigger_quote TEXT NOT NULL,
  risk_tier TEXT NOT NULL, -- low_risk_technical | high_impact_product
  status TEXT NOT NULL, -- queued | running | ready_for_gate_1 | resolved
  recommended_option TEXT,
  selected_option TEXT,
  r2_brief_key TEXT,
  citations_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE antigravity_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  tab_state TEXT NOT NULL, -- requirements | research | specs | app_build | qa_deploy
  matrix_week_id TEXT NOT NULL,
  matrix_content_hash TEXT,
  assigned_model TEXT NOT NULL,
  active_model TEXT NOT NULL,
  effort TEXT NOT NULL,
  cli_mode TEXT NOT NULL,
  agy_conversation_id TEXT,
  status TEXT NOT NULL, -- queued | claimed | running | fallback_retry | succeeded | failed
  r2_log_key TEXT,
  branch_name TEXT,
  pr_url TEXT,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  run_id TEXT REFERENCES antigravity_runs(id),
  environment TEXT NOT NULL, -- preview | production
  provider TEXT NOT NULL DEFAULT 'cloudflare',
  url TEXT NOT NULL,
  r2_bundle_key TEXT,
  smoke_report_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

---

## 2. HTTP, Webhook, Bridge & WebSocket Endpoints

### 2.1 Public Ingress & Webhooks
- `POST /api/webhooks/booking/:provider` — Verifies provider HMAC signature, normalizes `BookingScheduled`, runs Cascade Correlator.
- `POST /api/webhooks/calendar/:provider` — Verifies Google Calendar channel token (or Outlook/generic header), triggers incremental sync.
- `POST /api/webhooks/transcript/:provider` — Verifies Read.ai signature, uploads raw transcript to R2, enqueues multi-pass extraction + Meet Participant roster fetch.
- `POST /api/projects/:id/uploads/transcript` — Manual `.vtt/.srt/.txt/.json` upload fallback.
- `POST /api/projects/:id/uploads/ics` — Manual `.ics` calendar fallback.

### 2.2 Public Showcase, Google Auth, Admin Validation & Studio API
- `GET /api/public/config` — Returns public platform readiness (`googleAuthEnabled`, `googleClientId`, enabled 1-click `oauthProviders`, and `portalUrl`).
- `GET /api/public/projects` — Publicly returns all users' `visibility = 'public'` projects split into `current` and `past` lists (without private emails or credentials).
- `POST /api/contact` — Stores home page contact submissions into `contact_messages` and logs `contact_message_sent`.
- `POST /api/auth/google` — Verifies Google Identity Services ID token (`GOOGLE_CLIENT_ID`), sets the user matching Cloudflare Secret `ADMIN_EMAIL` as `role='admin'` + `approved`, sets new signups as `role='user'` + `approval_status='pending'`, logs `user_signed_up`/`user_signed_in`, and returns a signed HMAC session JWT.
- `GET /api/admin/overview` — Admin-only stats across users, projects, integrations, contacts, and user actions.
- `GET /api/admin/users` & `PATCH /api/admin/users/:id` — Admin-only (`ADMIN_EMAIL` secret) endpoints listing signed-up users with inline `recent_actions` and verifying (`approved`), revoking (`rejected`), or resetting (`pending`) access.
- `GET /api/admin/actions` — Admin-only filterable audit stream across all users (`?userId=...&actionType=...`).
- `GET /api/admin/projects` & `PATCH /api/admin/projects/:id` — Admin-only cross-account project inspection & moderation.
- `GET /api/admin/contacts` & `PATCH /api/admin/contacts/:id` — Admin-only contact inbox (`new` / `reviewed`).
- `POST /api/oauth/:provider/init` & `GET /api/oauth/:provider/callback` — Click-through 1-click OAuth onboarding for Google Workspace (`google_calendar`, `google_meet`, `google_meet_drive`), `github`, and `calendly`.
- `GET /api/me` & `PATCH /api/me` — Returns authenticated user info, approval status, visibility counts, integration status, and own `recentActions`; updates linked `github_username`.
- `GET /api/integrations`, `PUT /api/integrations/:category`, `POST /api/integrations/:category/test` — Reads, swaps/configures, and tests validated-user integration adapters (secrets encrypted with AES-GCM and masked on read; `403` if `approval_status !== 'approved'`).
- `GET /api/matrix/status` — Returns the currently active `agentic-model-matrix` snapshot (`week_id`, `schema_version`, `content_hash`, `pages_url`, per-stage models, and Stage 5 Gemini-on-Antigravity compliance state).
- `GET /api/projects`, `POST /api/projects`, `PATCH /api/projects/:id` — List/create project workspaces and toggle `visibility` (`public | private | hidden`) and `lifecycle` (`current | past`).
- `GET /api/projects/:id` — Hydrates all 5 Workspace Tabs (`intake`, `signals`, `research_specs`, `antigravity_tabs`, `deployments`).
- `GET /claim/:slug?token=...` & `GET /api/auth/github/callback` — 1-Click GitHub OAuth check-in binding a meeting-link joiner's GitHub identity to `participants`.
- `PATCH /api/projects/:id/participants/:pid` — Operator overrides collaborator permission (`pull | triage | push | maintain`) or skips invite.
- `POST /api/projects/:id/gates/1/approve` — Resolves selected `RES-*` and `OPEN-*` items, locks `requirements.json` + `slice.md`, and queues local Antigravity tab jobs.
- `POST /api/projects/:id/gates/2/approve` — Creates/updates private GitHub repo, opens/merges PR flow, dispatches GitHub collaborator invites to verified joiners, promotes Cloudflare preview to production, and sends notifications.

### 2.3 Outbound Local Antigravity Bridge Worker API
- `POST /api/bridge/jobs/claim` — Authenticated with `BRIDGE_WORKER_TOKEN`; returns next queued `antigravity_runs` job plus presigned R2 artifact download URLs and `routing.json` stage config.
- `POST /api/bridge/jobs/:runId/events` — Receives streamed NDJSON events (`tab_spawned`, `agy_conversation_id`, `model_fallback`, `tool_call`, `smoke_test_result`, `artifact_uploaded`, `completed`, `failed`).
- `POST /api/bridge/jobs/:runId/r2-upload-url` — Issues short-lived presigned R2 PUT URL for uploading local build bundles and logs without passing credentials to generated app code.
- `WS /ws/projects/:id` — Streams real-time stage transitions, participant claims, and Antigravity tab output lines to the 5-stage Studio Web UI.
