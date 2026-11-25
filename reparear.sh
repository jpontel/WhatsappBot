#!/usr/bin/env bash
# reparear.sh — rotina de RE-PAREAMENTO do WhatsApp (Baileys) para o bot.
#
# Quando usar: a conexão travou, deu 401 (loggedOut) ou ficou presa no meio do
# pareamento. Esta rotina:
#   1) derruba o container do bot;
#   2) APAGA a sessão (cache do Baileys em whatsapp-bot/auth_info_baileys);
#   3) reconstrói e sobe só o bot;
#   4) captura e imprime um novo CÓDIGO DE PAREAMENTO;
#   5) ABORTA sozinha se levar 401 ou se o código não sair na janela (não fica
#      martelando o número — isso só agrava o bloqueio do WhatsApp).
#
# ATENÇÃO: isto DESLOGA a sessão atual do WhatsApp DESTE servidor — será preciso
# digitar o novo código no celular (WhatsApp → Aparelhos conectados → Conectar
# com número de telefone). NÃO rode no servidor errado.
#
# Uso (dentro de /root/bot):
#   bash reparear.sh          # pede confirmação
#   bash reparear.sh -y       # não pergunta (uso automatizado/remoto)
#
# Uso remoto, da máquina de dev:
#   ssh -i linode_secondary/id_ed25519 root@172.237.48.33 'bash /root/bot/reparear.sh -y'

set -euo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICO="whatsapp-bot"
CONTAINER="bot-baileys"
AUTH_DIR="$BOT_DIR/whatsapp-bot/auth_info_baileys"
ENV_FILE="$BOT_DIR/whatsapp-bot/.env"
JANELA_SEG=120   # tempo máximo (s) esperando o código antes de abortar

AUTO=0
[ "${1:-}" = "-y" ] && AUTO=1

# Mostra qual número está configurado (sem vazar o resto do .env)
NUM="$(grep -E '^TELEFONE_CELULAR=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo '??')"

echo "=============================================="
echo " RE-PAREAMENTO DO WHATSAPP"
echo " Pasta:  $BOT_DIR"
echo " Número: $NUM"
echo " Isto APAGA a sessão atual e gera um novo código."
echo "=============================================="
if [ "$AUTO" -ne 1 ]; then
  read -r -p "Confirmar? (digite 's' para seguir): " OK
  [ "$OK" = "s" ] || { echo "Abortado."; exit 1; }
fi

cd "$BOT_DIR"

echo "[1/4] Derrubando container..."
docker compose down --remove-orphans >/dev/null 2>&1 || true

echo "[2/4] Apagando sessão (cache do Baileys)..."
rm -rf "$AUTH_DIR"
mkdir -p "$AUTH_DIR"

echo "[3/4] Rebuild + subindo só o bot (--no-deps)..."
docker compose up -d --build --no-deps "$SERVICO" >/dev/null

echo "[4/4] Aguardando código de pareamento (até ${JANELA_SEG}s)..."
FIM=$((SECONDS + JANELA_SEG))
while [ "$SECONDS" -lt "$FIM" ]; do
  sleep 8
  LOG="$(docker logs --since 5m "$CONTAINER" 2>&1 || true)"

  CODE="$(echo "$LOG" | grep -A1 'CÓDIGO DE CONEXÃO' | grep '👉' | tail -1 | grep -oE '[A-Z0-9]{6,}' | head -1 || true)"
  if [ -n "$CODE" ]; then
    echo
    echo "=============================================="
    echo " CÓDIGO DE PAREAMENTO:  $CODE"
    echo " Digite no WhatsApp → Aparelhos conectados →"
    echo " Conectar com número de telefone."
    echo "=============================================="
    exit 0
  fi

  if echo "$LOG" | grep -q 'Bot conectado e pronto'; then
    echo "Já conectou sozinho (sessão ainda válida) — não precisou de código."
    exit 0
  fi

  if echo "$LOG" | grep -q 'fechada (401)'; then
    echo
    echo "!! 401 (loggedOut): o WhatsApp recusou o número."
    echo "   Provável bloqueio temporário por muitas tentativas."
    echo "   Parando o container e ABORTANDO (espere ~15-30 min e rode de novo)."
    docker stop "$CONTAINER" >/dev/null 2>&1 || true
    exit 2
  fi
done

echo "!! Nenhum código em ${JANELA_SEG}s. Parando o container e abortando."
docker stop "$CONTAINER" >/dev/null 2>&1 || true
echo "--- últimas linhas do log ---"
docker logs --tail 20 "$CONTAINER" 2>&1 || true
exit 3
