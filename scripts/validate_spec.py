#!/usr/bin/env python3
"""
validate_spec.py — Consistency checks for Conversation-to-Ship specification,
provider config template, and embedded agentic-model-matrix submodule (v1.1.0+).
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

import yaml

REQUIRED_DOCS = [
    "README.md",
    "docs/BUILD_SPEC.md",
    "docs/PROVIDER_CONTRACTS.md",
    "docs/DATABASE_AND_API.md",
    "docs/index.html",
    "docs/config.json",
    "docs/public-projects.json",
    "docs/assets/app.js",
    "docs/assets/styles.css",
    "worker/wrangler.toml",
    "worker/src/index.ts",
    "worker/migrations/0001_init.sql",
    "worker/migrations/0002_admin_and_contact.sql",
    "worker/migrations/0003_user_actions_and_oauth.sql",
    "config/providers.example.yaml",
    ".env.example",
]


def _load_matrix_module(matrix_dir: Path) -> Any:
    gen_path = matrix_dir / "scripts" / "generate_weekly_matrix.py"
    if not gen_path.exists():
        return None
    spec = importlib.util.spec_from_file_location("agentic_matrix_gen", str(gen_path))
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(gen_path.parent))
    spec.loader.exec_module(mod)
    return mod


def validate_repo(root: Path) -> List[str]:
    errors: List[str] = []

    for rel in REQUIRED_DOCS:
        if not (root / rel).exists():
            errors.append(f"Missing required artifact: {rel}")

    cfg: Dict[str, Any] = {}
    providers_path = root / "config" / "providers.example.yaml"
    if providers_path.exists():
        cfg = yaml.safe_load(providers_path.read_text(encoding="utf-8")) or {}
        active = cfg.get("active_providers", {})
        for key in ["booking", "calendar", "meeting", "transcript", "repo", "deploy"]:
            if not active.get(key):
                errors.append(f"providers.example.yaml missing active_providers.{key}")
        if active.get("deploy") != "cloudflare":
            errors.append("providers.example.yaml active_providers.deploy should default to 'cloudflare'")
        cf = cfg.get("cloudflare", {})
        if not cf.get("use_r2") or not cf.get("use_workers"):
            errors.append("providers.example.yaml must enable cloudflare.use_workers and cloudflare.use_r2")

    matrix_dir = root / "modules" / "model-matrix"
    matrix_path = matrix_dir / "routing.json"
    if not matrix_path.exists():
        errors.append("Missing modules/model-matrix/routing.json (ensure submodule is initialized)")
        return errors

    matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
    if not matrix.get("content_hash"):
        errors.append("routing.json missing v1.1.0+ 'content_hash'")

    stats = matrix.get("stats", {})
    if stats.get("stage5_pinned_to_gemini") is not True:
        errors.append("routing.json stats.stage5_pinned_to_gemini must be true")

    stage_ids = {s.get("id") for s in matrix.get("stages", []) if s.get("id")}
    app_stages = [s for s in matrix.get("stages", []) if s.get("id") == "app_build"]
    if not app_stages:
        errors.append("routing.json missing stage 'app_build'")
    else:
        st = app_stages[0]
        if st.get("primary_provider") != "antigravity" or st.get("model_family") != "gemini":
            errors.append("routing.json stage 'app_build' must be pinned to Gemini on Antigravity")
        if not all("gemini" in m.lower() for m in st.get("fallback_chain", [])):
            errors.append("routing.json stage 'app_build' fallback_chain must contain only Gemini models")

    # Cross-check Antigravity Bridge tab_states[].stage_ref against routing.json stages
    for tab in cfg.get("antigravity_bridge", {}).get("tab_states", []):
        ref = tab.get("stage_ref")
        if ref not in stage_ids:
            errors.append(
                f"providers.example.yaml tab '{tab.get('id')}' stage_ref '{ref}' not found in routing.json"
            )

    expected_ver = cfg.get("model_routing", {}).get("expected_schema_version")
    if expected_ver and matrix.get("schema_version") != expected_ver:
        errors.append(
            f"routing.json schema_version '{matrix.get('schema_version')}' != expected '{expected_ver}'"
        )

    # Delegate full schema & docs parity verification to agentic-model-matrix itself
    matrix_mod = _load_matrix_module(matrix_dir)
    if matrix_mod is not None and hasattr(matrix_mod, "verify_existing"):
        ok, matrix_errs = matrix_mod.verify_existing(matrix_dir)
        if not ok:
            errors.extend(f"model-matrix verify_existing: {e}" for e in matrix_errs)

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate Conversation-to-Ship specification and submodule alignment.")
    parser.add_argument("--root", default=".", help="Repository root")
    args = parser.parse_args()

    errs = validate_repo(Path(args.root).resolve())
    if errs:
        print("SPEC VALIDATION FAILED:", file=sys.stderr)
        for err in errs:
            print(f"  - {err}", file=sys.stderr)
        return 1

    print("SPEC VALIDATION PASSED: all docs, provider contracts, and model matrix v1.1.0+ invariants aligned.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
