#!/usr/bin/env bash
# Para o backend do Assistente do Zap.
set -euo pipefail
systemctl stop assistente-zap
systemctl --no-pager status assistente-zap || true
