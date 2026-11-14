#!/usr/bin/env bash
# Testa o mecanismo de backup de ponta a ponta:
#   1) gera um backup (sem parar o servico)
#   2) decifra (se necessario)
#   3) extrai num diretorio temporario
#   4) valida todos os JSONs
#   5) limpa tudo
#
# Uso:
#   BACKUP_PASSPHRASE='a-frase-do-.env' bash scripts/verify-backup.sh
#   bash scripts/verify-backup.sh --keep   # mantem o diretorio para inspecao
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/assistente-zap}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
DEST="$(mktemp -d "${TMPDIR:-/tmp}/zap-verify.XXXXXX")"
KEEP="${1:-}"

cleanup() {
  if [[ "$KEEP" != "--keep" ]]; then
    rm -rf "$DEST"
  else
    echo "Diretorio preservado: $DEST"
  fi
}
trap cleanup EXIT

if [[ ! -d "$DATA_DIR" ]]; then
  echo "pasta de dados nao encontrada: $DATA_DIR" >&2
  exit 1
fi

echo "1/4 Gerando backup de teste em $DEST ..."
# BACKUP_STOP_SERVICE=0: nao mexe no servico durante a verificacao.
BACKUP_STOP_SERVICE=0 bash "$APP_DIR/scripts/backup.sh" "$DEST"

FILE="$(ls -1t "$DEST"/assistente-zap_*.tar.gz* 2>/dev/null | head -n1 || true)"
if [[ -z "$FILE" ]]; then
  echo "nenhum backup foi gerado" >&2
  exit 1
fi
echo "    arquivo: $(basename "$FILE")"

SRC="$FILE"
if [[ "$FILE" == *.enc ]]; then
  if [[ -z "${BACKUP_PASSPHRASE:-}" ]]; then
    echo "backup criptografado, mas BACKUP_PASSPHRASE nao foi definido" >&2
    exit 1
  fi
  command -v openssl >/dev/null 2>&1 || { echo "openssl nao esta instalado" >&2; exit 1; }
  echo "2/4 Decifrando ..."
  SRC="$DEST/decrypted.tar.gz"
  openssl enc -d -aes-256-cbc -pbkdf2 -in "$FILE" -out "$SRC" -pass env:BACKUP_PASSPHRASE
else
  echo "2/4 Backup sem criptografia (BACKUP_PASSPHRASE nao definido)"
fi

echo "3/4 Extraindo e validando ..."
mkdir -p "$DEST/extract"
tar -xzf "$SRC" -C "$DEST/extract"

ROOT="$DEST/extract/data"
if [[ ! -d "$ROOT" ]]; then
  echo "estrutura inesperada: pasta data/ nao encontrada no backup" >&2
  exit 1
fi

shopt -s nullglob
JSONS=("$ROOT"/*.json)
bad=0
for f in "${JSONS[@]}"; do
  if ! node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$f" 2>/dev/null; then
    echo "    JSON invalido: $(basename "$f")" >&2
    bad=1
  fi
done

if [[ "$bad" != "0" ]]; then
  echo "4/4 FALHOU: ha JSON corrompido no backup" >&2
  exit 1
fi

echo "    ${#JSONS[@]} arquivo(s) JSON validado(s)"
echo "4/4 OK: backup gerado, decifrado, extraido e validado."
