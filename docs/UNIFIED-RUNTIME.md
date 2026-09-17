# Unified runtime candidate — design and acceptance

Status: open-source release candidate; production migration and stable release remain pending.

## 0. Discovery and reuse

| Module | Evidence | Decision |
|---|---|---|
| codex-seat runSeat | existing WAL, thread locks, resume, relay pull, engine lifecycle | shared runtime for brain and computer; extend ingress, not another engine |
| codex-seat RealAppServerClient | official JSON-RPC stdio adapter used by computer | sole Codex driver in unified entrypoint |
| cc2wechat transport | QR/auth, WeChat API, media and sender helpers | pinned source package in this workspace; import transport only |
| cc2wechat v6 ChannelCore | in-memory dedupe/queue; cursor advances before async intake | retain legacy entrypoint; do not use as unified runtime owner |
| cc2wechat gateway SQLite | existing transaction pattern for inbox/cursor | reuse transaction approach; the gateway's pairing/runner/conversation layer would create a second session owner, so it is excluded |
| mesh Hub/relay/CLI | existing inter-device protocol | unchanged protocol and one relay per device |

## 1. Constraints and exclusions

| Constraint | Anchor | Consequence |
|---|---|---|
| User/team scale | requested one owner, one server, one computer | one explicit WeChat owner; multiple untrusted users out of scope |
| Quality | user, 2026-09-14: “关键在于统一，统一代码，一份代码跑在电脑，服务器，主脑” | same runtime binary, role config only; isolated testing first |
| Time | user, 2026-09-14: “我们这个对外分享不着急” | no shortcut claiming final after unit tests |
| Environment | existing macOS/Linux services | same Node source; platform-specific supervision |
| Data/traffic scale | no measured capacity target | fault tests and bounded queues; no invented throughput promise |
| Budget | no spending limit supplied | choose existing local/authorized infrastructure for this test; this is a test choice, not a prohibition on alternatives |
| External interfaces | relay pull + Codex app-server + WeChat API | retain known transport semantics |

No Redis or second Codex engine is needed to solve the observed durable acceptance and reply failures. The candidate targets Node 24 on local filesystems, one active runtime per state root, one owner per brain. SQLite native builds must be validated per OS/architecture; a macOS pass is not Linux evidence.

## 2. Change pressure

WeChat API/QR/media stays in transport. Codex RPC stays in existing client. Role instructions and notification destination are configuration. Common durable acceptance, thread queue, completion and recovery belong to runSeat. Every role uses these same functions.

## 3. Traffic and failure pressure

Long model turns must not block WeChat polling. Persist raw polled messages and cursor atomically before dispatch; replay pending intake after restart. Accept a channel message only after common WAL fsync. Same thread is serial. Completed turns with failed reply delivery remain pending; retry delivery without repeating model execution. In-flight interrupted work is reported, never blindly executed again. Platform receipt ambiguity means possible duplicate notification, not exactly-once external effects.

At 10 times a short interactive burst, the serial model thread is the first service-rate constraint. Admission caps at 256 active/queued inputs across channels, mesh and restart replay. The mesh batch suffix beyond available capacity retains its relay cursor; WAL replay schedules pending handlers as capacity returns. Raw WeChat inbox caps at 10,000 pending rows and retains the cursor on rejection. Completed outbox remains durable when the network is unavailable. Durable handoff and task-result tombstones cap at 100,000 rather than evicting IDs and silently permitting replay. These are defensive candidate limits, not measured throughput promises. State JSON rewriting and WAL folding will become the next bottleneck at high history volume; archival/migration must precede that capacity, not a new distributed broker.

## 4. Added boundaries

| Boundary | Problem/variation isolated | Complexity | Include now / trigger |
|---|---|---|---|
| Optional channel ingress/reply route on runSeat | WeChat and mesh enter one thread with original return address | additive envelope/WAL fields | yes: two real consumers |
| Raw WeChat inbox and cursor transaction | crash between polling and media/intake | one local SQLite store, existing dependency | yes: observed code advances cursor early |
| Config-driven brain result handling | worker machine receipts should inform brain without reply loops | explicit role + one owner route | yes: existing machine receipts are intentionally swallowed |
| Remote API facade / new message broker | no required benefit | more endpoints/state | no |

## 5. Module boundaries

packages/codex-seat remains runtime/engine/WAL owner. Optional WeChat adapter owns account auth, platform cursor/raw intake and delivery. Unified CLI assembles role configuration and both channels. Hub/relay remain separate processes from same workspace release. Legacy cc2wechat daemon is not launched by unified CLI.

## 6. Contracts

Channel input: stable channel-local message ID, configured channel name, verified endpoint and text. Runtime derives namespaced ID and transport source; clients cannot select another thread. This candidate supports text and voice transcripts; attachments produce an explicit unsupported response. Acceptance returns accepted/duplicate only after WAL fsync and durable handoff tombstone. Failure throws, retaining raw intake. The tombstone survives the existing 1,000-ID recent cache and WAL compaction.

Contract v6 adds `routed`, `submitting`, pending terminal outbox and reply route. WAL insertion order is the common acceptance order: local message IDs cannot be compared with relay sequence numbers. A `submitting` intent and resumable thread state are durable before turn/start RPC. A crash in that window is an uncertain execution and becomes interruption evidence, never automatic rerun. If thread resume fails, the unified entrypoint fails visibly instead of making a new conversation.

On brain role, only a parsed terminal done/failed/rejected from an explicitly configured peer, with matching replyTo to an actual outbound task in the local relay database, enters model context. The current assembly uses a read-only query of `messages(id,from,to,type,payload)`; it is an internal, versioned workspace dependency, not a public DB API. The result/system transport type is checked before interpreting the body; malformed body, mismatched node, missing or unknown replyTo, and control-looking result text are consumed without a model turn or reciprocal reply. One persisted result origin per sender/task prevents new transport IDs from waking the brain twice. Routing is persisted before queueing. Once accepted, retry/recovery uses that saved route even if the original task record is later unavailable. The owner is explicit and fixed; no last-contact routing. Worker receipt suppression remains unchanged.

Model completion writes the outbox and releases the model thread; output network I/O does not hold that thread lock. A per-message delivery guard prevents concurrent retry sends. Done, failed and valid-address rejection remain pending until confirmed. Empty/relay sender messages and stale-before-seat-birth notices are intentionally discarded/audited rather than entering an undeliverable outbox. Retry failures are logged and pending counts are in status. WeChat text-send success requires a parsed object, an int64 message ID and no error code. Empty/non-JSON/missing-confirmation HTTP 200 responses remain pending. This strict expectation must be checked during real phone acceptance; availability must fail visibly if the platform changes it. WeChat persists reply context and part checkpoints, uses stable logical send IDs and fails on account/owner rebinding. A timeout after platform acceptance can still duplicate the unconfirmed part; platform deduplication is not assumed.

Dynamic mesh control operations (spawn/close/compact/status directives) are explicitly disabled in the unified candidate before any side effect. The legacy implementations do not yet have a complete durable control-operation outbox. Use separately configured persistent seats and the local status API. Re-enabling dynamic controls requires independent intent/completion/restart tests; the candidate does not silently inherit those older paths.

Runtime shutdown closes admission, interrupts/stops the engine, drains handlers/output operations and then closes persistence. A drain timeout is an explicit failure; it must not be reported as clean shutdown. Transport poll cancellation includes HTTP body reads. A local SQLite exclusive lease prevents two new runtimes from using the same state root and is released by process death.

Credentials, routes and workspace paths remain local private configuration. No author infrastructure defaults in unified configuration. Runtime must reject missing owner/role/network settings rather than borrow private defaults. Existing legacy paths are not silently changed.

## 7. Increasing-cost decisions

Legacy records remain readable by the v6 fold, but older binaries are not safe writers for v6 state. Unified runtime requires a separate state root, explicit v6 manifest and strict state/WAL validation. There is no in-place rollback/migration promise: keep legacy state independent and leave the live brain unchanged. Changing owner/account/role/workspace or relay device identity fails rather than replacing or crossing conversations. Local filesystem/SQLite locks are required; network filesystem or multi-host shared state is unsupported.

Routing policy is explicitly single-owner and not a multi-user authorization scheme. The local relay assumes trusted local OS processes; an untrusted co-tenant able to impersonate X-Mesh-Node is outside this model. Existing Hub protocol remains unchanged. Model access policy currently has one supported mode, explicit full-access; a restricted-permission product is not implemented. These boundaries must remain visible in public documentation.

## 8. Logical and runtime layouts

```text
WeChat transport -----+
                     +--> common runSeat WAL/queue --> one app-server --> brain thread
relay mesh pull -----+

computer relay --> same runSeat WAL/queue --> same app-server client --> worker thread
```

Server hosts Hub + relay + unified runtime with WeChat enabled. Computer hosts relay + the same runtime with WeChat disabled. Each machine has independent state; code/release is identical. Model subprocess lifetime belongs to runSeat, not to channel start/stop.

Claude App retains the existing mesh/SSE adapter from the same source tree. It has a different engine protocol and does not use the new Codex app-server driver. No new Claude runtime or Claude end-to-end acceptance is claimed here.

## 9. Delivery stages

| Stage | Work | Complete when | Next trigger |
|---|---|---|---|
| Candidate | common channel ingress, durable completion delivery, pinned transport integration, role config | isolated tests prove shared thread and unchanged worker behavior | contract and fault tests pass |
| Hardening | real Codex local smoke, separate relay processes, restarts/disconnects, platform fixtures, clean builds | evidence identifies real vs simulated transport and OS | clean macOS/Linux + owner WeChat end-to-end |
| Release | clean source, license/provenance, installer/service matrix, observed soak | same source hash accepted on macOS/Linux; dedicated real WeChat scan + text/async result/media scope; at least 48 hours observed with no lost task/result, wrong route, duplicate model execution, unexplained thread replacement or growing orphan count | only then production migration and stable release |

No 48-hour stability claim from accelerated tests. Original live services and user conversations remain untouched.

## 10. Implementation and validation

Keep codex-seat existing regression suite. Add independent failure cases: channel/mesh same thread; duplicate replay across restart; intake crash before cursor; lost final reply retry with no extra model turn; channel restart preserves brain; role-specific task result semantics without loops; source route survives restart; shutdown drains safely; corrupt state fails visibly. Verify artifact hashes and paths. Do not use mock success to claim real WeChat phone delivery.

## 12. Brain HTTP channel (voice/chat)

Third optional brain ingress beside WeChat and mesh, in `packages/agent-runtime/src/brain-http.ts`.
It is transport only, under the same §5 boundary as the WeChat adapter: no model process, no thread
selection, no new authority. Voice clients and the chat page reach the brain through it, and every
turn lands in the same Codex thread WeChat uses, so the owner can start a question by voice and
continue it on the phone.

| Item | Value |
|---|---|
| Config | `brainChannel: {tokenFile, port?, stateFile?}` in `runtime.json`; brain role only |
| Bind | `127.0.0.1` only, default port `18090`; public exposure is the operator's tunnel, not this server |
| Auth | `Authorization: Bearer <token>`; token read from `tokenFile`, which must not be group/world readable |
| Durable state | `stateFile` (default `<stateRoot>/brain-http.json`): open turns, uncollected finals, per-session transcript |
| Wire contract | `POST /v1/brain/ask` (SSE `accepted`/`delta`/`final`/`pending`/`error`), `GET /v1/brain/replies`, `GET /v1/brain/health`, `GET /v1/brain/history` |

Endpoints are `voice:<sessionId>` and `chat:<sessionId>`; `accepts()` admits that namespace and
nothing else, so a WAL replay after restart still finds a valid reply route. The seat hashes the
endpoint into `from`, so the channel prefixes the delivered text with `[voice:<sessionId>]` /
`[chat:<sessionId>]`; the stored transcript keeps the owner's own words without that tag.

`waitSec` (1-90, default 45) bounds how long the caller holds the stream. On expiry the channel sends
`pending` and closes; the answer the model later produces is persisted and collected once by
`/v1/brain/replies` (take-and-destroy). Replies are persisted before they are streamed, so a socket
that dies mid-write loses nothing; the cost is that a crash between streaming and dequeuing can show
one answer twice, which is the same platform-receipt ambiguity §3 already accepts for WeChat.

The brain runs one thread serially for every door, so `accepted` carries `queued:true` whenever the
seat already has work in flight — from WeChat or a mesh peer as much as from another `ask`. A caller
told `queued:false` while the brain is mid-task for someone else would be misled into expecting a
fast answer; `SeatHandle.inFlightWork()` is the cheap admission counter that keeps that flag honest
(`status()` folds the WAL and is too expensive per request). Asks are queued, never refused. Input is capped at 4000 characters. Logs record turn ID, kind and
character counts, never message text.

Security boundary: the token buys the right to talk to the brain as its owner — equivalent to the
WeChat account being stolen, no more. It grants the brain no new execution authority, and the channel
does not go through the mesh allowlist because it is not a mesh peer.


## 11. Review

Fresh reviewer must examine the eight anti-overdesign risks from arch-design against this document and code, identify any unsafe contract or unnecessary duplicate queue/engine, and give a concrete decision. This is a candidate design subject to test evidence, not a final release claim.

Initial independent review found real gaps in submission intent, pending replies, long-lived dedupe and route recovery. The implementation above addresses those contracts; the next fresh review must assess the current code and any residual limitations. Test reports list every failure and unverified layer; review approval alone does not mark release readiness.
