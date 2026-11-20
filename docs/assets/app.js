(function () {
  "use strict";

  const STORAGE_KEYS = {
    backend: "c2s_backend_cfg_v1",
    session: "c2s_session_v2",
  };

  const ACTION_LABELS = {
    user_signed_up: { label: "Signed Up", tone: "cyan" },
    user_signed_in: { label: "Signed In", tone: "emerald" },
    profile_github_updated: { label: "GitHub Linked", tone: "violet" },
    project_created: { label: "Project Created", tone: "emerald" },
    project_visibility_updated: { label: "Visibility Updated", tone: "amber" },
    project_lifecycle_updated: { label: "Lifecycle Updated", tone: "violet" },
    integration_configured: { label: "Integration Saved", tone: "cyan" },
    integration_oauth_started: { label: "OAuth Started", tone: "cyan" },
    integration_oauth_connected: { label: "OAuth Connected", tone: "emerald" },
    integration_tested: { label: "Connection Tested", tone: "emerald" },
    admin_user_validated: { label: "Admin Approved", tone: "emerald" },
    admin_user_revoked: { label: "Admin Revoked", tone: "rose" },
    admin_user_reset: { label: "Reset Pending", tone: "amber" },
    admin_project_updated: { label: "Admin Moderated", tone: "violet" },
    contact_message_sent: { label: "Contact Sent", tone: "amber" },
  };

  const INTEGRATION_CATALOG = [
    {
      category: "booking",
      title: "Booking Links",
      providers: [
        {
          id: "calendly",
          label: "Calendly",
          authorizeUrl: "https://calendly.com/integrations/api_webhooks",
          actionText: "Click to Connect Calendly",
          noToken: false,
        },
        {
          id: "generic_webhook",
          label: "Built-In Booking Webhook",
          authorizeUrl: "",
          actionText: "Enable Built-In Booking",
          noToken: true,
        },
      ],
      secretLabel: "API Token or Signing Key",
      configHint: "Syncs scheduled calls and booking notes.",
      webhookPath: "/api/webhooks/booking/{provider}",
    },
    {
      category: "calendar",
      title: "Calendar",
      providers: [
        {
          id: "google_calendar",
          label: "Google Calendar",
          authorizeUrl: "https://myaccount.google.com/permissions",
          actionText: "Click to Connect Google Calendar",
          noToken: false,
        },
        {
          id: "generic_ics",
          label: "ICS Calendar Feed",
          authorizeUrl: "",
          actionText: "Enable ICS Calendar",
          noToken: true,
        },
      ],
      secretLabel: "Calendar Access Token",
      configHint: "Syncs event times and invited attendees.",
      webhookPath: "/api/webhooks/calendar/{provider}",
    },
    {
      category: "meeting",
      title: "Video Meetings",
      providers: [
        {
          id: "google_meet",
          label: "Google Meet",
          authorizeUrl: "https://myaccount.google.com/permissions",
          actionText: "Click to Connect Google Meet",
          noToken: false,
        },
        {
          id: "generic_link",
          label: "Meeting Link Check-In",
          authorizeUrl: "",
          actionText: "Enable Link Check-In",
          noToken: true,
        },
      ],
      secretLabel: "Meeting Access Token",
      configHint: "Captures everyone who joins your meeting link.",
      webhookPath: "",
    },
    {
      category: "transcript",
      title: "Call Transcripts",
      providers: [
        {
          id: "read_ai",
          label: "Read.ai",
          authorizeUrl: "https://app.read.ai/analytics/integrations/user/api",
          actionText: "Click to Get Read.ai Access",
          noToken: false,
        },
        {
          id: "google_meet_drive",
          label: "Google Meet Transcripts",
          authorizeUrl: "https://myaccount.google.com/permissions",
          actionText: "Click to Connect Google Transcripts",
          noToken: false,
        },
        {
          id: "manual_upload",
          label: "Upload Transcript (.vtt / .txt)",
          authorizeUrl: "",
          actionText: "Enable Direct Upload",
          noToken: true,
        },
      ],
      secretLabel: "Transcript API Token",
      configHint: "Pulls call transcripts to capture agreed requirements.",
      webhookPath: "/api/webhooks/transcript/{provider}",
    },
    {
      category: "repo",
      title: "Project Repositories",
      providers: [
        {
          id: "github",
          label: "GitHub",
          authorizeUrl: "https://github.com/settings/tokens/new?scopes=repo,read:user,user:email&description=Conversation-to-Ship",
          actionText: "Click to Connect GitHub",
          noToken: false,
        },
      ],
      secretLabel: "GitHub Token",
      configHint: "Creates private product repos and invites call participants.",
      webhookPath: "",
    },
    {
      category: "deploy",
      title: "Live Hosting",
      providers: [
        {
          id: "cloudflare",
          label: "Cloudflare Hosting",
          authorizeUrl: "https://dash.cloudflare.com/profile/api-tokens",
          actionText: "Click to Get Hosting Access",
          noToken: false,
        },
      ],
      secretLabel: "Hosting API Token",
      configHint: "Publishes your finished app to a live web link.",
      webhookPath: "",
    },
  ];

  const state = {
    view: "home",
    config: {
      workerApiUrl: "",
      googleClientId: "",
      repoUrl: "https://github.com/maximusmaximus/conversation-to-ship",
    },
    serverConfig: {
      googleAuthEnabled: false,
      googleClientId: null,
      oauthProviders: {},
    },
    session: null,
    publicProjects: [],
    myProjects: [],
    myActions: [],
    integrations: {},
    adminOverview: null,
    adminUsers: [],
    adminActions: [],
    adminProjects: [],
    adminContacts: [],
    expandedUserActions: {},
    publicFilter: "ALL",
    publicSearch: "",
    myFilter: "ALL",
    showHidden: false,
    adminUserFilter: "ALL",
    adminActionsUserId: "",
    adminActionsType: "",
  };

  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function showToast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => el.classList.add("hidden"), 3600);
  }

  function formatDateTime(iso) {
    if (!iso) return "—";
    return String(iso).slice(0, 19).replace("T", " ");
  }

  function actionBadge(actionType) {
    const meta = ACTION_LABELS[actionType] || { label: actionType || "action", tone: "cyan" };
    return `<span class="pill ${meta.tone}">${esc(meta.label)}</span>`;
  }

  function friendlyStatusLabel(status) {
    if (status === "DEPLOYED") return "Live";
    if (status === "BUILDING" || status === "SPEC_LOCKED" || status === "GATE_2_PENDING") return "In Progress";
    if (status === "GATE_1_PENDING" || status === "RESEARCHING") return "Scoping";
    if (status === "FAILED") return "Needs Attention";
    return "New";
  }

  function statusPillClass(status) {
    if (status === "DEPLOYED") return "emerald";
    if (status === "BUILDING" || status === "SPEC_LOCKED") return "cyan";
    if (status === "GATE_1_PENDING" || status === "GATE_2_PENDING" || status === "RESEARCHING") return "amber";
    if (status === "FAILED") return "rose";
    return "violet";
  }

  function workerBaseUrl() {
    return (state.config.workerApiUrl || "").replace(/\/+$/, "");
  }

  function activeGoogleClientId() {
    return (state.config.googleClientId || state.serverConfig.googleClientId || "").trim();
  }

  function isAuthenticated() {
    return Boolean(workerBaseUrl() && state.session && state.session.token && state.session.user);
  }

  function isAdminUser() {
    return Boolean(state.session && state.session.user && state.session.user.role === "admin");
  }

  function isValidatedUser() {
    if (!state.session || !state.session.user) return false;
    return isAdminUser() || state.session.user.approvalStatus === "approved";
  }

  function loadStoredBackend() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.backend) || "{}");
      if (saved.workerApiUrl) state.config.workerApiUrl = saved.workerApiUrl;
      if (saved.googleClientId) state.config.googleClientId = saved.googleClientId;
    } catch (_) {}
  }

  function loadStoredSession() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.session) || "null");
      if (saved && saved.token && saved.user) state.session = saved;
    } catch (_) {}
  }

  function saveSession(sessionObj) {
    state.session = sessionObj;
    if (sessionObj) {
      localStorage.setItem(STORAGE_KEYS.session, JSON.stringify(sessionObj));
    } else {
      localStorage.removeItem(STORAGE_KEYS.session);
    }
  }

  function defaultIntegrationsMap() {
    const out = {};
    INTEGRATION_CATALOG.forEach((cat) => {
      out[cat.category] = {
        category: cat.category,
        active_provider: cat.providers[0].id,
        status: "needs_setup",
        secret_configured: false,
        secret_fingerprint: "",
        oauth_account_label: "",
        last_test_message: "",
      };
    });
    return out;
  }

  async function apiFetch(path, options) {
    const base = workerBaseUrl();
    if (!base) throw new Error("Service API URL is not configured");
    const headers = Object.assign({ "Content-Type": "application/json" }, (options && options.headers) || {});
    if (state.session && state.session.token) {
      headers.Authorization = `Bearer ${state.session.token}`;
    }
    const resp = await fetch(`${base}${path}`, Object.assign({}, options, { headers }));
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  }

  async function refreshServerConfig() {
    if (!workerBaseUrl()) return;
    try {
      const data = await apiFetch("/api/public/config", { method: "GET" });
      state.serverConfig = {
        googleAuthEnabled: Boolean(data.googleAuthEnabled),
        googleClientId: data.googleClientId || null,
        oauthProviders: data.oauthProviders || {},
      };
    } catch (_) {}
  }

  async function refreshPublicProjects() {
    if (workerBaseUrl()) {
      try {
        const data = await apiFetch("/api/public/projects", { method: "GET" });
        state.publicProjects = [].concat(data.current || [], data.past || []);
        return;
      } catch (_) {}
    }

    try {
      const pubResp = await fetch("public-projects.json");
      if (pubResp.ok) {
        const pub = await pubResp.json();
        state.publicProjects = Array.isArray(pub.projects) ? pub.projects : [];
        return;
      }
    } catch (_) {}

    state.publicProjects = [];
  }

  async function hydrateAdminData() {
    if (!isAdminUser()) return;
    const params = new URLSearchParams();
    if (state.adminActionsUserId) params.set("userId", state.adminActionsUserId);
    if (state.adminActionsType) params.set("actionType", state.adminActionsType);
    const qs = params.toString() ? `?${params.toString()}` : "";

    const [overviewRes, usersRes, actionsRes, projectsRes, contactsRes] = await Promise.all([
      apiFetch("/api/admin/overview", { method: "GET" }),
      apiFetch("/api/admin/users", { method: "GET" }),
      apiFetch(`/api/admin/actions${qs}`, { method: "GET" }),
      apiFetch("/api/admin/projects", { method: "GET" }),
      apiFetch("/api/admin/contacts", { method: "GET" }),
    ]);

    state.adminOverview = overviewRes;
    state.adminUsers = usersRes.users || [];
    state.adminActions = actionsRes.actions || [];
    state.adminProjects = projectsRes.projects || [];
    state.adminContacts = contactsRes.contacts || [];
  }

  async function hydrateUserData() {
    if (!isAuthenticated()) return;
    try {
      const meData = await apiFetch("/api/me", { method: "GET" });
      if (meData.user) {
        state.session.user = meData.user;
        saveSession(state.session);
      }
      state.myActions = meData.recentActions || [];

      if (isValidatedUser()) {
        const [projData, intData] = await Promise.all([
          apiFetch("/api/projects", { method: "GET" }),
          apiFetch("/api/integrations", { method: "GET" }),
        ]);
        state.myProjects = projData.projects || [];
        const map = defaultIntegrationsMap();
        (intData.integrations || []).forEach((row) => {
          map[row.category] = Object.assign({}, map[row.category], row);
        });
        state.integrations = map;
        if (intData.oauthProviders) {
          state.serverConfig.oauthProviders = intData.oauthProviders;
        }
      } else {
        state.myProjects = [];
        state.integrations = defaultIntegrationsMap();
      }

      if (isAdminUser()) {
        await hydrateAdminData();
      } else {
        state.adminOverview = null;
        state.adminUsers = [];
        state.adminActions = [];
        state.adminProjects = [];
        state.adminContacts = [];
      }
    } catch (err) {
      if (String(err.message).toLowerCase().includes("authentication")) {
        signOut();
      } else {
        showToast(`Account sync notice: ${err.message}`);
      }
    }
  }

  async function initConfigAndData() {
    try {
      const cfgResp = await fetch("config.json");
      if (cfgResp.ok) {
        const cfg = await cfgResp.json();
        Object.assign(state.config, cfg);
      }
    } catch (_) {}

    loadStoredBackend();
    loadStoredSession();

    await Promise.all([refreshServerConfig(), refreshPublicProjects()]);
    if (isAuthenticated()) {
      await hydrateUserData();
    } else {
      saveSession(null);
    }

    const urlParams = new URLSearchParams(window.location.search);
    const oauthConnected = urlParams.get("oauth_connected");
    const oauthError = urlParams.get("oauth_error");
    if (oauthConnected) {
      showToast(`Connected ${oauthConnected} via 1-click OAuth!`);
      state.view = "integrations";
      window.history.replaceState({}, "", `${window.location.pathname}#integrations`);
    } else if (oauthError) {
      showToast(`OAuth notice: ${oauthError}`);
      state.view = "integrations";
      window.history.replaceState({}, "", `${window.location.pathname}#integrations`);
    } else if (window.location.hash === "#integrations" && isAuthenticated()) {
      state.view = "integrations";
    } else if (window.location.hash === "#admin" && isAdminUser()) {
      state.view = "admin";
    }

    setView(state.view);
  }

  function setView(viewName) {
    if (viewName === "admin" && !isAdminUser()) {
      viewName = isAuthenticated() ? "dashboard" : "home";
    }
    state.view = viewName;
    document.querySelectorAll(".nav-btn[data-view]").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-view") === viewName);
    });
    document.getElementById("view-home").classList.toggle("hidden", viewName !== "home");
    document.getElementById("view-dashboard").classList.toggle("hidden", viewName !== "dashboard");
    document.getElementById("view-integrations").classList.toggle("hidden", viewName !== "integrations");
    document.getElementById("view-admin").classList.toggle("hidden", viewName !== "admin");
    renderAll();
  }

  function openAuthModal() {
    document.getElementById("cfg-worker-url").value = state.config.workerApiUrl || "";
    document.getElementById("cfg-google-client-id").value = state.config.googleClientId || state.serverConfig.googleClientId || "";
    document.getElementById("auth-modal").classList.remove("hidden");
    renderGoogleButton();
  }

  function closeAuthModal() {
    document.getElementById("auth-modal").classList.add("hidden");
  }

  function renderGoogleButton() {
    const slot = document.getElementById("google-signin-button");
    const note = document.getElementById("google-not-configured-note");
    const clientId = activeGoogleClientId();
    const hasWorker = Boolean(workerBaseUrl());

    slot.innerHTML = "";
    if (clientId && hasWorker && window.google && window.google.accounts && window.google.accounts.id) {
      note.classList.add("hidden");
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: handleGoogleCredentialResponse,
      });
      window.google.accounts.id.renderButton(slot, {
        theme: "filled_black",
        size: "large",
        shape: "pill",
        text: "continue_with",
        width: 320,
      });
    } else {
      note.classList.remove("hidden");
      note.innerHTML = !hasWorker
        ? "Service API URL is not connected yet. Add your live Worker URL under <strong>Service Connection Overrides</strong> below."
        : "Google Sign-In Client ID is not configured on the live server yet. Once <code>GOOGLE_CLIENT_ID</code> is set on the Worker (or saved below), the Google Sign-In button activates automatically.";
    }
  }

  async function handleGoogleCredentialResponse(response) {
    try {
      const data = await apiFetch("/api/auth/google", {
        method: "POST",
        body: JSON.stringify({ idToken: response.credential }),
      });
      saveSession({
        token: data.token,
        user: data.user,
      });
      closeAuthModal();
      await Promise.all([hydrateUserData(), refreshPublicProjects()]);
      setView(data.user.role === "admin" ? "admin" : "dashboard");
      showToast(
        data.user.role === "admin"
          ? `Welcome back, Admin (${data.user.displayName})`
          : data.user.approvalStatus === "approved"
          ? `Signed in as ${data.user.displayName}`
          : "Google account authenticated — awaiting admin validation"
      );
    } catch (err) {
      showToast(`Google sign-in failed: ${err.message}`);
    }
  }

  function signOut() {
    saveSession(null);
    state.myProjects = [];
    state.myActions = [];
    state.adminOverview = null;
    state.adminUsers = [];
    state.adminActions = [];
    state.adminProjects = [];
    state.adminContacts = [];
    state.integrations = defaultIntegrationsMap();
    if (state.view === "admin") state.view = "home";
    renderAll();
    showToast("Signed out");
  }

  function renderAuthNav() {
    const adminBtn = document.getElementById("nav-admin");
    adminBtn.classList.toggle("hidden", !isAdminUser());

    const slot = document.getElementById("auth-nav-slot");
    if (!isAuthenticated()) {
      slot.innerHTML = `<button class="nav-btn cta" id="nav-connect-btn">Connect Account to Start Integrations</button>`;
      document.getElementById("nav-connect-btn").addEventListener("click", openAuthModal);
      return;
    }

    const u = state.session.user;
    const initials = esc((u.displayName || "U").slice(0, 2).toUpperCase());
    const avatarHtml = u.avatarUrl ? `<img src="${esc(u.avatarUrl)}" alt="${esc(u.displayName)}" />` : initials;
    const badgeLabel = isAdminUser()
      ? "Admin"
      : u.approvalStatus === "approved"
      ? "Verified"
      : u.approvalStatus === "rejected"
      ? "Revoked"
      : "Pending";
    const badgeTone = isAdminUser()
      ? "violet"
      : u.approvalStatus === "approved"
      ? "emerald"
      : u.approvalStatus === "rejected"
      ? "rose"
      : "amber";

    slot.innerHTML = `
      <div class="user-chip">
        <div class="avatar">${avatarHtml}</div>
        <span>${esc(u.displayName)}</span>
        <span class="pill ${badgeTone}" style="padding:2px 7px;">${badgeLabel}</span>
        <button class="btn-secondary btn-sm" id="nav-signout-btn">Sign Out</button>
      </div>
    `;
    document.getElementById("nav-signout-btn").addEventListener("click", signOut);
  }

  function renderPublicProjectCard(p) {
    const liveHref = p.cloudflare_live_url || p.cloudflare_preview_url || "";
    const claimHref = p.claim_path && workerBaseUrl() ? `${workerBaseUrl()}${p.claim_path}` : "";

    return `
      <article class="card">
        <div class="card-head">
          <div>
            <h4 class="card-title">${esc(p.name)}</h4>
            <div class="meta-row" style="margin-top:4px;">
              <span>by <strong>${esc(p.owner_display_name || "Creator")}</strong></span>
              <span>·</span>
              <span>${Number(p.participant_count || 1)} participant(s)</span>
            </div>
          </div>
          <span class="pill ${statusPillClass(p.status)}">${esc(friendlyStatusLabel(p.status))}</span>
        </div>

        <p class="card-desc">${esc(p.summary || "Built from a team conversation.")}</p>

        <div class="link-row">
          ${liveHref ? `<a class="btn-secondary btn-sm" href="${esc(liveHref)}" target="_blank" rel="noopener">Open Live App</a>` : `<span class="pill">In Progress</span>`}
          ${p.github_repo_url ? `<a class="btn-secondary btn-sm" href="${esc(p.github_repo_url)}" target="_blank" rel="noopener">Project Repo</a>` : ""}
          ${claimHref ? `<button class="btn-secondary btn-sm" data-copy-claim="${esc(claimHref)}">Copy Join Link</button>` : ""}
        </div>
      </article>
    `;
  }

  function renderPublicShowcase() {
    const q = state.publicSearch.trim().toLowerCase();
    const filter = state.publicFilter;
    const allPublic = state.publicProjects
      .filter((p) => p && p.visibility === "public")
      .filter((p) => {
        if (filter !== "ALL" && p.status !== filter) return false;
        if (q) {
          const hay = `${p.name} ${p.summary || ""} ${p.owner_display_name || ""}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));

    const current = allPublic.filter((p) => p.lifecycle !== "past");
    const past = allPublic.filter((p) => p.lifecycle === "past");

    document.getElementById("current-public-count").textContent = String(current.length);
    document.getElementById("past-public-count").textContent = String(past.length);

    const curGrid = document.getElementById("current-public-grid");
    const pastGrid = document.getElementById("past-public-grid");

    curGrid.innerHTML = current.length
      ? current.map(renderPublicProjectCard).join("")
      : `<div class="empty-state">No current public projects have been published yet.</div>`;

    pastGrid.innerHTML = past.length
      ? past.map(renderPublicProjectCard).join("")
      : `<div class="empty-state">No past public projects have been published yet.</div>`;

    bindClaimCopyButtons(curGrid);
    bindClaimCopyButtons(pastGrid);
  }

  function bindClaimCopyButtons(container) {
    container.querySelectorAll("[data-copy-claim]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const val = btn.getAttribute("data-copy-claim");
        if (navigator.clipboard) navigator.clipboard.writeText(val).catch(() => {});
        showToast(`Copied link: ${val}`);
      });
    });
  }

  async function validateUserAccount(userId, approvalStatus) {
    try {
      await apiFetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ approvalStatus }),
      });
      await hydrateAdminData();
      renderAdminConsole();
      showToast(`User marked ${approvalStatus}`);
    } catch (err) {
      showToast(`Validation failed: ${err.message}`);
    }
  }

  async function updateProjectField(projectId, patch, adminScope = false) {
    try {
      const endpoint = adminScope ? `/api/admin/projects/${projectId}` : `/api/projects/${projectId}`;
      const data = await apiFetch(endpoint, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (!adminScope) {
        state.myProjects = state.myProjects.map((p) => (p.id === projectId ? data.project : p));
      }
      await Promise.all([
        refreshPublicProjects(),
        isAdminUser() ? hydrateAdminData() : Promise.resolve(),
      ]);
      renderAll();
      showToast("Project updated");
    } catch (err) {
      showToast(`Update failed: ${err.message}`);
    }
  }

  function renderDashboard() {
    const loggedOut = document.getElementById("dash-logged-out");
    const loggedIn = document.getElementById("dash-logged-in");
    if (!isAuthenticated()) {
      loggedOut.classList.remove("hidden");
      loggedIn.classList.add("hidden");
      return;
    }

    loggedOut.classList.add("hidden");
    loggedIn.classList.remove("hidden");

    const u = state.session.user;
    const initials = esc((u.displayName || "U").slice(0, 2).toUpperCase());
    const avatarHtml = u.avatarUrl ? `<img src="${esc(u.avatarUrl)}" alt="${esc(u.displayName)}" />` : initials;
    const approvalTone = isAdminUser()
      ? "violet"
      : u.approvalStatus === "approved"
      ? "emerald"
      : u.approvalStatus === "rejected"
      ? "rose"
      : "amber";
    const approvalText = isAdminUser()
      ? "Administrator"
      : u.approvalStatus === "approved"
      ? "Verified User"
      : u.approvalStatus === "rejected"
      ? "Access Revoked"
      : "Pending Admin Validation";

    document.getElementById("user-profile-banner").innerHTML = `
      <div class="profile-left">
        <div class="profile-avatar">${avatarHtml}</div>
        <div>
          <h3 style="margin:0 0 3px;">${esc(u.displayName)}</h3>
          <div class="meta-row">
            <span>${esc(u.email)}</span>
            <span>·</span>
            <span class="pill emerald">Google Verified</span>
            <span class="pill ${approvalTone}">${approvalText}</span>
          </div>
        </div>
      </div>
      <div class="controls">
        <input class="input" id="gh-handle-input" value="${esc(u.githubUsername || "")}" placeholder="GitHub username" aria-label="GitHub username" style="width:170px;" />
        <button class="btn-secondary btn-sm" id="save-gh-handle-btn">Save GitHub Handle</button>
        ${isValidatedUser() ? `<button class="btn-secondary btn-sm" id="dash-to-integrations-btn">Integrations</button>` : ""}
        ${isAdminUser() ? `<button class="btn-primary btn-sm" id="dash-to-admin-btn">Open Admin Console</button>` : ""}
      </div>
    `;

    document.getElementById("save-gh-handle-btn").addEventListener("click", async () => {
      const val = document.getElementById("gh-handle-input").value.trim();
      try {
        await apiFetch("/api/me", { method: "PATCH", body: JSON.stringify({ githubUsername: val }) });
        state.session.user.githubUsername = val;
        saveSession(state.session);
        await hydrateUserData();
        renderDashboard();
        showToast("GitHub handle saved");
      } catch (err) {
        showToast(`Failed to save handle: ${err.message}`);
      }
    });

    const toIntBtn = document.getElementById("dash-to-integrations-btn");
    if (toIntBtn) toIntBtn.addEventListener("click", () => setView("integrations"));
    const toAdminBtn = document.getElementById("dash-to-admin-btn");
    if (toAdminBtn) toAdminBtn.addEventListener("click", () => setView("admin"));

    const adminBanner = document.getElementById("admin-quick-banner");
    if (isAdminUser() && state.adminOverview) {
      const pending = Number((state.adminOverview.users && state.adminOverview.users.pending) || 0);
      adminBanner.classList.remove("hidden");
      adminBanner.innerHTML = `<strong>Admin Mode Active:</strong> ${pending} account(s) awaiting validation · <a href="#" id="quick-open-admin-link">Open Admin Console</a> for full stats, user actions, and account management.`;
      document.getElementById("quick-open-admin-link").addEventListener("click", (e) => {
        e.preventDefault();
        setView("admin");
      });
    } else {
      adminBanner.classList.add("hidden");
    }

    const pendingGate = document.getElementById("user-pending-gate");
    const workspace = document.getElementById("validated-user-workspace");

    if (!isValidatedUser()) {
      workspace.classList.add("hidden");
      pendingGate.classList.remove("hidden");
      pendingGate.innerHTML =
        u.approvalStatus === "rejected"
          ? `<strong>Account Access Revoked:</strong> Use the Contact form if you believe this was a mistake.`
          : `<strong>Awaiting Admin Validation (Alpha):</strong> Your Google account (<code>${esc(u.email)}</code>) is signed in and queued for admin verification. Once approved, project creation and integrations will unlock automatically.`;
      return;
    }

    pendingGate.classList.add("hidden");
    workspace.classList.remove("hidden");

    const pubCount = state.myProjects.filter((p) => p.visibility === "public").length;
    const privCount = state.myProjects.filter((p) => p.visibility === "private").length;
    const hidCount = state.myProjects.filter((p) => p.visibility === "hidden").length;
    const intConnected = Object.values(state.integrations).filter((i) => i.status === "connected" || i.status === "configured").length;

    document.getElementById("hidden-count-label").textContent = String(hidCount);
    document.getElementById("user-kpi-grid").innerHTML = `
      <div class="kpi"><div class="kpi-label">My Projects</div><div class="kpi-value">${state.myProjects.length}</div><div class="kpi-sub">Total tracked</div></div>
      <div class="kpi"><div class="kpi-label">Public</div><div class="kpi-value" style="color:var(--emerald);">${pubCount}</div><div class="kpi-sub">On Home Page</div></div>
      <div class="kpi"><div class="kpi-label">Private</div><div class="kpi-value" style="color:var(--cyan);">${privCount}</div><div class="kpi-sub">Invitees only</div></div>
      <div class="kpi"><div class="kpi-label">Hidden</div><div class="kpi-value" style="color:var(--amber);">${hidCount}</div><div class="kpi-sub">Tucked away</div></div>
      <div class="kpi"><div class="kpi-label">Integrations</div><div class="kpi-value">${intConnected}/${INTEGRATION_CATALOG.length}</div><div class="kpi-sub">Configured</div></div>
    `;

    const visibleProjects = state.myProjects.filter((p) => {
      if (!state.showHidden && p.visibility === "hidden") return false;
      if (state.myFilter !== "ALL" && p.visibility !== state.myFilter) return false;
      return true;
    });

    const grid = document.getElementById("my-projects-grid");
    grid.innerHTML = visibleProjects.length
      ? visibleProjects
          .map((p) => {
            const claimUrl = p.claim_path && workerBaseUrl() ? `${workerBaseUrl()}${p.claim_path}` : "";
            const appUrl = p.cloudflare_live_url || p.cloudflare_preview_url || "";

            return `
              <article class="card">
                <div class="card-head">
                  <div>
                    <h4 class="card-title">${esc(p.name)}</h4>
                    <div class="meta-row" style="margin-top:4px;"><code>${esc(p.slug)}</code></div>
                  </div>
                  <span class="pill ${statusPillClass(p.status)}">${esc(friendlyStatusLabel(p.status))}</span>
                </div>

                <p class="card-desc">${esc(p.summary || "Project workspace.")}</p>

                <div class="meta-row" style="justify-content:space-between;">
                  <div>
                    <span style="font-size:11px;display:block;margin-bottom:4px;">Visibility</span>
                    <div class="segmented" role="group" aria-label="Project Visibility">
                      <button class="seg-btn ${p.visibility === "public" ? "active-public" : ""}" data-vis-id="${esc(p.id)}" data-vis="public">Public</button>
                      <button class="seg-btn ${p.visibility === "private" ? "active-private" : ""}" data-vis-id="${esc(p.id)}" data-vis="private">Private</button>
                      <button class="seg-btn ${p.visibility === "hidden" ? "active-hidden" : ""}" data-vis-id="${esc(p.id)}" data-vis="hidden">Hide</button>
                    </div>
                  </div>
                  <div>
                    <span style="font-size:11px;display:block;margin-bottom:4px;">Home Feed</span>
                    <div class="segmented" role="group" aria-label="Project Lifecycle">
                      <button class="seg-btn ${p.lifecycle !== "past" ? "active-current" : ""}" data-life-id="${esc(p.id)}" data-life="current">Current</button>
                      <button class="seg-btn ${p.lifecycle === "past" ? "active-past" : ""}" data-life-id="${esc(p.id)}" data-life="past">Past</button>
                    </div>
                  </div>
                </div>

                <div class="link-row">
                  ${appUrl ? `<a class="btn-secondary btn-sm" href="${esc(appUrl)}" target="_blank" rel="noopener">Open App URL</a>` : `<span class="pill">URL Pending</span>`}
                  ${p.github_repo_url ? `<a class="btn-secondary btn-sm" href="${esc(p.github_repo_url)}" target="_blank" rel="noopener">Project Repo</a>` : ""}
                  ${claimUrl ? `<button class="btn-secondary btn-sm" data-copy-claim="${esc(claimUrl)}">Copy Invite Link</button>` : ""}
                </div>
              </article>
            `;
          })
          .join("")
      : `<div class="empty-state">No projects yet. Start a new project above.</div>`;

    grid.querySelectorAll("[data-vis-id]").forEach((btn) => {
      btn.addEventListener("click", () => updateProjectField(btn.getAttribute("data-vis-id"), { visibility: btn.getAttribute("data-vis") }));
    });
    grid.querySelectorAll("[data-life-id]").forEach((btn) => {
      btn.addEventListener("click", () => updateProjectField(btn.getAttribute("data-life-id"), { lifecycle: btn.getAttribute("data-life") }));
    });
    bindClaimCopyButtons(grid);

    const myActBox = document.getElementById("my-recent-actions");
    myActBox.innerHTML = state.myActions.length
      ? state.myActions
          .map(
            (a) => `
              <div class="action-item">
                <span class="action-time">${esc(formatDateTime(a.created_at))}</span>
                <span>${actionBadge(a.action_type)}</span>
                <span>${esc(a.summary)}</span>
              </div>
            `
          )
          .join("")
      : `<div class="section-sub">No recent actions recorded yet.</div>`;
  }

  function renderIntegrations() {
    const loggedOut = document.getElementById("int-logged-out");
    const pendingGate = document.getElementById("int-pending-gate");
    const loggedIn = document.getElementById("int-logged-in");

    if (!isAuthenticated()) {
      loggedOut.classList.remove("hidden");
      pendingGate.classList.add("hidden");
      loggedIn.classList.add("hidden");
      return;
    }

    loggedOut.classList.add("hidden");
    if (!isValidatedUser()) {
      pendingGate.classList.remove("hidden");
      pendingGate.innerHTML = `<strong>Pending Admin Validation:</strong> Your Google account must be verified by an administrator before configuring integrations.`;
      loggedIn.classList.add("hidden");
      return;
    }

    pendingGate.classList.add("hidden");
    loggedIn.classList.remove("hidden");

    const connectedCount = INTEGRATION_CATALOG.filter((cat) => {
      const st = state.integrations[cat.category];
      return st && st.status === "connected";
    }).length;
    const pct = Math.round((connectedCount / INTEGRATION_CATALOG.length) * 100);

    document.getElementById("onboarding-progress-panel").innerHTML = `
      <div class="section-head" style="margin-bottom:4px;">
        <div>
          <h3 style="margin:0;">Integration Onboarding Progress</h3>
          <div class="section-sub">${connectedCount} of ${INTEGRATION_CATALOG.length} integrations connected — click any button below to authorize with minimal pasting.</div>
        </div>
        <span class="pill emerald">${pct}% Ready</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    `;

    const base = workerBaseUrl();
    const oauthFlags = state.serverConfig.oauthProviders || {};
    const grid = document.getElementById("integrations-grid");

    grid.innerHTML = INTEGRATION_CATALOG.map((cat) => {
      const current = state.integrations[cat.category] || {
        active_provider: cat.providers[0].id,
        status: "needs_setup",
        secret_configured: false,
        secret_fingerprint: "",
        oauth_account_label: "",
        last_test_message: "",
      };

      const selectedProv =
        cat.providers.find((p) => p.id === current.active_provider) || cat.providers[0];
      const oauthReady = Boolean(oauthFlags[selectedProv.id]);
      const statusTone =
        current.status === "connected"
          ? "emerald"
          : current.status === "configured"
          ? "cyan"
          : "amber";

      const webhookUrl =
        cat.webhookPath && base
          ? `${base}${cat.webhookPath.replace("{provider}", selectedProv.id)}`
          : "";

      const optionsHtml = cat.providers
        .map(
          (pr) =>
            `<option value="${esc(pr.id)}" ${pr.id === selectedProv.id ? "selected" : ""}>${esc(pr.label)}</option>`
        )
        .join("");

      const primaryBtn = selectedProv.noToken
        ? `<button class="btn-primary btn-sm" data-enable-builtin="${esc(cat.category)}">${esc(selectedProv.actionText)}</button>`
        : oauthReady
        ? `<button class="btn-primary btn-sm" data-oauth-connect="${esc(selectedProv.id)}">${esc(selectedProv.actionText)} (1-Click)</button>`
        : `<a class="btn-primary btn-sm" href="${esc(selectedProv.authorizeUrl)}" target="_blank" rel="noopener" data-open-auth-cat="${esc(cat.category)}">${esc(selectedProv.actionText)} &rarr;</a>`;

      return `
        <article class="card" data-int-card="${esc(cat.category)}">
          <div class="card-head">
            <div>
              <h4 class="card-title">${esc(cat.title)}</h4>
              <div class="section-sub">${esc(cat.configHint)}</div>
            </div>
            <span class="pill ${statusTone}">${esc(current.status)}</span>
          </div>

          <div class="field">
            <label for="prov-${esc(cat.category)}">Provider</label>
            <select class="select" id="prov-${esc(cat.category)}" data-prov-select="${esc(cat.category)}">${optionsHtml}</select>
          </div>

          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
            ${primaryBtn}
            <button class="btn-secondary btn-sm" data-test-int="${esc(cat.category)}">Verify</button>
            ${current.oauth_account_label ? `<span class="pill emerald">${esc(current.oauth_account_label)}</span>` : ""}
          </div>

          ${webhookUrl ? `
            <div class="field">
              <label>Webhook URL</label>
              <div style="display:flex;gap:6px;align-items:center;">
                <div class="webhook-box" style="flex:1;">${esc(webhookUrl)}</div>
                <button class="btn-secondary btn-sm" data-copy-claim="${esc(webhookUrl)}">Copy</button>
              </div>
            </div>
          ` : ""}

          ${!selectedProv.noToken ? `
            <details class="token-fallback" ${current.status !== "connected" && !oauthReady ? "open" : ""}>
              <summary>${current.secret_configured ? `Token saved (${esc(current.secret_fingerprint)})` : "Or finish with token"}</summary>
              <div style="display:flex;gap:6px;margin-top:8px;">
                <input type="password" class="input" style="flex:1;" id="sec-${esc(cat.category)}" placeholder="Paste ${esc(cat.secretLabel)}" />
                <button class="btn-secondary btn-sm" data-save-int="${esc(cat.category)}">Save</button>
              </div>
            </details>
          ` : ""}

          ${current.last_test_message ? `<div class="section-sub">${esc(current.last_test_message)}</div>` : ""}
        </article>
      `;
    }).join("");

    grid.querySelectorAll("[data-prov-select]").forEach((sel) => {
      sel.addEventListener("change", () => {
        const cat = sel.getAttribute("data-prov-select");
        if (!state.integrations[cat]) state.integrations[cat] = {};
        state.integrations[cat].active_provider = sel.value;
        renderIntegrations();
      });
    });

    grid.querySelectorAll("[data-oauth-connect]").forEach((btn) => {
      btn.addEventListener("click", () => startOAuthConnect(btn.getAttribute("data-oauth-connect")));
    });
    grid.querySelectorAll("[data-enable-builtin]").forEach((btn) => {
      btn.addEventListener("click", () => saveIntegration(btn.getAttribute("data-enable-builtin"), true));
    });
    grid.querySelectorAll("[data-save-int]").forEach((btn) => {
      btn.addEventListener("click", () => saveIntegration(btn.getAttribute("data-save-int"), false));
    });
    grid.querySelectorAll("[data-test-int]").forEach((btn) => {
      btn.addEventListener("click", () => testIntegration(btn.getAttribute("data-test-int")));
    });
    bindClaimCopyButtons(grid);
  }

  async function startOAuthConnect(provider) {
    try {
      const data = await apiFetch(`/api/oauth/${provider}/init`, { method: "POST", body: "{}" });
      if (data.authUrl) {
        window.location.href = data.authUrl;
      }
    } catch (err) {
      showToast(`OAuth start failed: ${err.message}`);
    }
  }

  async function saveIntegration(category, noToken) {
    const provider = document.getElementById(`prov-${category}`).value;
    const secInput = document.getElementById(`sec-${category}`);
    const secretVal = !noToken && secInput ? secInput.value.trim() : "";

    try {
      await apiFetch(`/api/integrations/${category}`, {
        method: "PUT",
        body: JSON.stringify({
          activeProvider: provider,
          config: {},
          secretValue: secretVal || undefined,
        }),
      });
      await hydrateUserData();
      renderIntegrations();
      showToast(`Saved ${category} -> ${provider}`);
    } catch (err) {
      showToast(`Save failed: ${err.message}`);
    }
  }

  async function testIntegration(category) {
    try {
      const res = await apiFetch(`/api/integrations/${category}/test`, { method: "POST" });
      await hydrateUserData();
      renderIntegrations();
      showToast(res.message || `Status: ${res.status}`);
    } catch (err) {
      showToast(`Verify error: ${err.message}`);
    }
  }

  function renderAdminConsole() {
    const denied = document.getElementById("admin-access-denied");
    const consoleEl = document.getElementById("admin-console");
    if (!isAdminUser()) {
      denied.classList.remove("hidden");
      consoleEl.classList.add("hidden");
      return;
    }

    denied.classList.add("hidden");
    consoleEl.classList.remove("hidden");

    const ov = state.adminOverview || {};
    const uStats = ov.users || {};
    const pStats = ov.projects || {};
    const iStats = ov.integrations || {};
    const cStats = ov.contacts || {};
    const aStats = ov.actions || {};

    document.getElementById("admin-stats-grid").innerHTML = `
      <div class="kpi"><div class="kpi-label">Signed-Up Users</div><div class="kpi-value">${Number(uStats.total || 0)}</div><div class="kpi-sub">${Number(uStats.pending || 0)} pending · ${Number(uStats.approved || 0)} approved</div></div>
      <div class="kpi"><div class="kpi-label">Projects</div><div class="kpi-value">${Number(pStats.total || 0)}</div><div class="kpi-sub">${Number(pStats.public_count || 0)} public · ${Number(pStats.private_count || 0)} private · ${Number(pStats.hidden_count || 0)} hidden</div></div>
      <div class="kpi"><div class="kpi-label">Integrations</div><div class="kpi-value">${Number(iStats.connected_count || 0)}</div><div class="kpi-sub">${Number(iStats.configured_count || 0)} total configured</div></div>
      <div class="kpi"><div class="kpi-label">User Actions</div><div class="kpi-value" style="color:var(--cyan);">${Number(aStats.last_24h || 0)}</div><div class="kpi-sub">last 24h (${Number(aStats.total || 0)} total)</div></div>
      <div class="kpi"><div class="kpi-label">Contact Messages</div><div class="kpi-value" style="color:var(--amber);">${Number(cStats.new_count || 0)}</div><div class="kpi-sub">new (${Number(cStats.total || 0)} total)</div></div>
    `;

    // Accounts + Inline User Actions
    const filteredUsers = state.adminUsers.filter((u) => {
      if (state.adminUserFilter === "ALL") return true;
      return u.approval_status === state.adminUserFilter;
    });

    const usersList = document.getElementById("admin-users-list");
    usersList.innerHTML = filteredUsers.length
      ? filteredUsers
          .map((u) => {
            const isAdminRow = u.role === "admin";
            const statusTone =
              u.approval_status === "approved"
                ? "emerald"
                : u.approval_status === "rejected"
                ? "rose"
                : "amber";
            const recent = Array.isArray(u.recent_actions) ? u.recent_actions : [];
            const expanded = Boolean(state.expandedUserActions[u.id]);
            const shownActions = expanded ? recent : recent.slice(0, 3);

            return `
              <div class="user-account-card">
                <div class="user-account-top">
                  <div>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                      <strong>${esc(u.display_name || "User")}</strong>
                      <code>${esc(u.email)}</code>
                      <span class="pill ${statusTone}">${esc(u.approval_status)}</span>
                      ${isAdminRow ? `<span class="pill violet">Admin</span>` : ""}
                      ${u.github_username ? `<span class="pill">@${esc(u.github_username)}</span>` : ""}
                    </div>
                    <div class="meta-row" style="margin-top:5px;">
                      <span>Joined: ${esc(formatDateTime(u.created_at))}</span>
                      <span>·</span>
                      <span>Last login: ${esc(formatDateTime(u.last_login_at))}</span>
                      <span>·</span>
                      <span>${Number(u.project_count || 0)} project(s)</span>
                      <span>·</span>
                      <span>${Number(u.integration_count || 0)} integration(s)</span>
                    </div>
                  </div>
                  <div class="controls">
                    ${
                      isAdminRow
                        ? `<span class="pill violet">Primary Admin</span>`
                        : `
                          ${u.approval_status !== "approved" ? `<button class="btn-primary btn-sm" data-admin-approve="${esc(u.id)}">Verify &amp; Approve</button>` : ""}
                          ${u.approval_status !== "rejected" ? `<button class="btn-secondary btn-sm" data-admin-reject="${esc(u.id)}">Revoke</button>` : ""}
                          ${u.approval_status !== "pending" ? `<button class="btn-secondary btn-sm" data-admin-pending="${esc(u.id)}">Set Pending</button>` : ""}
                        `
                    }
                  </div>
                </div>

                <div class="inline-actions-box">
                  <div class="inline-actions-title">
                    <span>Inline User Actions (${Number(u.action_count || recent.length)})</span>
                    ${recent.length > 3 ? `<button class="btn-secondary btn-sm" data-toggle-user-actions="${esc(u.id)}">${expanded ? "Show Fewer" : `Show All (${recent.length})`}</button>` : ""}
                  </div>
                  <div class="action-timeline">
                    ${
                      shownActions.length
                        ? shownActions
                            .map(
                              (a) => `
                                <div class="action-item">
                                  <span class="action-time">${esc(formatDateTime(a.created_at))}</span>
                                  <span>${actionBadge(a.action_type)}</span>
                                  <span>${esc(a.summary)}</span>
                                </div>
                              `
                            )
                            .join("")
                        : `<div class="section-sub">No logged actions yet for this user.</div>`
                    }
                  </div>
                </div>
              </div>
            `;
          })
          .join("")
      : `<div class="empty-state">No user accounts match this filter.</div>`;

    usersList.querySelectorAll("[data-admin-approve]").forEach((btn) => {
      btn.addEventListener("click", () => validateUserAccount(btn.getAttribute("data-admin-approve"), "approved"));
    });
    usersList.querySelectorAll("[data-admin-reject]").forEach((btn) => {
      btn.addEventListener("click", () => validateUserAccount(btn.getAttribute("data-admin-reject"), "rejected"));
    });
    usersList.querySelectorAll("[data-admin-pending]").forEach((btn) => {
      btn.addEventListener("click", () => validateUserAccount(btn.getAttribute("data-admin-pending"), "pending"));
    });
    usersList.querySelectorAll("[data-toggle-user-actions]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const uid = btn.getAttribute("data-toggle-user-actions");
        state.expandedUserActions[uid] = !state.expandedUserActions[uid];
        renderAdminConsole();
      });
    });

    // Populate user dropdown for global action stream
    const userSelect = document.getElementById("admin-actions-user-filter");
    const prevSelected = state.adminActionsUserId;
    userSelect.innerHTML = `<option value="">All Users</option>` +
      state.adminUsers
        .map((u) => `<option value="${esc(u.id)}" ${u.id === prevSelected ? "selected" : ""}>${esc(u.display_name || u.email)} (${esc(u.email)})</option>`)
        .join("");

    // Global User Actions table
    const actionsBody = document.getElementById("admin-actions-tbody");
    actionsBody.innerHTML = state.adminActions.length
      ? state.adminActions
          .map(
            (a) => `
              <tr>
                <td class="action-time">${esc(formatDateTime(a.created_at))}</td>
                <td><strong>${esc(a.user_name || "Visitor")}</strong><br /><code>${esc(a.user_email || "")}</code></td>
                <td>${actionBadge(a.action_type)}</td>
                <td><code>${esc(a.target_type || "—")}</code></td>
                <td>${esc(a.summary)}</td>
              </tr>
            `
          )
          .join("")
      : `<tr><td colspan="5">No actions match the selected filter.</td></tr>`;

    // All Projects table
    const projBody = document.getElementById("admin-projects-tbody");
    projBody.innerHTML = state.adminProjects.length
      ? state.adminProjects
          .map(
            (p) => `
              <tr>
                <td><strong>${esc(p.name)}</strong><br /><code>${esc(p.slug)}</code></td>
                <td>${esc(p.owner_display_name || "")}<br /><code>${esc(p.owner_email || "")}</code></td>
                <td><span class="pill ${statusPillClass(p.status)}">${esc(friendlyStatusLabel(p.status))}</span></td>
                <td>
                  <div class="segmented">
                    <button class="seg-btn ${p.visibility === "public" ? "active-public" : ""}" data-adm-vis-id="${esc(p.id)}" data-adm-vis="public">Public</button>
                    <button class="seg-btn ${p.visibility === "private" ? "active-private" : ""}" data-adm-vis-id="${esc(p.id)}" data-adm-vis="private">Private</button>
                    <button class="seg-btn ${p.visibility === "hidden" ? "active-hidden" : ""}" data-adm-vis-id="${esc(p.id)}" data-adm-vis="hidden">Hide</button>
                  </div>
                </td>
                <td>
                  <div class="segmented">
                    <button class="seg-btn ${p.lifecycle !== "past" ? "active-current" : ""}" data-adm-life-id="${esc(p.id)}" data-adm-life="current">Current</button>
                    <button class="seg-btn ${p.lifecycle === "past" ? "active-past" : ""}" data-adm-life-id="${esc(p.id)}" data-adm-life="past">Past</button>
                  </div>
                </td>
              </tr>
            `
          )
          .join("")
      : `<tr><td colspan="5">No projects created yet.</td></tr>`;

    projBody.querySelectorAll("[data-adm-vis-id]").forEach((btn) => {
      btn.addEventListener("click", () => updateProjectField(btn.getAttribute("data-adm-vis-id"), { visibility: btn.getAttribute("data-adm-vis") }, true));
    });
    projBody.querySelectorAll("[data-adm-life-id]").forEach((btn) => {
      btn.addEventListener("click", () => updateProjectField(btn.getAttribute("data-adm-life-id"), { lifecycle: btn.getAttribute("data-adm-life") }, true));
    });

    // Contacts table
    const contactsBody = document.getElementById("admin-contacts-tbody");
    contactsBody.innerHTML = state.adminContacts.length
      ? state.adminContacts
          .map(
            (c) => `
              <tr>
                <td><strong>${esc(c.name)}</strong><br /><span class="action-time">${esc(formatDateTime(c.created_at))}</span></td>
                <td><code>${esc(c.email)}</code></td>
                <td>${esc(c.message)}</td>
                <td><span class="pill ${c.status === "reviewed" ? "emerald" : "amber"}">${esc(c.status)}</span></td>
                <td>
                  ${c.status !== "reviewed" ? `<button class="btn-secondary btn-sm" data-mark-contact="${esc(c.id)}">Mark Reviewed</button>` : `<span class="section-sub">Done</span>`}
                </td>
              </tr>
            `
          )
          .join("")
      : `<tr><td colspan="5">No contact submissions yet.</td></tr>`;

    contactsBody.querySelectorAll("[data-mark-contact]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await apiFetch(`/api/admin/contacts/${btn.getAttribute("data-mark-contact")}`, {
            method: "PATCH",
            body: JSON.stringify({ status: "reviewed" }),
          });
          await hydrateAdminData();
          renderAdminConsole();
          showToast("Contact marked reviewed");
        } catch (err) {
          showToast(`Update failed: ${err.message}`);
        }
      });
    });
  }

  function renderAll() {
    renderAuthNav();
    renderPublicShowcase();
    renderDashboard();
    renderIntegrations();
    renderAdminConsole();
  }

  function bindGlobalEvents() {
    document.querySelectorAll(".nav-btn[data-view]").forEach((btn) => {
      btn.addEventListener("click", () => setView(btn.getAttribute("data-view")));
    });

    document.getElementById("nav-contact-link").addEventListener("click", () => setView("home"));
    document.getElementById("footer-contact-link").addEventListener("click", () => setView("home"));

    document.getElementById("hero-connect-btn").addEventListener("click", openAuthModal);
    document.getElementById("dash-connect-btn").addEventListener("click", openAuthModal);
    document.getElementById("int-connect-btn").addEventListener("click", openAuthModal);
    document.getElementById("close-auth-modal").addEventListener("click", closeAuthModal);

    document.getElementById("backend-config-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const workerUrl = document.getElementById("cfg-worker-url").value.trim().replace(/\/+$/, "");
      const googleId = document.getElementById("cfg-google-client-id").value.trim();
      state.config.workerApiUrl = workerUrl;
      state.config.googleClientId = googleId;
      localStorage.setItem(
        STORAGE_KEYS.backend,
        JSON.stringify({ workerApiUrl: workerUrl, googleClientId: googleId })
      );
      await Promise.all([refreshServerConfig(), refreshPublicProjects()]);
      renderGoogleButton();
      renderPublicShowcase();
      showToast("Saved service connection settings");
    });

    document.getElementById("contact-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("contact-name").value.trim();
      const email = document.getElementById("contact-email").value.trim();
      const message = document.getElementById("contact-message").value.trim();
      if (!name || !email || !message) return;

      if (!workerBaseUrl()) {
        showToast("Backend API URL is not configured yet.");
        openAuthModal();
        return;
      }

      try {
        await apiFetch("/api/contact", {
          method: "POST",
          body: JSON.stringify({ name, email, message }),
        });
        e.target.reset();
        showToast("Thanks! Your message has been sent.");
      } catch (err) {
        showToast(`Contact submission failed: ${err.message}`);
      }
    });

    document.getElementById("public-search").addEventListener("input", (e) => {
      state.publicSearch = e.target.value;
      renderPublicShowcase();
    });

    document.querySelectorAll("[data-public-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.publicFilter = btn.getAttribute("data-public-filter");
        document.querySelectorAll("[data-public-filter]").forEach((b) =>
          b.classList.toggle("active", b === btn)
        );
        renderPublicShowcase();
      });
    });

    document.getElementById("toggle-show-hidden").addEventListener("change", (e) => {
      state.showHidden = Boolean(e.target.checked);
      renderDashboard();
    });

    document.querySelectorAll("[data-my-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.myFilter = btn.getAttribute("data-my-filter");
        document.querySelectorAll("[data-my-filter]").forEach((b) =>
          b.classList.toggle("active", b === btn)
        );
        renderDashboard();
      });
    });

    document.getElementById("new-project-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!isValidatedUser()) {
        showToast("Account pending admin validation.");
        return;
      }
      const name = document.getElementById("new-proj-name").value.trim();
      const visibility = document.getElementById("new-proj-visibility").value;
      const lifecycle = document.getElementById("new-proj-lifecycle").value;
      const summary = document.getElementById("new-proj-summary").value.trim();
      if (!name) return;

      try {
        const data = await apiFetch("/api/projects", {
          method: "POST",
          body: JSON.stringify({ name, summary, visibility, lifecycle }),
        });
        state.myProjects.unshift(data.project);
        await Promise.all([refreshPublicProjects(), hydrateUserData()]);
        e.target.reset();
        renderAll();
        showToast(`Created ${name} (${visibility})`);
      } catch (err) {
        showToast(`Create project failed: ${err.message}`);
      }
    });

    document.getElementById("admin-refresh-btn").addEventListener("click", async () => {
      await hydrateAdminData();
      renderAdminConsole();
      showToast("Admin stats refreshed");
    });

    document.querySelectorAll("[data-admin-user-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.adminUserFilter = btn.getAttribute("data-admin-user-filter");
        document.querySelectorAll("[data-admin-user-filter]").forEach((b) =>
          b.classList.toggle("active", b === btn)
        );
        renderAdminConsole();
      });
    });

    document.getElementById("admin-actions-user-filter").addEventListener("change", async (e) => {
      state.adminActionsUserId = e.target.value;
      await hydrateAdminData();
      renderAdminConsole();
    });

    document.getElementById("admin-actions-type-filter").addEventListener("change", async (e) => {
      state.adminActionsType = e.target.value;
      await hydrateAdminData();
      renderAdminConsole();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindGlobalEvents();
    initConfigAndData();
  });
})();
