# Transport provenance

Source: https://github.com/Aster110/cc2wechat
Pinned revision: 5a363bf5eaa8d1545db09181134fbc97bb805c1c

Only the QR/auth, platform API, shared types and their local import closure are included. No CLI daemon, Agent Core or Codex driver is started. This source is redistributed under MIT; see the repository LICENSE and THIRD_PARTY_NOTICES.md.

Files: src/auth.ts, src/types.ts, src/utils.ts, src/v5/receiver/wechat-receiver.ts, src/v5/sender/wechat-api-sender.ts, src/v5/shared/wechat-api-core.ts, src/v6/wechat/errcode.ts, src/wechat-api.ts

Candidate changes: optional stable client ID for text-send retries; optional AbortSignal for polling and API request cleanup including response-body deadlines; lossless int64 inbound message IDs using Node 24 JSON source context. The type shim src/qrcode-terminal.d.ts is also from the pinned revision. These additive parameters preserve existing callers. Text-send acknowledgements must parse as an object with a numeric message ID and no error code; malformed/empty HTTP 200 bodies remain retryable. Platform exactly-once delivery is not assumed.
