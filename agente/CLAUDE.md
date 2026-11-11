# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Projeto Python que hospeda um agente Google ADK por trás de uma API FastAPI. Identificadores, comentários e respostas em **português (pt-BR)** — manter consistência.

## Comandos comuns

```bash
poetry install                                           # 1ª vez (resolve deps, cria .venv)
poetry run uvicorn main:app --app-dir src --reload --port 8000  # rodar em dev
poetry run pytest                                        # testes (quando existirem)
poetry run ruff check src tests                          # lint
```

Não há etapa de build — `uvicorn` carrega o módulo direto.

## Layout do código (`src/`)

Pacote **plano** sob `src/` (carregado via `PYTHONPATH=/app/src` no Docker; `--app-dir src` em dev). NÃO há mais o wrapper `agente` — os imports são diretos (`from config import ...`, `from client.root_agent import ...`, `from tools.tools import ...`).

```
src/
├── main.py     # app FastAPI (entry: main:app)
├── config.py   # Settings (pydantic-settings)
├── api/        # camada HTTP — chat.py, health.py
├── schemas/    # contratos Pydantic — chat.py
├── client/     # orquestração ADK — root_agent, instruction, fallback_model, historico, session
├── tools/      # ferramentas chamáveis pelo LLM — tools.py
├── repo/       # repositórios vetoriais — memoria_repo, rosto_repo
└── shared/     # infra compartilhada — mcp_client, request_context
```

## Pré-requisitos de runtime

- Python `^3.11`.
- `whatsapp-bot` rodando em `http://localhost:3001/mcp` (servidor MCP do client WhatsApp). Sem ele, qualquer tool MCP invocada pelo agente falha — o `/chat` ainda responde texto, mas tools como `enviar_sticker` quebram.
- `.env` preenchido (copiar de `.env.example`). Chaves obrigatórias: `GEMINI_API_KEY`. As demais têm default.

## Arquitetura

### Fluxo de uma request `/chat`

`POST /chat` (`src/api/chat.py`) recebe `{ chatId, mensagem, msgKey, midia? }`. Para cada turno:

1. `_garantir_sessao(chatId)` cria a sessão no `DatabaseSessionService` (sqlite em `agente.db`) se ainda não existir. `chatId == user_id == session_id` (= JID do WhatsApp).
2. `_montar_conteudo` constrói um `types.Content` com um bloco textual `[contexto-sistema] usuario_jid: ... msg_key: {...}` + `[mensagem-usuario] ...`. Se houver mídia, vai como `inline_data` na mesma `Content`.
3. Itera `runner.run_async(...)` coletando eventos:
   - `event.get_function_calls()` → registra nomes em `tools_acionadas` (debug/observabilidade).
   - `event.is_final_response()` → captura o texto final do LLM.
4. Resposta: `{ texto, tools_acionadas }`. O **bot** é quem envia esse texto ao WhatsApp; o agente nunca chama `enviar_texto` para a resposta final (ver instruction).

### Agente (`src/client/` + `src/tools/`)

- `client/root_agent.py` instancia o `LlmAgent` único (`name=NOME_BOT.lower()` → `"luladroid"`, vindo de `client/instruction.py`; modelo lido de `settings.gemini_model`) e expõe o `runner` singleton.
- `client/instruction.py` carrega a persona — migrada literalmente do `whatsapp-bot/src/services/google-cloud.service.ts`. **Persona vive aqui agora**, não no bot. Edite aqui se mudar o tom/dicionário de gírias. O **nome do bot** é a constante `NOME_BOT` (fonte ÚNICA da identidade): interpola no bloco `[IDENTIDADE]` da persona e alimenta o `name` do agente em `root_agent.py`. Para rebatizar o bot, mude só `NOME_BOT`.
- `tools/tools.py` contém as ferramentas (geração de imagem/áudio, busca web/artigos, memória, etc.). Tools que precisam falar com o WhatsApp (sticker, imagem, texto, reagir) **não** moram aqui — moram no MCP do bot e chegam via `MCPToolset`.
- `client/session.py` instancia `DatabaseSessionService(db_url=settings.database_url)` e exporta o `APP_NAME` usado pelo runner.

### Por que duas categorias de tool?

- **Python tools (in-process)** — coisas que o agente computa/gera localmente. Ex.: `gerar_imagem` chama Gemini, devolve bytes; não toca no WhatsApp.
- **MCP tools (no bot)** — efeitos colaterais no WhatsApp. Ex.: depois de gerar bytes com `gerar_imagem`, o agente chama MCP `enviar_imagem` para entregar. O MCP é a única superfície que conhece o socket Baileys.

Não tente colocar lógica do WhatsApp dentro de `tools/tools.py`. E não tente colocar geração de IA no MCP do bot. A divisão é proposital.

### Contexto por turno: `usuario_jid` e `msg_key`

O LLM precisa desses valores para chamar tools como `reagir(jid, msgKey, emoji)`. Eles **não** vivem em `session.state` (interpolação de state com objetos aninhados é frágil no ADK) — são injetados como um bloco de texto no topo da `Content` de cada turno. O `INSTRUCTION` ensina o modelo a usar esse bloco como metadado silencioso (sem expor ao usuário).

Se você adicionar uma tool MCP nova que precise de mais metadados (ex.: timestamp da mensagem), adicione o campo no `[contexto-sistema]` em `_montar_conteudo` e estenda o `INSTRUCTION` mencionando o novo campo.

## Adicionando capacidades

| O que você quer | Onde mexer |
|---|---|
| Mudar persona / humor / gírias | `agente/src/client/instruction.py` |
| Tool que apenas computa (sem mandar pra WhatsApp) | `agente/src/tools/tools.py` + registrar em `client/root_agent.py` |
| Tool que age no WhatsApp | `whatsapp-bot/src/mcp/mcp.server.ts` (do outro lado); o agente pega automaticamente via `MCPToolset` |
| Novo campo no contrato HTTP | `agente/src/schemas/chat.py` + `api/chat.py` |
| Trocar modelo Gemini | `.env`: `GEMINI_MODEL` / `GEMINI_IMAGE_MODEL` |

## [SEGURANÇA]: Verificação de impacto em tokens (OBRIGATÓRIA)

**Toda implementação nova passa por uma verificação de impacto no consumo de tokens ANTES de ser dada como pronta.** Não é opcional. Surgiu porque o histórico de sessão crescia sem limite e o ADK reenviava a conversa INTEIRA a cada turno — chegou a **~124k tokens de prompt por mensagem** (e subindo ~500 tok/turno) para uma resposta de ~125 tokens. Custo e latência crescendo de forma invisível até alguém medir.

Antes de concluir qualquer mudança, responda explicitamente:

1. **O que ela adiciona ao prompt enviado ao modelo?** (instrução nova, schema de tool, campo no `[contexto-sistema]`, conteúdo injetado por turno.)
2. **Esse acréscimo é por-turno e cresce com o tempo/uso?** Acréscimo fixo é tolerável; **acréscimo cumulativo/ilimitado é proibido** sem um teto explícito (janela por quantidade, truncamento, paginação).
3. **Tem teto?** Qualquer coisa que entre no prompt e possa crescer (histórico, memórias recuperadas, resultado de tool reinjetado, lista de participantes) precisa de um limite numérico configurável.
4. **Mediu?** Quando plausível, confira o `prompt_token_count` real (vem no `usage_metadata` dos eventos no `agente.db`) antes/depois. Caractere/4 só serve de estimativa grosseira e superestima.

Regras fixas que saíram desse incidente:
- **Histórico de sessão tem janela** — `settings.historico_max_itens` (cortado em `client/historico.py` via `before_model_callback`). NUNCA reenviar a sessão inteira. Ao mexer no fluxo do `runner`/sessão, confirmar que a janela continua ativa.
- **Respostas de tool grandes** (busca web, artigos) são o maior peso por-turno depois do histórico. Não reinjetar conteúdo volumoso de tool repetidamente sem truncar.
- **Métrica certa é quantidade, não tempo** — tempo não limita volume (um surto de mensagens estoura o contexto mesmo sendo "recente").

## Persistência

`agente.db` (SQLite) é gerenciado pelo `DatabaseSessionService` do ADK — não criar tabelas manualmente, ele faz. Arquivo é **separado** do `whatsapp-bot.db` de propósito (schemas e ciclos de vida diferentes; o `mensagens` do bot é legado e não é mais usado).

`agente.db*` está no `.gitignore`. Para zerar histórico de uma conversa, basta apagar a linha da sessão correspondente (ou o arquivo inteiro em dev).

## Pegadinhas

- **Sem `enviar_texto` para a resposta final**: o INSTRUCTION proíbe. A resposta final volta pelo `ChatResponse.texto` e o bot envia. Usar `enviar_texto` causaria mensagem duplicada.
- **`StreamableHTTPConnectionParams`** vem de `google.adk.tools.mcp_tool.mcp_session_manager` (não de `mcp_toolset` direto). Se trocar a versão do ADK e o import quebrar, conferir aí primeiro.
- **`Settings` falha cedo** se `GEMINI_API_KEY` estiver vazia — pydantic-settings levanta `ValidationError` no boot. Não tentar capturar; é proposital pra evitar deploy quebrado silencioso.
- **Timeout do bot é 180s** (`AGENT_TIMEOUT_MS` em `perguntar.ts`). Tarefas longas (busca web + geração de imagem + status incrementais) podem encostar nesse limite. Se aumentar de um lado, alinhar do outro.
