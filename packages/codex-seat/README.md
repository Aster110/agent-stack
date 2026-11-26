# Codex seat core

Shared engine, WAL, thread queue and relay pull loop used by `@cc-mesh/agent-runtime`. See [architecture](../../docs/UNIFIED-RUNTIME.md) and [deployment SOP](../../docs/DEPLOYMENT-SOP.md).

The older `codex-seat` CLI remains for compatibility. New deployments use agent-runtime; legacy defaults and permissive internal-peer routing are not the unified entrypoint's explicit peer policy.

Build: `pnpm --filter @cc-mesh/codex-seat build`. Contract changes need migration notes.
