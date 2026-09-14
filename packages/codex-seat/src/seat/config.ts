// config.json 的读取与缺省合并。契约见 contracts.SeatConfig / SEAT_CONFIG_DEFAULTS。

import { SEAT_CONFIG_DEFAULTS, isValidSeatName, type SeatConfig } from "../contracts.js"
import { readJsonSync } from "../state/atomic.js"

export type SeatConfigInput = Partial<SeatConfig> & Pick<SeatConfig, "seat" | "cwd">

/** 逐段合并（二级对象整段覆盖前先并缺省），不做深度递归——字段就两层，显式比聪明好。 */
export function resolveSeatConfig(input: SeatConfigInput): SeatConfig {
  if (!isValidSeatName(input.seat)) throw new Error(`invalid seat name: ${JSON.stringify(input.seat)}`)
  const d = SEAT_CONFIG_DEFAULTS
  return {
    version: 1,
    seat: input.seat,
    cwd: input.cwd,
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    relayUrl: input.relayUrl ?? d.relayUrl,
    hub: { ...d.hub, ...input.hub },
    codex: { ...d.codex, ...input.codex },
    allowlist: { ...d.allowlist, ...input.allowlist },
    worker: { ...d.worker, ...input.worker },
    compact: { ...d.compact, ...input.compact },
    sync: { ...d.sync, ...input.sync },
    turn: { ...d.turn, ...input.turn },
    log: { ...d.log, ...input.log },
  }
}

export function loadSeatConfig(file: string): SeatConfig | null {
  const raw = readJsonSync<SeatConfigInput>(file)
  if (!raw || typeof raw.seat !== "string" || typeof raw.cwd !== "string") return null
  return resolveSeatConfig(raw)
}
