#!/usr/bin/env node
/**
 * 从证据目录生成 `e2e/evidence/SUMMARY.md`。
 *
 * 纪律（这份文件存在的全部理由）：**汇总表只许从证据 JSON 生成，不许从任何人的报告文字转述。**
 * 判绿也在这里机器判，不许手改 SUMMARY.md：
 *   - 主档（无 mutation）        → `passed=true` 且断言全过
 *   - 红门（expectedRed=true）   → `actualRed=true`
 *   - 行为检查（expectedRed=false）→ `actualRed=false` 且断言全过
 *   - 每份都要过 `evidenceReallyRan()` 与 `EVIDENCE_SCHEMA.json` 的结构校验
 *   - 同一个 case 的同一个模式只许有一份证据（多份 = 跑了好几遍留着好看的那份）
 * 任何一行 verdict 是 FAIL，末行 `OVERALL` 就是 FAIL。
 *
 * 跑法：node dist/e2e/summarize.js [证据目录]（缺省 CODEX_SEAT_E2E_OUT / e2e/evidence）
 */
import fs from "node:fs"
import path from "node:path"

import { evidenceReallyRan, type EvidenceRecord } from "../src/contracts.js"

// ---------------------------------------------------------------------------
// 一个够用的 JSON Schema 子集校验器（draft-07 里 EVIDENCE_SCHEMA 真正用到的那些关键字）
// 不引依赖。**用之前先拿坏样本证明它量得出东西**（见 selfTest）。
// ---------------------------------------------------------------------------

type Schema = Record<string, any>

function typeOf(v: unknown): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  if (Number.isInteger(v)) return "integer"
  return typeof v
}

function typeMatches(v: unknown, t: string): boolean {
  const actual = typeOf(v)
  if (t === "number") return actual === "number" || actual === "integer"
  if (t === "object") return actual === "object"
  return actual === t
}

export function validate(value: unknown, schema: Schema, at = "$"): string[] {
  const errs: string[] = []
  if (schema.oneOf) {
    const hits = schema.oneOf.filter((s: Schema) => validate(value, s, at).length === 0)
    if (hits.length !== 1) errs.push(`${at}: oneOf 命中 ${hits.length} 个分支（应恰好 1）`)
    return errs
  }
  if (schema.type) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t) => typeMatches(value, t))) {
      errs.push(`${at}: 类型是 ${typeOf(value)}，应为 ${types.join("|")}`)
      return errs // 类型都不对，再往下查没意义
    }
  }
  if (schema.enum && !schema.enum.includes(value as never)) {
    errs.push(`${at}: ${JSON.stringify(value)} 不在 enum ${JSON.stringify(schema.enum)} 里`)
  }
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errs.push(`${at}: ${JSON.stringify(value)} 不匹配 /${schema.pattern}/`)
  }
  if (typeof value === "number" && schema.minimum != null && value < schema.minimum) {
    errs.push(`${at}: ${value} < minimum ${schema.minimum}`)
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => errs.push(...validate(v, schema.items, `${at}[${i}]`)))
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    for (const k of schema.required ?? []) {
      if (!(k in obj)) errs.push(`${at}: 缺必填字段 ${k}`)
    }
    const props: Record<string, Schema> = schema.properties ?? {}
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!(k in props)) errs.push(`${at}: 多出未声明字段 ${k}`)
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in obj) errs.push(...validate(obj[k], sub, `${at}.${k}`))
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      for (const [k, v] of Object.entries(obj)) {
        if (k in props) continue
        errs.push(...validate(v, schema.additionalProperties, `${at}.${k}`))
      }
    }
  }
  return errs
}

/**
 * 坏掉的工具会伪装成"发现"：先拿**已知坏样本**证明这把尺子量得出东西，
 * 再去用它宣布"全部合规"。量不出来就直接退出，不许出一份看着全绿的汇总。
 */
function selfTest(schema: Schema, good: EvidenceRecord): string[] {
  const probes: Array<[string, unknown]> = [
    ["改坏 env.appServer 的枚举值", { ...good, env: { ...good.env, appServer: "totally-bogus" } }],
    ["删掉必填的 passed", (() => { const c: any = { ...good }; delete c.passed; return c })()],
    ["多塞一个未声明字段", { ...good, sneaky: 1 }],
    ["case 写成 E99", { ...good, case: "E99" }],
    ["wallMs 写成字符串", { ...good, wallMs: "fast" }],
  ]
  const blind: string[] = []
  for (const [name, bad] of probes) {
    if (validate(bad, schema).length === 0) blind.push(name)
  }
  return blind
}

// ---------------------------------------------------------------------------

interface Row {
  case: string
  mode: string
  file: string
  passed: boolean
  asserts: string
  wallMs: number
  fault: string
  expectedRed: string
  actualRed: string
  reallyRan: boolean
  verdict: "PASS" | "FAIL" | "SKIP"
  why: string[]
}

/** 证据文件名：E0x[-mutate[-<mode>]]-<ISO>.json */
function parseName(base: string): { caseId: string; mode: string } | null {
  const m = /^(E\d{2})(?:-mutate(?:-([A-Za-z0-9_-]+))?)?-(\d{4}-.*)\.json$/.exec(base)
  if (!m) return null
  return { caseId: m[1]!, mode: m[2] ? m[2]! : (base.includes("-mutate") ? "--mutate" : "main") }
}

function judge(rec: EvidenceRecord, schemaErrs: string[]): { verdict: "PASS" | "FAIL"; why: string[] } {
  const why: string[] = []
  const allPass = rec.assertions.every((a) => a.pass)
  if (schemaErrs.length > 0) why.push(`结构校验：${schemaErrs.slice(0, 3).join("；")}`)
  if (!evidenceReallyRan(rec)) why.push("evidenceReallyRan=false（墙钟/事件计数/rollout 缺一）")
  if (!rec.mutation) {
    if (!rec.passed) why.push("主档 passed=false")
    if (!allPass) why.push(`主档有断言没过：${rec.assertions.filter((a) => !a.pass).map((a) => a.name).join(" / ")}`)
  } else if (rec.mutation.expectedRed) {
    if (!rec.mutation.actualRed) why.push("红门变异跑绿了（expectedRed=true 却 actualRed=false）——这个 case 什么也没测到")
    if (!rec.passed) why.push("红门档 passed=false")
  } else {
    if (rec.mutation.actualRed) why.push("行为检查变异下红了（expectedRed=false 却 actualRed=true）")
    if (!allPass) why.push(`行为检查档有断言没过：${rec.assertions.filter((a) => !a.pass).map((a) => a.name).join(" / ")}`)
    if (!rec.passed) why.push("行为检查档 passed=false")
  }
  return { verdict: why.length === 0 ? "PASS" : "FAIL", why }
}

function main(): void {
  // dist/e2e/summarize.js → 往上两层是包根
  const dir = process.argv[2] ?? process.env.CODEX_SEAT_E2E_OUT ?? path.resolve(__dirname, "..", "..", "e2e", "evidence")
  const schemaPath = path.resolve(__dirname, "..", "..", "e2e", "EVIDENCE_SCHEMA.json")
  const schema: Schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"))
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()

  const rows: Row[] = []
  const skipped: string[] = []
  let firstGood: EvidenceRecord | null = null

  for (const f of files) {
    const full = path.join(dir, f)
    if (f.endsWith(".skipped.json")) {
      const meta = JSON.parse(fs.readFileSync(full, "utf-8")) as { case?: string; reason?: string }
      rows.push({
        case: meta.case ?? f.replace(".skipped.json", ""), mode: "skipped", file: f, passed: false,
        asserts: "—", wallMs: 0, fault: "—", expectedRed: "—", actualRed: "—", reallyRan: false,
        verdict: "SKIP", why: [meta.reason ?? "本轮不执行"],
      })
      skipped.push(f)
      continue
    }
    const name = parseName(f)
    let rec: EvidenceRecord
    try {
      rec = JSON.parse(fs.readFileSync(full, "utf-8")) as EvidenceRecord
    } catch (err) {
      rows.push({
        case: name?.caseId ?? "??", mode: name?.mode ?? "??", file: f, passed: false, asserts: "—",
        wallMs: 0, fault: "—", expectedRed: "—", actualRed: "—", reallyRan: false,
        verdict: "FAIL", why: [`证据不是合法 JSON: ${String(err)}`],
      })
      continue
    }
    const schemaErrs = validate(rec, schema)
    if (!firstGood && schemaErrs.length === 0) firstGood = rec
    const { verdict, why } = judge(rec, schemaErrs)
    if (!name) why.push(`文件名不符合 E0x[-mutate[-mode]]-<ISO>.json：${f}`)
    rows.push({
      case: name?.caseId ?? rec.case, mode: name?.mode ?? (rec.mutation ? "--mutate" : "main"), file: f,
      passed: rec.passed,
      asserts: `${rec.assertions.filter((a) => a.pass).length}/${rec.assertions.length}`,
      wallMs: rec.wallMs,
      fault: rec.mutation?.fault ?? "—",
      expectedRed: rec.mutation ? String(rec.mutation.expectedRed) : "—",
      actualRed: rec.mutation ? String(rec.mutation.actualRed) : "—",
      reallyRan: evidenceReallyRan(rec),
      verdict: name ? verdict : "FAIL", why,
    })
  }

  // 尺子自检：拿坏样本证明结构校验器真的会报错
  let selfTestLine = "结构校验器自检：**跳过**（目录里没有一份合规证据可当基准）"
  if (firstGood) {
    const blind = selfTest(schema, firstGood)
    if (blind.length > 0) {
      process.stderr.write(`✗ 结构校验器是瞎的，认不出这些坏样本：${blind.join("、")}\n`)
      process.exit(2)
    }
    selfTestLine = "结构校验器自检：**通过**（5 个已知坏样本——枚举越界 / 缺必填 / 多字段 / case=E99 / wallMs 非数——全部被拦下）"
  }

  // 同 case 同模式只许一份
  const seen = new Map<string, string[]>()
  for (const r of rows) {
    if (r.verdict === "SKIP") continue
    const k = `${r.case}|${r.mode}`
    seen.set(k, [...(seen.get(k) ?? []), r.file])
  }
  for (const [k, fs2] of seen) {
    if (fs2.length <= 1) continue
    for (const r of rows) {
      if (`${r.case}|${r.mode}` === k) {
        r.verdict = "FAIL"
        r.why.push(`同 case 同模式有 ${fs2.length} 份证据（只许留一份最终的）：${fs2.join(" , ")}`)
      }
    }
  }

  rows.sort((a, b) => (a.case === b.case ? a.mode.localeCompare(b.mode) : a.case.localeCompare(b.case)))
  const graded = rows.filter((r) => r.verdict !== "SKIP")
  const fails = graded.filter((r) => r.verdict === "FAIL")
  const cases = new Set(rows.map((r) => r.case)).size
  const overall = fails.length === 0 && graded.length > 0 ? "PASS" : "FAIL"

  const lines: string[] = []
  lines.push("# codex-seat E2E 证据汇总")
  lines.push("")
  lines.push(`> 由 \`e2e/summarize.ts\` 从 \`${path.relative(process.cwd(), dir) || dir}\` 下的证据 JSON **机器生成**，不许手改。`)
  lines.push("> 判据：主档 `passed=true` 且断言全过；红门 `expectedRed=true` 必须 `actualRed=true`；")
  lines.push("> 行为检查 `expectedRed=false` 必须 `actualRed=false` 且断言全过；每份都要过 `evidenceReallyRan()` 与 `EVIDENCE_SCHEMA.json`。")
  lines.push(`> 生成时间：${new Date().toISOString()}`)
  lines.push("")
  lines.push(`${selfTestLine}`)
  lines.push("")
  lines.push("| case | mode | passed | asserts | wallMs | fault | expectedRed | actualRed | reallyRan | verdict |")
  lines.push("|---|---|---|---|---|---|---|---|---|---|")
  for (const r of rows) {
    lines.push(`| ${r.case} | ${r.mode} | ${r.passed} | ${r.asserts} | ${r.wallMs} | ${r.fault} | ${r.expectedRed} | ${r.actualRed} | ${r.reallyRan} | ${r.verdict} |`)
  }
  lines.push("")
  if (fails.length > 0 || skipped.length > 0) {
    lines.push("## 明细")
    lines.push("")
    for (const r of rows) {
      if (r.why.length === 0) continue
      lines.push(`- **${r.case} ${r.mode}**（${r.verdict}）：${r.why.join("；")}`)
    }
    lines.push("")
  }
  lines.push(`OVERALL: ${overall} (${cases} cases, ${graded.length} files${skipped.length > 0 ? `, ${skipped.length} skipped` : ""})`)
  lines.push("")

  const outFile = path.join(dir, "SUMMARY.md")
  fs.writeFileSync(outFile, lines.join("\n"))
  process.stdout.write(`${lines.join("\n")}\n`)
  process.stdout.write(`\n汇总写入 ${outFile}\n`)
  process.exit(overall === "PASS" ? 0 : 1)
}

main()
