# Relay producer identity compatibility

Missing or empty X-Mesh-Node now means the configured relay device's stable
`<device>:relay` for send, dispatch and broadcast. Nonempty explicit full node
identities remain unchanged. Default/legacy short quota labels and wake audit
omit the header, allowing the relay to author its own system event. Short quota
labels remain metadata; a full `--from device:name` keeps its wire identity.
CompositeTransport's no-original-message fallback uses the same complete node.
This is consistent attribution, not authentication of local HTTP callers.

No protocol, Hub authorization, credential, URL, port, runtime or state schema is
changed. Existing Hub versions accept the complete source. Existing broadcast
semantics remain local fanout plus LedgerSync; direct fallback transport remains
routed/acknowledged but is not automatically persisted by the old Hub.

`packages/hub/src/producer-compatibility.test.ts` exercises eleven cases through
an actual isolated relay HTTP server, existing token-authenticated Hub, uplink,
LedgerSync and in-memory SQLite. It checks exact source, quota/task projection,
cursor progress and a later good message; dispatch/fallback include actual remote
delivery and acknowledgement. Missing and explicitly empty headers are separate.

Testing must use a private temporary HOME, TMUX_TMPDIR and TMPDIR, fixture bearer,
synthetic quota input and random loopback ports. Never run CLI registration tests
against19800 or read real keychain/account credentials. The wake case executes
only audit(), never alarm/restart paths. No dependency installation is required
for this source-only change; reuse the established build dependencies.

Before an operational rollout, bind the built artifacts to this exact commit,
preserve the old artifact/commit/startup rollback point, and inspect every actual
script entry (including an independently installed quota cron copy). Wait for
no open runtime turn and drained relay traffic before restarting only the relay.
Do not restart the runtime or reset/change its thread, cursor or state. Verify
registration reconnect and existing-Hub send/deliver/ack after installation.
If any invariant fails, restore only the affected relay code/script artifacts;
never restore a stale DB or replace the runtime/profile to work around it.

The shared-token/plaintext network risks remain outside this producer patch.
# Actual quota copy verification follow-up

The s1 cron calls `/root/cc-mesh-relay/quota-probe/report-quota.sh`, not the repository path. The authorized installation copies this repository script to that exact runtime path, retaining a separate old-script backup. Its installed SHA256 is `f36e82431ca56be1af6e55fc4bc177a3dda6dcac306a522a47f7551c8d99a6a4`.

The isolated contract now includes explicit `--from ''` as well as missing, legacy-short and valid complete sender arguments (12 producer cases). Test-only `MESH_TEST_PRODUCER_ROOT` and `MESH_TEST_DEVICE` allow the byte-identical actual runtime script to run against a random-loopback relay configured as `s1`, fake credentials and synthetic quota input. Missing/empty/legacy-short resolves to `s1:relay`; explicit `s1:quota-seat` is preserved. This does not claim device binding: the old shared-token Hub/relay still accepts arbitrary complete foreign authors. Preventing that is the separate Hub authentication migration, not a producer-normalization guarantee.

An isolated/manual pass does not prove the real cron cycle. Keep the unchanged `*/30` schedule and separately read back the next ordinary cycle's complete sender and canonical quota entry before closing that rollout gate. Do not restart the agent runtime to obtain it.
