#!/usr/bin/env python3
"""Check tracked and candidate source paths without printing file contents.

This is a repository boundary check, not a replacement for Gitleaks, a history
scan, or an asset/privacy review. It never reads ignored, untracked runtime data.
"""

import argparse
from pathlib import Path
import re
import subprocess
import sys


PRIVATE_PATHS = re.compile(
    r"^(?:data|backups|artifacts|output|test-results|playwright-report|"
    r"\.openpbl-data|\.openpbl-runtime|\.cache|\.next[^/]*|node_modules)/"
    r"|^(?:docs/(?:paper|plans|audits|reports|verification|research)|deploy/secrets)/"
    r"|(?:^|/)(?:node_modules|\.auth|\.aws|\.ssh)/"
    r"|(?:^|/)(?:id_rsa|id_ed25519|\.netrc|\.git-credentials|server-providers\.yml)$"
    r"|(?:^|/)(?:storageState|storage-state)[^/]*\.json$"
    r"|\.(?:pem|key|p12|pfx|sqlite3?|db|dump|sql\.gz)$",
    re.IGNORECASE,
)
PRIVATE_KEY = re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----")
ATTACHMENT = re.compile(r"(?:/home/[^/\s]+|/Users/[^/\s]+)/\.codex/attachments/")


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args])


def inspect_repository(root):
    paths = set(filter(None, git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z").decode().split("\0")))
    ignored = set(filter(None, git(root, "ls-files", "-ci", "--exclude-standard", "-z").decode().split("\0")))
    findings = []
    for name in sorted(paths):
        path = root / name
        # Deleted files are absent from the proposed working tree. A staged
        # snapshot must be checked separately before publication.
        if not path.exists() and not path.is_symlink():
            continue
        if name in ignored:
            findings.append((name, "tracked-but-ignored"))
        if PRIVATE_PATHS.search(name) or (path.name.startswith(".env") and path.name != ".env.example"):
            findings.append((name, "private-or-generated-path"))
        if path.is_symlink():
            # Do not follow symlinks into private files outside the candidate.
            try:
                target = path.resolve(strict=True).relative_to(root).as_posix()
                included = target in paths or any(item.startswith(target + "/") for item in paths)
                if path.readlink().is_absolute() or not included or PRIVATE_PATHS.search(target):
                    findings.append((name, "symlink-requires-explicit-review"))
            except (OSError, RuntimeError, ValueError):
                findings.append((name, "symlink-requires-explicit-review"))
            continue
        if not path.is_file():
            continue
        data = path.read_bytes()
        if b"\0" in data:
            continue
        content = data.decode("utf-8", errors="replace")
        if PRIVATE_KEY.search(content):
            findings.append((name, "private-key-marker"))
        if ATTACHMENT.search(content):
            findings.append((name, "personal-attachment-path"))
    return len(paths), findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    root = args.root.resolve()
    try:
        count, findings = inspect_repository(root)
    except (OSError, subprocess.CalledProcessError) as error:
        print(f"Content check could not complete: {type(error).__name__}", file=sys.stderr)
        return 2
    for name, category in findings:
        print(f"{category}: {name}")
    print(f"Checked {count} candidate paths; {len(findings)} finding(s). History and binary content require separate review.")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
