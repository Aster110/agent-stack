# Long turn observation in the unified runtime

## Constraints and decisions

| Constraint and evidence | Decision | Excluded alternative |
| --- | --- | --- |
| `seat.ts` already persists `submitting` before RPC and owns a reliable receipt outbox | Retain that lifecycle and add observing/activity records | Replacing the seat implementation with the legacy cc-mesh version |
| `contracts.ts` stores channel `ReplyRoute` and routed brain results | Preserve route metadata through read-only recovery and final delivery | Sending a recovered channel result back through mesh |
| The assignment defines elapsed wall time as uncertainty | Submit with `timeoutMs: 0`; use configured timeout as observation threshold | Interrupting or returning failed because a timer fired |
| `turn/start` ACK can arrive late or disappear at a crash boundary | Keep its RPC correlation; recover the same thread/turn by unique user-message task marker | Replaying business input |
| Existing WAL can include `failed reason=timeout` followed by `receipted` | Retain both as nonterminal until actual completion/failure | Compacting these records away |
| Existing brain result routing accepts correlated terminal machine receipts | Consume observations and legacy timeout receipts without waking the brain | Reporting an old timeout to the owner as terminal |
| No deployment or production process operations authorized in this port | Isolated worktree, child-process fixtures and local test relay only | Restarting runtime, relay, sshd or P34 |

## Change and traffic pressure

| Boundary | Pressure | Response |
| --- | --- | --- |
| App-server transport | Late ACK and lost terminal notifications | `readTurn` and retained request IDs |
| Persistent state | Old timeout records and new observation outbox | Additive WAL operations and compatibility folding |
| Mesh task consumers | Nonterminal observation states | Existing system receipts plus ledger projection |
| Unified owner channels | Reliable final delivery already implemented | Reuse existing outbox and ReplyRoute; observations remain machine-only |
| Volume | No measured new traffic target | At most one delivered observation per state transition; recovery uses bounded polling. No capacity claim |

## Middleware gate

| Candidate | Problem / isolation | Complexity | V1 | Trigger |
| --- | --- | --- | --- | --- |
| New task queue/service | None beyond the current WAL | Extra owner and deployment boundary | No | Proven existing WAL cannot represent pending work |
| In-process recovery map | Separates unknown execution outcome from transport health | Timer and same-thread submission guard | Yes | Existing destructive timeout behavior |

## Modules and contracts

Seat owns durable observation intent and serialization. The app-server client owns read-only snapshots and late ACK correlation. WAL keeps original message identity and reply destination. Ledger projects `awaiting_confirmation`, `running`, `failed`, and `replied`; final results outrank delayed observations. Existing result outbox still owns terminal delivery.

The legacy `turn.timeoutMs` setting is an observation threshold. A turn is submitted exactly once with `[mesh-task-id:<msgId>]`; unknown turn IDs can be resolved only by a unique matching user message on the original thread. Unknown snapshots remain pending. An interrupted snapshot alone is not evidence of explicit cancellation because old runtimes could cause that interruption; live cancellation still takes the existing failure path.

Observations use system messages correlated through `replyTo`; relay message IDs remain relay-generated. Delivery retries are made harmless by task/state projection, not a newly invented transport idempotency contract. Channel observations do not create owner finals or errors. Explicit failures preserve the existing reliable failure outbox.

## Evolution and validation

| Stage | Scope | Next-stage trigger |
| --- | --- | --- |
| V1 | Isolated port, build, transport/restart/ledger/unified-runtime regression tests, PR | Reviewer acceptance and explicit deployment task |
| V1.5 | One configured runtime rollout at a time | Actual late-result and recovery evidence |
| V2 | Additional provider adapters | Another concrete provider needs the same contract |

Required checks cover late ACK without interruption, legacy timeout followed by receipted and compaction, original-turn recovery, observation/result ordering, channel outbox retry, and correlated brain results. The parent task owns real Codex canary validation and external consumer inventory. This PR does not deploy.
