import importlib.util
import json
from pathlib import Path
import sys

import yaml

ROOT = Path(__file__).resolve().parent.parent


def _load_local_script(name: str):
    path = ROOT / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"c2s_{name}", str(path))
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


security_scan = _load_local_script("security_scan")
validate_spec = _load_local_script("validate_spec")


def test_spec_and_submodule_alignment():
    errs = validate_spec.validate_repo(ROOT)
    assert errs == [], f"Spec validation errors: {errs}"


def test_model_matrix_v11_contract_and_tab_mapping():
    routing = json.loads((ROOT / "modules" / "model-matrix" / "routing.json").read_text(encoding="utf-8"))
    providers = yaml.safe_load((ROOT / "config" / "providers.example.yaml").read_text(encoding="utf-8"))

    assert routing["schema_version"] == "1.1.0"
    assert routing["content_hash"]
    assert routing["stats"]["stage5_pinned_to_gemini"] is True

    stages_by_id = {s["id"]: s for s in routing["stages"]}
    assert stages_by_id["app_build"]["primary_provider"] == "antigravity"
    assert stages_by_id["app_build"]["model_family"] == "gemini"
    assert "gemini" in stages_by_id["app_build"]["primary_model"].lower()

    for tab in providers["antigravity_bridge"]["tab_states"]:
        assert tab["stage_ref"] in stages_by_id


def test_github_pages_portal_and_worker_contract():
    index_html = (ROOT / "docs" / "index.html").read_text(encoding="utf-8")
    app_js = (ROOT / "docs" / "assets" / "app.js").read_text(encoding="utf-8")
    pub_json = json.loads((ROOT / "docs" / "public-projects.json").read_text(encoding="utf-8"))
    cfg_json = json.loads((ROOT / "docs" / "config.json").read_text(encoding="utf-8"))
    worker_ts = (ROOT / "worker" / "src" / "index.ts").read_text(encoding="utf-8")
    wrangler_toml = (ROOT / "worker" / "wrangler.toml").read_text(encoding="utf-8")
    migration_sql = (ROOT / "worker" / "migrations" / "0001_init.sql").read_text(encoding="utf-8")
    migration_2 = (ROOT / "worker" / "migrations" / "0002_admin_and_contact.sql").read_text(encoding="utf-8")
    migration_3 = (ROOT / "worker" / "migrations" / "0003_user_actions_and_oauth.sql").read_text(encoding="utf-8")

    # Marketing landing, Alpha notice, Admin menu & click-through integrations
    assert "Alpha Now" in index_html
    assert "Connect Account to Start Integrations" in index_html
    assert "Current Public Projects" in index_html
    assert "Past Public Projects" in index_html
    assert 'id="contact-form"' in index_html
    assert 'id="nav-admin"' in index_html
    assert 'id="view-admin"' in index_html
    assert "Admin Console" in index_html
    assert "Accounts &amp; Inline User Actions" in index_html

    # Keep marketing hero free of internal CLI/infra jargon and zero fake/preview data
    for forbidden in [
        "Windows Terminal",
        "wt.exe",
        "bridge_worker",
        "modal-preview-",
        "DEFAULT_PREVIEW_USERS",
        "DEFAULT_PREVIEW_PROJECTS",
        "Alex Rivera",
        "Feedback Triage Studio",
    ]:
        assert forbidden not in index_html
        assert forbidden not in app_js

    assert cfg_json["matrixRoutingUrl"].startswith("https://") if "matrixRoutingUrl" in cfg_json else True
    assert pub_json["projects"] == []

    # Secret-backed admin check (fail-closed, zero hardcoded personal email), user actions, and OAuth
    for route in [
        "/api/public/config",
        "/api/public/projects",
        "/api/contact",
        "/api/auth/google",
        "/api/admin/overview",
        "/api/admin/users",
        "/api/admin/actions",
        "/api/admin/projects",
        "/api/admin/contacts",
        "/api/oauth/",
        "/api/integrations",
        "/api/projects",
    ]:
        assert route in worker_ts

    assert "env.ADMIN_EMAIL" in worker_ts
    assert "ADMIN_EMAIL" in wrangler_toml
    assert "Account pending admin validation" in worker_ts
    assert "visibility TEXT NOT NULL DEFAULT 'private'" in migration_sql
    assert "lifecycle TEXT NOT NULL DEFAULT 'current'" in migration_sql
    assert "approval_status TEXT NOT NULL DEFAULT 'pending'" in migration_2
    assert "CREATE TABLE IF NOT EXISTS contact_messages" in migration_2
    assert "CREATE TABLE IF NOT EXISTS user_actions" in migration_3
    assert "CREATE TABLE IF NOT EXISTS oauth_states" in migration_3


def test_security_scan_clean():
    findings = security_scan.scan_repository(ROOT)
    assert findings == [], f"Unexpected security scan findings: {findings}"


def test_security_scan_blocks_private_host_and_path():
    sample = "url=https://devbox.tail999aa.ts.net\npath=C:\\\\Users\\\\alice\\\\secret.txt\n"  # security-scan:ignore
    clean_sample = sample.replace("  # security-scan:ignore", "").replace("\\\\", "\\")
    findings = security_scan.scan_text(clean_sample, "synthetic.txt")
    rules = {f["rule"] for f in findings}
    assert "tailscale_domain" in rules
    assert "windows_user_path" in rules
