# Open-source candidate release

Target tag: v0.1.0-rc.1. Status: verified open-source candidate; not a production stable release.

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

New preparation script: macOS downloaded the checksum-verified Node 24.13.0 distribution, installed the pinned CLI/tools, and built the full source. Official download slowness triggered the mirror fallback, still checked against the official SHA256. This machine already had developer tools; a clean OS installation and Linux bootstrap remain separate acceptance items.

Real WeChat send was attempted against the existing owner conversation. The platform returned errcode=-2 (idle conversation); owner activation is required before continuing. No successful phone-delivery claim is made. Production migration and the release-policy soak requirements remain open.
