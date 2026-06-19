# agente

Agente baseado no [Google ADK](https://google.github.io/adk-docs/) que orquestra comandos do `whatsapp-bot` via MCP.

## Setup

```bash
poetry install
cp .env.example .env
# preencher GEMINI_API_KEY em .env
```

## Rodar

```bash
poetry run uvicorn agente.main:app --reload --host "$HOST" --port "$PORT"
```

O `whatsapp-bot` (porta 3001 por padrão) precisa estar rodando para o agente conseguir invocar as tools MCP.

## Endpoints

- `POST /chat` — entrada do `/p` do whatsapp-bot
- `GET /health` — liveness
