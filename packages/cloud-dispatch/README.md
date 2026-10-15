# Cloud Dispatch

A small Python standard-library queue for code work using the owner's existing Codex ChatGPT subscription. It runs independently of `agent-runtime`, its Codex thread, and existing business monitors. A cloud worker produces a candidate; a separately authenticated verifier accepts or rejects that exact candidate.

The main-chat wrapper has four fast commands. All four read or write local SQLite and never wait for Git, SSH, a model, or desktop RPC:

```sh
cloud-dispatch submit-json '<prepare specification JSON>'
cloud-dispatch status TASK_ID
cloud-dispatch events --after 0
cloud-dispatch ack EVENT_ID
```

`submit-json` returns `prepare_queued`. A separate local launchd process prepares and publishes the snapshot, signs the request, and submits it through SSH. The s1 systemd service controls upstream concurrency. A second local launchd process mirrors durable server events into the local status cache and queues meaningful changes into the configured original Codex chat. Cached status includes its observation time; a disconnected laptop continues to show its last confirmed state.

## Input and code synchronization

A prepare specification contains `task_id`, configured `repo_id`, an optional explicit `repo_path`, full `base_sha`, `prompt`, `scope`, `include_untracked`, `exclude_untracked`, explicit `context` files, and separate `authorization: {source, reference}`. The wrapper supplies the configured original `return_route` if omitted. `task_kind` defaults to `code`; `requirements` defaults to `[]`.

Scope entries are exact repository-relative paths or directory prefixes ending in `/`. All tracked changes inside scope use the final working-tree bytes, including staged plus unstaged changes and both sides of a rename. In-scope untracked files must be explicitly included or excluded. Out-of-scope dirty paths are recorded as excluded and never uploaded as new changes. Explicit context files have source paths and noncolliding target paths; their byte hashes and file modes are fixed. Symbolic links and submodules cannot be newly supplied or produced by the worker.

A temporary Git index starts at the declared base. `commit-tree` constructs a deterministic snapshot; the original HEAD, index, branch, and working tree are preserved. Normal linked worktrees are accepted after their actual common Git directory matches the configured repository. An independent clone requires `allowed_clone_paths` and an identical configured origin URL. The caller's worktree is never silently replaced with the main checkout.

The immutable `codex/cloud/<task_id>` branch is published with a create-only ref lease. An existing branch must already match the snapshot; it is never overwritten. `prepare` can be repeated with identical input. Changed input under the same task ID is rejected. Prepared requests and a tracked binary patch are retained locally. The service maps repository IDs to trusted remote URLs and Codex environment IDs and verifies the remote branch, snapshot parent, manifest, bytes and modes before cloud submission.

The official Cloud CLI accepts branch names, not a commit argument. A dedicated immutable branch plus a recorded snapshot SHA is therefore required. Do not move or delete a task branch until its candidate and acceptance evidence have been archived. Existing environment access is repository-specific; no environment, GUI/macOS/local-login requirements, an unavailable subscription login, or an account mismatch produces `routed_worker` with `delivery=pending`. This is a pending handoff, not proof that another worker received the work.

## Server CLI and state

```sh
python3 cloud_dispatch.py --config PRIVATE_CONFIG prepare < specification.json
python3 cloud_dispatch.py --config PRIVATE_CONFIG submit < signed-request.json
python3 cloud_dispatch.py --config PRIVATE_CONFIG status TASK_ID
python3 cloud_dispatch.py --config PRIVATE_CONFIG tick
python3 cloud_dispatch.py --config PRIVATE_CONFIG serve
python3 cloud_dispatch.py --config PRIVATE_CONFIG events --after 0
python3 cloud_dispatch.py --config PRIVATE_CONFIG artifact TASK_ID --kind diff
python3 cloud_dispatch.py --config PRIVATE_CONFIG verify < signed-verdict.json
```

Canonical JSON is UTF-8 `json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)`. `input_hash` is SHA256 of the canonical request. Submit envelopes contain `{request, auth: {principal, signature}}`; signatures are HMAC-SHA256 over canonical request bytes. The trusted configuration maps submitter and verifier principals to different private key files. Reusing a submit key as a verifier key is rejected. No key, auth store, or verification fixture enters the worker prompt or task branch.

The queue uses SQLite WAL, full synchronization and short transactions. One scheduler lock protects admission and recovery. Default `max_active` is 2; it counts `submitting`, `running`, and `submission_unknown` tasks, not local subagent slots. Only the program invokes `codex cloud exec`; attempts are fixed to 1. Status queries read persisted state. No whole model thread is held while a task runs.

Submission intent is committed before creating the upstream task. A timeout, crash or ambiguous receipt in that window becomes `submission_unknown` and reserves its slot. It is never automatically resubmitted. Preserve the task ID and logs and reconcile with the upstream task list before an operator makes a recovery decision. Known task IDs are safely polled again after restart. `task_deadline_seconds` raises a durable deadline event; it does not cancel an upstream task or free a slot on an unproven assumption. Read-only reconciliation continues until a confirmed upstream terminal state.

A READY result is saved as a raw diff, replayed against the immutable snapshot through an isolated index, checked against write scope, and assigned `output_hash` and `candidate_tree_sha`. Its state is only `awaiting_verification`. The scheduler does not run repository tests or builds on s1. A verifier uses an independent checkout/executor and sends:

```json
{"verdict":{"task_id":"...","input_hash":"...","output_hash":"...","candidate_tree_sha":"...","decision":"accepted","evidence":{"test_receipt":"..."}},"auth":{"principal":"independent-verifier","signature":"..."}}
```

The verifier signature covers the entire verdict, including evidence. Before recording it, the service rehashes the saved diff and recomputes the candidate tree. A worker/submitter signature, wrong input, changed artifact, wrong candidate or conflicting final verdict is rejected. Acceptance is bound to that candidate; it does not merge, deploy, or establish an original-device/customer outcome.

## Desktop return path

The bridge uses only official app-server `thread/read`, `thread/queue/add`, `thread/queue/list` and `thread/turns/list` RPC. It checks the configured thread ID and cwd. Every durable event has a stable `clientUserMessageId`. If a queue response is lost, it searches official queue/history by that ID and never blindly resends an ambiguous event. Original-chat ACK records receipt, not acceptance. Task prompt and generated model text are not inserted into trusted notification instructions.

Server events are persisted locally before advancing the pull cursor. Mirroring into the main status cache has its own replay cursor. Events awaiting delivery survive process restarts. A server state-instance change fails visibly instead of replaying a new database as old events.

## Deployment

Use an immutable source release and separate private configuration/state directories. `deploy.py` renders a new systemd service, two launchd agents and the narrow wrapper; it refuses to overwrite a different existing target. It never invokes or edits the original brain deploy profile. Example service name: `org.agentstack.s1.cloud-dispatch.service`; example local agents: `org.agentstack.cloud-dispatch.prepare` and `.bridge`.

Required server config fields are `version: 1`, `state_dir`, absolute `codex_bin`, `codex_home`, expected account-ID SHA256 prefix, `repos`, `submitters`, and `verifiers`. Configured durations, concurrency and account binding are explicit. Server state must be on a local filesystem. The sample unit limits memory and processes; these are scheduler bounds, not a claim about cloud task capacity.

Local config additionally has `server: {ssh_host, python, script, config}`, `submit_identity`, `gateway_state_dir`, `bridge_state_dir`, `target_thread_id`, `target_cwd`, `desktop_codex_bin`, `main_wrapper`, per-repository `local_path`, optional `allowed_checkout_roots`/`allowed_clone_paths`, and explicit `context_roots`. A separate verifier config contains `verifier_identity`; the main wrapper config does not. Credentials stay outside the source checkout with mode 0600. Use the existing logged-in Codex account; do not copy or switch its auth store.

The source package and process separation enforce queue transitions and prevent cloud workers from possessing acceptance credentials. A main-chat tool hook is an additional role boundary implemented separately. This package is a single-owner system, not a hostile multi-tenant sandbox; an owner with arbitrary local shell/root access can change its database or keys.

## Verification

`python3 selftest.py -v` runs an offline integration with a real temporary Git repository and linked worktree, fake SSH/Codex, and an official-RPC-shaped fixture that loses a queue response after persisting it. It verifies immediate local enqueue, immutable scoped preparation, candidate delivery, cached status without transport, stable event reconciliation, one queue write, ACK, and worktree isolation. Independent black-box contract tests are maintained outside this implementation and are not uploaded to cloud workers.
