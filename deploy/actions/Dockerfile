# Runtime do bot no GitHub Actions (espelha deploy/Dockerfile.linux, com
# entrypoint proprio). Build com cache GHA no workflow zap-bot.yml.
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb xauth curl ca-certificates git \
    libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 libatspi2.0-0 libuuid1 \
    libsecret-1-0 libgbm1 libasound2 libx11-xcb1 libdrm2 libxcomposite1 \
    libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 libcups2 \
    libatk-bridge2.0-0 libatk1.0-0 libxkbcommon0 \
    fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund

COPY . .

ENV HEADLESS=1 \
    LINK_HTTP_PORT=8123 \
    LINK_HTTP_HOST=127.0.0.1 \
    LINK_DATA_DIR=/data

RUN chmod +x deploy/actions/entry.sh deploy/actions/backup.sh deploy/actions/monitor.sh deploy/actions/dispatch.sh || true

ENTRYPOINT ["bash", "deploy/actions/entry.sh"]
