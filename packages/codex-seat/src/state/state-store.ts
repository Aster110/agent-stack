// state.json 的读写。设计稿 §5 / contracts.StateFile。

import { CONTRACT_VERSION, RECENT_MSG_IDS_MAX, type StateFile } from "../contracts.js"
import fs from "node:fs"
import { atomicWriteFileSync, readJsonSync } from "./atomic.js"

export interface InitialStateInput {
  seat: string
  nodeId: string
  deviceId: string
  instanceId: string
  now?: string
}

export function initialState(i: InitialStateInput): StateFile {
  return {
    version: 1,
    contractVersion: CONTRACT_VERSION,
    seat: i.seat,
    nodeId: i.nodeId,
    deviceId: i.deviceId,
    mainThreadId: null,
    workers: {},
    // **null，不是 0**：0 对 relay 的意思是「把这个 nodeId 历来所有消息发给我」。
    // 复用老 nodeId 的新席位以 0 起跑就会把陈年指令当新派单执行（2026-09-02 computer2 事故）。
    // null = 未锚定 → 首启走只读 sync 取 relay 头，锚上去，历史一条不碰。
    cursor: null,
    createdAt: i.now ?? new Date().toISOString(),
    cursorAnchoredAt: null,
    cursorAnchorSeq: null,
    paused: null,
    instanceId: i.instanceId,
    startedAt: i.now ?? new Date().toISOString(),
    lastSeenAt: null,
    lastDoneAt: null,
    recentMsgIds: [],
    codexVersion: null,
    engine: null,
    resumableThreads: [],
  }
}

/** 追加已处理 msgId，尾部保留最新 RECENT_MSG_IDS_MAX 个（旧的先淘汰）。 */
export function rememberMsgIds(state: StateFile, ids: readonly string[]): void {
  if (ids.length === 0) return
  const seen = new Set(state.recentMsgIds)
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    state.recentMsgIds.push(id)
  }
  if (state.recentMsgIds.length > RECENT_MSG_IDS_MAX) {
    state.recentMsgIds = state.recentMsgIds.slice(-RECENT_MSG_IDS_MAX)
  }
}

export class StateStore {
  constructor(readonly file: string, private readonly strict = false) {}

  load(): StateFile | null {
    const raw = readJsonSync<StateFile>(this.file)
    if (this.strict && fs.existsSync(this.file) && (!raw || raw.version !== 1 || typeof raw.nodeId !== "string")) throw new Error("invalid persistent seat state; refusing to replace the conversation")
    if (this.strict && raw && (raw.contractVersion !== CONTRACT_VERSION ||
        !(raw.mainThreadId === null || typeof raw.mainThreadId === "string") ||
        !Array.isArray(raw.recentMsgIds) || !Array.isArray(raw.resumableThreads) ||
        !raw.workers || typeof raw.workers !== "object" ||
        !(raw.cursor === null || Number.isSafeInteger(raw.cursor))))
      throw new Error("unsupported or corrupt seat state; explicit migration required")
    if (!raw || typeof raw !== "object") return null
    if (raw.version !== 1 || typeof raw.nodeId !== "string") return null
    // 缺省补齐：老文件/手改过的文件不该让席位起不来。
    raw.workers ??= {}
    raw.recentMsgIds ??= []
    // 老文件里 cursor 恒是数字 → **原样保留**，当已锚定处理。
    // 千万别在这里 `??= 0`：那等于把「未锚定」悄悄翻译成「从头重放」，正好是事故的写法。
    if (raw.cursor === undefined) raw.cursor = null
    // contractVersion ≤2 的 state.json 没有出生时刻：退回 startedAt（这一代 sidecar 的启动时刻），
    // 再退回纪元 0（宁可年龄闸放行，也不要把一个升级上来的老席位全量拒收）。
    raw.createdAt ??= raw.startedAt ?? new Date(0).toISOString()
    raw.cursorAnchoredAt ??= null
    raw.cursorAnchorSeq ??= null
    raw.paused ??= null
    // contractVersion 1 的 state.json 没有这个字段：当空集补齐 —— 宁可多开一条新 thread，
    // 也不能拿一个没落过 rollout 的 thread 去 resume（必报 no rollout found）。
    raw.resumableThreads ??= []
    return raw
  }

  save(state: StateFile): void {
    atomicWriteFileSync(this.file, `${JSON.stringify(state, null, 2)}\n`)
  }
}
