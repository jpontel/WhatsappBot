# Plano: Tools de recuperação de artigos científicos no agente (Semantic Scholar + OpenAlex)

## Contexto

A Clarice (agente ADK em `agente/`) hoje responde com base no conhecimento do modelo + busca web genérica (`buscar_web`, via Tavily). Falta uma fonte de **artigos científicos confiáveis** para embasar respostas.

Após pesquisa de opções (Consensus, Semantic Scholar, OpenAlex, Europe PMC, arXiv, Crossref), a decisão foi adicionar **duas tools complementares**, em "tier":

- **`buscar_artigos`** (Semantic Scholar) — uso **padrão**: rápido, ranqueado por relevância, traz **TLDR** (resumo de 1 frase) pronto para responder no chat.
- **`deepsearch_artigos`** (OpenAlex) — **varredura profunda**: mais resultados, filtros (ano, nº de citações, open-access), para quando o S2 for insuficiente ou o usuário quiser levantamento amplo sobre um assunto.

Consensus foi descartado para integração: o MCP usa OAuth via navegador (não funciona no agente headless em Docker) e o REST é pago (US$0,10/call). Ambas as escolhas são gratuitas e funcionam headless.

Resultado esperado: a Clarice consegue buscar e citar artigos científicos (com link/DOI), preferindo S2 para respostas rápidas e OpenAlex para profundidade.

## Padrão a seguir (já existe no código)

A tool `buscar_web` em `agente/src/agente/agent/tools.py:48-86` é o template exato:
- `async def nome(args) -> dict`
- `httpx.AsyncClient(timeout=30)` (httpx já é dependência — `pyproject.toml`)
- `try/except Exception` devolvendo `{"erro": "..."}` (nunca derruba o turno)
- retorno como `dict` estruturado e enxuto

Tools são registradas em `agente/src/agente/agent/root_agent.py` (lista `tools=[...]`, funções passadas por referência) e descritas ao modelo na seção `[USO DE TOOLS]` de `agente/src/agente/agent/instruction.py`.

## Arquivos a modificar

### 1. `agente/src/agente/config.py`
Adicionar campos opcionais à classe `Settings` (todos com default — não quebram boot):
```python
semantic_scholar_api_key: str = ""  # opcional; melhora rate limit (1 RPS). Vazio = pool público.
semantic_scholar_api_url: str = "https://api.semanticscholar.org/graph/v1/paper/search"
openalex_api_url: str = "https://api.openalex.org/works"
openalex_mailto: str = "jose.pontel@waproject.com.br"  # "polite pool" do OpenAlex (sem key)
```

### 2. `agente/.env.example`
Acrescentar (documentação; key do S2 é opcional):
```
SEMANTIC_SCHOLAR_API_KEY=
```

### 3. `agente/src/agente/agent/tools.py`
Adicionar duas funções no mesmo estilo de `buscar_web`:

**`buscar_artigos(query: str) -> dict`** — Semantic Scholar:
- `GET {semantic_scholar_api_url}?query=...&limit=5&fields=title,abstract,year,authors,url,citationCount,tldr,openAccessPdf,venue`
- Header `x-api-key` **só se** `settings.semantic_scholar_api_key` não vazio.
- Retorno: `{"artigos": [{titulo, ano, autores (≤3 + "et al."), tldr, citacoes, venue, url, pdf_aberto}]}` ou `{"erro": "..."}`.

**`deepsearch_artigos(query: str, desde_ano: int | None = None, apenas_open_access: bool = False) -> dict`** — OpenAlex:
- `GET {openalex_api_url}?search=...&per_page=10&sort=cited_by_count:desc&mailto={openalex_mailto}`
- Montar `filter=` quando houver: `publication_year:>{desde_ano-1}` e/ou `is_oa:true`.
- Helper interno `_remontar_abstract(inverted_index) -> str` para reconstruir o abstract do `abstract_inverted_index` (dict palavra→[posições]) em texto corrido (truncar ~300 chars).
- Retorno: `{"artigos": [{titulo, ano, autores, resumo, citacoes, venue, url/doi, open_access}]}` ou `{"erro": "..."}`.

### 4. `agente/src/agente/agent/root_agent.py`
- Import: adicionar `buscar_artigos, deepsearch_artigos` ao `from agente.agent.tools import (...)`.
- Adicionar ambas à lista `tools=[...]`.

### 5. `agente/src/agente/agent/instruction.py`
Na seção `[USO DE TOOLS]`, adicionar (deixando claro QUANDO usar cada uma):
- `buscar_artigos(query)`: padrão para "o que a ciência diz sobre...", "tem estudo sobre...". Use o `tldr` para responder curto e cite título + link/ano.
- `deepsearch_artigos(query, desde_ano?, apenas_open_access?)`: use quando o `buscar_artigos` vier fraco/vazio, ou quando pedirem levantamento amplo/recente/aprofundado. Permite filtrar por ano e open-access.

### 6. `agente/tests/test_busca_artigos.py` (novo)
Seguir o padrão de `tests/test_envio_imagem.py` (pytest-asyncio, `monkeypatch`):
- Mockar a chamada httpx com JSON de resposta fixo de cada API.
- Asserts: retorno é dict com `artigos`; campos mapeados corretamente; em exceção retorna `{"erro": ...}`.
- Teste dedicado para `_remontar_abstract` (inverted index → frase na ordem certa).

## Verificação

1. **Lint + testes locais:**
   - `cd agente && poetry run ruff check src tests`
   - `cd agente && poetry run pytest`
2. **Smoke local:** `poetry run uvicorn agente.main:app --port 8000` e `POST /chat` perguntando algo científico — confirmar `tools_acionadas` e citação de artigo.
3. **Deploy prod (mesmo fluxo já usado):**
   - `rsync` de `agente/` para `root@REMOVIDO_IP:/root/clarice/agente/` (excluir `.venv .git __pycache__ *.db data .env .env.bak.*`).
   - `cd /root/clarice && docker compose up -d --build agente`.
   - Testar via `docker exec bot-baileys node -e '...POST http://agente:8000/chat...'` e conferir `docker logs --tail 30 agente-adk`.

## Notas / decisões

- **Sem nova dependência:** `httpx` já está no `pyproject.toml`.
- **Semantic Scholar key é opcional** (pool público funciona; key melhora rate limit). **OpenAlex não precisa de key** (só `mailto`).
- **Retornos enxutos:** limitar nº de artigos (5 S2, 10 OpenAlex) e truncar abstracts, para não estourar o contexto do modelo.
- Não mexer em `whatsapp-bot/` — é tudo lado-agente.
