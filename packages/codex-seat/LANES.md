# Core contribution boundaries

The shared contracts live in `src/contracts.ts`; architecture and persistence guarantees are in `../../docs/UNIFIED-RUNTIME.md`. Changes to message/state formats require versioned migration notes.

The unified runtime entrypoint is `../agent-runtime`; older CLI and terminal adapters remain compatibility tools. Do not add another model owner to the WeChat transport.
