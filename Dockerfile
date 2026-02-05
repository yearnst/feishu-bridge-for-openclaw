# feishu-bridge Dockerfile
# Build context should be the repo root so we can COPY ../fonts.

FROM node:20-alpine

WORKDIR /app

# Install deps first (better layer caching)
COPY feishu-bridge/package.json feishu-bridge/package-lock.json ./feishu-bridge/
RUN cd feishu-bridge && npm ci --omit=dev

# Copy source
COPY feishu-bridge ./feishu-bridge

# Copy bundled font + license (optional but recommended for CJK PDF embedding)
COPY fonts ./fonts

ENV NODE_ENV=production \
    PORT=8787 \
    FEISHU_DOWNLOAD_DIR=/data/downloads \
    FEISHU_MAX_DOWNLOAD_BYTES=31457280 \
    PDF_CJK_FONT_PATH=/app/fonts/NotoSansCJKsc-Regular.otf

VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "--env-file=feishu-bridge/.env", "feishu-bridge/server.js"]
