/**
 * Conversation-to-Ship Cloudflare Worker API
 *
 * Powers:
 *  - Public config & discovery (`GET /api/public/config`)
 *  - Public Showcase feed (`GET /api/public/projects`) across all users (current & past public projects)
 *  - Public Contact form (`POST /api/contact`)
 *  - Google Identity Sign-In (`POST /api/auth/google`) -> signed HMAC session JWT
 *  - Secret-backed Single-Admin Gate (`env.ADMIN_EMAIL` kept solely in Cloudflare secret)
 *  - New User Validation Queue (`approval_status: pending | approved | rejected`)
 *  - Admin Stats, Account Management & Inline User Actions (`/api/admin/overview`, `/api/admin/users`, `/api/admin/actions`, `/api/admin/projects`, `/api/admin/contacts`)
 *  - Click-Through OAuth & Swappable Integration Onboarding (`/api/oauth/:provider/init`, `/api/oauth/:provider/callback`, `/api/integrations/*`)
 *  - Signed Webhook Ingress storing raw payloads in Cloudflare R2 (`/api/webhooks/:category/:provider`)
 */

export interface Env {
  DB: D1Database;
  ARTIFACTS_BUCKET: R2Bucket;
  ALLOWED_ORIGIN: string;
  FRONTEND_PORTAL_URL?: string;
  MODEL_MATRIX_URL: string;
  ADMIN_EMAIL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  CALENDLY_CLIENT_ID?: string;
  CALENDLY_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  BRIDGE_WORKER_TOKEN?: string;
  CALENDLY_WEBHOOK_SIGNING_KEY?: string;
  GOOGLE_CALENDAR_WEBHOOK_TOKEN?: string;
  READAI_WEBHOOK_SECRET?: string;
}

type Visibility = "public" | "private" | "hidden";
type Lifecycle = "current" | "past";
type ApprovalStatus = "pending" | "approved" | "rejected";

interface SessionClaims {
  sub: string;
  email: string;
  name: string;
  avatar?: string;
  role: string;
  exp: number;
}

interface UserRecord {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  github_username: string | null;
  role: string;
  approval_status: ApprovalStatus;
  google_verified: number;
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
  last_login_at: string | null;
}

const VALID_CATEGORIES = new Set([
  "booking",
  "calendar",
  "meeting",
  "transcript",
  "repo",
  "deploy",
]);

const VALID_VISIBILITIES = new Set<Visibility>(["public", "private", "hidden"]);
const VALID_LIFECYCLES = new Set<Lifecycle>(["current", "past"]);
const VALID_APPROVALS = new Set<ApprovalStatus>(["pending", "approved", "rejected"]);

const OAUTH_PROVIDER_MAP: Record<string, { category: string; activeProvider: string }> = {
  google_calendar: { category: "calendar", activeProvider: "google_calendar" },
  google_meet: { category: "meeting", activeProvider: "google_meet" },
  google_meet_drive: { category: "transcript", activeProvider: "google_meet_drive" },
  github: { category: "repo", activeProvider: "github" },
  calendly: { category: "booking", activeProvider: "calendly" },
};

function getAdminEmail(env: Env): string {
  return (env.ADMIN_EMAIL || "").trim().toLowerCase();
}

function isSoleAdminEmail(email: string, env: Env): boolean {
  const adminEmail = getAdminEmail(env);
  if (!adminEmail) return false;
  return email.trim().toLowerCase() === adminEmail;
}

function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN || "https://maximusmaximus.github.io";
  const allowOrigin =
    origin === allowed || origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")
      ? origin
      : allowed;

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(
  data: unknown,
  status: number,
  request: Request,
  env: Env
): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(request, env),
    },
  });
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

async function signJwt(claims: SessionClaims, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64urlEncode(enc.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(signingInput)));
  return `${signingInput}.${b64urlEncode(sig)}`;
}

async function verifyJwt(token: string, secret: string): Promise<SessionClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    b64urlDecode(parts[2]),
    enc.encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) return null;
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as SessionClaims;
  if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}

async function encryptSecret(plaintext: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  const aesKey = await crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, enc.encode(plaintext))
  );
  return `${b64urlEncode(iv)}.${b64urlEncode(ciphertext)}`;
}

async function requireAuth(request: Request, env: Env): Promise<{ claims: SessionClaims; user: UserRecord } | null> {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const secret = env.SESSION_SECRET;
  if (!secret) return null;
  const claims = await verifyJwt(auth.slice(7).trim(), secret);
  if (!claims) return null;

  const user = await env.DB.prepare(
    `SELECT id, email, display_name, avatar_url, github_username, role,
            approval_status, google_verified, verified_by, verified_at, created_at, last_login_at
     FROM users WHERE id = ?`
  )
    .bind(claims.sub)
    .first<UserRecord>();

  if (!user) return null;
  const effectiveRole = isSoleAdminEmail(user.email, env) ? "admin" : "user";
  user.role = effectiveRole;
  if (effectiveRole === "admin") {
    user.approval_status = "approved";
  }
  return { claims, user };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";
}

async function logUserAction(
  env: Env,
  params: {
    userId?: string | null;
    userEmail?: string | null;
    userName?: string | null;
    actionType: string;
    targetType?: string | null;
    targetId?: string | null;
    summary: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO user_actions (
        id, user_id, user_email, user_name, action_type,
        target_type, target_id, summary, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        params.userId || null,
        params.userEmail || null,
        params.userName || null,
        params.actionType,
        params.targetType || null,
        params.targetId || null,
        params.summary,
        JSON.stringify(params.metadata || {}),
        new Date().toISOString()
      )
      .run();
  } catch (_) {
    // Non-fatal if audit table is migrating
  }
}

async function verifyGoogleIdToken(idToken: string, expectedClientId: string): Promise<{
  sub: string;
  email: string;
  name: string;
  picture?: string;
} | null> {
  const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const data = (await resp.json()) as Record<string, string>;
  if (data.aud !== expectedClientId) return null;
  if (data.email_verified !== "true") return null;
  if (!data.sub || !data.email) return null;
  return {
    sub: data.sub,
    email: data.email.trim().toLowerCase(),
    name: data.name || data.email.split("@")[0],
    picture: data.picture,
  };
}

function getOauthCapabilityFlags(env: Env): Record<string, boolean> {
  const hasGoogle = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const hasGithub = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
  const hasCalendly = Boolean(env.CALENDLY_CLIENT_ID && env.CALENDLY_CLIENT_SECRET);
  return {
    google_calendar: hasGoogle,
    google_meet: hasGoogle,
    google_meet_drive: hasGoogle,
    github: hasGithub,
    calendly: hasCalendly,
  };
}

function portalRedirect(env: Env, query: string, hash = "integrations"): Response {
  const base = (env.FRONTEND_PORTAL_URL || "https://maximusmaximus.github.io/conversation-to-ship/").replace(/#.*$/, "");
  const sep = base.includes("?") ? "&" : "?";
  return Response.redirect(`${base}${sep}${query}#${hash}`, 302);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Health, Public Config & Matrix Status
    if (path === "/api/health" && request.method === "GET") {
      return jsonResponse({ ok: true, service: "conversation-to-ship-api", stage: "alpha", timestamp: new Date().toISOString() }, 200, request, env);
    }

    if (path === "/api/public/config" && request.method === "GET") {
      return jsonResponse(
        {
          ok: true,
          stage: "alpha",
          googleAuthEnabled: Boolean(env.GOOGLE_CLIENT_ID),
          googleClientId: env.GOOGLE_CLIENT_ID || null,
          oauthProviders: getOauthCapabilityFlags(env),
          portalUrl: env.FRONTEND_PORTAL_URL || "https://maximusmaximus.github.io/conversation-to-ship/",
        },
        200,
        request,
        env
      );
    }

    if (path === "/api/matrix/status" && request.method === "GET") {
      const matrixUrl = env.MODEL_MATRIX_URL || "https://maximusmaximus.github.io/agentic-model-matrix/routing.json";
      const res = await fetch(matrixUrl);
      if (!res.ok) {
        return jsonResponse({ error: "Failed to fetch model matrix", status: res.status }, 502, request, env);
      }
      const matrix = await res.json();
      return jsonResponse(matrix, 200, request, env);
    }

    // 2. Public Contact Form Submission
    if (path === "/api/contact" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        name?: string;
        email?: string;
        message?: string;
      };
      const name = (body.name || "").trim();
      const email = (body.email || "").trim();
      const message = (body.message || "").trim();

      if (!name || !email || !email.includes("@") || !message) {
        return jsonResponse({ error: "Name, valid email, and message are required." }, 400, request, env);
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO contact_messages (id, name, email, message, status, created_at) VALUES (?, ?, ?, ?, 'new', ?)"
      )
        .bind(id, name.slice(0, 120), email.slice(0, 200), message.slice(0, 2000), now)
        .run();

      await logUserAction(env, {
        userEmail: email.slice(0, 200),
        userName: name.slice(0, 120),
        actionType: "contact_message_sent",
        targetType: "contact",
        targetId: id,
        summary: `Submitted contact inquiry: "${message.slice(0, 80)}${message.length > 80 ? "..." : ""}"`,
      });

      return jsonResponse({ ok: true, id, receivedAt: now }, 201, request, env);
    }

    // 3. Public Showcase Feed (Current & Past Public Projects across ALL users)
    if (path === "/api/public/projects" && request.method === "GET") {
      const rows = await env.DB.prepare(
        `SELECT id, slug, name, summary, status, lifecycle, golden_stack,
                owner_display_name, owner_avatar_url, github_repo_url,
                cloudflare_live_url, cloudflare_preview_url, claim_path,
                participant_count, active_matrix_week, active_matrix_model,
                created_at, updated_at
         FROM projects
         WHERE visibility = 'public'
         ORDER BY updated_at DESC
         LIMIT 200`
      ).all();

      const items = (rows.results || []) as Array<Record<string, unknown>>;
      return jsonResponse(
        {
          current: items.filter((p) => p.lifecycle !== "past"),
          past: items.filter((p) => p.lifecycle === "past"),
          total: items.length,
        },
        200,
        request,
        env
      );
    }

    // 4. Google Sign-In (Creates new users as 'pending' unless verified email matches secret env.ADMIN_EMAIL)
    if (path === "/api/auth/google" && request.method === "POST") {
      if (!env.GOOGLE_CLIENT_ID || !env.SESSION_SECRET) {
        return jsonResponse({ error: "Server auth secrets GOOGLE_CLIENT_ID or SESSION_SECRET are not configured." }, 500, request, env);
      }
      const body = (await request.json().catch(() => ({}))) as { idToken?: string };
      if (!body.idToken) {
        return jsonResponse({ error: "Missing idToken" }, 400, request, env);
      }
      const googleUser = await verifyGoogleIdToken(body.idToken, env.GOOGLE_CLIENT_ID);
      if (!googleUser) {
        return jsonResponse({ error: "Invalid or unverified Google ID token" }, 401, request, env);
      }

      const now = new Date().toISOString();
      const adminMatch = isSoleAdminEmail(googleUser.email, env);
      const role = adminMatch ? "admin" : "user";

      const existing = await env.DB.prepare(
        "SELECT id, github_username, approval_status FROM users WHERE google_sub = ?"
      )
        .bind(googleUser.sub)
        .first<{ id: string; github_username: string | null; approval_status: ApprovalStatus }>();

      const userId = existing?.id || crypto.randomUUID();
      const approvalStatus: ApprovalStatus = adminMatch
        ? "approved"
        : existing?.approval_status || "pending";

      if (existing) {
        await env.DB.prepare(
          `UPDATE users
           SET email = ?, display_name = ?, avatar_url = ?, role = ?,
               approval_status = ?, google_verified = 1, last_login_at = ?, updated_at = ?
           WHERE id = ?`
        )
          .bind(
            googleUser.email,
            googleUser.name,
            googleUser.picture || null,
            role,
            approvalStatus,
            now,
            now,
            userId
          )
          .run();

        await logUserAction(env, {
          userId,
          userEmail: googleUser.email,
          userName: googleUser.name,
          actionType: "user_signed_in",
          targetType: "user",
          targetId: userId,
          summary: `Signed in via Google (${role}, status: ${approvalStatus})`,
        });
      } else {
        await env.DB.prepare(
          `INSERT INTO users (
            id, google_sub, email, display_name, avatar_url, role,
            approval_status, google_verified, verified_by, verified_at,
            created_at, updated_at, last_login_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
        )
          .bind(
            userId,
            googleUser.sub,
            googleUser.email,
            googleUser.name,
            googleUser.picture || null,
            role,
            approvalStatus,
            adminMatch ? googleUser.email : null,
            adminMatch ? now : null,
            now,
            now,
            now
          )
          .run();

        await logUserAction(env, {
          userId,
          userEmail: googleUser.email,
          userName: googleUser.name,
          actionType: "user_signed_up",
          targetType: "user",
          targetId: userId,
          summary: `New Google signup (${approvalStatus === "approved" ? "admin auto-verified" : "queued for admin validation"})`,
        });
      }

      const token = await signJwt(
        {
          sub: userId,
          email: googleUser.email,
          name: googleUser.name,
          avatar: googleUser.picture,
          role,
          exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
        },
        env.SESSION_SECRET
      );

      return jsonResponse(
        {
          token,
          user: {
            id: userId,
            email: googleUser.email,
            displayName: googleUser.name,
            avatarUrl: googleUser.picture || null,
            githubUsername: existing?.github_username || null,
            role,
            approvalStatus,
            googleVerified: true,
          },
        },
        200,
        request,
        env
      );
    }

    // 5. OAuth Callback (Browser redirect target — no Authorization header)
    const oauthCallbackMatch = path.match(/^\/api\/oauth\/([a-z_]+)\/callback$/);
    if (oauthCallbackMatch && request.method === "GET") {
      const provider = oauthCallbackMatch[1];
      const code = url.searchParams.get("code") || "";
      const stateToken = url.searchParams.get("state") || "";
      const errorParam = url.searchParams.get("error") || "";

      if (errorParam || !code || !stateToken) {
        return portalRedirect(env, `oauth_error=${encodeURIComponent(errorParam || "missing_code")}`);
      }

      const stateRow = await env.DB.prepare(
        "SELECT state, user_id, provider, category, expires_at FROM oauth_states WHERE state = ?"
      )
        .bind(stateToken)
        .first<{ state: string; user_id: string; provider: string; category: string; expires_at: number }>();

      await env.DB.prepare("DELETE FROM oauth_states WHERE state = ?").bind(stateToken).run();

      if (!stateRow || stateRow.provider !== provider || stateRow.expires_at < Math.floor(Date.now() / 1000)) {
        return portalRedirect(env, "oauth_error=invalid_or_expired_state");
      }

      const userRow = await env.DB.prepare("SELECT id, email, display_name FROM users WHERE id = ?")
        .bind(stateRow.user_id)
        .first<{ id: string; email: string; display_name: string }>();

      if (!userRow || !env.SESSION_SECRET) {
        return portalRedirect(env, "oauth_error=session_unavailable");
      }

      const callbackUrl = `${url.origin}/api/oauth/${provider}/callback`;
      let tokenPayload: Record<string, unknown> = {};
      let accountLabel = userRow.email;

      try {
        if (provider.startsWith("google_") && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
          const resp = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              code,
              client_id: env.GOOGLE_CLIENT_ID,
              client_secret: env.GOOGLE_CLIENT_SECRET,
              redirect_uri: callbackUrl,
              grant_type: "authorization_code",
            }),
          });
          tokenPayload = (await resp.json()) as Record<string, unknown>;
          if (!resp.ok || !tokenPayload.access_token) {
            return portalRedirect(env, `oauth_error=${encodeURIComponent("google_token_exchange_failed")}`);
          }
        } else if (provider === "github" && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
          const resp = await fetch("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              client_id: env.GITHUB_CLIENT_ID,
              client_secret: env.GITHUB_CLIENT_SECRET,
              code,
              redirect_uri: callbackUrl,
            }),
          });
          tokenPayload = (await resp.json()) as Record<string, unknown>;
          if (!resp.ok || !tokenPayload.access_token) {
            return portalRedirect(env, "oauth_error=github_token_exchange_failed");
          }
          const ghUserResp = await fetch("https://api.github.com/user", {
            headers: {
              Authorization: `Bearer ${tokenPayload.access_token}`,
              "User-Agent": "conversation-to-ship-worker",
            },
          });
          if (ghUserResp.ok) {
            const ghUser = (await ghUserResp.json()) as { login?: string };
            if (ghUser.login) {
              accountLabel = `@${ghUser.login}`;
              await env.DB.prepare("UPDATE users SET github_username = ?, updated_at = ? WHERE id = ?")
                .bind(ghUser.login, new Date().toISOString(), userRow.id)
                .run();
            }
          }
        } else if (provider === "calendly" && env.CALENDLY_CLIENT_ID && env.CALENDLY_CLIENT_SECRET) {
          const resp = await fetch("https://auth.calendly.com/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              client_id: env.CALENDLY_CLIENT_ID,
              client_secret: env.CALENDLY_CLIENT_SECRET,
              code,
              redirect_uri: callbackUrl,
            }),
          });
          tokenPayload = (await resp.json()) as Record<string, unknown>;
          if (!resp.ok || !tokenPayload.access_token) {
            return portalRedirect(env, "oauth_error=calendly_token_exchange_failed");
          }
        } else {
          return portalRedirect(env, "oauth_error=provider_not_configured");
        }
      } catch (_) {
        return portalRedirect(env, "oauth_error=oauth_exchange_exception");
      }

      const now = new Date().toISOString();
      const encrypted = await encryptSecret(JSON.stringify(tokenPayload), env.SESSION_SECRET);
      const accessTokenStr = String(tokenPayload.access_token || "");
      const fingerprint = accessTokenStr ? `oauth:**${accessTokenStr.slice(-4)}` : "oauth";

      await env.DB.prepare(
        `INSERT INTO user_integrations (
          id, user_id, category, active_provider, status, config_json,
          secret_configured, secret_fingerprint, encrypted_secret,
          oauth_account_label, last_tested_at, last_test_message, updated_at
        ) VALUES (?, ?, ?, ?, 'connected', '{}', 1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, category) DO UPDATE SET
          active_provider = excluded.active_provider,
          status = 'connected',
          secret_configured = 1,
          secret_fingerprint = excluded.secret_fingerprint,
          encrypted_secret = excluded.encrypted_secret,
          oauth_account_label = excluded.oauth_account_label,
          last_tested_at = excluded.last_tested_at,
          last_test_message = excluded.last_test_message,
          updated_at = excluded.updated_at`
      )
        .bind(
          crypto.randomUUID(),
          userRow.id,
          stateRow.category,
          provider,
          fingerprint,
          encrypted,
          accountLabel,
          now,
          `Connected via 1-click OAuth (${accountLabel})`,
          now
        )
        .run();

      await logUserAction(env, {
        userId: userRow.id,
        userEmail: userRow.email,
        userName: userRow.display_name,
        actionType: "integration_oauth_connected",
        targetType: "integration",
        targetId: stateRow.category,
        summary: `Connected ${stateRow.category} (${provider}) via 1-click OAuth`,
      });

      return portalRedirect(env, `oauth_connected=${encodeURIComponent(provider)}`);
    }

    // 6. Signed Webhook Ingress (Stores payload to R2)
    const webhookMatch = path.match(/^\/api\/webhooks\/(booking|calendar|transcript)\/([a-z0-9_-]+)$/);
    if (webhookMatch && request.method === "POST") {
      const [, category, provider] = webhookMatch;
      if (category === "calendar" && env.GOOGLE_CALENDAR_WEBHOOK_TOKEN) {
        const tokenHeader = request.headers.get("X-Goog-Channel-Token") || "";
        if (tokenHeader !== env.GOOGLE_CALENDAR_WEBHOOK_TOKEN) {
          return jsonResponse({ error: "Invalid calendar channel token" }, 401, request, env);
        }
      }
      const rawBody = await request.text();
      const eventId = crypto.randomUUID();
      const r2Key = `webhooks/${category}/${provider}/${new Date().toISOString().slice(0, 10)}/${eventId}.json`;
      await env.ARTIFACTS_BUCKET.put(r2Key, rawBody, {
        httpMetadata: { contentType: "application/json" },
      });
      await env.DB.prepare(
        "INSERT INTO webhook_events (id, category, provider, r2_object_key, received_at) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(eventId, category, provider, r2Key, new Date().toISOString())
        .run();

      return jsonResponse({ accepted: true, eventId, r2Key }, 202, request, env);
    }

    // --- Authenticated Google User Endpoints ---
    const authCtx = await requireAuth(request, env);
    if (!authCtx) {
      return jsonResponse({ error: "Authentication required" }, 401, request, env);
    }
    const { user } = authCtx;
    const isAdmin = isSoleAdminEmail(user.email, env) && user.role === "admin";
    const isValidatedUser = isAdmin || user.approval_status === "approved";

    // 7. User Profile & Own Activity Summary
    if (path === "/api/me" && request.method === "GET") {
      const counts = await env.DB.prepare(
        `SELECT visibility, COUNT(*) AS count FROM projects WHERE owner_user_id = ? GROUP BY visibility`
      )
        .bind(user.id)
        .all();
      const integrations = isValidatedUser
        ? await env.DB.prepare(
            "SELECT category, active_provider, status, secret_configured, oauth_account_label, last_tested_at FROM user_integrations WHERE user_id = ?"
          )
            .bind(user.id)
            .all()
        : { results: [] };
      const myActions = await env.DB.prepare(
        "SELECT id, action_type, target_type, target_id, summary, created_at FROM user_actions WHERE user_id = ? ORDER BY created_at DESC LIMIT 15"
      )
        .bind(user.id)
        .all();

      return jsonResponse(
        {
          user: {
            id: user.id,
            email: user.email,
            displayName: user.display_name,
            avatarUrl: user.avatar_url,
            githubUsername: user.github_username,
            role: user.role,
            approvalStatus: user.approval_status,
            googleVerified: Boolean(user.google_verified),
            verifiedBy: user.verified_by,
            verifiedAt: user.verified_at,
            createdAt: user.created_at,
          },
          projectCounts: counts.results || [],
          integrations: integrations.results || [],
          recentActions: myActions.results || [],
        },
        200,
        request,
        env
      );
    }

    if (path === "/api/me" && request.method === "PATCH") {
      const body = (await request.json().catch(() => ({}))) as { githubUsername?: string };
      const cleanHandle = body.githubUsername ? body.githubUsername.trim() : null;
      await env.DB.prepare("UPDATE users SET github_username = ?, updated_at = ? WHERE id = ?")
        .bind(cleanHandle, new Date().toISOString(), user.id)
        .run();

      await logUserAction(env, {
        userId: user.id,
        userEmail: user.email,
        userName: user.display_name,
        actionType: "profile_github_updated",
        targetType: "user",
        targetId: user.id,
        summary: cleanHandle ? `Linked GitHub handle @${cleanHandle}` : "Cleared GitHub handle",
      });

      return jsonResponse({ ok: true }, 200, request, env);
    }

    // 8. Admin Stats, Account Management & Inline User Actions (Strictly env.ADMIN_EMAIL only)
    if (path.startsWith("/api/admin/")) {
      if (!isAdmin) {
        return jsonResponse({ error: "Admin access restricted to configured secret ADMIN_EMAIL" }, 403, request, env);
      }

      if (path === "/api/admin/overview" && request.method === "GET") {
        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const [uStats, pStats, iStats, cStats, aStats] = await Promise.all([
          env.DB.prepare(
            `SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN approval_status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN approval_status = 'approved' THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN approval_status = 'rejected' THEN 1 ELSE 0 END) AS rejected
             FROM users`
          ).first(),
          env.DB.prepare(
            `SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN visibility = 'public' THEN 1 ELSE 0 END) AS public_count,
              SUM(CASE WHEN visibility = 'private' THEN 1 ELSE 0 END) AS private_count,
              SUM(CASE WHEN visibility = 'hidden' THEN 1 ELSE 0 END) AS hidden_count,
              SUM(CASE WHEN lifecycle = 'current' THEN 1 ELSE 0 END) AS current_count,
              SUM(CASE WHEN lifecycle = 'past' THEN 1 ELSE 0 END) AS past_count
             FROM projects`
          ).first(),
          env.DB.prepare(
            `SELECT
              COUNT(*) AS configured_count,
              SUM(CASE WHEN status = 'connected' THEN 1 ELSE 0 END) AS connected_count
             FROM user_integrations`
          ).first(),
          env.DB.prepare(
            `SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_count
             FROM contact_messages`
          ).first(),
          env.DB.prepare(
            `SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last_24h
             FROM user_actions`
          )
            .bind(since24h)
            .first(),
        ]);

        return jsonResponse(
          {
            users: uStats,
            projects: pStats,
            integrations: iStats,
            contacts: cStats,
            actions: aStats,
          },
          200,
          request,
          env
        );
      }

      if (path === "/api/admin/users" && request.method === "GET") {
        const [userRows, actionRows] = await Promise.all([
          env.DB.prepare(
            `SELECT u.id, u.email, u.display_name, u.avatar_url, u.github_username, u.role,
                    u.approval_status, u.google_verified, u.verified_by, u.verified_at,
                    u.created_at, u.last_login_at,
                    (SELECT COUNT(*) FROM projects p WHERE p.owner_user_id = u.id) AS project_count,
                    (SELECT COUNT(*) FROM user_integrations ui WHERE ui.user_id = u.id) AS integration_count,
                    (SELECT COUNT(*) FROM user_actions ua WHERE ua.user_id = u.id) AS action_count
             FROM users u
             ORDER BY
               CASE u.approval_status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
               u.created_at DESC`
          ).all(),
          env.DB.prepare(
            `SELECT id, user_id, action_type, target_type, target_id, summary, created_at
             FROM user_actions
             WHERE user_id IS NOT NULL
             ORDER BY created_at DESC
             LIMIT 300`
          ).all(),
        ]);

        const actionsByUser: Record<string, Array<Record<string, unknown>>> = {};
        for (const row of (actionRows.results || []) as Array<Record<string, unknown>>) {
          const uid = String(row.user_id || "");
          if (!uid) continue;
          if (!actionsByUser[uid]) actionsByUser[uid] = [];
          if (actionsByUser[uid].length < 15) {
            actionsByUser[uid].push(row);
          }
        }

        const enriched = ((userRows.results || []) as Array<Record<string, unknown>>).map((u) => ({
          ...u,
          recent_actions: actionsByUser[String(u.id)] || [],
        }));

        return jsonResponse({ users: enriched }, 200, request, env);
      }

      const adminUserMatch = path.match(/^\/api\/admin\/users\/([a-zA-Z0-9-]+)$/);
      if (adminUserMatch && request.method === "PATCH") {
        const targetUserId = adminUserMatch[1];
        const body = (await request.json().catch(() => ({}))) as { approvalStatus?: ApprovalStatus };
        if (!body.approvalStatus || !VALID_APPROVALS.has(body.approvalStatus)) {
          return jsonResponse({ error: "approvalStatus must be pending | approved | rejected" }, 400, request, env);
        }
        const target = await env.DB.prepare("SELECT id, email, display_name FROM users WHERE id = ?")
          .bind(targetUserId)
          .first<{ id: string; email: string; display_name: string }>();
        if (!target) {
          return jsonResponse({ error: "User not found" }, 404, request, env);
        }
        if (isSoleAdminEmail(target.email, env) && body.approvalStatus !== "approved") {
          return jsonResponse({ error: "Cannot revoke sole admin account" }, 400, request, env);
        }

        const now = new Date().toISOString();
        await env.DB.prepare(
          `UPDATE users
           SET approval_status = ?, verified_by = ?, verified_at = ?, updated_at = ?
           WHERE id = ?`
        )
          .bind(body.approvalStatus, user.email, now, now, targetUserId)
          .run();

        await logUserAction(env, {
          userId: targetUserId,
          userEmail: target.email,
          userName: target.display_name,
          actionType:
            body.approvalStatus === "approved"
              ? "admin_user_validated"
              : body.approvalStatus === "rejected"
              ? "admin_user_revoked"
              : "admin_user_reset",
          targetType: "user",
          targetId: targetUserId,
          summary: `Admin set account status to ${body.approvalStatus}`,
        });

        const updated = await env.DB.prepare(
          `SELECT id, email, display_name, avatar_url, github_username, role,
                  approval_status, google_verified, verified_by, verified_at, created_at, last_login_at
           FROM users WHERE id = ?`
        )
          .bind(targetUserId)
          .first();
        return jsonResponse({ user: updated }, 200, request, env);
      }

      if (path === "/api/admin/actions" && request.method === "GET") {
        const filterUserId = (url.searchParams.get("userId") || "").trim();
        const filterType = (url.searchParams.get("actionType") || "").trim();
        let query = "SELECT id, user_id, user_email, user_name, action_type, target_type, target_id, summary, metadata_json, created_at FROM user_actions WHERE 1=1";
        const binds: string[] = [];
        if (filterUserId) {
          query += " AND user_id = ?";
          binds.push(filterUserId);
        }
        if (filterType) {
          query += " AND action_type = ?";
          binds.push(filterType);
        }
        query += " ORDER BY created_at DESC LIMIT 150";
        const stmt = env.DB.prepare(query);
        const rows = binds.length ? await stmt.bind(...binds).all() : await stmt.all();
        return jsonResponse({ actions: rows.results || [] }, 200, request, env);
      }

      if (path === "/api/admin/projects" && request.method === "GET") {
        const rows = await env.DB.prepare(
          `SELECT p.*, u.email AS owner_email
           FROM projects p
           LEFT JOIN users u ON p.owner_user_id = u.id
           ORDER BY p.updated_at DESC
           LIMIT 200`
        ).all();
        return jsonResponse({ projects: rows.results || [] }, 200, request, env);
      }

      const adminProjMatch = path.match(/^\/api\/admin\/projects\/([a-zA-Z0-9-]+)$/);
      if (adminProjMatch && request.method === "PATCH") {
        const projectId = adminProjMatch[1];
        const body = (await request.json().catch(() => ({}))) as {
          visibility?: Visibility;
          lifecycle?: Lifecycle;
          status?: string;
        };
        if (body.visibility && !VALID_VISIBILITIES.has(body.visibility)) {
          return jsonResponse({ error: "Invalid visibility" }, 400, request, env);
        }
        if (body.lifecycle && !VALID_LIFECYCLES.has(body.lifecycle)) {
          return jsonResponse({ error: "Invalid lifecycle" }, 400, request, env);
        }

        const existing = await env.DB.prepare("SELECT id, name, owner_user_id FROM projects WHERE id = ?")
          .bind(projectId)
          .first<{ id: string; name: string; owner_user_id: string }>();
        if (!existing) {
          return jsonResponse({ error: "Project not found" }, 404, request, env);
        }

        await env.DB.prepare(
          `UPDATE projects SET
            visibility = COALESCE(?, visibility),
            lifecycle = COALESCE(?, lifecycle),
            status = COALESCE(?, status),
            updated_at = ?
           WHERE id = ?`
        )
          .bind(body.visibility || null, body.lifecycle || null, body.status || null, new Date().toISOString(), projectId)
          .run();

        await logUserAction(env, {
          userId: existing.owner_user_id,
          userEmail: user.email,
          userName: user.display_name,
          actionType: "admin_project_updated",
          targetType: "project",
          targetId: projectId,
          summary: `Admin updated project "${existing.name}"`,
        });

        const updated = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(projectId).first();
        return jsonResponse({ project: updated }, 200, request, env);
      }

      if (path === "/api/admin/contacts" && request.method === "GET") {
        const rows = await env.DB.prepare(
          "SELECT id, name, email, message, status, created_at FROM contact_messages ORDER BY created_at DESC LIMIT 100"
        ).all();
        return jsonResponse({ contacts: rows.results || [] }, 200, request, env);
      }

      const adminContactMatch = path.match(/^\/api\/admin\/contacts\/([a-zA-Z0-9-]+)$/);
      if (adminContactMatch && request.method === "PATCH") {
        const contactId = adminContactMatch[1];
        const body = (await request.json().catch(() => ({}))) as { status?: string };
        const nextStatus = body.status === "reviewed" ? "reviewed" : "new";
        await env.DB.prepare("UPDATE contact_messages SET status = ? WHERE id = ?")
          .bind(nextStatus, contactId)
          .run();
        return jsonResponse({ ok: true, id: contactId, status: nextStatus }, 200, request, env);
      }
    }

    // --- Gate Remaining Service Routes to Admin-Validated Users Only ---
    if (!isValidatedUser) {
      return jsonResponse(
        {
          error: "Account pending admin validation. An admin must verify your account before using the service.",
          approvalStatus: user.approval_status,
        },
        403,
        request,
        env
      );
    }

    // 9. Click-Through OAuth Initiation (`POST /api/oauth/:provider/init`)
    const oauthInitMatch = path.match(/^\/api\/oauth\/([a-z_]+)\/init$/);
    if (oauthInitMatch && request.method === "POST") {
      const provider = oauthInitMatch[1];
      const mapping = OAUTH_PROVIDER_MAP[provider];
      if (!mapping) {
        return jsonResponse({ error: "Unsupported OAuth provider" }, 400, request, env);
      }

      const callbackUrl = `${url.origin}/api/oauth/${provider}/callback`;
      const stateToken = crypto.randomUUID();
      const expiresAt = Math.floor(Date.now() / 1000) + 600;
      let authUrl = "";

      if (provider.startsWith("google_") && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
        const scope =
          provider === "google_calendar"
            ? "https://www.googleapis.com/auth/calendar.readonly"
            : provider === "google_meet"
            ? "https://www.googleapis.com/auth/meetings.space.readonly"
            : "https://www.googleapis.com/auth/drive.readonly";

        const qs = new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          redirect_uri: callbackUrl,
          response_type: "code",
          access_type: "offline",
          prompt: "consent",
          scope,
          login_hint: user.email,
          state: stateToken,
        });
        authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${qs.toString()}`;
      } else if (provider === "github" && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
        const qs = new URLSearchParams({
          client_id: env.GITHUB_CLIENT_ID,
          redirect_uri: callbackUrl,
          scope: "repo read:user user:email",
          state: stateToken,
        });
        authUrl = `https://github.com/login/oauth/authorize?${qs.toString()}`;
      } else if (provider === "calendly" && env.CALENDLY_CLIENT_ID && env.CALENDLY_CLIENT_SECRET) {
        const qs = new URLSearchParams({
          client_id: env.CALENDLY_CLIENT_ID,
          response_type: "code",
          redirect_uri: callbackUrl,
          state: stateToken,
        });
        authUrl = `https://auth.calendly.com/oauth/authorize?${qs.toString()}`;
      } else {
        return jsonResponse({ error: `1-click OAuth app credentials are not configured on server for ${provider}.` }, 400, request, env);
      }

      await env.DB.prepare(
        "INSERT INTO oauth_states (state, user_id, provider, category, expires_at) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(stateToken, user.id, provider, mapping.category, expiresAt)
        .run();

      await logUserAction(env, {
        userId: user.id,
        userEmail: user.email,
        userName: user.display_name,
        actionType: "integration_oauth_started",
        targetType: "integration",
        targetId: mapping.category,
        summary: `Started 1-click OAuth onboarding for ${provider}`,
      });

      return jsonResponse({ authUrl }, 200, request, env);
    }

    // 10. User Projects CRUD (Public / Private / Hidden + Current / Past)
    if (path === "/api/projects" && request.method === "GET") {
      const rows = await env.DB.prepare(
        `SELECT * FROM projects WHERE owner_user_id = ? ORDER BY updated_at DESC`
      )
        .bind(user.id)
        .all();
      return jsonResponse({ projects: rows.results || [] }, 200, request, env);
    }

    if (path === "/api/projects" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        name?: string;
        summary?: string;
        visibility?: Visibility;
        lifecycle?: Lifecycle;
        goldenStack?: string;
        activeMatrixWeek?: string;
        activeMatrixModel?: string;
        activeMatrixHash?: string;
      };
      if (!body.name || !body.name.trim()) {
        return jsonResponse({ error: "Project name is required" }, 400, request, env);
      }
      const visibility: Visibility = VALID_VISIBILITIES.has(body.visibility as Visibility)
        ? (body.visibility as Visibility)
        : "private";
      const lifecycle: Lifecycle = VALID_LIFECYCLES.has(body.lifecycle as Lifecycle)
        ? (body.lifecycle as Lifecycle)
        : "current";

      const id = crypto.randomUUID();
      const slug = `${slugify(body.name)}-${id.slice(0, 6)}`;
      const now = new Date().toISOString();

      await env.DB.prepare(
        `INSERT INTO projects (
          id, owner_user_id, owner_display_name, owner_avatar_url, slug, name, summary,
          status, visibility, lifecycle, golden_stack, claim_path,
          active_matrix_week, active_matrix_model, active_matrix_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'INTAKE', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id,
          user.id,
          user.display_name,
          user.avatar_url || null,
          slug,
          body.name.trim(),
          (body.summary || "").trim(),
          visibility,
          lifecycle,
          body.goldenStack || "nextjs_cloudflare",
          `/claim/${slug}`,
          body.activeMatrixWeek || "2026-W47",
          body.activeMatrixModel || "gemini-4-neon-xhigh",
          body.activeMatrixHash || null,
          now,
          now
        )
        .run();

      await logUserAction(env, {
        userId: user.id,
        userEmail: user.email,
        userName: user.display_name,
        actionType: "project_created",
        targetType: "project",
        targetId: id,
        summary: `Created project "${body.name.trim()}" (${visibility}, ${lifecycle})`,
      });

      const created = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
      return jsonResponse({ project: created }, 201, request, env);
    }

    const projectPatchMatch = path.match(/^\/api\/projects\/([a-zA-Z0-9-]+)$/);
    if (projectPatchMatch && request.method === "PATCH") {
      const projectId = projectPatchMatch[1];
      const existing = await env.DB.prepare("SELECT id, name, owner_user_id, visibility, lifecycle FROM projects WHERE id = ?")
        .bind(projectId)
        .first<{ id: string; name: string; owner_user_id: string; visibility: Visibility; lifecycle: Lifecycle }>();
      if (!existing || existing.owner_user_id !== user.id) {
        return jsonResponse({ error: "Project not found" }, 404, request, env);
      }

      const body = (await request.json().catch(() => ({}))) as {
        visibility?: Visibility;
        lifecycle?: Lifecycle;
        status?: string;
        githubRepoUrl?: string;
        cloudflareLiveUrl?: string;
        cloudflarePreviewUrl?: string;
      };

      if (body.visibility && !VALID_VISIBILITIES.has(body.visibility)) {
        return jsonResponse({ error: "Invalid visibility (must be public | private | hidden)" }, 400, request, env);
      }
      if (body.lifecycle && !VALID_LIFECYCLES.has(body.lifecycle)) {
        return jsonResponse({ error: "Invalid lifecycle (must be current | past)" }, 400, request, env);
      }

      await env.DB.prepare(
        `UPDATE projects SET
          visibility = COALESCE(?, visibility),
          lifecycle = COALESCE(?, lifecycle),
          status = COALESCE(?, status),
          github_repo_url = COALESCE(?, github_repo_url),
          cloudflare_live_url = COALESCE(?, cloudflare_live_url),
          cloudflare_preview_url = COALESCE(?, cloudflare_preview_url),
          updated_at = ?
         WHERE id = ? AND owner_user_id = ?`
      )
        .bind(
          body.visibility || null,
          body.lifecycle || null,
          body.status || null,
          body.githubRepoUrl || null,
          body.cloudflareLiveUrl || null,
          body.cloudflarePreviewUrl || null,
          new Date().toISOString(),
          projectId,
          user.id
        )
        .run();

      if (body.visibility && body.visibility !== existing.visibility) {
        await logUserAction(env, {
          userId: user.id,
          userEmail: user.email,
          userName: user.display_name,
          actionType: "project_visibility_updated",
          targetType: "project",
          targetId: projectId,
          summary: `Changed "${existing.name}" visibility: ${existing.visibility} -> ${body.visibility}`,
        });
      }
      if (body.lifecycle && body.lifecycle !== existing.lifecycle) {
        await logUserAction(env, {
          userId: user.id,
          userEmail: user.email,
          userName: user.display_name,
          actionType: "project_lifecycle_updated",
          targetType: "project",
          targetId: projectId,
          summary: `Moved "${existing.name}": ${existing.lifecycle} -> ${body.lifecycle}`,
        });
      }

      const updated = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(projectId).first();
      return jsonResponse({ project: updated }, 200, request, env);
    }

    // 11. User Integrations Dashboard API
    if (path === "/api/integrations" && request.method === "GET") {
      const rows = await env.DB.prepare(
        `SELECT category, active_provider, status, config_json, secret_configured, secret_fingerprint,
                oauth_account_label, last_tested_at, last_test_message, updated_at
         FROM user_integrations WHERE user_id = ?`
      )
        .bind(user.id)
        .all();
      return jsonResponse(
        {
          integrations: rows.results || [],
          oauthProviders: getOauthCapabilityFlags(env),
        },
        200,
        request,
        env
      );
    }

    const intMatch = path.match(/^\/api\/integrations\/([a-z_]+)$/);
    if (intMatch && request.method === "PUT") {
      const category = intMatch[1];
      if (!VALID_CATEGORIES.has(category)) {
        return jsonResponse({ error: "Unknown integration category" }, 400, request, env);
      }
      const body = (await request.json().catch(() => ({}))) as {
        activeProvider?: string;
        config?: Record<string, unknown>;
        secretValue?: string;
      };
      if (!body.activeProvider) {
        return jsonResponse({ error: "activeProvider is required" }, 400, request, env);
      }

      const now = new Date().toISOString();
      const secretTrimmed = (body.secretValue || "").trim();
      const hasSecret = secretTrimmed.length > 0;
      const fingerprint = hasSecret ? `***${secretTrimmed.slice(-4)}` : null;
      const encrypted = hasSecret && env.SESSION_SECRET
        ? await encryptSecret(secretTrimmed, env.SESSION_SECRET)
        : null;
      const autoReady = body.activeProvider === "manual_upload" || body.activeProvider === "generic_ics" || body.activeProvider === "generic_webhook" || body.activeProvider === "generic_link";
      const nextStatus = hasSecret || autoReady ? "connected" : "configured";

      await env.DB.prepare(
        `INSERT INTO user_integrations (
          id, user_id, category, active_provider, status, config_json,
          secret_configured, secret_fingerprint, encrypted_secret, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, category) DO UPDATE SET
           active_provider = excluded.active_provider,
           status = excluded.status,
           config_json = excluded.config_json,
           secret_configured = CASE WHEN excluded.secret_configured = 1 THEN 1 ELSE user_integrations.secret_configured END,
           secret_fingerprint = COALESCE(excluded.secret_fingerprint, user_integrations.secret_fingerprint),
           encrypted_secret = COALESCE(excluded.encrypted_secret, user_integrations.encrypted_secret),
           updated_at = excluded.updated_at`
      )
        .bind(
          crypto.randomUUID(),
          user.id,
          category,
          body.activeProvider,
          nextStatus,
          JSON.stringify(body.config || {}),
          hasSecret || autoReady ? 1 : 0,
          fingerprint,
          encrypted,
          now
        )
        .run();

      await logUserAction(env, {
        userId: user.id,
        userEmail: user.email,
        userName: user.display_name,
        actionType: "integration_configured",
        targetType: "integration",
        targetId: category,
        summary: `Configured ${category} using ${body.activeProvider} (${nextStatus})`,
      });

      return jsonResponse({ ok: true, category, activeProvider: body.activeProvider, status: nextStatus }, 200, request, env);
    }

    const testMatch = path.match(/^\/api\/integrations\/([a-z_]+)\/test$/);
    if (testMatch && request.method === "POST") {
      const category = testMatch[1];
      if (!VALID_CATEGORIES.has(category)) {
        return jsonResponse({ error: "Unknown integration category" }, 400, request, env);
      }
      const row = await env.DB.prepare(
        "SELECT active_provider, config_json, secret_configured, oauth_account_label FROM user_integrations WHERE user_id = ? AND category = ?"
      )
        .bind(user.id, category)
        .first<{ active_provider: string; config_json: string; secret_configured: number; oauth_account_label: string | null }>();

      const now = new Date().toISOString();
      if (!row) {
        return jsonResponse({ ok: false, status: "needs_setup", message: "Connect or save a provider first." }, 200, request, env);
      }

      const builtInNoSecret = row.active_provider === "manual_upload" || row.active_provider === "generic_ics" || row.active_provider === "generic_webhook" || row.active_provider === "generic_link";
      const ok = category === "deploy" ? Boolean(env.ARTIFACTS_BUCKET) : row.secret_configured === 1 || builtInNoSecret;
      const status = ok ? "connected" : "needs_setup";
      const message = ok
        ? `${row.active_provider} verified${row.oauth_account_label ? ` (${row.oauth_account_label})` : ""}.`
        : `Provider ${row.active_provider} needs authorization or a token to finish setup.`;

      await env.DB.prepare(
        "UPDATE user_integrations SET status = ?, last_tested_at = ?, last_test_message = ? WHERE user_id = ? AND category = ?"
      )
        .bind(status, now, message, user.id, category)
        .run();

      await logUserAction(env, {
        userId: user.id,
        userEmail: user.email,
        userName: user.display_name,
        actionType: "integration_tested",
        targetType: "integration",
        targetId: category,
        summary: `Tested ${category} (${row.active_provider}): ${status}`,
      });

      return jsonResponse({ ok, status, message, testedAt: now }, 200, request, env);
    }

    return jsonResponse({ error: "Route not found" }, 404, request, env);
  },
};
