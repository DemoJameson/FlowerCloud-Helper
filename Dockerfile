# 本服务不再跑浏览器 —— Cloudflare 人机验证交给 FlareSolverr 处理，
# 这里只需要一个精简的 Node 运行时。
#   之前为cloakbrowser 装的那 20 多个图形库（nss/atk/drm/gbm/…）已全部不需要。
FROM node:22-bookworm-slim

# 订阅回源是 Node fetch 发起的 HTTPS 请求，需要系统 CA 根证书
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    CONFIG_FILE=/data/config.json \
    DEBUG_DIR=/data/debug

# 先只拷清单：依赖层可缓存，改业务代码不会触发重装
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

VOLUME ["/data"]
EXPOSE 8787

# /health 探活；PORT 可被环境变量覆盖，运行时读取
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 用 exec 形式，node 作为 PID 1 直接收到 SIGTERM，配合 src/index.js 的优雅退出
CMD ["node", "src/index.js"]