#!/usr/bin/env bash
#
# init_notes.sh — sobe a ponte Apple Notes para o agente.
#
# Roda NO MAC. Expõe o `apple-notes-mcp` (stdio) como um endpoint StreamableHTTP
# na interface da Tailscale, para o agente (na Linode) consumir via MCP.
# Ver docs/PLANO-apple-notes-mcp.md.
#
# Uso:
#   ./init_notes.sh            # sobe em PRIMEIRO PLANO (Ctrl+C encerra; bom p/ testar)
#   ./init_notes.sh --daemon   # sobe EM BACKGROUND (log + pidfile); sobrevive ao terminal
#   ./init_notes.sh --stop     # encerra a ponte em background
#   ./init_notes.sh --status   # checa se a ponte responde (/health)
#
# Token (NÃO fica no repo público): lido de $NOTES_MCP_TOKEN ou de ~/.notes_bridge_token.
set -euo pipefail

PORT="${NOTES_MCP_PORT:-8787}"
LOG="$HOME/Library/Logs/notes-bridge.log"
PIDFILE="$HOME/.notes_bridge.pid"
TOKEN_FILE="$HOME/.notes_bridge_token"

msg() { printf '\033[1;36m[init_notes]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[init_notes] ERRO:\033[0m %s\n' "$*" >&2; }

carregar_token() {
  TOKEN="${NOTES_MCP_TOKEN:-}"
  if [ -z "$TOKEN" ] && [ -f "$TOKEN_FILE" ]; then
    TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  fi
  if [ -z "$TOKEN" ]; then
    err "token ausente. Defina \$NOTES_MCP_TOKEN ou crie $TOKEN_FILE (chmod 600)."
    exit 1
  fi
}

ip_tailnet() {
  local ip
  ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  if [ -z "$ip" ]; then
    err "Tailscale não está no ar (tailscale ip -4 vazio). Rode 'tailscale up' primeiro."
    exit 1
  fi
  printf '%s' "$ip"
}

checar_deps() {
  command -v node >/dev/null || { err "node não encontrado (precisa Node 20+)."; exit 1; }
  if ! command -v supergateway >/dev/null; then
    msg "supergateway ausente — instalando global (npm i -g supergateway)..."
    npm i -g supergateway
  fi
}

stdio_cmd() {
  # Usa o binário GLOBAL do apple-notes-mcp via node ABSOLUTO (determinístico).
  # Evita `npx` dentro do supergateway: sob o daemon o npx degrada p/ um `sh` que
  # lê o JSON-RPC ("sh: jsonrpc:2.0: command not found"). Fallback: npx.
  local node anm
  node="$(command -v node || true)"
  anm="$(command -v apple-notes-mcp || true)"
  if [ -n "$node" ] && [ -n "$anm" ]; then
    printf '%s %s' "$node" "$anm"
  else
    printf 'npx -y apple-notes-mcp@latest'
  fi
}

montar_args() {
  # Monta os args num ARRAY (ARGS) para preservar o --stdio como UM único argumento
  # (ele contém espaço: "node /caminho"). Montar via string + expansão sem aspas
  # quebrava o --stdio em vários args e o supergateway caía num `sh` solto.
  # stateful = mantém UM processo apple-notes-mcp vivo (sem cold start por chamada).
  # --apiKey EXIGE dos clientes "Authorization: Bearer <key>" (casa com o header do
  # agente). NÃO usar --oauth2Bearer (é p/ saída; deixaria a entrada SEM auth).
  ARGS=(
    --stdio "$(stdio_cmd)"
    --outputTransport streamableHttp
    --stateful --sessionTimeout 600000
    --host "$HOST" --port "$PORT"
    --apiKey "$TOKEN"
    --healthEndpoint /health
  )
}

acao_status() {
  HOST="$(ip_tailnet)"; carregar_token
  local code
  code="$(curl -s -m 6 -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" "http://$HOST:$PORT/health" || echo 000)"
  if [ "$code" = "200" ]; then
    msg "ponte NO AR em http://$HOST:$PORT (HTTP 200) ✅"
  else
    err "ponte não respondeu em http://$HOST:$PORT (HTTP $code)."
    exit 1
  fi
}

acao_stop() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" && rm -f "$PIDFILE"
    msg "ponte encerrada."
  else
    # fallback: mata qualquer supergateway da porta
    pkill -f "supergateway.*--port $PORT" 2>/dev/null && msg "ponte encerrada (pkill)." \
      || msg "nenhuma ponte rodando."
    rm -f "$PIDFILE"
  fi
}

acao_subir() {
  local daemon="$1"
  HOST="$(ip_tailnet)"; carregar_token; checar_deps
  msg "Mac na tailnet: $HOST | porta: $PORT"
  msg "⚠️ Na 1ª vez que tocar o Notes, aprove o prompt 'controlar Notas' do macOS."

  montar_args
  if [ "$daemon" = "1" ]; then
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      err "já há uma ponte rodando (pid $(cat "$PIDFILE")). Use --stop antes."; exit 1
    fi
    mkdir -p "$(dirname "$LOG")"
    nohup supergateway "${ARGS[@]}" >>"$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    msg "ponte EM BACKGROUND (pid $(cat "$PIDFILE")). Log: $LOG"
    msg "cheque com: ./init_notes.sh --status"
  else
    msg "subindo em primeiro plano (Ctrl+C encerra)..."
    exec supergateway "${ARGS[@]}"
  fi
}

case "${1:-}" in
  --stop)   acao_stop ;;
  --status) acao_status ;;
  --daemon) acao_subir 1 ;;
  ""|--fg)  acao_subir 0 ;;
  *) err "uso: $0 [--daemon|--stop|--status]"; exit 2 ;;
esac
