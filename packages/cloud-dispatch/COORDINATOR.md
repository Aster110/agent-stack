# Coordinator integration

The coordinator understands requests, dispatches execution, reads receipts, assigns an independent verifier, and reports the result. Compatible code tasks use the configured Codex Cloud repository environment by default. GUI, macOS, local-login, and unavailable repository environments require an explicit independent-worker route. A pending fallback is not proof that a worker received it.

The bounded local entry point is `cloud-dispatch submit-json '<prepare specification JSON>'`; an explicit `repo_path` naming the actual Git worktree root is mandatory. Before returning success, it freezes and persists exact local input with a two-second subprocess budget. A separate deterministic worker publishes that frozen snapshot and sends the signed request through SSH. Network Git operations, Cloud execution/polling, and result delivery remain outside the coordinator's turn. `status TASK_ID`, `events --after N`, and `ack EVENT_ID` access local cached state. If capture exceeds its budget, no task is queued: delegate `cloud-dispatch capture-json '<same specification>'` to an independent worker, which has a 60-second capture limit. Do not lengthen the coordinator wait or loop retries. A repeated task ID reuses its original frozen input.

Preserve the originating request, owner, scope and exclusions, acceptance criteria, fixed base SHA, actual worktree, explicit untracked files, relevant instructions and decisions, and original return chat. Never upload the whole dirty documentation checkout by default. A linked worktree remains the source of its own task; do not silently prepare from the repository's primary checkout.

Cloud READY first enters recoverable `collecting`, then `awaiting_verification` once the candidate is saved and checked; neither means completed. Reuse an existing independent verification owner and collect their result; assign a verifier who did not implement the change only when no owner exists. Each task has one verdict owner, without duplicate assignments or verdict submissions. The verifier replays the saved diff on the recorded snapshot, runs the task's independent checks, and signs the exact input, diff, candidate tree, decision, and evidence. Tests and mocked UI do not replace required deployed/device/customer acceptance.

## Hook installation

`coordination_hook.py` uses the official command-hook JSON interface. Configure `PreToolUse`, `SubagentStart`, and `UserPromptSubmit` to run it with `--thread-id` and `--config`. Only that parent session is affected. Configuration requires:

- `thread_id`, `coordinator_transcript`: exact original chat and transcript path.
- `wrapper`: absolute installed fast-wrapper executable path.
- `actor_registry`, `audit_log`: private persistent files.

Review the script and exact definitions, then trust them through the official `/hooks` UI. `hooks/list` confirms trust, not execution. Existing desktop runtimes may retain old hook definitions: during this integration an idle chat was archived and immediately restored through the official app tools to reload configuration without losing its chat ID or history. Do not do this while a chat is executing unrelated work.

Validate an actual denied coordinator command and `apply_patch`, an allowed registered worker command, and an unaffected other chat. The current desktop runtime (0.162.0-alpha.17.2) supplies `agent_id` and a distinct `transcript_path` in worker PreToolUse events. SubagentStart registers the exact pair. The parent session ID alone cannot distinguish workers. Missing or mismatched identity inside the protected session is denied; other chats are unchanged.

Shell access in the coordinator is limited to the four fast wrapper commands. Commands must equal Python `shlex.join(shlex.split(command))`; this accepts correctly quoted JSON while rejecting shell interpolation and command chaining. Other execution tools, edits, and browser operations are delegated. Native worker waits are limited to ten seconds, and cross-chat status waits must be immediate snapshots. Return after dispatch and let durable completion events resume the original chat.

Hooks are workflow guardrails, not OS isolation or a guarantee about the model's thinking latency. Some hosted/specialized tools can bypass hook coverage, and a broken hook process can fail open in Codex. The script emits an explicit supported denial on coordinator policy errors, but installation and upgrades still need a real denied-tool test. Do not claim this makes an agent a security boundary.

## Verified scope and maintenance

The current official `codex cloud` adapter uses the environment/task protocol exposed by the CLI. OpenAI's documentation now distinguishes newer Cloud environments from Codex Cloud (Legacy) and says the legacy experience is planned for deprecation. Keep this provider behind the dispatcher; an environment in the newer UI is not automatically a compatible CLI environment. Do not claim every repository is enabled merely because the CLI accepts one configured environment.

Repository environment IDs, account binding, secrets, local paths, and chat IDs belong in private installation configuration. Never commit signing keys or account credentials. Preserve the existing main chat, business monitoring identities, and the independent s1 runtime service.

References: [official hooks](https://learn.chatgpt.com/docs/hooks), [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments), [legacy environments](https://learn.chatgpt.com/docs/environments/cloud-environment).
