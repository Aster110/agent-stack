#!/usr/bin/env bash
# Install local tools and locked dependencies; never start services.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
command -v node >/dev/null || { echo 'Install Node.js 24 first.' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) { console.error("Node.js 24 is required."); process.exit(1); }'
command -v npm >/dev/null || { echo 'npm is required.' >&2; exit 1; }
mkdir -p .tools
npm install --prefix "$root/.tools" --no-audit --no-fund --save-exact pnpm@10.13.1 @openai/codex@0.153.4
export PATH="$root/.tools/node_modules/.bin:$PATH"
"$root/.tools/node_modules/.bin/pnpm" install --frozen-lockfile
"$root/.tools/node_modules/.bin/pnpm" build
mkdir -p "$root/.tools/bin"
ln -sf "$root/packages/cli/mesh.sh" "$root/.tools/bin/mesh"
printf 'Prepared. Add %s/.tools/bin and actual Node/Codex directories to the service PATH.\n' "$root"
printf 'Read docs/DEPLOYMENT-SOP.md. No service was started and no network was joined.\n'
