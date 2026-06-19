# Plano: Memória de longo prazo por usuário (vetorial, sqlite-vec) na Clarice

## Contexto

Hoje a Clarice não lembra nada entre conversas além do histórico de sessão do ADK (por chat). Objetivo: dar ao agente uma **memória de longo prazo por pessoa cadastrada**, guardando trechos-chave relevantes (datas importantes, trabalho, características, etc.) e recuperando os mais pertinentes (busca vetorial) para enriquecer as respostas.

Decisões já tomadas com o usuário:
- **Backend vetorial: `sqlite-vec`** (busca KNN real dentro do próprio `agente.db`).
- **Escrita via tool** que o LLM chama quando julga algo relevante.
- **Recuperação top-K por similaridade**, injetada no contexto a cada turno.
- Memória só para **cadastrados** (`registrado=sim`), chaveada por `remetente_numero`.

**Escopo: 100% no `agente/` (Python).** Não toca o `whatsapp-bot` nem o MCP — só o `agente-adk` precisa de redeploy; sem risco de colisão de nomes de tool com o MCP (ver [[clarice-tool-naming-colisao-mcp]]).

## Fatos técnicos (confirmados)
- `google-genai 1.75`: embeddings via `await client.aio.models.embed_content(model=..., contents=texto, config=types.EmbedContentConfig(output_dimensionality=768))` → `resp.embeddings[0].values`. Mesmo padrão de client de `gerar_imagem` (`tools.py`).
- Modelo de embedding: configurável; default `text-embedding-004` (768 dim). Verificar na chave de prod; fallback `gemini-embedding-001`.
- `agente.db` persiste no volume (`/app/data` em prod). Reusar o MESMO arquivo (path derivado de `settings.database_url`), adicionando a tabela virtual do sqlite-vec.
- **sqlite-vec** entra como dependência Poetry (`sqlite-vec`); o pacote traz a extensão carregável. Carregar exige `conn.enable_load_extension(True)` + `sqlite_vec.load(conn)`.
- Decisão de runtime: usar **`sqlite3` síncrono** (stdlib) no `memoria_repo` (carregar extensão é mais previsível que no `aiosqlite`), e expor funções async chamando-as via `asyncio.to_thread(...)` — queries são minúsculas e ficam fora do event loop. Embedding é gerado em async (genai) e o vetor é passado pronto ao repo sync.
- Injeção: `_montar_conteudo` em `api/chat.py` (hoje injeta usuario_jid, remetente_numero, registrado, data_hora_atual, mensagem_citada_*). Chave = `remetente_numero`; filtro = `registrado`.

## Design

**Modelo de dados (sqlite-vec):** tabela virtual `vec0` com metadados + vetor, ex.:
`CREATE VIRTUAL TABLE IF NOT EXISTS memorias USING vec0(numero TEXT PARTITION KEY, categoria TEXT, conteudo TEXT, created_at TEXT, embedding float[768])`.
Usar `numero` como **partition key**/metadata para escopar a busca por pessoa. KNN: `SELECT conteudo, distance FROM memorias WHERE embedding MATCH ? AND numero = ? ORDER BY distance LIMIT k` (confirmar a sintaxe exata de filtro+k da versão do sqlite-vec na implementação; alternativa: tabela `vec0` só de vetores + tabela meta normal unidas por rowid). Vetor serializado com `sqlite_vec.serialize_float32(values)`.

**Escrita (model-driven):** tool `salvar_memoria(numero, categoria, conteudo)` → gera embedding do `conteudo` → INSERT. Dedup: KNN do próprio conteúdo contra a pessoa; se a mais próxima tiver distância < limiar_dedup (≈ muito similar), não duplica. Teto por pessoa (`memoria_max_por_pessoa`) podando as mais antigas.

**Recuperação (top-K, auto-injetada):** a cada turno, se `registrado=sim` e a pessoa tiver memórias (COUNT>0): gera embedding da `[mensagem-usuario]`, faz KNN top-K (default 5) filtrado por `numero`, aplica limiar de distância, e injeta um bloco `[memória-do-usuário]` no `[contexto-sistema]`. COUNT=0 → pula o embedding (custo zero p/ quem não tem memória).

**Gestão:** tools `listar_memorias(numero)` e `esquecer_memoria(numero, id)` ("o que você sabe sobre mim?" / "esquece que falei X").

## Arquivos

### Novos
- **`src/agente/agent/memoria_repo.py`** — núcleo (sqlite3 + sqlite-vec, funções sync; wrappers async via `asyncio.to_thread`):
  - Conexão única ao arquivo derivado de `settings.database_url`, com `enable_load_extension(True)` + `sqlite_vec.load(conn)`; cria a tabela virtual `vec0` idempotente no 1º uso.
  - `gerar_embedding(texto) -> list[float]` (async; `genai.Client` + `client.aio.models.embed_content`, modelo `settings.embedding_model`).
  - `salvar(numero, categoria, conteudo, embedding)` (dedup + teto), `top_k(numero, embedding, k) -> list[dict]`, `listar(numero) -> list[dict]`, `esquecer(numero, id) -> bool`, `contar(numero) -> int`.
- **`tests/test_memoria.py`** — mocka `memoria_repo.gerar_embedding` (monkeypatch, padrão de `test_busca_artigos.py`). Testa salvar→top_k retorna o mais relevante no topo, dedup, listar/esquecer, COUNT, e tools devolvendo `{"erro": ...}` sem estourar. (Usa um arquivo .db temporário do pytest.)

### Editar
- **`src/agente/config.py`** — `embedding_model: str = "text-embedding-004"`, `memoria_top_k: int = 5`, `memoria_distancia_max: float = 0.8`, `memoria_max_por_pessoa: int = 200`.
- **`src/agente/agent/tools.py`** — tools finas `salvar_memoria`, `listar_memorias`, `esquecer_memoria` (geram embedding quando preciso e chamam `memoria_repo`; retornam `{"status"/"memorias"/...}` ou `{"erro": ...}`). Nomes distintos de qualquer tool MCP.
- **`src/agente/agent/root_agent.py`** — importar e registrar as 3 tools.
- **`src/agente/api/chat.py`** — recuperação async em `chat()` (dentro do lock): se `registrado` e `numero` e `contar(numero)>0`, gerar embedding de `req.mensagem`, `top_k(...)`, e passar o texto a `_montar_conteudo` (novo param `memoria_texto`) que injeta o bloco `[memória-do-usuário]`.
- **`src/agente/agent/instruction.py`** — (1) `[CONTEXTO DA EXECUÇÃO]`: explicar o bloco `[memória-do-usuário]` (fatos que você já sabe da pessoa; use natural, sem expor que "leu uma ficha"). (2) `[USO DE TOOLS]`: ensinar `salvar_memoria` (CRITÉRIOS: datas importantes, trabalho, relações, preferências/características estáveis; NÃO salvar trivial/efêmero; `numero=remetente_numero`; só `registrado=sim`) + `listar_memorias`/`esquecer_memoria`.
- **`pyproject.toml`** — adicionar dependência `sqlite-vec`.

## Verificação
1. **Extensão carrega no runtime (RISCO principal):** confirmar `sqlite3.Connection.enable_load_extension` + `sqlite_vec.load` funcionam (a) no venv local e (b) no container `python:3.11` de prod. Se o Python local não permitir load de extensão, validar a lógica com mocks e confirmar o caminho vetorial só em prod.
2. **Embeddings na chave de prod:** smoke chamando `embed_content` com `text-embedding-004` (200 + dim 768; senão `gemini-embedding-001`).
3. **Lint+testes:** `poetry run ruff check src tests && poetry run pytest`.
4. **Smoke do repo:** salvar 3 memórias para um número, `top_k` com query relevante → a esperada no topo; `listar`/`esquecer`/dedup.
5. **E2E `/chat`:** (a) "trabalho na WaProject e meu aniversário é 12/03" como registrado → modelo chama `salvar_memoria`; (b) "quando é meu niver?" → bloco `[memória-do-usuário]` traz o fato e a resposta acerta. Conferir `tools_acionadas`.
6. **Deploy prod:** rsync só do `agente/` + `docker compose up -d --build agente` (Dockerfile roda `poetry install` → instala sqlite-vec). Testar via `docker exec ... POST /chat` com `remetente.registrado=true`. Bot intacto.

## Notas / riscos
- **Carregar extensão** é o risco real (não a performance): alguns builds de Python desabilitam `load_extension`. Mitigação: `sqlite3` stdlib no Docker `python:3.11` normalmente suporta; verificar no passo 1. Se necessário, fallback para cosseno em Python puro (mesma interface do `memoria_repo`, troca interna).
- **Custo/latência:** +1 embedding por turno (só cadastrados com memória) e +1 por `salvar_memoria`. O gargalo é a API/LLM, não o banco.
- **Privacidade:** memória só de cadastrados; `esquecer_memoria` apaga. Futuro: restringir gravação ao admin.
- **Concorrência:** conexão sqlite3 dedicada do `memoria_repo`; escritas minúsculas e já serializadas por chat (lock em `chat.py`). Usar `asyncio.to_thread` p/ não bloquear o loop.

---

## ✅ ENTREGUE (2026-06-04) — agente em produção

- `memoria_repo.py` (sqlite-vec, `vec0` partition por `numero`, `busy_timeout`, sync+`to_thread`), tools `salvar_memoria`/`listar_memorias`/`esquecer_memoria`, recuperação top-K auto-injetada (`[memória-do-usuário]`), `eh_admin` no contexto.
- **Correção de embedding:** `text-embedding-004` NÃO existe na chave de prod (404) → usado **`gemini-embedding-001`** com `output_dimensionality=768` + **normalização L2** do vetor.
- **Permissão (travada no código):** identidade confiável via `ContextVar` (`request_context.py`) setada em `chat.py`; `_alvo_memoria` em `tools.py` aplica a regra independente do LLM. Admin administra a memória de todos; usuário comum só a própria. Validado e2e em prod: comum salva/lê só o próprio (ContextVar propaga pelo ADK), comum recusado em memória alheia, admin lê de outro usuário. +4 testes de permissão (41 no total).
- **Verificação:** sqlite-vec carrega no container `python:3.11`; embeddings OK com a chave de prod (dim 768); 37 testes + ruff limpos; e2e `/chat` — salvou 2 fatos (trabalho + aniversário) e recuperou em turno novo SEM tool (via bloco de memória).
- Sobrou no `memorias` de prod uma linha de teste sob o número fake `5500000001@s.whatsapp.net` (isolada por partition key; inofensiva).
