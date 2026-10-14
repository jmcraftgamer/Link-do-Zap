#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${LINK_APP_DIR:-/opt/link-zap}"
REPO_URL="${LINK_REPO_URL:-}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Preciso de root - rodando de novo com sudo..."
  exec sudo -E env LINK_APP_DIR="$APP_DIR" LINK_REPO_URL="$REPO_URL" bash "$0" "$@"
fi

echo "[1/6] Dependencias do sistema (Electron + Xvfb)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  curl ca-certificates git xvfb xauth \
  libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 libatspi2.0-0 libuuid1 \
  libsecret-1-0 libgbm1 libasound2 libx11-xcb1 libdrm2 libxcomposite1 \
  libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 libcups2 \
  libatk-bridge2.0-0 libatk1.0-0 libxkbcommon0 \
  fonts-liberation fonts-noto-color-emoji

echo "[2/6] Node.js 20"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | tr -d 'v' | cut -d. -f1)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "    node $(node -v) / npm $(npm -v)"

echo "[3/6] Arquivos da aplicacao em $APP_DIR"
if [ -f "$APP_DIR/app.tar.gz" ] && [ ! -f "$APP_DIR/package.json" ]; then
  echo "    Descompactando app.tar.gz..."
  tar xzf "$APP_DIR/app.tar.gz" -C "$APP_DIR"
  rm -f "$APP_DIR/app.tar.gz"
fi
if [ ! -f "$APP_DIR/package.json" ]; then
  if [ -n "$REPO_URL" ]; then
    git clone "$REPO_URL" "$APP_DIR"
  else
    echo "ERRO: $APP_DIR nao tem package.json."
    echo "Copie os arquivos a partir do Windows (PowerShell, na pasta do projeto):"
    echo "    New-Item -ItemType Directory -Force root@IP_DA_VPS:$APP_DIR"
    echo "    scp -r ./* root@IP_DA_VPS:$APP_DIR/"
    exit 1
  fi
fi
cd "$APP_DIR"

echo "[4/6] npm install (baixa o Electron do Linux)"
npm install --no-audit --no-fund

echo "[5/6] Testes antes de ligar - se falhar, o servico NAO e instalado"
npm test

echo "[6/6] Servico systemd (sobe sozinho no boot e se reinicia sozinho)"
mkdir -p "$APP_DIR/data"
sed "s|/opt/link-zap|$APP_DIR|g" "$APP_DIR/deploy/alavps/link-zap.service" > /etc/systemd/system/link-zap.service
chmod +x "$APP_DIR/deploy/alavps/start.sh"
systemctl daemon-reload
systemctl enable link-zap >/dev/null 2>&1

echo ""
echo "SETUP COMPLETO. Proximos passos:"
echo "  1) Iniciar:      systemctl start link-zap"
echo "  2) Ver status:   systemctl status link-zap --no-pager | tail -n 8"
echo "  3) Ver QR:       no NOTEBOOK:  ssh -L 8123:localhost:8123 root@IP_DA_VPS"
echo "                   e abra       http://localhost:8123"
echo "  4) Logs ao vivo: journalctl -u link-zap -f"
