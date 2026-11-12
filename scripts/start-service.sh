#!/usr/bin/env bash
# Inicia o backend do Assistente do Zap e mostra o estado.
set -euo pipefail
systemctl start assistente-zap
sleep 2
systemctl --no-pager status assistente-zap || true
echo
echo "Logs: journalctl -u assistente-zap -f"
