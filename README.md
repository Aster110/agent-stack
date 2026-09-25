# Agent Stack

同一份代码，在电脑和服务器运行 Codex 席位，通过 mesh 协作；主脑额外接入微信。Claude App 可使用同仓的 relay pull / SSE 接口。

**当前版本：`v0.1.0-rc.2`，公开候选版。尚未发布生产稳定版，也未完成既有设备的统一迁移。**

```text
微信 → WeChat transport → 主脑 runSeat → Codex app-server
                              ↕
                         本机 relay
                              ↕
                             Hub
                              ↕
                         电脑 relay
                              ↕
                      同一个 runSeat → Codex app-server
```

Hub 通常与主脑部署在同一台服务器，每台设备各有一个本地 relay。微信与 mesh 输入进入主脑同一条持久化队列、同一个 Codex thread。Codex 使用 app-server 的 stdio JSON-RPC；统一运行时无需 tmux。

- [给部署 AI 的 SOP](docs/DEPLOYMENT-SOP.md)
- [版本与升级约定](docs/RELEASE-POLICY.md)
- [架构与恢复契约](docs/UNIFIED-RUNTIME.md)
- [此前候选实现的跨平台测试](docs/UNIFIED-RUNTIME-TEST-REPORT.md)
- [本次公开源码的验证](docs/OPEN-SOURCE-RELEASE.md)

下载版本源码并解压后，macOS 双击 `一键准备.command`；终端执行：

```bash
git clone --branch v0.1.0-rc.2 https://github.com/Aster110/agent-stack.git
cd agent-stack
bash scripts/bootstrap.sh
```

准备脚本校验并安装 Node 24.13.0、pnpm 10.13.1 和 Codex CLI 0.153.4 到项目 `.tools/`，构建全部包，不修改全局 Node、不注册服务。Linux 缺少构建工具时自动用 apt 安装；Mac 如缺开发工具会打开系统安装窗口，完成后重跑。随后按 SOP 使用 deploy.py 生成配置、扫码配对并安装 launchd/systemd 服务；登录与扫码由本人完成。

电脑、服务器和主脑使用 `packages/agent-runtime` 的同一个入口，由配置选择 `computer`、`server` 或 `brain`。主脑开启 `wechat`，不再另外启动 cc2wechat daemon。Hub、relay、Codex 驱动、微信 transport 都在本仓，不需访问私有仓库。

主脑可选开启第三条通道 **brain HTTP channel**（语音 / 文字对话）：`runtime.json` 加 `brainChannel`，只绑 `127.0.0.1`（默认 `18090`），Bearer token 从 0600 的 `tokenFile` 读取，公网暴露由本机已有的隧道（如 cloudflared ingress）负责，本服务自己不开公网口。它与微信、mesh 共用同一条 Codex thread：语音里问的问题，微信里接着聊。接口与恢复语义见[架构与恢复契约 §12](docs/UNIFIED-RUNTIME.md#12-brain-http-channel-voicechat)。

```jsonc
// runtime.json 片段
"brainChannel": { "tokenFile": "/root/.config/agent-stack/<profile>/brain-channel-token", "port": 18090 }
```

```yaml
# /etc/cloudflared/config.yml 片段
ingress:
  - hostname: brain.example.com
    service: http://127.0.0.1:18090
```

候选版支持微信文字、已有语音转写、照片和文件：照片/文件先从微信 CDN 下载解密，校验 MIME、尺寸与 SHA-256 后私有落盘（目录 0700、文件 0600，默认保留 72 小时后自动清理），按原消息顺序标注本地路径交给模型，照片同时作为原生图片输入；下载失败时文字照常送达并注明错误。视频与未转写语音不下载，只如实标注。动态 spawn/close/compact 控制命令的恢复契约未完成，当前禁用；固定配置的常驻席位可以互相派单。Claude App 旧适配仍保留，未验证新的完整 Claude 流程。

这是同一所有者管理设备和本地进程的系统，配置明确启用 `full-access`，不是多租户托管服务。凭证、地址、身份、工作目录和会话数据库属于各自的部署配置。公开版本不会连接作者的基础设施。

构建：`pnpm build`。回归：`pnpm test`、`pnpm test:cli`。MIT，见 [LICENSE](LICENSE) 和 [第三方来源](THIRD_PARTY_NOTICES.md)。
