#!/usr/bin/env bash
# Compatibility entry: this repository owns the release's skill.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
test -f "$root/skills/cc-mesh/SKILL.md"
echo "Skill source: $root/skills/cc-mesh (no external synchronization)"
