# syntax=docker/dockerfile:1.4
# Endless Test API 生产镜像（项目根目录版本）
# 多阶段构建：先编译 TypeScript，再复制产物到精简运行镜像

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# 阶段一：依赖安装与 TypeScript 编译
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /build

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --omit=optional --no-audit --no-fund

COPY *.ts ./
RUN npx tsc --noEmit false && \
    node -e "const fs=require('fs'); const s=require('./dist/swagger.config'); fs.writeFileSync('./dist/swagger.json', JSON.stringify(s, null, 2));"

# ---------------------------------------------------------------------------
# 阶段二：运行镜像（仅包含产物与生产依赖）
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app

RUN addgroup -g 1001 endless && \
    adduser -u 1001 -G endless -s /bin/sh -D endless

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund && \
    npm cache clean --force

COPY --from=builder /build/dist ./dist
COPY public ./public

RUN mkdir -p /app/data/logs && chown -R endless:endless /app
VOLUME ["/app/data"]

USER endless

EXPOSE 3001
ENV ENDLESS_SIDECAR_PORT=3001
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
