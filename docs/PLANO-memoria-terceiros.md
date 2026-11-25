# Memória: recuperação de terceiros + reforço do salvamento (menos dependente do julgamento da IA)

## Contexto

Investigação (skill `analise-debito-tecnico`) confirmou, com logs reais de produção e consulta direta ao banco (`agente.db`/`whatsapp-bot.db` na instância secundária), que o bot não conseguiu responder "qual a artista favorita do Andrei?" por DOIS motivos que se somam:

1. **O fato nunca foi salvo.** A tabela `memorias` de produção tem só 3 registros no total (nenhum do Andrei, que está cadastrado com numero `554191862566`). `salvar_memoria` (`agente/src/tools/tools.py:811`) só é chamada quando o LLM **decide**, por conta própria, que vale a pena guardar — não existe nenhuma trava determinística cobrando essa chamada.
2. **Mesmo que tivesse sido salvo, não teria sido recuperado.** `_recuperar_memorias` (`agente/src/api/chat.py:158-174`) só busca a memória de **quem enviou a mensagem** (`rem.numero`, o remetente). Pessoas MENCIONADAS no texto (ex.: "Andrei") nunca entram nessa busca — o único caminho pra isso seria o LLM decidir sozinho chamar `buscar_contato` + `listar_memorias`, e os logs reais do incidente mostram que isso não aconteceu (1 único round-trip ao Gemini, sem nenhuma chamada de tool, `rota=None` no roteador — a mensagem não bateu em nenhuma regex de rota).

O usuário quer tirar esse acionamento da "aposta no julgamento do LLM" e colocar travas estruturais, cobrindo dois gatilhos de recuperação:
- **(1.1)** pergunta direta sobre fato de alguém cadastrado ("A Aline nasceu em que dia?");
- **(1.2)** pedido de geração que deveria se apoiar em dado de alguém cadastrado ("cria uma figurinha com base nos gostos musicais da Aline").

E também robustecer o lado do **salvamento**, hoje 100% discricionário.

## Abordagem

### 1. Recuperação determinística de memória de terceiros mencionados

Hoje existe só o caminho "ambiente" pro PRÓPRIO remetente (`_recuperar_memorias`). Vamos generalizar o MESMO mecanismo (embedding da mensagem + `memoria_repo.top_k`) para qualquer pessoa cadastrada **mencionada pelo nome** no texto — cobre 1.1 e 1.2 com um único mecanismo (não precisa distinguir "é pergunta" de "é pedido de geração": qualquer menção a um nome cadastrado já dispara a busca).

**Novo MCP tool no `whatsapp-bot`** (`whatsapp-bot/src/mcp/mcp.server.ts`), espelhando o padrão de `buscar_pessoa` (linha ~731) e reaproveitando a função que já existe para o `/cadastrar -listar`:
- `listar_pessoas` (sem args) → handler novo (mesmo estilo de `buscarContatoHandler`, linha 346) que chama `listarTodos()` (`whatsapp-bot/src/repository/pessoa.repository.ts:56`, já existe, não precisa escrever query nova) e devolve `JSON.stringify([{nome, jid}])`.

**No agente**, novo módulo `agente/src/client/mencoes.py`:
- `async def pessoas_mencionadas(mensagem: str, excluir_numero: str | None) -> list[dict]`: busca a lista completa via `chamar_mcp_texto("listar_pessoas", {})` (`shared/mcp_client.py`, já existe), normaliza a mensagem (reusar `client.roteador._norm` — NFD + remove acento + lower, já faz exatamente isso), e para cada pessoa verifica se ALGUM token do nome (≥3 letras, pra evitar falso-positivo com partículas curtas) aparece como palavra inteira (`\b`) no texto normalizado. Exclui `excluir_numero` (o próprio remetente — já coberto pelo caminho existente). Dedup por numero; **cap em `settings.memoria_mencoes_max_pessoas` (novo, default 3)** — satisfaz a regra de teto do `[SEGURANÇA]` do CLAUDE.md do agente.
- **Gate de privacidade**: só roda quando `eh_admin=sim` (mesma regra de permissão já aplicada em `_alvo_memoria`, `tools/tools.py:795` — hoje só o admin pode consultar/gerenciar memória de outra pessoa; a busca ambiente tem que respeitar a MESMA regra, não abrir uma backdoor pra qualquer um do grupo puxar dado de terceiro).
- **[FECHADO — revisão técnica] Cache em memória com TTL para `listar_pessoas`.** Sem isso, TODO turno do admin (mesmo "bom dia", sem menção nenhuma) dispara uma chamada de rede ao MCP do bot antes de sequer saber se vale a pena — latência desnecessária e acoplamento a cada mensagem. Correção: módulo-level `_cache: tuple[float, list[dict]] | None` + `settings.mencoes_cache_ttl_seg: float = 60.0` (novo). `pessoas_mencionadas` só chama `chamar_mcp_texto` se o cache estiver vazio ou mais velho que o TTL; senão reusa a lista em memória. Como o cadastro de pessoas muda raramente (só via `/cadastrar`, ação manual do admin), um TTL de 60s é seguro e elimina o round-trip redundante na imensa maioria dos turnos.

**Em `agente/src/api/chat.py`**, generalizar `_recuperar_memorias`:
- Computar o embedding da mensagem **uma única vez** e reusar tanto pro remetente quanto pra cada pessoa mencionada (evita N chamadas de embedding — 1 por turno, não 1+N).
- Para o remetente: bloco `[sobre você]` (comportamento atual, inalterado).
- Para cada pessoa mencionada (só se `eh_admin=sim` e `memoria_repo.contar(numero) > 0`): bloco `[sobre <nome>]` com o mesmo formato `- (categoria) conteudo`.
- Concatenar tudo e devolver; `_montar_conteudo` já injeta esse texto como `[memória-do-usuário]` — vamos renomear/ampliar esse bloco pra deixar claro que pode ter MAIS de uma pessoa (ver instruction.py abaixo).

**`agente/src/config.py`**: `memoria_mencoes_max_pessoas: int = 3`, `mencoes_cache_ttl_seg: float = 60.0`.

**`agente/src/client/instruction.py`** (`[CONTEXTO DA EXECUÇÃO]`): documentar que o bloco de memória agora pode trazer fatos de PESSOAS MENCIONADAS, não só do remetente, cada um rotulado com o nome — e que isso já veio filtrado/permitido, não precisa chamar `listar_memorias` de novo pra essas pessoas (evita round-trip redundante agora que a busca é automática).

### 2. Salvamento forçado quando a intenção é clara

Hoje o roteador já detecta intenção de GRAVAR com `_RE_MEMORIA` (`agente/src/client/roteador.py:107` — verbos tipo "anota", "lembra que eu", "guarda que", "salva que", "registra que", "grava que"), roteia pra `rota="memoria"`, mas a TOOL `salvar_memoria` continua sendo uma escolha opcional do LLM — pode simplesmente responder em texto sem gravar nada (foi o que aconteceu, mais provavelmente, com o fato do Andrei).

Vamos **forçar a chamada da tool** nesse caso, via `tool_config` do Gemini (function calling mode `ANY`, restrito a `salvar_memoria`) — mesmo padrão arquitetural dos `before_model_callback` que já existem (`filtrar_tools`, `injetar_instrucao` em `roteador.py`):
- Novo callback `forcar_salvamento(callback_context, llm_request)` em `roteador.py`: se `request_context.rota_atual() == "memoria"` **e** o gatilho de força (ver abaixo) estiver ativo, seta `llm_request.config.tool_config = types.ToolConfig(functionCallingConfig=types.FunctionCallingConfig(mode=types.FunctionCallingConfigMode.ANY, allowedFunctionNames=["salvar_memoria"]))`.
- Encadear esse callback em `_antes_do_modelo` (`client/root_agent.py`), depois de `filtrar_tools` (que já restringe as tools da rota `memoria` a `{salvar_memoria, listar_memorias, esquecer_memoria, buscar_contato}` — o `allowedFunctionNames` do `tool_config` precisa ser subconjunto disso).
- **API confirmada** (verificado na venv do projeto, `google-genai` instalado): `types.ToolConfig(functionCallingConfig=types.FunctionCallingConfig(mode=types.FunctionCallingConfigMode.ANY, allowedFunctionNames=["salvar_memoria"]))` — campos em camelCase, modes disponíveis `AUTO`/`ANY`/`NONE`/`VALIDATED`.
- Isso NÃO cobre "esquecer" nem rotas de consulta (fora de escopo pedido agora) — só reforça o caminho de GRAVAR, que é onde o incidente aconteceu.

**[FECHADO — revisão técnica, 1ª rodada] Bloqueante #1: forçar `tool_config=ANY` travaria o turno sem resposta final.**
A revisão técnica (subagente independente, lendo o ADK instalado em `site-packages/google/adk/flows/llm_flows/base_llm_flow.py`) confirmou que o `before_model_callback` roda em TODA chamada ao modelo dentro do mesmo turno — inclusive na 2ª chamada, depois que `salvar_memoria` já executou e o ADK pede o texto final de confirmação. Como `request_context.rota_atual()` só é limpo no `finally` do turno inteiro (`api/chat.py:283-286`, o `finally` depois do `async for event in runner.run_async(...)`), forçar `tool_config=ANY` de novo nessa 2ª chamada prenderia o modelo tentando chamar `salvar_memoria` outra vez (batendo no dedup) em vez de responder em texto — o usuário não receberia confirmação nenhuma do turno.
**Correção, detecção da 1ª vs. 2ª chamada**: `forcar_salvamento` só aplica o `tool_config=ANY` se NENHUM `Part` de NENHUM `Content` em `llm_request.contents` tiver uma function_response preenchida.

**[FECHADO — revisão técnica, 2ª rodada] Correção de uma REGRESSÃO no fechamento acima: nome do atributo errado.**
A 2ª rodada de revisão rodou a lib `google-genai` de verdade na venv do projeto e confirmou: o atributo do `types.Part` é `function_response` (**snake_case**), não `functionResponse` — esse é só o alias usado na serialização JSON, não existe como atributo de instância Python (`getattr(part, "functionResponse", None)` sempre devolve `None`/o default, mesmo quando o part TEM uma function_response). O próprio ADK confirma lendo por `part.function_response` em `base_llm_flow.py:779-782`. Com o nome errado, `_turno_ja_executou_tool` sempre devolveria `False` e o Bloqueante #1 **reapareceria exatamente como antes** — esse foi o motivo de rodar uma 2ª crítica antes de liberar. Versão corrigida e final da função:
```python
def _turno_ja_executou_tool(llm_request) -> bool:
    for content in (llm_request.contents or []):
        for part in (content.parts or []):
            if getattr(part, "function_response", None):
                return True
    return False
```
**Atenção pro teste** (`test_roteador_forcar_salvamento.py`, ver "Arquivos a alterar"): construir o `Content`/`Part` de teste com `google.genai.types.Part(function_response=...)` DE VERDADE (não um dublê/`Mock` com atributo solto `.functionResponse` setado manualmente) — um dublê caseiro passaria mesmo com o bug do nome errado, escondendo exatamente a regressão que esta rodada encontrou.

**[FECHADO — revisão técnica, 1ª rodada, com encanamento fechado na 2ª] Bloqueante #2: falso positivo do regex força salvamento de lixo.**
`_RE_MEMORIA` (`roteador.py:107`) casa frases como "não esquece que hoje é sexta" — sem fato real de terceiro. Hoje isso é inofensivo (o modelo só responde em texto se não há o que salvar); com `mode=ANY` o modelo seria OBRIGADO a produzir uma function call, inventando `categoria`/`conteudo` pra satisfazer a constraint.
**Correção (regra)**: o gatilho de força usa uma condição MAIS ESTRITA que a de roteamento — não força em todo match de `_RE_MEMORIA`, só quando, ALÉM do match, sobra conteúdo substancial após o trecho-gatilho: pelo menos 3 palavras depois do verbo-gatilho (ex.: "guarda que" + "a Aline nasceu em março" passa; "não esquece que hoje é sexta" também passa por ter 3+ palavras — nesse caso o pior resultado é uma memória trivial e descartável, não uma alucinação sobre pessoa inexistente). **Risco residual aceito, documentado explicitamente**: essa heurística reduz mas não elimina 100% o risco de uma memória de baixa qualidade — mitigado por `esquecer_memoria` (correção manual do admin) e pelo dedup de `memoria_repo._salvar_sync` (linha 93-98, evita acúmulo de duplicata). Eliminar por completo exigiria um classificador dedicado de "isso é um fato salvável?" — fora de escopo; próximo passo natural se o risco se mostrar incômodo na prática.

**[FECHADO — revisão técnica, 2ª rodada] Encanamento que faltava: de onde `forcar_salvamento` lê a mensagem e onde a heurística roda.**
A 2ª rodada apontou que `forcar_salvamento(callback_context, llm_request)` tem a MESMA assinatura de `filtrar_tools`/`injetar_instrucao` (`roteador.py:193`, `262`) — um `before_model_callback` não recebe `req.mensagem`, e o `request_context` (`shared/request_context.py:69-106`) hoje só carrega `rota`, `tools_permitidas` e `instrucao_suplementar`. Sem resolver isso, não há como o callback reavaliar a heurística de conteúdo mínimo. Também apontou um bug de índice: calcular o fim do match sobre a mensagem NORMALIZADA (`_norm`, NFD + remoção de acentos) mas fatiar a string ORIGINAL (`mensagem[match.end():]`) — sem garantia formal de que os dois têm o mesmo comprimento caractere-a-caractere pra todo input.
**Correção — calcular UMA VEZ em `chat.py`, igual já se faz com `instr_suf`:**
- Novo helper PÚBLICO em `roteador.py` (ao lado de `decidir_rota`/`instrucao_suplementar`): `def deve_forcar_salvamento(mensagem: str) -> bool`, que internamente normaliza (`m = _norm(mensagem)`), roda `_RE_MEMORIA.search(m)`, e aplica o guard de conteúdo mínimo **sobre a própria string normalizada** (`len(m[match.end():].split()) >= 3`) — corrige o bug de índice ao mesmo tempo, mantendo a normalização encapsulada dentro de `roteador.py` (ninguém de fora mexe em `_norm`/`_RE_MEMORIA` diretamente).
- `agente/src/shared/request_context.py`: nova `ContextVar[bool]` `_forcar_salvamento_memoria` (default `False`), `definir_rota` ganha um 4º parâmetro `forcar_salvamento_memoria: bool = False` e passa a devolver uma tupla de 4 tokens; `limpar_rota` reseta os 4; novo getter `forcar_salvamento_memoria_atual() -> bool`.
- `agente/src/api/chat.py`, no ponto onde `rota` já foi decidida (perto de `instr_suf = roteador.instrucao_suplementar(...)`): `forcar = roteador.deve_forcar_salvamento(req.mensagem) if rota == "memoria" else False`, e passa pra `request_context.definir_rota(rota, roteador.tools_da_rota(rota), instr_suf, forcar)`.
- O callback `forcar_salvamento(callback_context, llm_request)` fica simples: só lê `request_context.forcar_salvamento_memoria_atual()` (bool já pronto) **e** `not _turno_ja_executou_tool(llm_request)` — nenhuma regex nem normalização dentro do callback.

### Por que essa divisão (pré-busca determinística pra LER vs. tool forçada pra GRAVAR)

- **Ler**: o dado já existe no banco — não precisa de "raciocínio" pra decidir buscar, só precisa SABER que a pessoa foi mencionada. Pré-buscar e injetar ambientalmente (como já se faz pro remetente) é estritamente melhor que forçar uma tool call: economiza um round-trip ao Gemini e garante que o dado SEMPRE chega no prompt quando existe, independente de como a pergunta foi formulada.
- **Gravar**: o que salvar (categoria/conteúdo/pra quem) depende de entender a frase — isso ainda precisa do LLM. Forçar a CHAMADA da tool (sem forçar o CONTEÚDO) garante que a tentativa sempre aconteça quando a intenção de gravar é clara (regex já bate), sem tirar do LLM o trabalho de extrair os campos certos. O dedup já existente em `memoria_repo._salvar_sync` (`memoria_distancia_dedup`) protege contra duplicata se o LLM tentar salvar a mesma coisa de novo.

**[Verificado na checagem final] Outro chamador de `definir_rota`/`limpar_rota` existe e não precisa mudar.** `client/retry_pendencias.py:130-151` também usa esse par, sempre com `rota=None` (retry cai no fallback, nunca redecide a rota original — "YAGNI" já comentado ali) e repassa o token como tupla opaca (nunca desestrutura). Como o novo 4º parâmetro de `definir_rota` tem default `False`, essa chamada continua funcionando sem edição — `forcar_salvamento_memoria` fica `False` nesse caminho, o que é o comportamento correto (retry não deve forçar salvamento).

## Impacto em tokens (checklist obrigatório do CLAUDE.md do agente)

1. Acrescenta: possíveis blocos extras `[sobre <nome>]` no prompt, por turno.
2. Fixo por turno (não cumulativo) — mesma garantia do bloco `[sobre você]` já existente.
3. Teto explícito: `memoria_mencoes_max_pessoas` (3) × `memoria_top_k` (5, já existente) — pior caso limitado e pequeno.
4. Forçar `salvar_memoria` não adiciona nada ao PROMPT (é config de tool-calling, não texto) — custo é só a chamada de tool em si, que já existia como possibilidade.
5. O cache de `listar_pessoas` (TTL 60s) é memória de processo, não entra no prompt nem no banco — reduz chamadas de rede, não tem custo de token.

## Arquivos a alterar

- `whatsapp-bot/src/mcp/mcp.server.ts` — novo `server.registerTool("listar_pessoas", ...)` + handler (mirror de `buscarContatoHandler`, linha 346).
- `agente/src/client/mencoes.py` (novo) — detecção de menções + resolução via MCP + cache TTL.
- `agente/src/api/chat.py` — generalizar `_recuperar_memorias` (embedding único, bloco por pessoa mencionada).
- `agente/src/config.py` — `memoria_mencoes_max_pessoas`, `mencoes_cache_ttl_seg`.
- `agente/src/client/roteador.py` — novo helper público `deve_forcar_salvamento(mensagem)` + novo callback `forcar_salvamento(callback_context, llm_request)` (com `_turno_ja_executou_tool`, checando `function_response` em snake_case).
- `agente/src/shared/request_context.py` — nova `ContextVar` `_forcar_salvamento_memoria`, `definir_rota`/`limpar_rota` com o 4º token, getter `forcar_salvamento_memoria_atual()`.
- `agente/src/api/chat.py` — além de generalizar `_recuperar_memorias` (embedding único, bloco por pessoa mencionada): calcular `forcar = roteador.deve_forcar_salvamento(req.mensagem) if rota == "memoria" else False` e repassar em `request_context.definir_rota(...)`.
- `agente/src/client/root_agent.py` — encadear `forcar_salvamento` em `_antes_do_modelo`.
- `agente/src/client/instruction.py` — documentar o bloco de memória de terceiros no `[CONTEXTO DA EXECUÇÃO]`.
- Testes novos: `agente/tests/test_mencoes.py` (detecção de nome mencionado, normalização, cap, exclusão do próprio remetente, gate `eh_admin`, cache TTL); `agente/tests/test_roteador_forcar_salvamento.py` (usando `google.genai.types.Part`/`Content` DE VERDADE, não dublê — não força na 2ª chamada do turno com `Part(function_response=...)` presente, não força com gatilho sem conteúdo suficiente, `deve_forcar_salvamento` fatia a string normalizada corretamente); extensão de teste de `_recuperar_memorias`/`_montar_conteudo` cobrindo o bloco de terceiros.

## Verificação

- `poetry run pytest` + `poetry run ruff check src tests` (agente).
- Teste manual local: cadastrar 2 contatos fake, salvar uma memória pra um deles, simular um `/chat` do ADMIN mencionando o nome dele numa pergunta — conferir que o bloco `[sobre <nome>]` aparece no texto montado e que a resposta final usa o fato.
- Teste manual do salvamento forçado: mandar (como admin) uma frase que bate em `_RE_MEMORIA` (ex.: "anota que a Fulana faz aniversário dia 10") e confirmar no log/no banco que `salvar_memoria` foi de fato chamada nesse turno (não só respondida em texto) **e** que o turno ainda termina com uma resposta final de confirmação (valida o fechamento do bloqueante #1).
- Teste manual do guard de falso-positivo: mandar uma frase que bate em `_RE_MEMORIA` mas sem conteúdo substancial (ex.: só "anota que" sozinho) e confirmar que NÃO força a tool (valida o fechamento do bloqueante #2).
- Repetir o cenário real do Andrei em dev (perguntar o fato dele depois de salvo) pra fechar o ciclo do incidente original.
