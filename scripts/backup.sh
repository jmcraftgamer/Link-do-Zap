#!/usr/bin/env bash
# Backup diario dos dados do Assistente do Zap (config + sessoes do WhatsApp).
# Uso: bash scripts/backup.sh [destino]
# Agende com cron: 0 3 * * * BACKUP_STOP_SERVICE=1 /opt/assistente-zap/scripts/backup.sh
#
# Por padrao o servico e parado durante a copia: o WhatsApp grava na sessao o
# tempo todo e um tar "ao vivo" pode gerar um backup inconsistente.
# Use BACKUP_STOP_SERVICE=0 para copiar com o servico no ar (nao recomendado).
#
# Os dados contem conversas e contatos de clientes (LGPD). Para criptografar:
#   BACKUP_PASSPHRASE='frase-longa-e-secreta' bash scripts/backup.sh
# O arquivo sai como .tar.gz.enc e o restore.sh pede a mesma frase.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/assistente-zap}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
DEST="${1:-$APP_DIR/backups}"
KEEP="${KEEP:-7}"
SERVICE="${SERVICE:-assistente-zap}"
STOP_SERVICE="${BACKUP_STOP_SERVICE:-1}"
STAMP="$(date +%Y%m%d_%H%M%S)"
FILE="$DEST/assistente-zap_${STAMP}.tar.gz"

SERVICE_STOPPED=0

start_service() {
  if [[ "$SERVICE_STOPPED" == "1" ]]; then
    systemctl start "$SERVICE" >/dev/null 2>&1 || echo "aviso: falha ao reiniciar $SERVICE" >&2
    SERVICE_STOPPED=0
  fi
}
trap start_service EXIT

mkdir -p "$DEST"
if [[ ! -d "$DATA_DIR" ]]; then
  echo "pasta de dados nao encontrada: $DATA_DIR" >&2
  exit 1
fi

if [[ "$STOP_SERVICE" == "1" ]] && command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet "$SERVICE"; then
    echo "Parando $SERVICE para copiar a sessao do WhatsApp com seguranca..."
    if systemctl stop "$SERVICE"; then
      SERVICE_STOPPED=1
      # Espera o processo liberar os arquivos de sessao.
      for _ in $(seq 1 15); do
        systemctl is-active --quiet "$SERVICE" || break
        sleep 1
      done
      sleep 2
    else
      echo "aviso: nao foi possivel parar $SERVICE; backup sera feito com o servico no ar" >&2
    fi
  fi
fi

echo "Gerando backup de $DATA_DIR ..."
status=0
tar -czf "$FILE" \
  --warning=no-file-changed \
  --exclude='Cache' \
  --exclude='Code Cache' \
  --exclude='GPUCache' \
  --exclude='DawnCache' \
  --exclude='blob_storage' \
  --exclude='Session Storage' \
  --exclude='.wwebjs_cache' \
  --exclude='*.log' \
  --exclude='Singleton*' \
  --exclude='*.lock' \
  --exclude='LOCK' \
  -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")" \
  || status=$?
# tar retorna 1 quando um arquivo muda durante a leitura; o backup ainda vale.
if [[ "$status" -gt 1 ]]; then
  echo "falha no backup (tar=$status)" >&2
  exit 1
fi

if [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
  command -v openssl >/dev/null 2>&1 || { echo "BACKUP_PASSPHRASE definido, mas openssl nao esta instalado" >&2; exit 1; }
  echo "Criptografando backup (AES-256)..."
  openssl enc -aes-256-cbc -pbkdf2 -salt -in "$FILE" -out "$FILE.enc" -pass env:BACKUP_PASSPHRASE
  rm -f "$FILE"
  FILE="$FILE.enc"
fi

SIZE="$(du -h "$FILE" | cut -f1)"
echo "Backup criado: $FILE ($SIZE)"

# Mantem os N mais recentes (inclui os criptografados)
mapfile -t OLD < <(ls -1t "$DEST"/assistente-zap_*.tar.gz* 2>/dev/null | tail -n +$((KEEP + 1)) || true)
for f in "${OLD[@]:-}"; do
  [[ -n "$f" ]] || continue
  echo "Removendo backup antigo: $f"
  rm -f "$f"
done

echo "OK"
