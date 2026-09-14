/**
 * Lane C —— 保活模板渲染（先红后绿）。
 *
 * 三条守门（每条都对应一次真实事故）：
 *   1. 占位符必须全替换 —— 半渲染的 plist launchd 照样 load，`launchctl list` 显示正常，
 *      但席位根本没起来（memory/launchd-path-node-trap.md）。
 *   2. 生产模板里绝不能出现 CODEX_SEAT_ALLOW_FAULTS —— 故障注入漏进生产 = 席位随机自残。
 *   3. 路径必须绝对且 PATH 必须显式 —— launchd 只给系统四目录，node 在 /opt/homebrew/bin。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { launchdLabel, systemdUnitName, seatPaths } from "../contracts.js"
import {
  renderTemplate,
  xmlEscape,
  renderLaunchdPlist,
  renderSystemdUnit,
  buildSupervisorContext,
  LAUNCHD_PATH,
  UnreplacedPlaceholderError,
  type SupervisorContext,
} from "./templates.js"

const ctx = (): SupervisorContext => ({
  seat: "e2e-ab12",
  label: launchdLabel("e2e-ab12"),
  unit: systemdUnitName("e2e-ab12"),
  nodeBin: "/opt/homebrew/bin/node",
  cliEntry: "/Users/example/AIproject/cc-mesh/packages/codex-seat/dist/src/cli/main.js",
  workingDir: "/Users/example/workspace/project",
  home: "/Users/example",
  pathEnv: LAUNCHD_PATH,
  lang: "en_US.UTF-8",
  stdoutPath: "/Users/example/.ccmesh/codex-seat/e2e-ab12/log/stdout.log",
  stderrPath: "/Users/example/.ccmesh/codex-seat/e2e-ab12/log/stderr.log",
  throttleSec: 10,
  restartSec: 5,
})

describe("模板占位符替换", () => {
  it("全部替换", () => {
    assert.equal(renderTemplate("a={{A}} b={{B}}", { A: "1", B: "2" }), "a=1 b=2")
  })

  it("留下未替换的占位符要抛，不许把 {{X}} 写进 plist", () => {
    assert.throws(() => renderTemplate("a={{A}} b={{B}}", { A: "1" }), UnreplacedPlaceholderError)
  })

  it("XML 转义（席位目录里真出现过带 & 的路径就完蛋）", () => {
    assert.equal(xmlEscape(`a&b<c>"d"`), "a&amp;b&lt;c&gt;&quot;d&quot;")
  })
})

describe("launchd plist", () => {
  const out = () => renderLaunchdPlist(ctx())

  it("没有残留占位符", () => {
    assert.equal(/\{\{[A-Z_]+\}\}/.test(out()), false)
  })

  it("Label 与 contracts.launchdLabel 一致", () => {
    assert.match(out(), /<key>Label<\/key>\s*<string>com\.aster\.codex-seat\.e2e-ab12<\/string>/)
  })

  it("ProgramArguments 用 node 绝对路径 + dist 入口 + run --seat", () => {
    const s = out()
    assert.match(s, /<string>\/opt\/homebrew\/bin\/node<\/string>/)
    assert.match(s, /<string>\/Users\/example\/AIproject\/cc-mesh\/packages\/codex-seat\/dist\/src\/cli\/main\.js<\/string>/)
    assert.match(s, /<string>run<\/string>\s*<string>--seat<\/string>\s*<string>e2e-ab12<\/string>/)
  })

  it("KeepAlive / RunAtLoad 都在", () => {
    assert.match(out(), /<key>KeepAlive<\/key>\s*<true\/>/)
    assert.match(out(), /<key>RunAtLoad<\/key>\s*<true\/>/)
  })

  it("显式 PATH，且含 /opt/homebrew/bin（launchd 只给系统四目录）", () => {
    const s = out()
    assert.match(s, /<key>PATH<\/key>\s*<string>[^<]*\/opt\/homebrew\/bin[^<]*<\/string>/)
    assert.match(s, /<key>HOME<\/key>\s*<string>\/Users\/example<\/string>/)
  })

  it("StandardOut/ErrorPath 指向席位 log 目录", () => {
    const p = seatPaths("e2e-ab12", "/Users/example")
    const s = out()
    assert.equal(s.includes(`${p.logDir}/stdout.log`), true)
    assert.equal(s.includes(`${p.logDir}/stderr.log`), true)
  })

  it("绝不含故障注入开关", () => {
    const s = out()
    assert.equal(s.includes("CODEX_SEAT_ALLOW_FAULTS"), false)
    assert.equal(s.includes("CODEX_SEAT_FAULT"), false)
  })

  it("绝不含 --remote-control", () => {
    assert.equal(out().includes("--remote-control"), false)
  })

  it("所有 <string> 里的路径参数都是绝对路径", () => {
    const s = out()
    const args = [...s.matchAll(/<string>(\/[^<]*|[^<\/][^<]*)<\/string>/g)].map((m) => m[1]!)
    const pathish = args.filter((a) => a.includes("/") && !a.includes(":"))
    for (const a of pathish) assert.equal(a.startsWith("/"), true, `不是绝对路径: ${a}`)
  })
})

describe("systemd unit", () => {
  const out = () => renderSystemdUnit(ctx())

  it("没有残留占位符", () => {
    assert.equal(/\{\{[A-Z_]+\}\}/.test(out()), false)
  })

  it("Restart=always + 显式 PATH + KillMode=control-group", () => {
    const s = out()
    assert.match(s, /^Restart=always$/m)
    assert.match(s, /^Environment=PATH=.+$/m)
    assert.match(s, /^KillMode=control-group$/m)
  })

  it("ExecStart 是绝对路径的 node + dist 入口", () => {
    assert.match(out(), /^ExecStart=\/opt\/homebrew\/bin\/node \/Users\/.*\/dist\/src\/cli\/main\.js run --seat e2e-ab12$/m)
  })

  it("绝不含故障注入开关", () => {
    assert.equal(out().includes("CODEX_SEAT_ALLOW_FAULTS"), false)
  })
})

describe("上下文推导", () => {
  it("cliEntry 落在包的 dist 下且绝对", () => {
    const c = buildSupervisorContext({
      seat: "codex-main",
      workingDir: "/Users/example/workspace/project",
      homeDir: "/Users/example",
    })
    assert.equal(c.cliEntry.startsWith("/"), true)
    assert.equal(c.cliEntry.endsWith("/dist/src/cli/main.js"), true)
    assert.equal(c.label, launchdLabel("codex-main"))
    assert.equal(c.unit, systemdUnitName("codex-main"))
  })

  it("nodeBin 是绝对路径（launchd 下 PATH 为空，不能靠 env node）", () => {
    const c = buildSupervisorContext({ seat: "s", workingDir: "/tmp", homeDir: "/Users/example" })
    assert.equal(c.nodeBin.startsWith("/"), true)
  })
})

describe("node 路径要稳定（brew upgrade 不能把席位干掉）", () => {
  it("优先 /opt/homebrew/bin/node，不用 Cellar 里带版本号的实路径", async () => {
    const { resolveStableNodeBin } = await import("./templates.js")
    assert.equal(resolveStableNodeBin((p) => p === "/opt/homebrew/bin/node"), "/opt/homebrew/bin/node")
  })
  it("候选都不在时退回 process.execPath（总比没有强）", async () => {
    const { resolveStableNodeBin } = await import("./templates.js")
    assert.equal(resolveStableNodeBin(() => false), process.execPath)
  })
})
