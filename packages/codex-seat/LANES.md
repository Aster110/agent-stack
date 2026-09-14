# Core contribution boundaries

The shared contracts live in `src/contracts.ts`; architecture and persistence guarantees are in `../../docs/UNIFIED-RUNTIME.md`. Changes to message/state formats require versioned migration notes and fault/restart tests.

Tests and E2E harnesses use independent state, random local ports and explicit test identities. Never replay production history or replace a live seat merely to run a test. E2E evidence goes to the ignored `e2e/evidence/` directory and is not committed.

The unified runtime entrypoint is `../agent-runtime`; older CLI and terminal adapters remain compatibility tools. Do not add another model owner to the WeChat transport.
