#!/usr/bin/env bash
# Backup diario dos dados do Assistente do Zap (config + sessoes do WhatsApp).
# Uso: bash scripts/backup.sh [destino]
# Agende com cron: 0 3 * * * /opt/assistente-zap/scripts/backup.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/assistente-zap}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
DEST="${1:-$APP_DIR/backups}"
KEEP="${KEEP:-7}"
STAMP="$(date +%Y%m%d_%H%M%S)"
FILE="$DEST/assistente-zap_${STAMP}.tar.gz"

mkdir -p "$DEST"
if [[ ! -d "$DATA_DIR" ]]; then
  echo "pasta de dados nao encontrada: $DATA_DIR" >&2
  exit 1
fi

echo "Gerando backup de $DATA_DIR ..."
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
  -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")" \
  || status=$?
# tar retorna 1 quando um arquivo muda durante a leitura; o backup ainda vale.
if [[ "${status:-0}" -gt 1 ]]; then
  echo "falha no backup (tar=$status)" >&2
  exit 1
fi

SIZE="$(du -h "$FILE" | cut -f1)"
echo "Backup criado: $FILE ($SIZE)"

# Mantem os N mais recentes
mapfile -t OLD < <(ls -1t "$DEST"/assistente-zap_*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) || true)
for f in "${OLD[@]:-}"; do
  [[ -n "$f" ]] || continue
  echo "Removendo backup antigo: $f"
  rm -f "$f"
done

echo "OK"
