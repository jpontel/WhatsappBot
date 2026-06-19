# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Identificadores, mensagens e documentação aqui são em **português (pt-BR)** — siga essa convenção em código novo.

## Estrutura do repositório

Este diretório agrupa dois projetos independentes que cooperam em tempo de execução:

```
bot/
├── whatsapp-bot/   # client WhatsApp (Baileys, Node/TS) — repo Git próprio
└── agente/         # agente ADK (Python/FastAPI) que orquestra o bot via MCP
```

A raiz **não é** um repositório Git. O `.git` vive dentro de `whatsapp-bot/`. `agente/` é um projeto Python separado ao lado — não há lockfile/workspace compartilhado na raiz.

### `whatsapp-bot/` — client de interface

Bot Node.js + TypeScript que conecta ao WhatsApp via Baileys e despacha comandos digitados pelo usuário. Detalhes (comandos npm, ESM/NodeNext, sistema de comandos auto-descoberto, persistência SQLite, servidor MCP) ficam em `whatsapp-bot/CLAUDE.md`.

Pontos relevantes para a integração entre os dois projetos:
- O `whatsapp-bot` expõe um **servidor MCP** em `http://localhost:3001/mcp` (`StreamableHTTP`, stateless) com as tools `enviar_texto`, `enviar_imagem`, `enviar_sticker` e `reagir`. É a única superfície que o `agente/` enxerga do bot.
- O comando `/p` foi convertido em ponte HTTP: chama `POST {AGENT_URL}/chat` no agente, envia o texto retornado e reage com `💅`/`❌`. Toda a lógica de persona/histórico/IA agora mora no `agente/`.

### `agente/` — agente ADK

Servidor FastAPI Python que hospeda um `LlmAgent` do Google ADK. Detalhes (Poetry, layout, como rodar) ficam em `agente/CLAUDE.md`.

Pontos relevantes para a integração:
- Endpoint principal: `POST /chat` com `{ chatId, mensagem, msgKey, midia? }`. Resposta: `{ texto, tools_acionadas }`. Texto retornado é enviado pelo bot; tools de efeito colateral (reagir, sticker, imagem) são acionadas pelo agente via MCP durante a execução.
- Sessão por `chatId` (= JID do WhatsApp) via ADK `DatabaseSessionService` em `agente.db` (SQLite, **separado** do `whatsapp-bot.db`).
- Agente consome o MCP do bot (`MCPToolset` apontando para `MCP_URL`) — fluxo bidirecional: bot → agente via HTTP, agente → bot via MCP.

## Fluxo end-to-end

```
WhatsApp ─msg─▶ whatsapp-bot ──/p──▶ POST :8000/chat ──▶ agente (ADK + Gemini)
                                                            │
                                                            ▼ tool calls
                                                          POST :3001/mcp
                                                            │
                                                            ▼
                                                          whatsapp-bot ──▶ WhatsApp
```

## Subindo o ambiente local

São dois processos. Ordem importa: o agente precisa do MCP do bot disponível.

1. `cd whatsapp-bot && npm run start` — sobe Baileys + MCP server na 3001.
2. `cd agente && poetry run uvicorn agente.main:app --reload --port 8000` — sobe FastAPI.

## Servidor de produção (Linode / Akamai)

A instância de produção fica na Linode. Gestão de recursos pela `linode-cli` (instalada via `pip3 install linode-cli`; autenticar com `linode-cli configure`).

- **Instância:** label `clarice` · id `94666542` · região `us-ord` · Ubuntu 24.04 · plano `g6-standard-1` (2 GB RAM, 50 GB disco) · swap de 2 GB em `/swapfile`.
- **IP público:** `172.232.7.171`.
- **Conexão SSH:** `ssh root@172.232.7.171` — acesso por **chave** (a `~/.ssh/id_ed25519` desta máquina já está autorizada em `/root/.ssh/authorized_keys`). **Nunca** colocar a senha de root neste arquivo (ele é versionado).
- **Achar o IP de novo:** `linode-cli linodes list --text --format "id,label,status,ipv4"`.

### Layout no servidor (arquitetura nova, em produção)

Deploy em **`/root/clarice/`** com a arquitetura de dois serviços (espelha este repo). Enviado por `rsync` (deploy manual, sem git no servidor).

- **2 containers** via `/root/clarice/docker-compose.yml`:
  - `bot-baileys` (imagem `clarice-whatsapp-bot`) — Baileys + MCP na 3001.
  - `agente-adk` (imagem `clarice-agente`) — FastAPI + ADK na 8000.
  - Conversam pela rede interna do compose: bot→agente `http://agente:8000`, agente→bot `http://whatsapp-bot:3001/mcp` (overrides em `environment:` no compose).
- **Persistência:** `./whatsapp-bot/auth_info_baileys` (bind, sessão WhatsApp) + volumes nomeados `clarice_bot_db` e `clarice_agente_db` (montados em `/app/data`; os SQLite ficam em `data/`).
- **`.env`:** um por serviço (`whatsapp-bot/.env`, `agente/.env`), enviados por rsync; **não** versionados. `TELEFONE_CELULAR=5547992706378` (casa com a sessão preservada).
- **Operação:** `cd /root/clarice && docker compose up -d --build` · `docker compose restart` · `docker logs -f bot-baileys` / `agente-adk`.

**Redeploy de código:** `rsync` dos projetos para `/root/clarice/` (excluir `node_modules`, `.venv`, `.git`, `auth_info_baileys`, `*.db`, `data`) → `docker compose up -d --build`. Como bot e agente compartilham a sessão WhatsApp, ao recriar o `bot-baileys` evite duas instâncias simultâneas (erro `conflict: replaced`).

**Rollback:** a versão antiga (monolítica) fica preservada em `/root/bot` (container removido). Para voltar: `cd /root/clarice && docker compose down && cd /root/bot && docker compose up -d`.

**Dockerfiles:** o do `whatsapp-bot` copia só `package.json` e roda `npm install` (o `package-lock.json` é legado pré-pnpm e quebra o dedup do npm — "Invalid Version"). O do `agente` usa Poetry com `PYTHONPATH=/app/src`.

> Pendência: a `GEMINI_API_KEY` do `agente/.env` em produção está com a chave de **desenvolvimento** (testada com os modelos `gemini-3`), não a chave antiga de produção. Trocar e reiniciar o `agente-adk` se quiser usar o billing de produção.
