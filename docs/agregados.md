# Agregados — plano de implementação

## Contexto
Hoje a Clarice só "conhece" participantes do WhatsApp: a tabela `pessoas` (no `whatsapp-bot`) é chaveada por `numero`/JID e serve pra identificar **quem está falando**. A memória de longo prazo (`agente/src/repo/memoria_repo.py`) também é por `numero` do remetente.

Falta um jeito de o bot ter **contexto sobre pessoas/coisas que NÃO estão no WhatsApp** (ex.: "meu irmão João que não usa zap", um pet, um lugar, um projeto) e usar esse contexto quando elas forem **citadas pelo nome** na conversa. Isso é conceitualmente separado de `pessoas` (identidade do remetente, chave = número) — aqui a chave é o **nome** e a recuperação é **quando a coisa é mencionada**.

A feature se chama **agregados**. Resultado esperado: qualquer pessoa cadastrada pode cadastrar agregados (os seus) e a Clarice consulta os fatos sob demanda quando o nome aparece, sem inflar o prompt por turno.

## Decisões (travadas)
- **Repo dedicado**, NÃO namespear `memorias`. Reusa só `gerar_embedding` (mesmo espaço de texto, 768-d). Motivo: agregado tem identidade própria (nome + apelidos + tipo) que `memorias` não modela; resolução nome→agregado é busca textual determinística, não KNN; ciclos de vida diferentes (espelha a separação texto×rosto já existente).
- **Genérico** via campo `tipo` livre (`pessoa`|`pet`|`lugar`|`projeto`|`coisa`, default `pessoa`).
- **Multi-curador, escopado por dono**: cada cadastrado cria/edita/consulta **os seus**. O `dono_numero` vem SEMPRE da identidade confiável (`request_context.atual()`), nunca de argumento do LLM — espelha o gate `_alvo_memoria`. (Gestão cruzada por admin fica reservada via `dono_numero`, sem implementar no MVP.)
- **Recuperação on-demand** via tool `consultar_agregado(nome)` — o modelo chama quando cita alguém/algo relevante. SEM injeção por turno (cumpre `[SEGURANÇA]` do `agente/CLAUDE.md`: não há gatilho barato no texto, então on-demand é o correto).
- **Vínculo opcional com `numero`** (bridge se a pessoa entrar no zap depois) — só armazenado no MVP, sem merge automático.

## Arquivos
- **NOVO** `agente/src/repo/agregado_repo.py` — espelha o padrão de `agente/src/repo/rosto_repo.py` (conexão sqlite3 dedicada lazy, `PRAGMA busy_timeout=5000`, sqlite-vec, tabelas criadas no `_conexao()`, funções síncronas + wrappers `async` via `asyncio.to_thread`). Importa `from repo.memoria_repo import gerar_embedding`.
- `agente/src/tools/tools.py` — tools novas + gate `_alvo_agregado` (espelha `_alvo_memoria`, ~linhas 615-629).
- `agente/src/client/root_agent.py` — importar de `tools.tools` e adicionar à lista `tools=[...]` (junto do bloco memória/rosto).
- `agente/src/client/instruction.py` — bloco AGREGADOS em `[USO DE TOOLS]` (após MEMÓRIA VISUAL).
- `agente/src/config.py` — settings `agregado_*` (após o bloco `memoria_*`, ~linhas 70-76).
- **NOVO** `agente/tests/test_agregado.py` — espelha `tests/test_memoria.py` + `tests/test_rosto.py`.

## Schema (`agente.db`, criado em `agregado_repo._conexao()`)
```sql
CREATE TABLE IF NOT EXISTS agregados(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dono_numero TEXT NOT NULL,   -- dono (identidade confiável do remetente)
    nome TEXT NOT NULL,          -- canônico (ex.: "João")
    aliases TEXT,                -- JSON: ["jão","meu irmão"]
    tipo TEXT,                   -- pessoa|pet|lugar|projeto|coisa
    numero TEXT,                 -- OPCIONAL: bridge se entrar no zap
    created_at TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS agregado_fatos USING vec0(
    agregado_id TEXT partition key,   -- str(agregados.id)
    categoria TEXT, conteudo TEXT, created_at TEXT,
    embedding float[768]              -- settings.embedding_dim
);
```
`aliases` é JSON em TEXT (volume baixo; desserializa e compara em Python). Apagar agregado apaga os fatos (espelha `_esquecer_rosto_sync`, rosto_repo:188-194).

## Funções do repo (`agregado_repo.py`)
Reaproveita `gerar_embedding`. Helper `_norm_texto(s)` = casefold + `unicodedata.normalize("NFKD")` + strip de acentos, pra match robusto.

Identidade (tabela regular): `criar(dono, nome, aliases, tipo, numero)`, `editar(id_, dono, ...)`, `apagar(id_, dono)`, `resolver(dono, termo)` (exato casefold → fallback substring; filtra por `dono`; retorna lista p/ desambiguar), `listar_agregados(dono)`, `obter(id_, dono)`, `contar_agregados(dono)`.

Fatos (vec0, recebem embedding pronto como `memoria_repo.salvar`/`top_k`): `add_fato(agregado_id, categoria, conteudo, emb)` (dedup `agregado_distancia_dedup` + teto `agregado_max_fatos`, espelha `_salvar_sync` memoria_repo:87-116), `top_fatos(agregado_id, emb, k)` (KNN + corte `agregado_distancia_max`), `listar_fatos(agregado_id)`, `esquecer_fato(agregado_id, fato_id)`, `contar_fatos(agregado_id)`.

`criar` recusa se `contar_agregados(dono) >= settings.agregado_max`.

## Tools (`tools.py`) + permissão
Gate (espelha `_alvo_memoria`):
```python
def _alvo_agregado() -> tuple[str | None, str | None]:
    proprio, _eh_admin, registrado = request_context.atual()
    if not (registrado and proprio):
        return None, "Agregados só funcionam para pessoas cadastradas."
    return proprio, None   # dono = sempre o próprio remetente (MVP)
```
Todas `async`, retornam sempre `dict` (try/except → `{"erro": ...}`, nunca exceção sobe), docstrings pt-BR detalhadas (viram o schema da tool). `aliases` default mutável: usar `aliases or []`, nunca mutar o argumento.

- `consultar_agregado(nome)` → resolve no escopo do dono; 1 → `{"agregado":{nome,tipo,numero?}, "fatos":[{categoria,conteudo}]}` (top `agregado_top_k`); vários → `{"ambiguo":[{nome,tipo}]}`; 0 → `{"agregado":null,"aviso":...}`.
- `criar_agregado(nome, tipo="pessoa", aliases=[], numero="")` (aplica `agregado_max`).
- `adicionar_fato_agregado(nome, categoria, conteudo)` (resolve → `add_fato`).
- `listar_agregados()`, `listar_fatos_agregado(nome)` (com id), `esquecer_fato_agregado(nome, id)`, `editar_agregado(nome, novo_nome="", aliases=[], tipo="", numero="")`, `apagar_agregado(nome)`.

## Instruction (`instruction.py`, bloco novo em `[USO DE TOOLS]`)
- CONSULTAR: chamar `consultar_agregado(nome)` quando a mensagem citar pelo NOME algo/alguém **de fora do WhatsApp** relevante pra responder. Usar `fatos` de forma silenciosa. `agregado:null` → não inventar; `ambiguo` → perguntar qual. NÃO usar pra contatos do zap (é `buscar_contato`) nem nomes genéricos/famosos.
- CRIAR/EDITAR: as tools de curadoria; explicar `aliases`/`tipo`/`numero`.
- Diferenciar pro modelo: **agregado** (fora do zap) × **`buscar_contato`** (cadastrado no zap) × **memória** (fatos do próprio remetente).

## Config (`config.py`)
```python
agregado_top_k: int = 5
agregado_distancia_max: float = 1.0
agregado_distancia_dedup: float = 0.15
agregado_max_fatos: int = 50
agregado_max: int = 100
```

## Conformidade [SEGURANÇA]
Acréscimo ao prompt = (a) schema **fixo** das tools novas (não cresce); (b) resultado de `consultar_agregado` **só quando chamado**, cortado em `agregado_top_k`, sujeito à janela `historico_max_itens`. Sem acréscimo cumulativo/ilimitado. Tetos numéricos configuráveis: `agregado_top_k`, `agregado_max_fatos`, `agregado_max`.

## Verificação
1. **Testes** (`poetry run pytest tests/test_agregado.py`, no padrão `test_memoria.py`/`test_rosto.py`): nível tool com repo mockado (permissão: não-cadastrado bloqueia; fluxo consultar 1/ambíguo/0; `agregado_max` via `monkeypatch`); nível repo com sqlite-vec real em `tmp_path` (CRUD + aliases round-trip; `resolver` exato/substring/acentos/escopo-por-dono/ambíguo; fatos top/dedup/corte; teto de fatos 5→3; apagar limpa fatos). Reusar helpers `_ident` (context de `request_context`) e `_vec(i, dim=768)` dos testes existentes; passar `_vec` direto às funções de fato (evita mockar `gerar_embedding`).
2. **Smoke de import** no container após deploy (igual à validação 15/15 já feita): importar `repo.agregado_repo`, `tools.tools`.
3. **Manual end-to-end** (no `/p`): como cadastrado, `criar_agregado` de um "João de fora"; em outra mensagem citar "o João" e confirmar que o modelo chama `consultar_agregado` e usa o fato. Conferir `prompt_token_count` no `usage_metadata` (`agente.db`) antes/depois — garantir que o schema novo é o único acréscimo fixo e que o resultado só aparece quando a tool é chamada.

## Riscos / edge cases
- **Colisão nome agregado × contato do zap** ("João" nos dois): instrução decide (agregado=fora do zap; contato→`buscar_contato`); sem merge automático.
- **Aliases ambíguos** (dois "chefe"): `resolver` devolve lista → `ambiguo` → modelo pergunta; nunca escolhe sozinho.
- **Falso-positivo de substring** ("ana"⊂"Mariana"): exato tem prioridade; substring é fallback.
- **`agregado_id` str×int**: regular usa INTEGER PK, vec0 particiona por TEXT → padronizar `str(id)`; testar round-trip.
- **Default mutável `aliases=[]`**: `aliases or []`, nunca `.append` no argumento.
- **Concorrência `agente.db`**: já mitigada pelo padrão herdado (`busy_timeout=5000` + `_lock`); é mais um cliente do mesmo arquivo (ADK + memoria + rosto + agregado).
- **pt-BR** em docstrings/comentários/erros; `ruff` line-length=100.
