#!/usr/bin/env bash
# Instala o motor de transcricao local (whisper.cpp) e o servico systemd.
#
# Idempotente: pode rodar de novo para atualizar binario/modelo sem apagar
# dados. Se a compilacao ou o download falharem, NAO derruba o backend: apenas
# avisa que os audios locais ficarao aguardando.
#
# Uso:
#   sudo bash scripts/install-stt.sh
#   LINK_STT_MODEL=base sudo bash scripts/install-stt.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/assistente-zap}"
APP_USER="${APP_USER:-zap}"
MODEL_NAME="${LINK_STT_MODEL:-tiny}"
WHISPER_REF="${WHISPER_REF:-v1.7.4}"
STT_DIR="$APP_DIR/vendor/whisper.cpp"
MODEL_DIR="$APP_DIR/models"
MODEL_FILE="$MODEL_DIR/ggml-${MODEL_NAME}.bin"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 1)}"
PORT="${LINK_STT_WORKER_PORT:-8191}"
LANG_NAME="${LINK_STT_LANG:-pt}"
THREADS="${LINK_STT_THREADS:-1}"
[[ "$THREADS" =~ ^[0-9]+$ ]] || THREADS=1
[[ "$LANG_NAME" =~ ^[A-Za-z-]+$ ]] || LANG_NAME=pt

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${YELLOW}==>${NC} $*"; }
ok()   { echo -e "${GREEN}OK${NC}  $*"; }
warn() { echo -e "${RED}aviso${NC} $*" >&2; }

[[ $EUID -eq 0 ]] || { echo "execute como root (sudo bash scripts/install-stt.sh)" >&2; exit 1; }

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  warn "usuario $APP_USER nao existe; rode primeiro scripts/install.sh"
  exit 1
fi

# ---------------------------------------------------------------- dependencias
if ! command -v cmake >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1 ||
   ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  info "Instalando cmake/build-essential/git/curl (compilacao unica)"
  apt-get update -y >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential cmake git curl >/dev/null 2>&1 || true
fi
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  info "Instalando FFmpeg/FFprobe (conversao para WAV 16 kHz)"
  apt-get update -y >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg >/dev/null 2>&1 || true
fi
for cmd in cmake g++ git curl ffmpeg ffprobe; do
  command -v "$cmd" >/dev/null 2>&1 || { warn "dependencia ausente: $cmd"; exit 1; }
done

mkdir -p "$STT_DIR" "$MODEL_DIR" "$APP_DIR/data/stt/tmp" "$APP_DIR/data/stt/cache"

# ---------------------------------------------------------------- whisper.cpp
find_bin() {
  local name="$1"
  find "$STT_DIR/build" -maxdepth 4 -type f -name "$name" -perm -u+x 2>/dev/null | head -n1 || true
}

SERVER_BIN="$(find_bin whisper-server)"
CLI_BIN="$(find_bin whisper-cli)"
[[ -z "$SERVER_BIN" ]] && SERVER_BIN="$(find_bin server)"
[[ -z "$CLI_BIN" ]] && CLI_BIN="$(find_bin main)"

CURRENT_REF="$(git -C "$STT_DIR" describe --tags --exact-match 2>/dev/null || true)"
if [[ -z "$SERVER_BIN" || -z "$CLI_BIN" || "$CURRENT_REF" != "$WHISPER_REF" ]]; then
  info "Compilando whisper.cpp ($WHISPER_REF) com $JOBS job(s)"
  if [[ -d "$STT_DIR/.git" ]]; then
    git -C "$STT_DIR" fetch --depth 1 origin "+refs/tags/${WHISPER_REF}:refs/tags/${WHISPER_REF}" >/dev/null 2>&1 || {
      warn "nao foi possivel atualizar o whisper.cpp"
      exit 1
    }
    git -C "$STT_DIR" checkout -f "$WHISPER_REF" >/dev/null 2>&1 || {
      warn "nao foi possivel selecionar a versao $WHISPER_REF"
      exit 1
    }
  else
    rm -rf "$STT_DIR"
    git clone --depth 1 --branch "$WHISPER_REF" https://github.com/ggerganov/whisper.cpp "$STT_DIR" || {
      warn "nao foi possivel clonar o whisper.cpp"
      exit 1
    }
  fi
  cmake -S "$STT_DIR" -B "$STT_DIR/build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DWHISPER_BUILD_EXAMPLES=ON \
    -DWHISPER_BUILD_TESTS=OFF >/dev/null
  if ! cmake --build "$STT_DIR/build" -j"$JOBS" --target whisper-server whisper-cli >/dev/null 2>&1; then
    if ! cmake --build "$STT_DIR/build" -j"$JOBS" --target server main >/dev/null 2>&1; then
      cmake --build "$STT_DIR/build" -j"$JOBS" >/dev/null || {
        warn "compilacao do whisper.cpp falhou"
        exit 1
      }
    fi
  fi
  SERVER_BIN="$(find_bin whisper-server)"; [[ -z "$SERVER_BIN" ]] && SERVER_BIN="$(find_bin server)"
  CLI_BIN="$(find_bin whisper-cli)"; [[ -z "$CLI_BIN" ]] && CLI_BIN="$(find_bin main)"
fi

if [[ -z "$SERVER_BIN" || -z "$CLI_BIN" ]]; then
  warn "binarios do whisper.cpp nao encontrados apos a compilacao"
  exit 1
fi

# Nomes estaveis usados pelo servico e pelo modo cli.
mkdir -p "$STT_DIR/build/bin"
[[ "$SERVER_BIN" != "$STT_DIR/build/bin/whisper-server" ]] && cp -f "$SERVER_BIN" "$STT_DIR/build/bin/whisper-server"
[[ "$CLI_BIN" != "$STT_DIR/build/bin/whisper-cli" ]] && cp -f "$CLI_BIN" "$STT_DIR/build/bin/whisper-cli"
chmod 0755 "$STT_DIR/build/bin/whisper-server" "$STT_DIR/build/bin/whisper-cli"
ok "binarios prontos: $(du -h "$STT_DIR/build/bin/whisper-server" | cut -f1) + $(du -h "$STT_DIR/build/bin/whisper-cli" | cut -f1)"

# ---------------------------------------------------------------- modelo
if [[ ! -s "$MODEL_FILE" ]]; then
  info "Baixando modelo ggml-${MODEL_NAME} (uma vez)"
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 \
    -o "$MODEL_FILE.part" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL_NAME}.bin" || true
  if [[ -s "$MODEL_FILE.part" ]] && [[ "$(stat -c%s "$MODEL_FILE.part" 2>/dev/null || echo 0)" -gt 1000000 ]]; then
    mv "$MODEL_FILE.part" "$MODEL_FILE"
  else
    rm -f "$MODEL_FILE.part"
    warn "download do modelo falhou; transcricao local ficara indisponivel"
    warn "o bot continua no ar. Para usar a API externa enquanto isso: LINK_STT_ENGINE=api no .env"
    exit 1
  fi
fi
ok "modelo: $MODEL_FILE ($(du -h "$MODEL_FILE" | cut -f1))"

# O servico roda como $APP_USER: dono correto antes de subir.
chown -R "$APP_USER:$APP_USER" "$STT_DIR" "$MODEL_DIR" "$APP_DIR/data/stt" 2>/dev/null || true

# ---------------------------------------------------------------- servico
UNIT_SRC="$APP_DIR/deploy/assistente-zap-stt.service"
if [[ -f "$UNIT_SRC" ]]; then
  sed -e "s#/opt/assistente-zap#$APP_DIR#g" \
      -e "s#ggml-tiny.bin#ggml-${MODEL_NAME}.bin#g" \
      -e "s#^User=zap#User=$APP_USER#" \
      -e "s#^Group=zap#Group=$APP_USER#" \
      -e "s#--port 8191#--port $PORT#" \
      -e "s#-t 1#-t $THREADS#" \
      -e "s#-l pt#-l $LANG_NAME#" \
      "$UNIT_SRC" > /etc/systemd/system/assistente-zap-stt.service
  systemctl daemon-reload
  systemctl enable assistente-zap-stt >/dev/null 2>&1 || true
  systemctl restart assistente-zap-stt || true
else
  warn "unit $UNIT_SRC nao encontrada; servico nao instalado"
fi

# ---------------------------------------------------------------- defaults .env
add_env() {
  local key="$1" value="$2"
  grep -qE "^${key}=" "$APP_DIR/.env" 2>/dev/null || echo "${key}=${value}" >> "$APP_DIR/.env"
}
if [[ -f "$APP_DIR/.env" ]]; then
  if [[ -s "$APP_DIR/.env" && -n "$(tail -c 1 "$APP_DIR/.env")" ]]; then
    printf '\n' >> "$APP_DIR/.env"
  fi
  add_env LINK_STT_ENGINE local
  add_env LINK_STT_MODEL "$MODEL_NAME"
  add_env LINK_STT_LANG "$LANG_NAME"
  add_env LINK_STT_THREADS "$THREADS"
  add_env LINK_STT_CONCURRENCY 1
  add_env LINK_STT_WORKER_URL "http://127.0.0.1:${PORT}"
  add_env LINK_STT_FALLBACK_API 0
  add_env LINK_STT_CLI_PATH "$STT_DIR/build/bin/whisper-cli"
  add_env LINK_STT_MODEL_PATH "$MODEL_FILE"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
fi

# ---------------------------------------------------------------- smoke test
info "Testando o motor local em 127.0.0.1:${PORT}"
TMP_WAV="$(mktemp /tmp/stt-smoke-XXXX.wav)"
if command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=frequency=440:duration=1" \
    -ar 16000 -ac 1 -y "$TMP_WAV" >/dev/null 2>&1 || true
fi

HEAD_OK=0
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" 2>/dev/null || true)"
  if [[ "$code" =~ ^[1-4][0-9][0-9]$ ]]; then HEAD_OK=1; break; fi
  sleep 2
done

INFER_OK=0
if [[ -s "$TMP_WAV" ]]; then
  for _ in $(seq 1 15); do
    response="$(curl -s -w '\n%{http_code}' \
      -F "file=@${TMP_WAV}" \
      -F "response_format=json" \
      -F "language=${LANG_NAME}" \
      "http://127.0.0.1:${PORT}/inference" 2>/dev/null || true)"
    code="${response##*$'\n'}"
    payload="${response%$'\n'*}"
    if [[ "$code" == "200" ]] && printf '%s' "$payload" | grep -q '"text"'; then
      INFER_OK=1
      break
    fi
    sleep 2
  done
fi
rm -f "$TMP_WAV"

if [[ "$HEAD_OK" == "1" && "$INFER_OK" == "1" ]]; then
  ok "transcricao local respondendo (HTTP 200)"
else
  warn "servico subiu mas nao respondeu ao teste (head=$HEAD_OK infer=$INFER_OK)."
  warn "Veja: journalctl -u assistente-zap-stt -n 80 --no-pager"
  warn "O bot continua no ar; audios locais ficarao aguardando ate o servico responder."
fi

echo
echo "Memoria do worker (limite 700 MB):"
systemctl show assistente-zap-stt -p MemoryCurrent 2>/dev/null || true
echo "Logs: journalctl -u assistente-zap-stt -f"
