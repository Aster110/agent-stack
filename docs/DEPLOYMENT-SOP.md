# 从新电脑搭建自己的主脑：交给 Codex 执行的 SOP

目标：多台电脑和服务器固定同一个公开发行版；微信派单，服务器主脑指定电脑执行，核验交付物后回原微信上下文。唯一源码：[Aster110/agent-stack](https://github.com/Aster110/agent-stack)。当前为 **v0.1.0-rc.2 候选版**，稳定标准见 [版本政策](RELEASE-POLICY.md)。

把本 SOP 和服务器 SSH 入口交给本机 Codex，它执行软件准备、配置、部署和验证；本人完成登录、扫码、MFA。不安装旧 npm cc-mesh，不访问作者的私有仓。

## 1. 最小条件与架构

需要一台可通过 SSH 管理的 Linux 服务器、一台 macOS/Linux 电脑、两端可用的 Codex 登录、扫码微信。电脑须保持开机联网；睡眠时不能执行任务。支持 macOS、Debian/Ubuntu 的 arm64/x64；现场已验证 macOS arm64、Linux x64，其余架构待验收。Windows 不属于本版安装路径。

本版 Linux 托管入口使用 root，Codex 登录和服务必须在同一 root 账号下。Mac 使用已登录桌面用户，退出该账号会停止用户服务。未实现 Linux 普通用户的服务安装向导。

| 组件 | 主脑服务器 | 每台电脑 / 执行服务器 |
|---|---|---|
| 相同标签源码、Node、Codex CLI | 安装 | 安装 |
| Hub：跨设备路由 | 启动一个 | 不启动 |
| relay：本地消息接口 | 启动一个 | 启动一个 |
| agent-runtime → Codex app-server | role=brain | role=computer 或 server |
| WeChat transport | 配置启用 | 不启用 |
| SSH 隧道 | 接受现有 SSH | 系统托管并重连 |

微信和 mesh 共用主脑 runtime 的持久化队列、Codex thread。app-server 用 stdio JSON-RPC，mesh 用 relay pull。**tmux 不承担新方案的通信或上下文保存**。主脑不再额外启动 cc2wechat daemon；多一个角色不是维护另一份代码。

## 2. 两端安装同一标签

服务器和每台电脑分别执行。每次升级用新目录，不在运行目录 `git pull main`。

```bash
git clone --branch v0.1.0-rc.2 https://github.com/Aster110/agent-stack.git agent-stack-v0.1.0-rc.2
cd agent-stack-v0.1.0-rc.2
bash scripts/bootstrap.sh
source .tools/env.sh
codex login
codex login status
python3 scripts/source-version.py --verify
```

没有 Git 的新 Mac 可下载 Release ZIP，解压后双击 `一键准备.command`。脚本安装项目内 Node 24.13.0、pnpm 10.13.1、Codex CLI 0.153.4 并构建；Linux 缺依赖调用 apt，Mac 缺开发工具会打开系统安装窗口，完成后重跑。不安装 tmux，不改全局 Node，不自动启动服务。镜像下载仍校验官方 SHA256；下载失败要解决网络，不能忽略校验。

`source .tools/env.sh` 对当前终端生效，服务自行使用绝对路径。官方登录以安装的 `codex login --help` 为准，不复制别人的认证。账号与网络可用性必须实际核验。

ZIP 不含 Git 历史，source-version 的 commit 会为 null；此时用 Release 页面列出的提交和源码哈希核对，不把 null 当作已证明相同提交。跨机 sourceHash 仍须一致。

## 3. 服务器生成配置、扫码和启动

下面在服务器 root 的源码目录执行。先确认 19800、19900 空闲；冲突时选新端口并同步全部相关配置。Hub、relay 默认只绑定回环地址，电脑经 SSH 隧道连接，不需要先准备域名、证书或开放新的公网服务端口。

```bash
mkdir -p /root/.config/agent-stack
chmod 700 /root/.config/agent-stack
python3 - <<'PY'
from pathlib import Path
import os,secrets
p=Path('/root/.config/agent-stack/network-token')
with p.open('x') as f:
    os.chmod(p,0o600)
    f.write(secrets.token_hex(32)+'\n')
PY
python3 scripts/deploy.py init \
  --profile /root/.config/agent-stack/server \
  --role brain --device server --seat brain \
  --workspace /root/agent-work \
  --peer computer1:codex-main \
  --token-file /root/.config/agent-stack/network-token
node scripts/pair-wechat.mjs /root/.config/agent-stack/server
```

本人扫描二维码并确认。配对从微信确认接口取得 owner ID，凭证写入权限 600 文件，不打印 token，不自动信任第一个发信的人。平台若省略 owner ID，取得可验证的本人 ID 后作为配对命令第二参数；不能随便绑定陌生来信。不要在已有同账号 receiver 运行时启动另一个。

```bash
node packages/agent-runtime/dist/cli.js check /root/.config/agent-stack/server/runtime.json
python3 scripts/deploy.py install --profile /root/.config/agent-stack/server
python3 scripts/deploy.py status --profile /root/.config/agent-stack/server
```

安装器启动 `org.agentstack.server.hub`、`.relay`、`.runtime` 三个 systemd 服务。`check` 只验证结构。本人先向新微信对话发消息，随后验证实际回复。

## 4. 电脑连接服务器

部署 AI 按用户给定入口配置 SSH 别名 `my-server`，核对主机密钥并完成 SSH key 登录；不要关闭主机密钥检查。先验证 `ssh -o BatchMode=yes my-server true`，后台隧道不能交互输入密码。以下在电脑源码目录执行：

```bash
mkdir -p "$HOME/.config/agent-stack"
chmod 700 "$HOME/.config/agent-stack"
scp my-server:/root/.config/agent-stack/network-token "$HOME/.config/agent-stack/network-token"
chmod 600 "$HOME/.config/agent-stack/network-token"
python3 scripts/deploy.py init \
  --profile "$HOME/.config/agent-stack/computer1" \
  --role computer --device computer1 --seat codex-main \
  --workspace "$HOME/agent-work" \
  --peer server:brain --ssh my-server \
  --token-file "$HOME/.config/agent-stack/network-token"
python3 scripts/deploy.py install --profile "$HOME/.config/agent-stack/computer1"
python3 scripts/deploy.py status --profile "$HOME/.config/agent-stack/computer1"
```

电脑 tunnel 将本地 19900 转发到服务器回环 19900，relay 连接它。Mac 用 launchd，Linux 用 systemd。`install --render-only` 只生成服务文件；重复 install 不覆盖不同内容的已有定义。旧机器试用须选独立 profile、设备名、relay 端口和隧道端口，避开旧服务。

Mac 日志在 profile 的 `logs/`。Linux 用 `journalctl -u org.agentstack.<device>.<component>.service`。`deployment.json` 含 token，`runtime.json` 含本机配置；均在源码之外，不提交、不截图分享。服务停止用 `deploy.py stop --profile ...`，同 profile 再 install 可重新启动。

## 5. 增加电脑、服务器与 Claude App

新增设备重复第 2、4 步，使用同一标签，设备名改为 computer2 等。执行服务器使用 `--role server`，同样连接主脑 Hub。各机独立登录、独立状态，不共享 SQLite。

主脑 `runtime.json` 的 peerNodes 加入完整节点 `computer2:codex-main`，新电脑保留 `server:brain`。确认主脑没有任务执行后，重启主脑 runtime 加载配置；不使用通配符，不让两台设备共用 device ID。

Claude App 为可选项：同仓 relay 保留 `/api/events` SSE、`/api/sync` pull 和公开 `skills/cc-mesh/SKILL.md`。Claude 自己管理模型进程，协议不同于 Codex。新的 Claude App 自动配对与现场验收尚未完成；先跑通 Codex 最小路径，不能声称 Claude 已一键可用。

## 6. 现场验收：必须核验结果

证据只留在本机私有目录：

1. 两端 source-version 的 release/commit/sourceHash 一致，系统服务实际入口指向该目录，Node/Codex 版本符合锁定值。
2. `curl --noproxy '*' http://127.0.0.1:19800/api/status` 显示本机席位持续 sync、uplink connected；`/api/devices` 看到另一端。
3. 本人微信发送：“让 computer1 在工作目录创建 acceptance.txt，写入本次随机码，实际读回后告诉我路径和内容。”部署 AI 独立读取电脑文件，匹配随机码；用户在原微信对话看到结果。
4. 追问随机码，重启 runtime 后再次追问，核对 thread ID 保持；旧任务没有重做。模型自报记得不够。
5. 无在途任务时停止、恢复电脑 tunnel，验证重连和下一次真实任务。不要切断正在工作的全机网络。
6. 按版本政策持续观察无丢任务、重复执行、错误回程、意外换会话、孤儿进程增长。

accepted、HTTP 200、PID 或单元测试通过均不能替代微信与文件闭环。微信空闲过期返回 errcode=-2 时，本人先发信恢复会话；不能反复重跑模型补发。

## 7. 升级、回退与旧主脑

新发行版进入新源码目录并 bootstrap，保存旧源码、服务定义与停止后的一致状态备份。运行任务排空后再切换；源码启动时核对 profile 创建时的 sourceHash，源码被改动会拒绝启动。不要在旧 profile 改 source 字段绕过校验。

新状态适合首次安装。已有席位/主脑要保留 thread、WAL、mesh cursor、微信 cursor/owner 和待发结果。本版没有将旧 tmux/cc2wechat 主脑直接无损导入的一键命令；空 stateRoot 不算迁移，cursor=0 不能重放历史。状态导入与回滚未核验时保留旧主脑运行。

runtime contract=6，旧二进制不能写新状态。回退使用一致备份，不让新旧桥同时轮询同一微信账号或消费同一席位。状态异常保留现场，不删除数据库“修复”。

对外只分享本仓标签、源码 ZIP 和本 SOP。机器地址、SSH config、凭证、实际工作目录、会话记录及内部迁移清单不属于分享包。
