# Legacy brain cutover (rc.3)

The unified release includes the same fenced SSE probe/ACK doorbell used by Claude App. Codex runs a persistent app-server via stdio and consumes mesh through its durable pull queue; it does not need a simulated SSE listener. Neither path starts idle model turns.

## Preserve before switching

- Stop legacy intake, submit guards, recurring reseed and restore units. Confirm the old composer is empty, the active turn is finished and both the wrapper and Codex writer have exited. Disabling a oneshot unit does not terminate tmux children.
- Keep the existing Hub topology, relay database, Codex home and actual thread rollout. Generic `deploy.py init --role brain` creates a new Hub and is **not** the legacy migration path.
- Capture a consistent relay database backup and an explicit cutover sequence. An inject seat may have no ACK cursor: interpreting that as zero would replay its history. Record in-flight outbound task IDs; later correlated results remain deliverable through the existing DB.
- Save the WeChat account, latest polling cursor and latest reply context after stopping the poller. A durable seed context may be older than the live context file.
- Back up private state and supervisor files with restrictive permissions outside this repository. Never publish credentials, owner identifiers, infrastructure addresses or original conversation content.

## Import and start

`scripts/migrate-tmux-brain.mjs /private/migration.json` consumes the `LegacyMigration` schema in `packages/agent-runtime/src/migrate.ts`. It requires the original thread's rollout, an explicit cutover sequence, the stopped legacy process IDs, and a runtime profile pointing to the existing relay DB. It refuses live captured PIDs, mismatched owner/thread, future cursors and existing destination state.

The import sets both `mainThreadId` and `resumableThreads`, retains the original creation time, and imports the platform polling cursor and reply route without generating incoming messages. A private deployment profile pins the release source hash and contains only the needed relay/runtime services. Use `MESH_TERMINAL=none`; no tmux bootstrap remains in the new supervisor chain.

Update the brain role instructions: runtime owns intake and final delivery; no manual duplicate `cc2wechat` or mesh final sends. Keep explicit authorization and peer allowlists. Ordinary uncorrelated peer chat is not automatically forwarded to WeChat; use the correlated task-result contract.

An optional `healthPort` exposes read-only `/health` on loopback with engine, thread, queue and WeChat intake state, without credentials. Runtime shutdown releases the channel and lease even if seat draining fails.

## Acceptance and rollback

Verify source identity **and** running entrypoints, same original thread, one poller, no tmux delivery, genuine inbound WeChat and acknowledged outbound delivery, correlated peer work with independent artifact readback, and a restart that retains thread/context and does not repeat side effects. Exercise the SSE client separately: probe receipts must not alter cursors or generate model turns.

Before the new runtime accepts any input, rollback may restore the consistent snapshot and old entrypoints. After new inputs or outputs occur, do not blindly restore old cursors: drain/export accepted inbox/outbox and reconcile confirmed sends first, or history can be replayed or skipped.

The current WeChat transport supports text and provider-supplied voice transcription. Attachment download remains unsupported; preserve accompanying text and tell the owner this limitation. A text-path pass is not full media parity with the legacy bridge.
