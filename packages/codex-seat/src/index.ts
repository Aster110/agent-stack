/**
 * @cc-mesh/codex-seat 公共出口。
 *
 * 三线合并后由这里统一对外：契约（contracts）+ 引擎层（Lane A）+ 席位核心（Lane B）+
 * 进程/CLI（Lane C）。同名符号有两份实现的地方一律**显式起别名**，不做 `export *` 混合——
 * `writePidFile` / `resolveCodexBin` / `packageRoot` / `loadSeatConfig` 都各有两份，
 * 靠 `export *` 让 TS 静默挑一个，用的人会拿到"看着对、行为不对"的那份。
 *
 * 分包纪律见 `../LANES.md`。
 */

// ---- 冻结契约（类型 + 纯函数；StatusReport / StateFile / EvidenceRecord 等都在这里） ----
export * from "./contracts.js"

// ---- Lane A：引擎层 ----
export * from "./app-server/index.js"

// ---- Lane B：席位核心 ----
export { runSeat } from "./seat/seat.js"
export type { SeatHandle, SeatLogRecord, SeatLogger, SeatProcOps, SeatRuntimeOptions } from "./seat/seat.js"
export type { SeatChannel, ChannelInput, ChannelOutput, ReplyRoute } from "./seat/channels.js"
/** 结构化合并缺省的 config 解析（内存里造配置用；从磁盘读走 CLI 那份带校验的） */
export { resolveSeatConfig, loadSeatConfig as loadSeatConfigFile } from "./seat/config.js"
export type { SeatConfigInput } from "./seat/config.js"
export { MeshClient } from "./mesh/mesh-client.js"
export type { MeshClientOptions } from "./mesh/mesh-client.js"
export { LedgerClient } from "./mesh/ledger-client.js"
export { StateStore, initialState, rememberMsgIds } from "./state/state-store.js"
export type { InitialStateInput } from "./state/state-store.js"
export { WalStore, WAL_COMPACT_EVERY } from "./state/wal.js"
export { atomicWriteFileSync, readJsonSync } from "./state/atomic.js"

// ---- Lane C：进程层 ----
export {
  SEAT_TAG_KEY, CHATGPT_APP_MARKER, seatTag, seatTagArgs, seatTagPrefix,
  isOurAppServerCmd, findOrphans, sweepOrphans,
} from "./proc/orphans.js"
export type { OrphanCandidate, FindOrphansOptions, SweepResult } from "./proc/orphans.js"
export { defaultSysProcOps } from "./proc/ops.js"
export type { ProcInfo, SysProcOps } from "./proc/ops.js"
export { stopProcessGroup } from "./proc/group.js"
export {
  buildAppServerArgs, spawnAppServer, codexVersion, defaultBinProbe,
  resolveCodexBin as resolveCodexBinPath,
} from "./proc/spawn.js"
export type { BinProbe, SpawnEngineOptions, SpawnedEngine } from "./proc/spawn.js"
export {
  parsePidFile, serializePidFile, checkPidFile,
  writePidFile as writeProcPidFile,
  readPidFile as readProcPidFile,
  clearPidFile as clearProcPidFile,
} from "./proc/pidfile.js"
export type { PidFileRecord, PidCheck } from "./proc/pidfile.js"

// ---- Lane C：CLI 入口与只读视图 ----
/** `codex-seat` 可执行入口（package.json bin → dist/src/cli/main.js） */
export { main as cliMain } from "./cli/main.js"
export { parseCli, USAGE } from "./cli/args.js"
export type { ParsedCli, ParseError } from "./cli/args.js"
export {
  ConfigError, defaultSeatConfig, validateSeatConfig, writeSeatConfig, configPathFor,
  loadSeatConfig,
} from "./cli/config.js"
export type { ValidateResult } from "./cli/config.js"
export {
  buildStatusReport, formatStatusTable, statusExitCode, threadsFromState, walCounts,
  supervisorIsLoaded, statusLogPathHint,
} from "./cli/status.js"
export type { StatusInputs, WalCounts } from "./cli/status.js"
export {
  planInstall, planUninstall, executeInstallPlan, executeUninstallPlan, contextForSeat,
} from "./cli/install.js"
export type { InstallPlan, UninstallPlan, PlanInstallInput, PlanUninstallInput, ExecResult, SupervisorKind } from "./cli/install.js"
export {
  renderLaunchdPlist, renderSystemdUnit, buildSupervisorContext, renderTemplate,
  assertNoFaultEnv, resolveStableNodeBin, templateFile, cliEntryPath,
  LAUNCHD_PATH, SYSTEMD_PATH, STABLE_NODE_CANDIDATES, UnreplacedPlaceholderError,
  packageRoot as templatesPackageRoot,
} from "./cli/templates.js"
export type { SupervisorContext, BuildContextInput } from "./cli/templates.js"
