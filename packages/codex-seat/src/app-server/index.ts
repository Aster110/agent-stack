/**
 * Lane A（引擎层）出口。集成时由主席位在 `src/index.ts` 里 re-export 这一个文件。
 * 冻结契约见 `../contracts.ts`；分包纪律见 `../../LANES.md`。
 */
export { AppServerConnection, SHUTDOWN_GRACE_MS } from "./connection.js"
export type { ConnTransport, ConnectionEvent, RpcResult, ServerRequestDisposition } from "./connection.js"
export { EventQueue } from "./event-queue.js"
export { FakeAppServerClient } from "./fake-client.js"
export type { FakeAppServerClientOptions } from "./fake-client.js"
export {
  DEFAULT_SCENARIO,
  FAKE_SAMPLED_AT,
  loadScenario,
  parseScenario,
  pickTurnScript,
} from "./fake-scenario.js"
export type {
  FakeEventSpec,
  FakeMatch,
  FakeScenario,
  FakeScenarioInput,
  FakeTurnOutcome,
  FakeTurnScriptInput,
  FakeTurnScript,
  FakeTurnStep,
} from "./fake-scenario.js"
export { noopLogger, stderrLogger } from "./logger.js"
export type { LogLevel, Logger } from "./logger.js"
export {
  ORPHAN_KILL_GRACE_MS,
  clearPidFile,
  defaultProcOps,
  killOrphanFromPidFile,
  readCodexVersion,
  readPidFile,
  resolveCodexBin,
  writePidFile,
} from "./proc.js"
export type {
  CodexBinResolution,
  CodexBinSource,
  EnginePidFile,
  OrphanAction,
  OrphanSweepOptions,
  OrphanSweepResult,
  ProcOps,
} from "./proc.js"
export {
  BACKOFF_MS,
  INITIALIZE_TIMEOUT_MS,
  RealAppServerClient,
  THREAD_OP_TIMEOUT_MS,
  lastAgentMessageOf,
  mapBucket,
  mapNotification,
  mapRateLimits,
} from "./real-client.js"
export type { RealAppServerClientOptions } from "./real-client.js"
export { SERVER_REQUEST_METHODS, answerForServerRequest, tableAnswer } from "./server-request.js"
export { LineSplitter, classifyFrame, encodeFrame, notificationThreadId } from "./wire.js"
export type { InboundFrame, OutboundFrame } from "./wire.js"
