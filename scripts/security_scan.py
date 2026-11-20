#!/usr/bin/env python3
"""
security_scan.py — Zero-leak pre-commit and CI scanner for public repositories.

Fails with exit code 1 if potential secrets, private network indicators,
local absolute user paths, or non-placeholder personal emails are detected.
Uses Python standard library only (Python 3.7+ compatible).
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

SKIP_DIRS = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".next",
    ".wrangler",
    "dist",
    "build",
}

BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf",
    ".zip", ".tar", ".gz", ".woff", ".woff2", ".ttf", ".pyc",
}

ALLOWLIST_PATTERNS = [
    re.compile(r"example\.com", re.IGNORECASE),
    re.compile(r"example\.org", re.IGNORECASE),
    re.compile(r"users\.noreply\.github\.com", re.IGNORECASE),
    re.compile(r"<[A-Z0-9_]+>"),
    re.compile(r"placeholder", re.IGNORECASE),
    re.compile(r"127\.0\.0\.1"),
    re.compile(r"0\.0\.0\.0"),
    re.compile(r"localhost", re.IGNORECASE),
]

RULES: List[Tuple[str, re.Pattern]] = [
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("github_token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b")),
    ("github_fine_grained", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b")),
    ("private_key_header", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    ("bearer_literal_secret", re.compile(r"Bearer\s+[A-Za-z0-9_\-\.]{24,}")),
    ("slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("tailscale_domain", re.compile(r"\b[a-z0-9-]+\.tail[a-z0-9]+\.ts\.net\b", re.IGNORECASE)),
    ("tailscale_cgnat_ip", re.compile(r"\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b")),
    ("rfc1918_192_168", re.compile(r"\b192\.168\.\d{1,3}\.\d{1,3}\b")),
    ("rfc1918_10_x", re.compile(r"\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b")),
    ("windows_user_path", re.compile(r"[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\")),
    ("unix_home_path", re.compile(r"/(?:home|Users)/[a-z0-9._-]+/")),
    ("email_address", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
]


def is_allowlisted_match(line: str, rule_name: str, matched_text: str) -> bool:
    if rule_name == "email_address":
        domain = matched_text.split("@", 1)[1].lower()
        if domain in {"example.com", "example.org", "example.net", "users.noreply.github.com"}:
            return True
    if rule_name in {"bearer_literal_secret"} and any(p.search(matched_text) for p in ALLOWLIST_PATTERNS):
        return True
    if "example" in line.lower() and rule_name == "windows_user_path" and "username" in matched_text.lower():
        return True
    if rule_name == "rfc1918_10_x" and "10.0.0.0/8" in line:
        return True
    if rule_name == "rfc1918_192_168" and "192.168.0.0/16" in line:
        return True
    return False


def iter_files(root: Path) -> Iterable[Path]:
    for dirpath, dirnames, filenames in os.walk(str(root)):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fname in filenames:
            fpath = Path(dirpath) / fname
            if fpath.suffix.lower() in BINARY_EXTENSIONS:
                continue
            yield fpath


def scan_text(text: str, rel_path: str) -> List[Dict[str, object]]:
    findings: List[Dict[str, object]] = []
    lines = text.splitlines()
    for lineno, line in enumerate(lines, start=1):
        if "# security-scan:ignore" in line:
            continue
        for rule_name, pattern in RULES:
            for match in pattern.finditer(line):
                matched = match.group(0)
                if is_allowlisted_match(line, rule_name, matched):
                    continue
                findings.append({
                    "file": rel_path,
                    "line": lineno,
                    "rule": rule_name,
                    "snippet": matched[:32] + ("..." if len(matched) > 32 else ""),
                })
    return findings


def scan_repository(root: Path) -> List[Dict[str, object]]:
    findings: List[Dict[str, object]] = []
    for fpath in iter_files(root):
        try:
            content = fpath.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        rel = str(fpath.relative_to(root)).replace("\\", "/")
        findings.extend(scan_text(content, rel))
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description="Scan repository for secrets, PII, local paths, and private IPs.")
    parser.add_argument("--root", default=".", help="Repository root directory to scan")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    findings = scan_repository(root)
    if findings:
        print(f"SECURITY SCAN FAILED: {len(findings)} potential leak(s) detected:", file=sys.stderr)
        for item in findings:
            print(f"  - {item['file']}:{item['line']} [{item['rule']}] {item['snippet']}", file=sys.stderr)
        return 1

    print(f"SECURITY SCAN PASSED: 0 findings in {root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
