#!/usr/bin/env bash
# Restaura um backup gerado por scripts/backup.sh.
# Uso: bash scripts/restore.sh /opt/assistente-zap/backups/arquivo.tar.gz
# Backups criptografados (.tar.gz.enc) exigem BACKUP_PASSPHRASE:
#   BACKUP_PASSPHRASE='frase-longa-e-secreta' bash scripts/restore.sh arquivo.tar.gz.enc
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/assistente-zap}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
APP_USER="${APP_USER:-zap}"
FILE="${1:-}"

if [[ -z "$FILE" || ! -f "$FILE" ]]; then
  echo "Uso: $0 <arquivo.tar.gz|arquivo.tar.gz.enc>" >&2
  exit 1
fi

# Backups criptografados: decifra para um arquivo temporario antes de parar o servico.
SRC="$FILE"
DECRYPTED=""
if [[ "$FILE" == *.enc ]]; then
  if [[ -z "${BACKUP_PASSPHRASE:-}" ]]; then
    echo "Backup criptografado: defina BACKUP_PASSPHRASE antes de restaurar." >&2
    exit 1
  fi
  command -v openssl >/dev/null 2>&1 || { echo "openssl nao esta instalado" >&2; exit 1; }
  echo "Decifrando backup..."
  DECRYPTED="$(mktemp "${TMPDIR:-/tmp}/zap-restore.XXXXXX.tar.gz")"
  openssl enc -d -aes-256-cbc -pbkdf2 -in "$FILE" -out "$DECRYPTED" -pass env:BACKUP_PASSPHRASE
  SRC="$DECRYPTED"
fi

echo "Parando o servico..."
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop assistente-zap || true
  for _ in $(seq 1 15); do
    systemctl is-active --quiet assistente-zap || break
    sleep 1
  done
  sleep 2
fi

# Garante que o servico volte mesmo se a extracao falhar.
trap 'command -v systemctl >/dev/null 2>&1 && systemctl start assistente-zap || true; rm -f "${DECRYPTED:-}"' EXIT

STAMP="$(date +%Y%m%d_%H%M%S)"
if [[ -d "$DATA_DIR" ]]; then
  echo "Preservando dados atuais em ${DATA_DIR}.old-${STAMP}"
  mv "$DATA_DIR" "${DATA_DIR}.old-${STAMP}"
fi
mkdir -p "$DATA_DIR"

echo "Extraindo $FILE ..."
tar -xzf "$SRC" -C "$(dirname "$DATA_DIR")"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"

echo "Iniciando o servico..."
if command -v systemctl >/dev/null 2>&1; then
  systemctl start assistente-zap
fi

PORT="$(grep -E '^PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2 || true)"
PORT="${PORT:-3000}"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "Restauracao concluida e backend no ar."
    exit 0
  fi
  sleep 2
done

echo "AVISO: backend nao respondeu. Veja: journalctl -u assistente-zap -n 120 --no-pager" >&2
exit 1
