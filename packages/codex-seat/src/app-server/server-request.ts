/**
 * 服务端 → 客户端的请求应答表。
 *
 * **这张表漏一个，那一轮就永久挂死** —— codex 在等我们回话，我们在等 turn/completed。
 * 语义按席位的使用口径（全程 bypass）一律准；需要人当场决策的（MCP elicitation、
 * 工具追问）一律明确拒绝，而不是挂着——席位那头没人能填表单。
 *
 * 默认分支的 `-32601` 是 E16 的靶心：删掉它，未知 ServerRequest 会让整轮挂死。
 * 名单核对：`codex app-server generate-ts` 的 `ServerRequest` 联合体（0.151.0 实测 10 个方法）。
 */
import { JSONRPC_METHOD_NOT_FOUND } from "../contracts.js"
import type { ServerRequestReply } from "../contracts.js"

export type { ServerRequestReply }

const TABLE: Record<string, () => ServerRequestReply> = {
  // 旧版审批入口
  execCommandApproval: () => ({ result: { decision: "approved" } }),
  applyPatchApproval: () => ({ result: { decision: "approved" } }),

  // v2 审批入口
  "item/commandExecution/requestApproval": () => ({ result: { decision: "accept" } }),
  "item/fileChange/requestApproval": () => ({ result: { decision: "accept" } }),
  "item/permissions/requestApproval": () => ({
    result: { permissions: { network: { enabled: true }, fileSystem: {} }, scope: "session" },
  }),

  // 没人能回答的，明确拒绝，别把 turn 吊在那
  "mcpServer/elicitation/request": () => ({ result: { action: "decline" } }),
  "item/tool/requestUserInput": () => ({ result: { answers: {} } }),
  "item/tool/call": () => ({ result: { contentItems: [], success: false } }),

  // initialize 时已声明 requestAttestation:false，正常不会走到这
  "attestation/generate": () => ({ result: { token: "" } }),
  "currentTime/read": () => ({ result: { currentTimeAt: Math.floor(Date.now() / 1000) } }),

  // 席位不持有 ChatGPT 凭据。**在表里**（replied=table），但答的是 error。
  "account/chatgptAuthTokens/refresh": () => ({
    error: { code: JSONRPC_METHOD_NOT_FOUND, message: "codex-seat 不持有 ChatGPT 凭据，无法刷新" },
  }),
}

export const SERVER_REQUEST_METHODS: readonly string[] = Object.freeze(Object.keys(TABLE))

/** 表里有就返回应答，没有返回 null（调用方据此把事件标成 default-32601）。 */
export function tableAnswer(method: string): ServerRequestReply | null {
  const f = TABLE[method]
  return f ? f() : null
}

export function answerForServerRequest(method: string): ServerRequestReply {
  return (
    tableAnswer(method) ?? {
      // 未知方法也要回 —— 回错误至少能让 codex 往下走，沉默只会挂死
      error: { code: JSONRPC_METHOD_NOT_FOUND, message: `codex-seat 未处理的 server request: ${method}` },
    }
  )
}
