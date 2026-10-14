#!/usr/bin/env bash
# Dispara a PROXIMA execucao do zap-bot (cadeia 24h).
# Precisa de BOT_PAT: o GITHUB_TOKEN nao dispara workflows (anti-recursao).
set -uo pipefail

BOT_PAT="${BOT_PAT:-}"
REPO="${GITHUB_REPOSITORY:-}"
REF="${GITHUB_REF_NAME:-main}"
MAX_MINUTES="${MAX_MINUTES:-310}"

if [ -z "$BOT_PAT" ]; then
  echo "[DISPATCH] BOT_PAT ausente" >&2
  exit 1
fi
if [ -z "$REPO" ]; then
  echo "[DISPATCH] GITHUB_REPOSITORY ausente" >&2
  exit 1
fi

HTTP=$(curl -sS -o /tmp/dispatch-body.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $BOT_PAT" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/$REPO/actions/workflows/zap-bot.yml/dispatches" \
  -d "{\"ref\":\"$REF\",\"inputs\":{\"max_minutes\":\"$MAX_MINUTES\"}}")

if [ "$HTTP" = "204" ]; then
  echo "[DISPATCH] proxima execucao agendada (max_minutes=$MAX_MINUTES)"
  exit 0
fi

echo "[DISPATCH] HTTP $HTTP - veja /tmp/dispatch-body.json" >&2
cat /tmp/dispatch-body.json >&2 || true
exit 1
