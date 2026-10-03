# 本服务不再跑浏览器 —— Cloudflare 人机验证交给 FlareSolverr 处理，
# 这里只需要一个精简的 Node 运行时。
#   之前为cloakbrowser 装的那 20 多个图形库（nss/atk/drm/gbm/…）已全部不需要。

# syntax=docker/dockerfile:1.7

# ---- 与架构无关的准备工作，全部在构建机自己的架构（$BUILDPLATFORM，CI 上是
# ---- x64）上原生跑一次，再把产物拷给两个架构。多架构构建时，buildkit 默认
# ---- 会对每个目标架构各跑一遍；下面两步在 QEMU 模拟下要花掉绝大部分时间。
#
#  ·  ca-certificates：产物是 300 个证书文件 + 一个纯文本的 ca-certificates.crt，
#    不含任何架构相关内容，两个架构完全一致，可直接复用
#  ·  npm ci：依赖只有 express 与 dotenv，全是纯 JS、无原生二进制，
#    装出来的 node_modules 逐字节相同
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS prep

# 订阅回源是 Node fetch 发起的 HTTPS 请求，需要系统 CA 根证书。
# node:22-bookworm-slim 本身不带（实测 /etc/ssl 目录都不存在），必须装。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# --mount=type=cache 让 npm 包下载缓存在 builder 里，跨构建复用；
# --no-audit/--no-fund 省掉每次都要联网的全量审计与募捐信息请求
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# ---- 运行时镜像：只有基础镜像 + 上面准备好的产物 + 业务代码 ----
FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    CONFIG_FILE=/data/config.json \
    DEBUG_DIR=/data/debug

COPY --from=prep /etc/ssl/certs /etc/ssl/certs
COPY --from=prep /app/node_modules ./node_modules

# 业务代码放在最后：改代码只失效这一层，不触发前面的准备工作
COPY src ./src

VOLUME ["/data"]
EXPOSE 8787

# /health 探活；PORT 可被环境变量覆盖，运行时读取
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 用 exec 形式，node 作为 PID 1 直接收到 SIGTERM，配合 src/index.js 的优雅退出
CMD ["node", "src/index.js"]
