# Plano: Alertas agendados (lembretes cron) na Clarice

## Contexto

Hoje a Clarice não consegue lembrar o usuário de nada no futuro. O objetivo: o usuário diz "me avise às 08h de escovar os dentes" (ou "todo dia às 8h", "toda segunda 9h", "amanhã às 14h") e o sistema agenda o envio de uma mensagem WhatsApp no horário certo — únicos e recorrentes — além de poder **listar** e **cancelar** os alertas.

Decisões tomadas com o usuário:
- **O agendador roda no `whatsapp-bot`** (node-cron), reusando a infra já existente (tabela `agendamento`, `node-cron` instalado). Mais robusto: o disparo não depende do agente estar no ar; o socket WhatsApp vive no bot.
- **O agente é o cérebro:** interpreta linguagem natural → estrutura (tipo + cron/data) e grava via uma tool MCP nova; o bot persiste, agenda e dispara.
- Suporte a **único e recorrente**; **criar, listar e cancelar**.

Divisão: agente traduz NL→estrutura (precisa saber "agora" + fuso) → MCP → bot agenda no SQLite + node-cron → no horário, bot envia via Baileys.

**Regra de destino (importante):** o lembrete é SEMPRE enviado para o chat de onde veio a instrução. `chat_id` = `usuario_jid` (= `req.chatId`), que já é o JID do chat de origem — grupo (`...@g.us`) ou privado (`...@s.whatsapp.net`). O disparo faz `sendMessage(chat_id, ...)`. `contact_id` guarda o remetente (quem pediu) só para referência; nunca é o destino do envio.

## Parte A — `whatsapp-bot` (persistência + agendador + tools MCP)

### A1. Schema — `src/config/database.ts`
A tabela `agendamento` existe mas é legado (`chat_id, contact_id, mensagem, cron_expression NOT NULL, status, created_at`) e nunca foi usada. Estender para suportar único vs recorrente:
- Atualizar o `CREATE TABLE` (DBs novos) acrescentando: `tipo TEXT NOT NULL DEFAULT 'once'` ('once'|'recorrente'), `run_at TEXT` (ISO 8601 com offset, p/ 'once'), `timezone TEXT DEFAULT 'America/Sao_Paulo'`.
- Migração idempotente p/ o DB de prod (que já tem a tabela antiga): após o `db.exec(CREATE...)`, rodar um bloco que checa `PRAGMA table_info(agendamento)` e dá `ALTER TABLE agendamento ADD COLUMN ...` para cada coluna ausente.
- `cron_expression` continua `NOT NULL` no DB legado → para 'once' grava-se `cron_expression = ''` (string vazia satisfaz NOT NULL); 'recorrente' grava a expressão real.
- `status`: `pendente` (ativo) | `enviado` (once já disparado) | `cancelado` | `erro`. Recorrente permanece `pendente` (não vira `enviado`).

### A2. Repository ESM — `src/repository/agendamento.repository.ts`
Reescrever de CommonJS para **ESM + TypeScript** (o projeto é `"type": "module"`, NodeNext, imports com `.js`). Reusar o `db` de `../config/database.js`. Métodos:
- `criar(dados): number` (retorna id) — insere chat_id, contact_id, mensagem, tipo, cron_expression, run_at, timezone.
- `listarAtivos(): Agendamento[]` — todos com `status='pendente'` (usado no boot).
- `listarPorChat(chatId): Agendamento[]` — ativos de um chat (para `listar`).
- `buscarPorId(id)`, `marcarEnviado(id)`, `marcarErro(id)`, `cancelar(id)` (status='cancelado'; mais auditável que excluir).
- Exportar `interface Agendamento` + singleton `agendamentoRepository`.

### A3. Serviço de agendamento — `src/services/scheduler.service.ts` (novo)
Singleton `schedulerService` que mantém um `Map<number, {stop()}>` de tarefas vivas. Usa `node-cron` (já instalado) + `setTimeout`. O DB é a fonte de verdade; memória é reconstruída no boot.
- `inicializar()`: lê `listarAtivos()` e registra cada um. Chamado no boot.
- `registrar(ag)`:
  - `recorrente` → `cron.schedule(ag.cron_expression, fn, { timezone: ag.timezone })`. Valida com `cron.validate` antes.
  - `once` → `setTimeout(fn, delayMs)` onde `delayMs = Date.parse(ag.run_at) - Date.now()`. Se já passou no boot: dispara se atrasado ≤ grace (6h) senão marca `erro` (perdido) — evita spam de lembretes velhos após downtime.
- `fn` (disparo): `whatsappService.recuperarInstancia().sendMessage(ag.chat_id, { text: ag.mensagem })`; em sucesso, se `once` → `marcarEnviado` + remove do Map; recorrente segue ativo. Em falha → `marcarErro` + log.
- `cancelar(id)`: para a tarefa (cron.stop/clearTimeout), remove do Map, `repo.cancelar(id)`.

Reusa `whatsappService.recuperarInstancia()` (`src/services/whatsapp.service.ts`) — mesmo padrão dos handlers MCP atuais.

### A4. Tools MCP — `src/mcp/mcp.server.ts`
Seguir o padrão existente (`registerTool` + handler + helpers `ok`/`fail`). Adicionar 3 tools:
- `agendar_mensagem({ jid, mensagem, tipo, cron_expression?, run_at?, timezone? })` → `repo.criar(...)` + `schedulerService.registrar(novo)` → `ok` com o id. Valida: `tipo` ∈ {once,recorrente}; recorrente exige `cron.validate(cron_expression)`; once exige `run_at` parseável e futuro.
- `listar_agendamentos({ jid })` → `repo.listarPorChat(jid)` → `ok(JSON.stringify(lista))` (texto estruturado p/ o agente parsear).
- `cancelar_agendamento({ jid, id })` → confere que o id pertence ao jid → `schedulerService.cancelar(id)` → `ok`.

### A5. Boot — `src/index.ts`
Após `startMcpServer();` (linha 104, roda uma vez só), adicionar `schedulerService.inicializar();`. O disparo usa `recuperarInstancia()` no momento do fire — por isso só registra no boot; quando o alerta toca, o socket já está `open`. Import com `.js`.

## Parte B — `agente` (interpretação NL + tools)

### B1. Config — `src/agente/config.py`
Adicionar `timezone: str = "America/Sao_Paulo"`. (zoneinfo é stdlib no 3.11; sem dep nova.)

### B2. Hora atual no contexto — `src/agente/api/chat.py`
Em `_montar_conteudo`, injetar no bloco `[contexto-sistema]` uma linha `data_hora_atual: {datetime.now(ZoneInfo(settings.timezone)).isoformat()}`. Sem isso o modelo não tem âncora para "às 8h"/"amanhã".

### B3. MCP client retornando texto — `src/agente/agent/mcp_client.py`
`chamar_mcp` hoje retorna `None` (só levanta em erro). Adicionar `chamar_mcp_texto(tool, args) -> str` que retorna o texto concatenado do `resultado.content` (necessário para `listar_alertas`). Mantém `chamar_mcp` intacto para as tools de efeito colateral.

### B4. Tools — `src/agente/agent/tools.py`
Três tools finas (padrão das tools de envio, que chamam `chamar_mcp`):
- `agendar_alerta(jid, mensagem, tipo, cron_expression="", run_at="", timezone="America/Sao_Paulo") -> dict` → `chamar_mcp("agendar_mensagem", {...})`; retorna `{"status":"ok"}` ou `{"erro":...}`.
- `listar_alertas(jid) -> dict` → `chamar_mcp_texto("listar_agendamentos", {jid})` → parse JSON → `{"alertas":[...]}`.
- `cancelar_alerta(jid, id) -> dict` → `chamar_mcp("cancelar_agendamento", {jid, id})`.

### B5. Registro — `src/agente/agent/root_agent.py`
Importar e adicionar as 3 tools à lista `tools=[...]`.

### B6. Instrução — `src/agente/agent/instruction.py`
- Em `[CONTEXTO DA EXECUÇÃO]`: documentar `data_hora_atual` (a referência de "agora", no fuso de SP).
- Em `[USO DE TOOLS]`: descrever as 3 tools e **ensinar a conversão NL→estrutura** a partir de `data_hora_atual`:
  - recorrente → `tipo="recorrente"` + `cron_expression` (ex.: "todo dia 8h"→`0 8 * * *`; "toda segunda 9h"→`0 9 * * 1`).
  - único → `tipo="once"` + `run_at` ISO com offset calculado de `data_hora_atual` (ex.: "amanhã às 14h").
  - `mensagem` = texto do lembrete já na persona (ex.: "⏰ Lembrete: escovar os dentes! 🦷").
  - Sempre confirmar ao usuário em uma frase (ex.: "fechou, te lembro todo dia às 8h 💅"); para listar/cancelar, formatar amigável.

## Arquivos
- **Bot (novos):** `src/services/scheduler.service.ts`.
- **Bot (editar):** `src/config/database.ts`, `src/repository/agendamento.repository.ts` (reescrita ESM), `src/mcp/mcp.server.ts`, `src/index.ts`.
- **Agente (novos):** `tests/test_agendamento.py`.
- **Agente (editar):** `config.py`, `api/chat.py`, `agent/mcp_client.py`, `agent/tools.py`, `agent/root_agent.py`, `agent/instruction.py`.
- **Sem dependências novas:** `node-cron` já está no bot; `zoneinfo` é stdlib no agente.

## Verificação

1. **Testes do agente:** `cd agente && poetry run ruff check src tests && poetry run pytest`. Novo `test_agendamento.py` mocka `chamar_mcp`/`chamar_mcp_texto` e valida que as 3 tools montam os args certos (tipo/cron/run_at).
2. **Bot (sem framework de teste — manual):** rodar local, criar via `/p "me avise daqui 2 minutos de tomar água"` e observar o disparo; testar recorrente (`* * * * *` de teste), `listar` e `cancelar`. Conferir reinício: criar alerta futuro, reiniciar o bot, confirmar que `inicializar()` re-registra e dispara.
3. **Smoke MCP isolado:** chamar `agendar_mensagem` direto via cliente MCP (sem LLM) para validar persistência + agendamento.
4. **Deploy prod:** rsync dos dois projetos para `/root/clarice/` (excludes habituais) → `docker compose up -d --build agente whatsapp-bot`. ⚠️ Recriar `bot-baileys` reusa `auth_info_baileys` (bind), mas evitar duas instâncias simultâneas (erro `conflict: replaced`); o `up -d --build` para o antigo antes de subir o novo. Teste end-to-end via `/p` real e `docker logs -f bot-baileys`.

## Notas / riscos
- **Fuso:** node-cron recebe `{ timezone }`; 'once' usa instante absoluto (run_at com offset) → imune ao TZ do container. Não confiar no TZ do SO.
- **Downtime:** 'once' atrasado além do grace (6h) vira `erro` em vez de disparar tarde.
- **Persistência cross-restart:** DB é fonte de verdade; `inicializar()` reconstrói as tarefas em memória a cada boot.
- **Deploy do bot** mexe no container do WhatsApp — único ponto sensível desta entrega.

---

## ✅ ENTREGUE (2026-06-04) — inclui extensões além do plano original

Tudo implementado, testado e em produção (`/root/clarice`). Resumo do que foi entregue:

### Base (conforme plano)
- Schema `agendamento` estendido (tipo, run_at, timezone) + migração idempotente.
- `agendamento.repository.ts` reescrito em ESM/TS. `scheduler.service.ts` (node-cron p/ recorrente, setTimeout p/ once, grace 6h, timeout de envio 30s). Tools MCP `agendar_mensagem`/`listar_agendamentos`/`cancelar_agendamento`. Boot via `schedulerService.inicializar()`.
- Agente: `data_hora_atual` no `[contexto-sistema]`, `timezone` no config, `chamar_mcp_texto`, tools `agendar_alerta`/`listar_alertas`/`cancelar_alerta` + instrução (NL→cron/run_at).
- **Aprendizado:** os timers só "não disparavam" nos testes porque o JID era falso e o `sock.sendMessage` pendurava; com JID real dispara no horário. Daí o **timeout de envio**.

### Extensão 1 — Lembrete URGENTE (`urgente=true`, só `once`)
- Após disparar, entra em `aguardando_confirmacao` e **reenvia a cada 3 min** (env `NAG_INTERVALO_MS`) até o solicitante **responder** no chat; desiste após **10 reenvios** (`nao_confirmado`).
- Confirmação detectada no `dispatcher.ts` (`confirmarUrgentes`): qualquer msg do solicitante encerra; guard `foiLembrete()` evita auto-confirmação pelos próprios reenvios do bot. Colunas novas: `urgente`, `nag_count`.

### Extensão 2 — Direcionar a CONTATO cadastrado
- "lembre o João de X às Y" → `buscar_contato(nome)` (agente) → MCP `buscar_pessoa` → `pessoa.repository.buscarPorNome` (LIKE case-insensitive). Agenda com `chat_id` = JID do contato. Trata não-encontrado e ambiguidade. Urgente desabilitado p/ terceiros (Opção A).
- **Atenção a colisão de nomes:** tool Python e tool MCP NÃO podem ter o mesmo nome (o `MCPToolset` expõe as MCP ao LLM) — por isso a MCP chama-se `buscar_pessoa` e a Python `buscar_contato`. Mesmo nome → `Duplicate function declaration` do Gemini e `/chat` quebra.

### Extensão 3 — Captura da mensagem RESPONDIDA no `/p`
- `perguntar.ts` extrai texto+autor da `quotedMessage` (1 item → campo `citacao`; lote → inline por item). Novo `Citacao` no `ChatRequest`; injetado como `mensagem_citada_texto`/`autor` no `[contexto-sistema]`; instrução ensina a tratar como contexto silencioso. Mídia citada continua intacta.

### Verificação em produção
- `/p` 200 OK; urgente disparou e entrou em cobrança (id 8, depois cancelado); citação usada na resposta; resolução de contato OK e caminho "não cadastrado" tratado.
- Testes do agente: 32 passando + ruff limpo. Bot validado por smoke (tsx) e e2e via MCP/`/chat`.
