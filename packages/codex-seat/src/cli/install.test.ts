/**
 * Lane C —— install/uninstall 的**计划**（先红后绿）。
 * 计划是纯函数：算出装哪个文件、跑哪条命令。真正的副作用在 executeInstallPlan 里，
 * 这样 `--dry-run` 打印的和真跑的是同一份东西，不会出现「dry-run 说得好听、真跑另一套」。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { launchdLabel, systemdUnitName } from "../contracts.js"
import { planInstall, planUninstall } from "./install.js"
import { buildSupervisorContext } from "./templates.js"

const ctx = (platform: NodeJS.Platform) =>
  buildSupervisorContext({
    seat: "e2e-ab12",
    workingDir: "/Users/example/workspace/project",
    homeDir: "/Users/example",
    platform,
    nodeBin: "/opt/homebrew/bin/node",
    cliEntry: "/repo/packages/codex-seat/dist/src/cli/main.js",
  })

describe("install 计划（macOS）", () => {
  const p = () => planInstall({ seat: "e2e-ab12", platform: "darwin", uid: 501, ctx: ctx("darwin") })

  it("装到 ~/Library/LaunchAgents/<label>.plist", () => {
    assert.equal(p().targetPath, `/Users/example/Library/LaunchAgents/${launchdLabel("e2e-ab12")}.plist`)
  })

  it("bootstrap 到 gui/<uid>，不是 system", () => {
    const cmds = p().commands.map((c) => c.join(" "))
    assert.equal(cmds.some((c) => c.includes("bootstrap gui/501")), true)
    assert.equal(cmds.some((c) => c.includes("system/")), false)
  })

  it("先 bootout 再 bootstrap（幂等重装）", () => {
    const cmds = p().commands.map((c) => c.join(" "))
    const bootout = cmds.findIndex((c) => c.includes("bootout"))
    const bootstrap = cmds.findIndex((c) => c.includes("bootstrap"))
    assert.equal(bootout >= 0 && bootstrap > bootout, true)
  })

  it("内容是渲染好的 plist，且不含故障开关", () => {
    const c = p().content
    assert.equal(c.includes("<key>KeepAlive</key>"), true)
    assert.equal(c.includes("CODEX_SEAT_ALLOW_FAULTS"), false)
  })

  it("绝不碰 com.aster.mesh-* 那三个生产 job", () => {
    const all = JSON.stringify(p())
    assert.equal(/com\.aster\.mesh-/.test(all), false)
  })
})

describe("install 计划（Linux）", () => {
  const p = () => planInstall({ seat: "e2e-ab12", platform: "linux", uid: 1000, ctx: ctx("linux") })

  it("装到 ~/.config/systemd/user/<unit>", () => {
    assert.equal(p().targetPath, `/Users/example/.config/systemd/user/${systemdUnitName("e2e-ab12")}`)
  })

  it("命令里有 enable-linger 提示 + daemon-reload + enable --now", () => {
    const cmds = p().commands.map((c) => c.join(" "))
    assert.equal(cmds.some((c) => c.includes("enable-linger")), true)
    assert.equal(cmds.some((c) => c.includes("daemon-reload")), true)
    assert.equal(cmds.some((c) => c.includes("enable") && c.includes("--now")), true)
  })
})

describe("uninstall 计划", () => {
  it("macOS: bootout + 删 plist", () => {
    const p = planUninstall({ seat: "e2e-ab12", platform: "darwin", uid: 501, homeDir: "/Users/example" })
    assert.equal(p.commands.map((c) => c.join(" ")).some((c) => c.includes(`bootout gui/501/${launchdLabel("e2e-ab12")}`)), true)
    assert.equal(p.removePaths.includes(`/Users/example/Library/LaunchAgents/${launchdLabel("e2e-ab12")}.plist`), true)
  })

  it("Linux: disable --now + 删 unit", () => {
    const p = planUninstall({ seat: "e2e-ab12", platform: "linux", uid: 1000, homeDir: "/home/x" })
    assert.equal(p.commands.map((c) => c.join(" ")).some((c) => c.includes("disable") && c.includes("--now")), true)
    assert.equal(p.removePaths.some((x) => x.endsWith(systemdUnitName("e2e-ab12"))), true)
  })

  it("uninstall 只删托管文件，绝不删席位目录（state/wal/rollout 要留着换名用）", () => {
    const p = planUninstall({ seat: "codex-main2", platform: "darwin", uid: 501, homeDir: "/Users/example" })
    assert.equal(p.removePaths.some((x) => x.includes(".ccmesh/codex-seat/")), false)
  })

  it("绝不 bootout com.aster.mesh-*（席位监督器/relay 监督器）", () => {
    for (const seat of ["e2e-ab12", "codex-main"]) {
      const p = planUninstall({ seat, platform: "darwin", uid: 501, homeDir: "/Users/example" })
      assert.equal(/com\.aster\.mesh-/.test(JSON.stringify(p)), false)
    }
  })
})
