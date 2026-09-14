# E18 —— Linux 档（systemd --user）的容器镜像。
#
# ⚠️ 本机（computer2）**没有 docker/colima/podman**，所以这份 Dockerfile 只写不跑，
#    证据目录里有 E18.skipped.json 写明原因。真跑要么在测试设备（真 Linux + systemd），
#    要么在装了容器运行时的机器上。
#
# 🔴 凭据红线：**绝不 bake 任何凭据进镜像**。CODEX_HOME 在 run 时以**只读**方式挂进来
#    （`-v $HOME/.codex:/home/seat/.codex:ro`），镜像里一个 token 都没有。
#    容器里也不放 hub-token；E14 用假 Hub。
FROM ubuntu:24.04

ARG NODE_MAJOR=22
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git tmux procps python3 systemd systemd-sysv dbus \
    && rm -rf /var/lib/apt/lists/*

# Node（NodeSource）——systemd unit 里写死绝对路径 /usr/bin/node
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9 @openai/codex

# 非 root 用户：systemd --user 必须有真实用户会话，root 跑不出这个场景
RUN useradd -m -s /bin/bash seat && mkdir -p /home/seat/.config/systemd/user && chown -R seat:seat /home/seat

USER seat
WORKDIR /home/seat/cc-mesh

# 代码在 run 时挂进来（-v <repo>:/home/seat/cc-mesh:ro 之外还要一个可写的 dist）
ENV PATH=/usr/local/bin:/usr/bin:/bin:/home/seat/.local/bin
ENV CODEX_HOME=/home/seat/.codex

CMD ["/bin/bash"]
