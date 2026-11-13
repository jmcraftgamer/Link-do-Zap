#!/usr/bin/env bash
# HTTPS (Let's Encrypt) para o backend do Assistente do Zap.
#
# Uso:
#   DOMAIN=zap.seudominio.com EMAIL=voce@email.com sudo bash scripts/setup-https.sh
#
# Requisitos:
#   - O dominio precisa ter um registro A apontando para o IP desta VPS.
#   - Portas 80 e 443 abertas (o install.sh ja libera a 80).
#
# O script e idempotente: pode rodar de novo para renovar/reemitir.
set -euo pipefail

DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
APP_DIR="${APP_DIR:-/opt/assistente-zap}"
PORT="${PORT:-3000}"
FORCE="${FORCE:-0}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${YELLOW}==>${NC} $*"; }
ok()   { echo -e "${GREEN}OK${NC}  $*"; }
fail() { echo -e "${RED}ERRO${NC} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "execute como root (sudo bash scripts/setup-https.sh)"
[[ -n "$DOMAIN" ]] || fail "defina DOMAIN=seu.dominio.com"
[[ -n "$EMAIL" ]] || fail "defina EMAIL=voce@email.com (avisos de renovacao do certificado)"

# O DNS precisa apontar para esta maquina, senao o Let's Encrypt recusa.
IP="$(curl -fsS -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
if [[ -n "$RESOLVED" && "$RESOLVED" != "$IP" && "$FORCE" != "1" ]]; then
  fail "$DOMAIN resolve para $RESOLVED, mas o IP desta VPS e $IP. Ajuste o DNS (registro A) ou rode com FORCE=1."
fi

info "Instalando certbot e Nginx"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y certbot python3-certbot-nginx nginx

# Garante o site publicado antes de pedir o certificado.
if [[ -f "$APP_DIR/deploy/nginx-assistente-zap.conf" ]]; then
  info "Publicando o site do Assistente do Zap"
  sed "s/127.0.0.1:3000/127.0.0.1:$PORT/g" \
    "$APP_DIR/deploy/nginx-assistente-zap.conf" > /etc/nginx/sites-available/assistente-zap
  ln -sf /etc/nginx/sites-available/assistente-zap /etc/nginx/sites-enabled/assistente-zap
  rm -f /etc/nginx/sites-enabled/default
  nginx -t
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl restart nginx
fi

info "Emitindo certificado para $DOMAIN"
certbot --nginx \
  -d "$DOMAIN" \
  --non-interactive \
  --agree-tos \
  -m "$EMAIL" \
  --redirect \
  --keep-until-expiring

# Renovacao automatica (o pacote ja cria o timer; garantimos habilitado).
systemctl enable --now certbot.timer >/dev/null 2>&1 || true

if command -v ufw >/dev/null 2>&1; then
  ufw allow 443/tcp >/dev/null || true
fi

info "Validando HTTPS"
for i in $(seq 1 15); do
  if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then
    ok "HTTPS no ar"
    break
  fi
  sleep 2
  [[ $i -eq 15 ]] && fail "https://$DOMAIN/health nao respondeu. Veja: nginx -t && certbot certificates"
done

echo
ok "Pronto"
echo "  Painel:        https://$DOMAIN"
echo "  Health:        https://$DOMAIN/health"
echo "  No Setup:      LINK_API_URL=https://$DOMAIN"
echo "  Renovacao:     systemctl list-timers certbot.timer"
