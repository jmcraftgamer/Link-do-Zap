#!/usr/bin/env bash
# Instalador do backend do Assistente do Zap (Electron headless + Xvfb + systemd).
# Testado em Ubuntu 22.04/24.04 e Debian 12.
#
# Uso:
#   REPO_URL=https://github.com/usuario/assistente-zap.git bash scripts/install.sh
#   APP_DIR=/opt/assistente-zap REPO_URL=... bash scripts/install.sh
#
# O script e idempotente: pode rodar de novo para atualizar dependencias,
# unit do systemd e configuracao do Nginx sem apagar os dados.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/assistente-zap}"
APP_USER="${APP_USER:-zap}"
PORT="${PORT:-3000}"
REPO_URL="${REPO_URL:-}"
SKIP_NGINX="${SKIP_NGINX:-0}"
NODE_MAJOR="${NODE_MAJOR:-20}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${YELLOW}==>${NC} $*"; }
ok()   { echo -e "${GREEN}OK${NC}  $*"; }
fail() { echo -e "${RED}ERRO${NC} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "execute como root (sudo bash scripts/install.sh)"

info "Atualizando indice de pacotes"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y

BASE_PKGS=(
  curl ca-certificates gnupg git unzip xvfb ffmpeg
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2
  libgbm1 libpangocairo-1.0-0 libpango-1.0-0 libcairo2
  libgtk-3-0 libx11-xcb1 libxss1 libxtst6 fonts-liberation
)
info "Instalando dependencias do sistema"
apt-get install -y "${BASE_PKGS[@]}" || true
# Ubuntu 24.04 renomeou libasound2 para libasound2t64.
apt-get install -y libasound2t64 2>/dev/null || apt-get install -y libasound2 2>/dev/null || true

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 18 ]]; then
  info "Instalando Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
ok "Node $(node -v) / npm $(npm -v)"

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  info "Criando usuario do servico: $APP_USER"
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi

# Fuso horario: vencimento, carencia e campanhas dependem da data local.
if [[ "${SKIP_TIMEZONE:-0}" != "1" ]] && command -v timedatectl >/dev/null 2>&1; then
  info "Ajustando fuso horario para America/Sao_Paulo"
  timedatectl set-timezone America/Sao_Paulo || true
fi

# Swap: Electron + varias paginas do WhatsApp podem estourar 8 GB de RAM.
if [[ "${SKIP_SWAP:-0}" != "1" ]]; then
  if ! swapon --show 2>/dev/null | grep -q .; then
    info "Criando swap de ${SWAP_SIZE:-4G}"
    if fallocate -l "${SWAP_SIZE:-4G}" /swapfile 2>/dev/null; then
      chmod 600 /swapfile
      mkswap /swapfile >/dev/null
      swapon /swapfile
      grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
      grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
      sysctl -p >/dev/null 2>&1 || true
      ok "swap ativo"
    else
      echo "aviso: nao foi possivel criar swap (seguindo sem swap)"
    fi
  else
    ok "swap ja existe"
  fi
fi

if [[ ! -d "$APP_DIR/.git" && ! -f "$APP_DIR/package.json" ]]; then
  if [[ -n "$REPO_URL" ]]; then
    info "Clonando $REPO_URL em $APP_DIR"
    mkdir -p "$(dirname "$APP_DIR")"
    git clone "$REPO_URL" "$APP_DIR"
  else
    fail "codigo nao encontrado em $APP_DIR. Envie os arquivos ou defina REPO_URL."
  fi
fi

mkdir -p "$APP_DIR/data" "$APP_DIR/backups"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

info "Instalando dependencias do projeto (inclui Electron)"
cd "$APP_DIR"
if [[ -f package-lock.json ]]; then
  sudo -u "$APP_USER" npm ci
else
  sudo -u "$APP_USER" npm install
fi

if [[ ! -f "$APP_DIR/.env" ]]; then
  info "Criando .env com senha administrativa aleatoria"
  PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
  JWT_SECRET="$(openssl rand -hex 32)"
  cat > "$APP_DIR/.env" <<EOF
DATA_DIR=$APP_DIR/data
HOST=127.0.0.1
PORT=$PORT
API_PREFIX=/api/v1
ADMIN_PASSWORD=$PASSWORD
JWT_SECRET=$JWT_SECRET
TOKEN_TTL_SECONDS=604800
CORS_ORIGINS=*
MAX_BODY_MB=30
LINK_SERVER_SYNC=0
HEADLESS=1
TZ=America/Sao_Paulo
# Pareamento automatico: gera o codigo no painel e salva em data/pairing-codes.json
LINK_AUTO_PAIR=1
EOF
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
else
  ok ".env existente preservado"
  # Atualiza instalacoes antigas sem sobrescrever o que o usuario ja ajustou.
  grep -q '^JWT_SECRET=' "$APP_DIR/.env" || echo "JWT_SECRET=$(openssl rand -hex 32)" >> "$APP_DIR/.env"
  grep -q '^TZ=' "$APP_DIR/.env" || echo 'TZ=America/Sao_Paulo' >> "$APP_DIR/.env"
  grep -q '^LINK_AUTO_PAIR=' "$APP_DIR/.env" || echo 'LINK_AUTO_PAIR=1' >> "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
fi

if [[ "$SKIP_NGINX" == "1" ]]; then
  info "Sem Nginx: expondo a API direto na porta $PORT"
  sed -i "s/^HOST=.*/HOST=0.0.0.0/" "$APP_DIR/.env"
fi

info "Instalando servico systemd"
install -m 0644 "$APP_DIR/deploy/assistente-zap.service" /etc/systemd/system/assistente-zap.service
systemctl daemon-reload
systemctl enable assistente-zap >/dev/null
systemctl restart assistente-zap

if [[ "$SKIP_NGINX" != "1" ]]; then
  info "Configurando Nginx na porta 80"
  apt-get install -y nginx
  sed "s/127.0.0.1:3000/127.0.0.1:$PORT/g" \
    "$APP_DIR/deploy/nginx-assistente-zap.conf" > /etc/nginx/sites-available/assistente-zap
  ln -sf /etc/nginx/sites-available/assistente-zap /etc/nginx/sites-enabled/assistente-zap
  rm -f /etc/nginx/sites-enabled/default
  nginx -t
  systemctl enable nginx >/dev/null
  systemctl restart nginx
fi

info "Configurando firewall (22/80)"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp >/dev/null || true
  ufw allow 80/tcp >/dev/null || true
  [[ "$SKIP_NGINX" == "1" ]] && ufw allow "$PORT"/tcp >/dev/null || true
  ufw --force enable >/dev/null || true
fi

info "Aguardando o backend responder em /health"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    ok "backend no ar"
    break
  fi
  sleep 2
  [[ $i -eq 30 ]] && fail "backend nao respondeu. Veja: journalctl -u assistente-zap -n 120 --no-pager"
done

IP="$(curl -fsS -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
if [[ "$SKIP_NGINX" == "1" ]]; then
  URL="http://$IP:$PORT"
else
  URL="http://$IP"
fi

echo
ok "Instalacao concluida"
echo "  Painel/API:   $URL"
echo "  Health:       $URL/health"
echo "  Senha admin:  $APP_DIR/.env (ADMIN_PASSWORD) ou $APP_DIR/data/ADMIN_PASSWORD.txt"
echo "  Logs:         journalctl -u assistente-zap -f"
echo "  Backup:       bash $APP_DIR/scripts/backup.sh"
echo
echo "No Setup, defina LINK_API_URL=$URL antes de abrir o painel."
