# 给部署 AI 的 SOP

目标：一台服务器运行 Hub、relay 和主脑；电脑运行 relay 和同版 Codex runtime；微信派单，电脑生成可核验交付物，结果回原微信会话。先读 [版本政策](RELEASE-POLICY.md)。本候选版尚未完成新机一键安装和真实手机验收。

## 前置

需要可管理的 Linux 服务器、macOS/Linux 电脑、两端可用的 Codex 登录、扫码微信。两端能访问 Codex，服务器能访问微信接口，电脑能连接服务器 Hub。本人完成账号登录、扫码和必要的 MFA。

两端下载同一标签的源码，执行 `bash scripts/bootstrap.sh`（Mac 也可双击 `一键准备.command`）。它安装独立 Node 24.13.0、pnpm 10.13.1、Codex CLI 0.153.4 并构建；Linux 缺构建工具时用 apt 安装，Mac 缺开发工具时需完成系统窗口后重跑。已有 Node 24 的开发者可用 `scripts/prepare.sh`。准备完成后 `source .tools/env.sh`。脚本不启动服务。不要安装旧 npm `@aster110/cc-mesh` 或克隆旧 cc-core 来补运行时。

使用 `.tools/node_modules/.bin/codex login --help` 及 `login` 完成官方登录，不复制他人的认证文件。服务 PATH 包含项目 `.tools/bin` 和实际 Node、Codex 目录；配置使用绝对路径。`mesh` 由准备脚本链接到同仓 CLI。

## Hub 和 relay

Hub 与主脑在同一服务器，各自是独立进程。生成新的随机 token，以权限 600 保存私有配置。Hub 环境为 `HUB_TOKEN`、`MESH_HUB_PORT`，入口 `node packages/hub/dist/index.js`。旧 Hub 入口在无 token 时允许匿名，仅可用于隔离测试；真实部署必须设置 token。

电脑经私有网络或 TLS 反向代理访问 Hub WebSocket；不得通过公网明文传输 token/消息，不对公网开放本地 relay HTTP。

每机配置 `MESH_DEVICE_ID`（例：server、computer）、`MESH_HUB_URL`、`MESH_HUB_TOKEN`、`RELAY_HTTP_HOST=127.0.0.1`、`RELAY_HTTP_PORT=19800`，运行 `node packages/relay/dist/index.js`。启动后核实实际数据库位置与日志。

Node 服务由 macOS launchd 或 Linux systemd 托管，指定绝对 Node/入口、工作目录、环境、日志和失败重启。候选版尚无统一服务安装向导。`scripts/start-relay.sh` 是保留的 tmux 入口，不用于新统一方案托管。

## 同一运行时的配置

配置保存在源码目录之外，权限 600。以下路径由部署 AI 换成真实绝对路径，不支持 `~` 自动展开。

```json
{
  "version": 1,
  "role": "computer",
  "seat": "codex-main",
  "cwd": "/absolute/workspace",
  "stateRoot": "/absolute/private-state/computer",
  "relayUrl": "http://127.0.0.1:19800",
  "peerNodes": ["server:brain"],
  "codex": {"bin": "/absolute/agent-stack/.tools/node_modules/.bin/codex"},
  "executionPolicy": "full-access"
}
```

主脑改为 `role=brain`、`seat=brain`、独立 stateRoot、`peerNodes=["computer:codex-main"]`，添加：

```json
{
  "relayDatabase": "/absolute/actual-relay-database/mesh.db",
  "wechat": {
    "accountFile": "/absolute/private-config/wechat-account.json",
    "ownerId": "verified-wechat-user-id"
  }
}
```

账号文件为 `{ "accountId": "...", "token": "...", "baseUrl": "..." }`，baseUrl 可省略。仓内 transport 提供 `loginWithQR`；取得账号后，以权限 600 写入，切勿打印 token。ownerId 必须是本次用户确认的平台 ID，不能绑定第一位陌生发信者。完整配对命令与真实手机验收尚未完成。

先执行 `node packages/agent-runtime/dist/cli.js check /absolute/runtime.json`，再以 `run` 启动并托管。check 只验证结构，不代表模型、微信或网络可用。每个 stateRoot 只允许一个进程；不能复用旧桥/旧席位的状态目录，也不能让新旧桥同时轮询同一账号。

## 验收与排障

留下脱敏证据：两机同 release/commit 和实际入口；relay 互相可见；电脑产生此次随机标记的真实文件；微信收到同一标记和结果；重启保持 thread ID，历史任务没有重做。accepted、HTTP 200、PID 或模型自报均不足。首次用独立试用网络和工作目录；真实手机与 48 小时观察通过前不标 stable，不切既有主脑。

- Hub 拒连：核对 token、WebSocket/TLS 路由和时钟，勿打印 token。
- relay 可见但不执行：核对席位 lastSyncAt、peerNodes、Codex 登录和服务 PATH。
- 模型启动失败：核实实际 Node/Codex 和入口，读 app-server stderr。
- 微信 200 但无回执：核实有效平台 message_id，不把空体当成功，不重新执行模型补发。
- 状态损坏：保存目录停止排查，不能删状态或 cursor=0 重放。
- 媒体/动态控制：按 README 的当前能力边界回复。
