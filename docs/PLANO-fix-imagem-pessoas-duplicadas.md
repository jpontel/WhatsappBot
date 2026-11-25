# Fix: `gerar_e_enviar_imagem_com_pessoas` resolve nomes sozinha (sem depender do LLM)

## Contexto

Investigação em produção (logs reais) mostrou que, ao pedir uma imagem com 2
pessoas cadastradas ("gera uma imagem com o edubecks e o andrei"), o modelo
chamou `gerar_e_enviar_imagem_com_pessoas` passando **só 1 número** (o do
`edubecks`) — nunca chamou `buscar_contato("andrei")` nesse turno, apesar da
própria docstring da tool mandar resolver "CADA pessoa" antes. Com 1 foto de
referência pra um prompt pedindo 2 pessoas nomeadas, o Gemini duplicou a
única cara que tinha.

Diferente dos 3 bugs anteriores desta sessão (todos determinísticos, no
roteador), este é o modelo pulando uma etapa manual de orquestração
(`buscar_contato` → montar `numeros` → chamar a tool). O usuário pediu pra
reforçar a instrução **e** adicionar uma trava de código. A trava
originalmente cogitada (contar quantos nomes aparecem no texto livre do
`prompt`) é frágil — frases como "sorrindo e muito felizes" têm "e" que não
são nomes, gerando falsos positivos/negativos.

**Abordagem recomendada**: em vez de validar heuristicamente depois do fato,
**elimina a etapa manual que falha** — a tool passa a receber os `nomes` como
o usuário falou e resolve `nome → numero` sozinha, por dentro, reaproveitando
`buscar_contato` (mesma função Python, não reimplementada). Isso torna
impossível proceder com uma lista de pessoas incompleta: cada nome citado OU
resolve pra exatamente 1 contato, OU a chamada inteira falha com um erro
claro (não encontrado / nome ambíguo).

> **Revisão técnica (crítica adversarial, 1 rodada)**: o desenho inicial deste
> plano tinha 2 bloqueantes e 4 pontos importantes, todos fechados abaixo nas
> seções correspondentes (marcados com **[FECHADO]**). Resumo dos achados
> reais: o teto de pessoas (`rosto_gen_max_pessoas`) não se aplicava quando
> `incluir_remetente=true`; um teste que seria removido na verdade cobria uma
> reconciliação de formato de número que continua necessária; a resolução de
> nomes em série reabriria uma sessão MCP inteira por pessoa; `buscar_contato`
> ficaria redundante no schema de 2 rotas sem necessidade; e a desambiguação
> por nome não reaproveitava a lógica de "igualdade exata > parcial único >
> ambíguo" que já existe em `melhorPessoa` (whatsapp-bot).

## Mudança de assinatura

`agente/src/tools/tools.py` — `gerar_e_enviar_imagem_com_pessoas`:

```python
# Antes
async def gerar_e_enviar_imagem_com_pessoas(prompt: str, numeros: list[str], jid: str) -> dict:

# Depois
async def gerar_e_enviar_imagem_com_pessoas(
    prompt: str, nomes: list[str], jid: str, incluir_remetente: bool = False
) -> dict:
```

- `nomes`: lista de nomes tal como o usuário falou (ex.: `["edubecks", "andrei"]`). A tool resolve CADA um reaproveitando `buscar_contato(nome)` (mesma função já definida em `tools.py`, logo abaixo) — **sem** o LLM precisar chamá-la antes.
- `incluir_remetente`: substitui o caso especial de "comigo/eu/a gente" que hoje o LLM resolvia manualmente (`remetente_numero` do contexto-sistema). Continua MAIS confiável resolver o próprio remetente por `request_context.atual()` do que por busca de nome (o admin pode não estar cadastrado como "pessoa" com esse nome) — então esse caso continua fora da resolução por nome, só que agora como flag booleana explícita.

### Helper de desambiguação (novo, módulo `tools.py`)

**[FECHADO — importante #5 e #6 da revisão]** A busca por nome (`buscarPorNome`
em `whatsapp-bot/src/repository/pessoa.repository.ts:39-41`) é `LIKE` parcial
sem preferência por match exato — "ana" pode casar com "Ana" E "Mariana" ao
mesmo tempo. O mesmo arquivo do bot já resolve isso para o fluxo de menção
(`melhorPessoa`, `whatsapp-bot/src/mcp/mcp.server.ts:411-419`: "igualdade
exata (ci) > parcial único > ambíguo"), mas `buscar_pessoa`/`buscar_contato`
NÃO reaproveita essa função — devolve a lista crua. Em vez de mexer no lado
TypeScript (fora do escopo deste fix), replico a mesma regra no lado Python,
sobre a lista que `buscar_contato` já devolve:

```python
def _melhor_contato(nome_buscado: str, contatos: list[dict]) -> dict | None:
    """Espelha a lógica de mcp.server.ts:melhorPessoa (igualdade exata
    case-insensitive > parcial único > ambíguo), aplicada sobre a lista que
    `buscar_contato` já retorna — sem precisar mexer no lado TypeScript."""
    if len(contatos) == 1:
        return contatos[0]
    alvo = nome_buscado.strip().lower()
    exatos = [c for c in contatos if c["nome"].strip().lower() == alvo]
    if len(exatos) == 1:
        return exatos[0]
    return None  # 2+ exatos, ou 0 exatos com 2+ parciais → ambíguo de verdade
```

Isso fecha o caso comum (nome digitado bate exatamente com um dos cadastros,
mesmo havendo outros parciais) sem tocar no MCP do bot. Pro caso raro de
ambiguidade REAL (inclusive 2 pessoas com o mesmo nome de exibição), a
mensagem de erro cita nome **e** número pra permitir desambiguar de verdade:

```python
opcoes = ", ".join(f"{c['nome']} ({c['jid'].split('@')[0]})" for c in contatos)
```

### Lógica interna (substitui o bloco atual de `nums`/`fotos`/`faltando`)

**[FECHADO — bloqueante #1]** O teto `rosto_gen_max_pessoas` tinha que incidir
sobre a lista FINAL (remetente + nomeados), não só sobre `nomes`, senão
"comigo + 4 pessoas" passava do teto sem erro. Corrigido calculando `vagas`
depois de inserir o remetente.

**[FECHADO — importante #3 e #8]** Resolver nomes em `for` sequencial reabre
uma `ClientSession` MCP inteira (handshake completo, `shared/mcp_client.py:28-41`)
por pessoa — até `rosto_gen_max_pessoas` vezes em série, dentro do turno
síncrono do ADK. Trocado por `asyncio.gather` (precisa `import asyncio` novo em
`tools.py` — hoje não importado) chamando `buscar_contato` em paralelo, e
reaproveitando a função existente (não duplica o parse/try-except de
`chamar_mcp_texto` + `json.loads`, que já vive em `buscar_contato`).

```python
import asyncio  # novo import no topo de tools.py

_proprio, _eh_admin, registrado = request_context.atual()
if not registrado:
    return {"erro": "Esse recurso é só para pessoas cadastradas."}

nomes_limpos = [n.strip() for n in (nomes or []) if (n or "").strip()]
if not nomes_limpos and not incluir_remetente:
    return {"erro": "Preciso do nome de pelo menos uma pessoa."}

alvos: list[tuple[str, str]] = []  # (numero, rótulo-pra-mensagem-de-erro)
if incluir_remetente:
    if not _proprio:
        return {"erro": "Não consegui identificar seu número."}
    alvos.append((_proprio, "você"))

# Teto aplicado à lista FINAL (remetente + nomeados) — não só aos nomeados.
vagas = max(settings.rosto_gen_max_pessoas - len(alvos), 0)
nomes_limpos = nomes_limpos[:vagas]

# Resolve todos os nomes em PARALELO, reaproveitando buscar_contato (mesmo
# parse/tratamento de erro de chamar_mcp_texto, sem duplicar).
resultados = await asyncio.gather(*(buscar_contato(nome) for nome in nomes_limpos))
for nome, res in zip(nomes_limpos, resultados):
    if "erro" in res:
        return {"erro": f"Falha ao resolver '{nome}': {res['erro']}"}
    contatos = res.get("contatos", [])
    if not contatos:
        return {"erro": f"Não encontrei '{nome}' cadastrado(a) — confirme o nome ou cadastre antes."}
    melhor = _melhor_contato(nome, contatos)
    if melhor is None:
        opcoes = ", ".join(f"{c['nome']} ({c['jid'].split('@')[0]})" for c in contatos)
        return {"erro": f"Mais de uma pessoa bate com '{nome}' ({opcoes}) — peça pra especificar o número."}
    alvos.append((melhor["jid"], melhor["nome"]))

nums = [numero for numero, _rotulo in alvos]
try:
    fotos = await rosto_repo.fotos_de(nums)
except Exception as exc:  # noqa: BLE001
    return {"erro": f"Falha ao recuperar as fotos: {exc}"}
achados = {rosto_repo.normalizar_numero(f["numero"]) for f in fotos}
faltando = [rotulo for numero, rotulo in alvos if rosto_repo.normalizar_numero(numero) not in achados]
if faltando:
    return {"erro": f"Sem foto cadastrada para: {', '.join(faltando)}. Cadastre o rosto dessas pessoas (com foto) antes."}

midia = request_context.midia_atual()
imagens = ([midia] if midia else []) + fotos
return await _entregar(gerar_imagem_com_referencias(prompt, imagens), "enviar_imagem", jid)
```

Ganho colateral: mensagens de erro agora citam o **nome** em vez do número
cru — melhor UX, reaproveitando o `nome` que `buscar_contato` já devolve.

Qualquer falha (nome não encontrado, ambíguo, sem foto) aborta a chamada
inteira — não gera com uma lista parcial.

## Instrução (`agente/src/client/instruction.py`)

Nos dois fragmentos que descrevem a assinatura da tool (`geracao_visual`,
linhas 173/176, e `edicao_visual`, linha 192):
- Trocar a explicação de "descubra o `numero` de cada pessoa com
  `buscar_contato` antes" por: "passe os NOMES como a pessoa falou em
  `nomes` — a tool resolve e valida sozinha; se vier erro de nome não
  encontrado/ambíguo, repasse a pergunta ao usuário".
- Trocar o passo manual do caso "comigo/eu/a gente" por `incluir_remetente=true`.
- Isso **encurta** a instrução (um passo a menos pro modelo seguir).

**[FECHADO — nice-to-have #7]** Há uma 3ª menção à tool em
`instruction.py:256` (fragmento `rosto`, dentro da explicação de
`registrar_rosto`: "é essa foto que alimenta o `gerar_e_enviar_imagem_com_pessoas`").
Não descreve parâmetros, então não precisa mudar — só registrando aqui pra não
dar a impressão de que só existem "dois fragmentos" no arquivo inteiro.

## Roteador (`agente/src/client/roteador.py`)

**[FECHADO — importante #4]** `buscar_contato` está declarado no tool-set de
`geracao_visual` (linha ~56) e `edicao_visual` (linha ~67, adicionado no fix
anterior desta sessão) SÓ por causa do fluxo manual que este plano elimina —
não há outro uso de `buscar_contato` dentro dessas duas rotas. Deixar como
está violaria o checklist `[SEGURANÇA]` do `CLAUDE.md` do agente (schema de
uma tool redundante sendo enviado todo turno sem necessidade). Remover
`"buscar_contato"` de `_TOOLS_POR_ROTA["geracao_visual"]` e
`_TOOLS_POR_ROTA["edicao_visual"]`.

## Testes (`agente/tests/test_rosto.py`)

Os 6 testes existentes que chamam a tool usam o parâmetro antigo `numeros` e
mockam só `rosto_repo.fotos_de`. Precisam mockar `tools.buscar_contato`
também (não mais `tools.chamar_mcp_texto` — a nova lógica delega pra
`buscar_contato`, então o mock fica no nível certo):

- `test_gerar_com_pessoas_nao_cadastrado` — só troca `numeros=["A"]` por
  `nomes=["Ana"]` (guard de `registrado` roda antes de qualquer resolução).
- `test_gerar_com_pessoas_sem_foto_de_alguem` — mock `tools.buscar_contato`
  resolvendo 2 nomes → 2 jids distintos sem ambiguidade; `fotos_de` devolve
  só 1 — confirma erro citando o NOME que falta.
- `test_gerar_com_pessoas_ok` — mock `tools.buscar_contato` resolvendo 2
  nomes; `fotos_de`/`gerar_imagem_com_referencias` fakes como hoje.
- `test_gerar_com_pessoas_numero_sem_sufixo` — **[FECHADO — bloqueante #2]
  NÃO remover, reescrever.** O crítico confirmou que esse teste não cobre "o
  LLM passando número sem sufixo" (cenário que some), mas sim a reconciliação
  `achados`/`faltando` via `normalizar_numero` DENTRO da tool quando o
  `numero` que `buscar_contato` resolve vem num formato e a foto salva em
  `rostos_fotos` está noutro — isso continua podendo acontecer (um rosto
  cadastrado antes de uma correção no cadastro da pessoa). Reescrever
  mockando `tools.buscar_contato` pra devolver `jid="555199416342@s.whatsapp.net"`
  e `rosto_repo.fotos_de` fake devolvendo a foto com
  `numero="555199416342"` (sem sufixo) — confirma que a reconciliação ainda
  casa os dois formatos.
- Os 2 testes adicionados no fix anterior
  (`test_gerar_com_pessoas_inclui_foto_do_turno_como_referencia`,
  `test_gerar_com_pessoas_sem_foto_no_turno_nao_adiciona_nada`) — atualizar
  pra `nomes=[...]` + mock de `tools.buscar_contato`.

Novos testes a adicionar:
- **Regressão direta do bug relatado**: 2 nomes distintos, cada um resolve
  pra um jid DIFERENTE → `fotos_de` é chamado com os 2 jids corretos (nunca
  com um só) → `gerar_imagem_com_referencias` recebe 2 fotos distintas.
- Nome não encontrado (`buscar_contato` devolve `{"contatos": []}`) → erro,
  sem chamar `fotos_de`.
- Nome ambíguo DE VERDADE (2+ contatos, nenhum com igualdade exata ao nome
  buscado) → erro listando nome + número de cada opção, sem chamar `fotos_de`.
- **Nome ambíguo mas com match exato** (ex.: busca "Ana", contatos retornam
  "Ana" e "Mariana") → `_melhor_contato` escolhe "Ana" automaticamente, SEM
  erro — prova que o helper de desambiguação funciona.
- `incluir_remetente=True` sem nenhum nome → usa só `_proprio` da identidade
  do turno.
- `incluir_remetente=True` + nomes que excedem o teto → confirma que o total
  (remetente + nomeados) nunca passa de `rosto_gen_max_pessoas`.

`test_roteador_forcar_salvamento.py::test_adicionar_pessoa_cadastrada_em_foto_libera_tool_de_pessoas`
precisa de 1 ajuste: hoje afirma `"buscar_contato" in tools_permitidas` — como
`buscar_contato` sai do tool-set de `edicao_visual` (ver seção Roteador
acima), essa asserção deve ser removida/invertida (`not in`).

## Verificação

- `poetry run pytest` (agente) — confirmar que as reescritas + novos testes
  passam e a suite completa continua só com as 6 falhas pré-existentes/não-
  relacionadas já confirmadas nesta sessão.
- `poetry run ruff check src tests`.
- Deploy: commit em `main` (push via `!` — bloqueado por classifier, igual
  aos 3 fixes anteriores desta sessão) → rsync só de `agente/` pra
  `wpp-bot-secondary` → `docker compose up -d --build --no-deps agente`.
- Teste manual real no WhatsApp: pedir uma imagem citando 2 pessoas
  cadastradas distintas (ex.: "gera uma imagem com o Edu Becks e o Andrei") e
  conferir visualmente que os DOIS rostos aparecem (não duplicados).
