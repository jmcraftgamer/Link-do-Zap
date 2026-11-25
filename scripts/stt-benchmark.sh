#!/usr/bin/env bash
# Benchmark real do motor de STT local (na VPS, com audio de verdade).
#
# Mede tempo de transcricao, RTF (tempo real fator), RAM do worker e CPU
# consumida. Nao estima nada: os numeros saem do whisper-server em execucao.
#
# Uso:
#   mkdir -p /opt/assistente-zap/benchmark-audio
#   # copie 5-10 audios reais em pt-BR (ogg/mp3/wav/m4a) para essa pasta
#   sudo bash scripts/stt-benchmark.sh
#   sudo bash scripts/stt-benchmark.sh /caminho/com/audios
#
# Para comparar tiny x base:
#   1) LINK_STT_MODEL=tiny sudo bash scripts/install-stt.sh && sudo bash scripts/stt-benchmark.sh
#   2) LINK_STT_MODEL=base sudo bash scripts/install-stt.sh && sudo bash scripts/stt-benchmark.sh
#   (o servico reinicia entre os testes; nunca ha dois modelos carregados)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/assistente-zap}"
SERVICE="${SERVICE:-assistente-zap-stt}"
PORT="${LINK_STT_WORKER_PORT:-8191}"
DIR="${1:-$APP_DIR/benchmark-audio}"
OUT="${OUT:-$APP_DIR/benchmark-stt-$(date +%Y%m%d-%H%M%S).csv}"
URL="http://127.0.0.1:${PORT}/inference"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${YELLOW}==>${NC} $*"; }
ok()   { echo -e "${GREEN}OK${NC}  $*"; }
warn() { echo -e "${RED}aviso${NC} $*" >&2; }

command -v ffmpeg >/dev/null 2>&1 || { warn "ffmpeg nao encontrado"; exit 1; }
command -v ffprobe >/dev/null 2>&1 || { warn "ffprobe nao encontrado"; exit 1; }
command -v curl >/dev/null 2>&1 || { warn "curl nao encontrado"; exit 1; }

if ! systemctl is-active --quiet "$SERVICE"; then
  warn "servico $SERVICE nao esta ativo. Rode: sudo bash scripts/install-stt.sh"
  exit 1
fi

PID="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || echo 0)"
[[ "$PID" =~ ^[0-9]+$ ]] || PID=0

MODEL="?"
if [[ "$PID" -gt 0 && -r "/proc/$PID/cmdline" ]]; then
  MODEL="$(tr '\0' ' ' < "/proc/$PID/cmdline" | sed -n 's/.*-m \([^ ]*\).*/\1/p' || true)"
  MODEL="${MODEL:-?}"
fi

rss_mb() {
  [[ "$PID" -gt 0 ]] || { echo 0; return; }
  local kb
  kb="$(awk '/VmRSS/ {print $2}' "/proc/$PID/status" 2>/dev/null || echo 0)"
  echo $(( kb / 1024 ))
}
cpu_ticks() {
  [[ "$PID" -gt 0 ]] || { echo 0; return; }
  awk '{print $14+$15}' "/proc/$PID/stat" 2>/dev/null || echo 0
}
CLK="$(getconf CLK_TCK 2>/dev/null || echo 100)"

mapfile -t FILES < <(find "$DIR" -maxdepth 1 -type f \( -iname '*.ogg' -o -iname '*.opus' -o -iname '*.mp3' -o -iname '*.wav' -o -iname '*.m4a' -o -iname '*.aac' -o -iname '*.webm' \) | sort)
if [[ ${#FILES[@]} -eq 0 ]]; then
  warn "nenhum audio em $DIR"
  echo "Copie 5-10 audios reais em portugues (diferentes duracoes/ruido) e rode de novo."
  exit 1
fi

info "modelo=$MODEL pid=$PID rss_inicial=$(rss_mb)MB audios=${#FILES[@]}"
free -m
echo ""
printf "%s\n" "arquivo,bytes,duracao_s,ms,rtf,chars,rss_mb,erro" > "$OUT"

START_TICKS="$(cpu_ticks)"
TOTAL_MS=0
TOTAL_DUR=0
FAILS=0

for f in "${FILES[@]}"; do
  tmp="$(mktemp /tmp/stt-bench-XXXX.wav)"
  dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null || echo 0)"
  if ! ffmpeg -hide_banner -loglevel error -y -i "$f" -vn -ac 1 -ar 16000 -c:a pcm_s16le "$tmp" >/dev/null 2>&1; then
    warn "falha ao converter $(basename "$f")"
    printf "%s,%s,%s,0,0,0,%s,conversao\n" "$(basename "$f")" "$(stat -c%s "$f")" "$dur" "$(rss_mb)" >> "$OUT"
    FAILS=$((FAILS + 1))
    rm -f "$tmp"
    continue
  fi

  t0="$(date +%s%3N)"
  body="$(curl -s -m 300 -F "file=@${tmp}" -F "response_format=json" -F "language=pt" "$URL" || true)"
  t1="$(date +%s%3N)"
  ms=$((t1 - t0))
  rm -f "$tmp"

  chars="$(printf '%s' "$body" | node -e "try{const j=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String((j.text||'').trim().length))}catch(e){process.stdout.write('0')}" 2>/dev/null || echo 0)"
  durns="$(awk -v d="$dur" 'BEGIN { if (d+0 > 0) printf "%.2f", d+0; else printf "0" }')"
  rtf="$(awk -v ms="$ms" -v d="$durns" 'BEGIN { if (d+0 > 0) printf "%.2f", (ms/1000)/d; else printf "0" }')"
  err=""
  [[ "$chars" == "0" ]] && err="texto_vazio"

  printf "%s; %ss; %sms; RTF %s; %s chars; RSS %sMB%s\n" \
    "$(basename "$f")" "$durns" "$ms" "$rtf" "$chars" "$(rss_mb)" "${err:+; $err}"
  printf "%s,%s,%s,%s,%s,%s,%s,%s\n" \
    "$(basename "$f")" "$(stat -c%s "$f")" "$durns" "$ms" "$rtf" "$chars" "$(rss_mb)" "$err" >> "$OUT"

  TOTAL_MS=$((TOTAL_MS + ms))
  TOTAL_DUR="$(awk -v a="$TOTAL_DUR" -v b="$durns" 'BEGIN { printf "%.2f", a+b }')"
  [[ -n "$err" ]] && FAILS=$((FAILS + 1))
done

END_TICKS="$(cpu_ticks)"
CPU_MS=$(( (END_TICKS - START_TICKS) * 1000 / CLK ))
COUNT=${#FILES[@]}

echo ""
info "resumo"
echo "audios:        $COUNT (falhas: $FAILS)"
echo "tempo total:   ${TOTAL_MS}ms"
echo "audio total:   ${TOTAL_DUR}s"
echo "RTF medio:     $(awk -v ms="$TOTAL_MS" -v d="$TOTAL_DUR" 'BEGIN { if (d+0 > 0) printf "%.2f", (ms/1000)/d; else printf "0" }') (menor e melhor; <1 = mais rapido que tempo real)"
echo "media por audio: $(awk -v ms="$TOTAL_MS" -v n="$COUNT" 'BEGIN { if (n>0) printf "%.0f", ms/n; else print 0 }')ms"
echo "CPU do worker: ${CPU_MS}ms de CPU para ${TOTAL_MS}ms de parede"
echo "RAM do worker: $(rss_mb)MB (limite systemd 700MB)"
echo "vazao medida:  $(awk -v n="$COUNT" -v ms="$TOTAL_MS" 'BEGIN { if (ms>0) printf "%.1f", n/(ms/60000); else print 0 }') audios/min (1 por vez)"
echo ""
free -m
echo ""
ok "csv: $OUT"
echo "Logs do servico: journalctl -u $SERVICE -n 40 --no-pager"
