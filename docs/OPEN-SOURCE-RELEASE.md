# Open-source candidate release

Target tag: v0.1.0-rc.2. Status: verified open-source candidate; not a production stable release.

This repository starts from the unified source candidate, excluding historical Git objects, captured operational evidence, private skill content, host-specific deployment scripts and generated caches. Runtime code, tests and generic tooling remain together. Deployment defaults and examples use local addresses or fictional identifiers; legacy skill installation no longer reads a personal documentation repository.

MIT license and cc2wechat transport provenance are included. Existing production installs have not yet all migrated. Current migration acceptance is defined in RELEASE-POLICY.md.

The earlier report UNIFIED-RUNTIME-TEST-REPORT.md describes the implementation before the public-source cleanup. Verification of this exported source is recorded separately here; earlier test counts must not be treated as results of a later modified commit.

## Verification, 2026-09-14

Both macOS arm64 (Node 24.19.0) and Linux x64 (Node 24.13.0): full build and 1,270 passing tests, zero failures/cancellations, one tmux-environment skip. Breakdown: protocol 13, Codex core 395, relay 603, ledger 179, unified runtime 12, Hub 68. The shell CLI regression passed on macOS. The proxy fix's updated shell-wrapper test is additionally rechecked on Linux after syncing that file.

Real Codex smoke passed on both OS: input through the WeChat HTTP fixture, mesh recall of that context, original-peer reply, runtime restart preserving thread ID, and actual file creation with the remembered nonce. Zero terminal/tmux operations. The WeChat platform and peer were test fixtures; this is not a real phone round trip.

Publication hardening found and fixed two actual failures:

- better-sqlite3 11.10.0 aborted the macOS Node 24 process during statement cleanup. The isolated store regression reproduced it; pinning 13.0.3 fixed it, then both OS passed their complete regressions. Version 13 uses N-API; see [upstream release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0).
- The shell pull wrapper inherited an outbound proxy and returned proxy HTTP 503 for a local relay. Explicit proxy bypass fixes the real configured-proxy test; failure/empty-batch tests remain enabled.

Source secret scanning: gitleaks reported no secrets after excluding one explicitly synthetic bearer-token redaction fixture. Private host addresses, account fingerprints, captured evidence, personal workspace defaults and private skill import paths were removed. Only the clean initial Git snapshot is published.

New preparation script: macOS downloaded the checksum-verified Node 24.13.0 distribution, installed the pinned CLI/tools, and built the full source. Official download slowness triggered the mirror fallback, still checked against the official SHA256. This machine already had developer tools; this did not itself establish a clean OS installation. Later Linux bootstrap evidence is recorded below.

Real WeChat send was attempted against the existing owner conversation. The platform returned errcode=-2 (idle conversation); owner activation is required before continuing. No successful phone-delivery claim is made. Production migration and the release-policy soak requirements remain open.

## rc.2 deployment acceptance

The corrected public baseline passed GitHub Actions on both macOS and Ubuntu: [run 34862751090](https://github.com/Aster110/agent-stack/actions/runs/34862751090). A CI-only lease test failure was traced to the child fixture discarding its database owner; the test now retains it and forces GC before checking exclusivity. The underlying lock implementation was unchanged.

Fresh Linux installation exposed a missing project-local pnpm PATH during nested build scripts; prepare.sh now sets it explicitly. Two separate Linux hosts subsequently completed bootstrap. Another Mac completed download/install/build. A Mac with slow outbound downloads required transferring the already verified Node distribution; network progress must not be confused with a code failure.

rc.2 adds private profile generation, QR-confirmed owner binding, launchd/systemd definitions and SSH tunnels. A newly installed pull-only relay explicitly selects MESH_TERMINAL=none; it no longer needs tmux/iTerm discovery. The minimal profile disables legacy Hub ledger/attachment defaults and keeps state private and isolated. The first deployment smoke revealed those defaults and was aborted, then rerun after the isolation fix.

The resulting macOS full regression passed 1,271 tests (one additional terminal-free test), one tmux-only skip, plus shell CLI regressions. Deployment profile tests passed 3/3 and QR binding tests passed 2/2. The opt-in `node scripts/deployment-smoke.mjs` passed with real Codex accounts: an authenticated Hub, two actual relay processes, two identical runtime processes, dispatch to a computer that created the exact nonce file, verified correlated result acceptance, brain process restart preserving the Codex thread and recalled nonce, and Hub restart with both relays reconnecting. All temporary services exited. Only the WeChat HTTP platform was simulated; both device roles ran on the same test Mac, so this does not establish a physical cross-machine phone round trip.

Release packaging and installed-source hashes are separate from OS service migration. Existing production brain import, real owner phone acceptance, offline device access and the observation period still gate stable promotion.

### Final rc.2 verification

A stricter acceptance now waits for the *specific correlated peer-result response* to reach WeChat delivery done=1 with the correct nonce before restarting the brain. The earlier smoke checked accepted routing and could stop while that response was still running; it must not be cited as completed peer-result delivery. The strengthened test passed on both macOS arm64 and Linux x64 using real models, Hub/relay/runtime processes and an HTTP WeChat fixture. Delegation instructions now tell the brain to finish the dispatch turn and let the runtime deliver results, preventing model inbox polling from delaying its own queued result.

Actual OS supervision was also exercised: launchd on macOS and systemd on Linux installed the isolated computer profile, started the real relay and Codex engine, tolerated repeated installation, then stopped and removed the test units. The first Linux run found invalid WorkingDirectory quoting; that directive is corrected, systemd-analyze validates units before installation, and installation separately starts and checks is-active. Service process startup alone did not count as a model-task test; the separate real-model acceptance above covers tasks.

The final functional changes passed both GitHub CI jobs: [run 34865856244](https://github.com/Aster110/agent-stack/actions/runs/34865856244). Published Git history was scanned with gitleaks and contained no detected credentials. No real production phone round trip, existing-brain state import, or long observation period is claimed.
