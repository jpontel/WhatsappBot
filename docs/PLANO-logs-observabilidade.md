# PLANO — Logs centralizados + `/logs` + tool de auto-inspeção

## Objetivo

1. **Esquema de log centralizado e estruturado**: todo ponto que já loga passa a
   alimentar um buffer consultável, em formato que a IA entenda com **poucos tokens**.
2. **`/logs`** (comando, admin): recupera os últimos logs dos DOIS serviços.
3. **Tool `inspecionar_logs`** (admin): a própria LulaDroid lê os logs do agente para
   "analisar o estado do código" (ex.: "por que a figurinha não enviou?").

## Decisões (escolhas recomendadas)

- **Store = ring buffer em memória** (sem persistência) — rápido, sem infra, sem
  contenção de arquivo entre containers, naturalmente limitado. Histórico que
  sobrevive a restart fica para uma fase futura (trocar o buffer por `logs.db` sem
  mudar a interface).
- **Captura sem refatorar cada chamada**: aproveitamos o que JÁ é logado —
  - **Agente (Python):** um `logging.Handler` no logger raiz captura TODOS os
    `logger.*` existentes (o agente já loga nível + módulo em todo lugar).
  - **Bot (Node):** um *tee* no `console.log/warn/error` captura tudo que já é
    impresso, sem tocar nos call sites.
- **Admin-only + redação** de segredos/PII: obrigatórios.

## Formato do registro (estruturado, barato p/ IA)

```
{ ts, nivel, svc:"bot|agente", comp, msg }
```
`comp` = nome do logger (agente) / origem (bot). A IA lê `ERROR agente/client.roteador: ...`
em vez de parágrafos.

## Técnicas p/ token/latência

- **Filtro na fonte**: parâmetros `nivel` (mínimo), `comp`, `limite`. Default =
  `WARNING+` e últimos N.
- **Modo resumo**: contagem por (nível, comp) numa janela — ultra-compacto p/
  "analisa o estado" (ex.: "12 ERROR, 3 em client.chat").
- **Truncar**: `msg` cortada (~300 chars); dedupe de repetidas ("×N").
- **Caps rígidos**: teto de registros/charset por resposta (disciplina de token).
- **Latência**: escrever no buffer é O(1) em memória → **zero impacto** no turno
  normal; recuperação é on-demand (só no `/logs`/tool).
- **Redação**: mascara chaves (`AIza…`, `AQ…`, `ghp_…`, `Bearer …`) e números/JID
  (`\d{10,}`) ANTES de devolver.

## Topologia da recuperação

```
/logs (comando, bot, admin)  → buffer do BOT  +  GET {AGENT_URL}/logs  → mescla → WhatsApp
inspecionar_logs (tool, agente, admin) → buffer do AGENTE → devolve ao LLM
```
(Fase 2: a tool também puxa os logs do bot via um MCP `recuperar_logs`.)

## Arquivos

**Agente**
| Arquivo | Mudança |
|---|---|
| `shared/log_buffer.py` *(novo)* | deque + `RingBufferHandler` + `instalar()` + `recuperar(nivel, comp, limite, resumo)` + redação |
| `main.py` | instala o handler no logger raiz no startup |
| `api/logs.py` *(novo)* | `GET /logs?nivel=&comp=&limite=&resumo=` |
| `tools/tools.py` + `client/root_agent.py` | tool `inspecionar_logs` (admin-gated via request_context) |
| `config.py` | `log_buffer_max`, defaults de filtro/caps |

**Bot**
| Arquivo | Mudança |
|---|---|
| `core/log-buffer.ts` *(novo)* | ring buffer + tee do `console.*` + `recuperar()` + redação |
| `index.ts` | instala o tee cedo no boot |
| `commands/logs.ts` *(novo)* | comando `/logs` (admin-only): buffer do bot + `GET` no agente, mescla e formata |

## Fases

1. **MVP (este plano):** buffers nos 2 serviços, `/logs` (comando, mescla os dois) e
   `inspecionar_logs` (tool, agente). Admin-only + redação + caps.
2. MCP `recuperar_logs` no bot → a tool do agente também vê os logs do bot.
3. Persistência opcional (`logs.db`) se quiser histórico pós-restart.

## Validação

- Smoke: gerar logs, chamar `recuperar()` (filtro/resumo/redação/caps) nos 2 serviços.
- `/logs` como admin devolve mescla; como não-admin, recusa.
- `py_compile`/typecheck; rebuild dos dois containers.
