# Ajuste 1 (roteador: lacuna estrutural) + Ajuste 2 (instrução: mitigar troca de nome)

> **Revisado (crítica adversarial, agente Plan):** item 1 (ampliar
> `_RE_EDIT`) aprovado sem ressalvas. Item 2 (regra 9) aprovado no princípio
> (inverter o default pra `None` em vez de `visao`) mas a 1ª versão tinha
> uma cláusula "OR ≤3 palavras" que reabria a mesma classe de bug pra verbos
> curtos fora de `_RE_EDIT` (ex.: "poe oculos nele", "manda ver") — corrigida
> abaixo por um critério de fullmatch-por-token contra um vocabulário
> fechado (reação + palavras neutras), não mais contagem de palavras.
> Pronto para implementar.

## Contexto

Depois do fix de `gerar_e_enviar_imagem_com_pessoas` (ver
`docs/PLANO-fix-imagem-pessoas-duplicadas.md`), dois bugs reais apareceram em
produção:

1. **Roteamento**: `"o matheuzinho tem peitos maiores (busto), aumente"`
   (com `tem_imagem=true`) caiu na rota `visao` (0 tools) porque `_RE_EDIT`
   não reconhece o verbo "aumente". Sem nenhuma tool de edição disponível, o
   LLM tentou uma função inexistente (`editar_imagem_com_prompt`). Isso **não
   crashou cru** — `agente/src/api/chat.py:398-405` já captura
   `ValueError: Tool '...' not found` e devolve uma mensagem amigável
   (`_MSG_TOOL_INEXISTENTE`, linha 31) — mas o resultado pro usuário ainda é
   "o bot recusou o pedido que deveria ter atendido".
2. **Alucinação de nome**: o usuário pediu "andrei e edubecks", o modelo
   chamou a tool com `nomes=["edubecks", "matheuzinho"]`. A resolução
   determinística (código) funcionou — resolveu 2 nomes DIFERENTES em 2
   fotos DIFERENTES, sem duplicar (o bug original está corrigido). O erro foi
   o próprio LLM trocando um nome sob uma conversa de grupo longa e carregada
   de entidades. Não existe correção 100% garantida em código pra isso (é uma
   falha probabilística de atenção do modelo); o que dá pra fazer é reduzir a
   taxa via instrução mais explícita sobre usar só os nomes da mensagem
   ATUAL.

Esse é o 4º bug de regex de roteamento "roubando"/"perdendo" rota nesta
sessão. Resolver só adicionando mais um verbo por vez na regex é whack-a-mole
que não converge — o ajuste aqui ataca a causa estrutural: a regra final do
`decidir_rota` (`if tem_imagem: return "visao"`) intercepta QUALQUER
mensagem-com-imagem não reconhecida e nunca deixa ela chegar na rede de
segurança real (`None` = todas as tools), que o próprio módulo documenta
como intenção ("nunca bloqueia, só atalha").

## Abordagem recomendada

### 1) `agente/src/client/roteador.py` — fechar a lacuna estrutural

**1a. Ampliar `_RE_EDIT`** (linha 106) com os verbos de alteração de
atributo/tamanho que faltam — fecha o caso relatado e vizinhos próximos:

```python
_RE_EDIT = re.compile(r"\b(edita\w*|muda\w*|troca\w*|altera\w*|remov\w*|tira\w*|coloca\w*|adiciona\w*|deixa|transform\w*|melhora\w*|conserta\w*|recorta\w*|corta\w*|apaga\w*|pinta\w*|aumenta\w*|diminui\w*|reduz\w*|amplia\w*|encolhe\w*)\b")
```

**1b. Corrigir a regra 9 (`tem_imagem → visao`)** para não sequestrar a rede
de segurança. Hoje:

```python
# 9) Imagem no turno sem outra intenção: só olhar/comentar.
if tem_imagem:
    return "visao"
```

Troca por um critério mais estreito — `visao` só quando a mensagem **parece
mesmo** um comentário/reação pura; qualquer coisa mais substancial que não
bateu em NENHUMA regra anterior cai no fallback real (`None` = todas as
tools, comportamento documentado como rede de segurança no topo do arquivo).

O critério de "reação pura" exige que **todo token** da mensagem esteja num
vocabulário fechado (léxico de reação + palavras neutras de preenchimento),
com fullmatch por token — não `.search` substring solto, pra não repetir o
padrão de regex "roubando rota" que já ocorreu 3x nesta sessão:

```python
# Vocabulário de REAÇÃO PURA (risada, interjeição, elogio, confirmação) +
# palavras NEUTRAS de preenchimento (artigos/conectivos comuns em reações
# curtas, ex.: "que foto linda"). Critério: TODO token da mensagem precisa
# estar num dos dois conjuntos, E pelo menos 1 token precisa ser reação de
# verdade — senão "poe oculos nele"/"manda ver" (sem verbo conhecido, mas
# pedido de ação real) cairiam aqui só por acaso não baterem em nenhuma
# regra anterior. Fullmatch por TOKEN (não .search): uma palavra de elogio
# dentro de uma frase maior ("ficou bom demais, mas diminui o brilho") não
# pode sequestrar a classificação.
_PALAVRAS_REACAO = frozenset({
    "kk", "rs", "haha", "rindo", "chorando", "nossa", "uau", "caramba",
    "eita", "aff", "affs", "lindo", "linda", "incrivel", "demais", "top",
    "show", "massa", "maravilhoso", "maravilhosa", "perfeito", "perfeita",
    "sim", "nao", "ok", "blz", "valeu", "vlw", "obrigado", "obrigada",
})
_PALAVRAS_NEUTRAS = frozenset({
    "que", "isso", "essa", "esse", "foto", "imagem", "ficou", "ficaram",
    "ta", "tao", "muito", "bem", "mto", "mt", "pra", "de", "a", "o", "la", "ai",
})
# Mensagem vazia (foto sem legenda) ou só risada/pontuação — caso de maior
# volume real (reação a foto enviada pelo próprio bot).
_RE_SO_RISADA_OU_VAZIO = re.compile(r"^[\s.,!?~\-]*(k+|rs+|haha+\w*|rindo|chorando)?[\s.,!?~\-]*$")

def _eh_reacao_pura(m: str) -> bool:
    if _RE_SO_RISADA_OU_VAZIO.fullmatch(m):
        return True
    palavras = re.findall(r"\w+", m)
    if not palavras:
        return False
    vocabulario = _PALAVRAS_REACAO | _PALAVRAS_NEUTRAS
    return all(p in vocabulario for p in palavras) and any(p in _PALAVRAS_REACAO for p in palavras)

...

# 9) Imagem no turno sem outra intenção RECONHECIDA. "visao" (0 tools) só
# quando a mensagem parece mesmo um comentário/reação pura — senão cai no
# fallback (10), que dá TODAS as tools. Sem essa distinção, qualquer verbo de
# edição não previsto (ex.: "aumenta", que faltava até esse fix) caía com 0
# tools disponíveis e o LLM alucinava uma função inexistente em vez de ter a
# chance de usar a tool real.
if tem_imagem:
    return "visao" if _eh_reacao_pura(m) else None

# 10) Nada casou → fallback (sem filtro: LLM recebe todas as tools).
return None
```

(O `return None` dentro do bloco 9 e o `return None` final da regra 10 ficam
redundantes só nesse ramo — tudo bem, a regra 10 continua sendo o fallback
geral para mensagens SEM imagem que não bateram em nada.)

**Casos verificados contra o novo critério:**
- `"kkkkk"` → match em `_RE_SO_RISADA_OU_VAZIO` → `visao`.
- `"que foto linda"` → tokens `{que, foto, linda}` ⊆ vocabulário, e `linda` ∈
  reação → `visao`.
- `"poe oculos nele"` → tokens `{poe, oculos, nele}` ⊄ vocabulário → `None`
  (antes cairia errado em `visao` pelo critério de tamanho) — corrigido.
- `"manda ver"` → tokens `{manda, ver}` ⊄ vocabulário → `None` — corrigido.
- `"o matheuzinho tem peitos maiores (busto), aumente"` → bate em `_RE_EDIT`
  ampliado (regra 2, ANTES da regra 9) → `edicao_visual`, nem chega aqui.

**Verificação de impacto em tokens (checklist obrigatório do CLAUDE.md do
agente):** o fallback `None` já existe hoje (mensagens sem imagem caem nele
o tempo todo) — não é um acréscimo novo ao sistema, só passa a ser alcançável
também por mensagens COM imagem que não batem em nada. É acréscimo FIXO
por-turno (schema completo de tools + instrução completa), não cumulativo —
só ocorre nos turnos em que a mensagem-com-imagem não é reação pura, que já
é a minoria dos casos reais.

### 2) `agente/src/client/instruction.py` — reforço de fidelidade ao nome

Nos dois fragmentos que já explicam `gerar_e_enviar_imagem_com_pessoas`
(`geracao_visual` ~linha 173, `edicao_visual` ~linha 192), adicionar UMA
frase reforçando que os nomes em `nomes=[...]` devem vir EXCLUSIVAMENTE da
mensagem-usuário atual, não de pessoas citadas em turnos anteriores da
mesma conversa — mitigação de troca de nome sob contexto longo (não é
garantia, é redução de taxa):

> "IMPORTANTE: monte `nomes` SÓ com os nomes que aparecem na
> `[mensagem-usuario]` DESTE turno — nunca reaproveite nomes de pessoas
> citadas em turnos anteriores da conversa, mesmo que pareçam relacionados
> ou recorrentes no papo."

## Testes (`agente/tests/test_roteador_forcar_salvamento.py`)

Adicionar (sem remover nenhum existente — todos os já cobertos continuam
batendo nas regras 1-8 antes de chegar na 9, não regridem; confirmado que
nenhum teste atual exercita a regra 9 hoje, então nada quebra):

- `test_edicao_com_verbo_de_tamanho_reconhecida`: `"aumenta o busto dele"` +
  `tem_imagem=True` → rota `"edicao_visual"`.
- `test_imagem_com_reacao_curta_continua_rota_visao`: `"kkkkk"`,
  `""` (legenda vazia) e `"que foto linda"` + `tem_imagem=True` → rota
  `"visao"`.
- `test_imagem_com_pedido_nao_reconhecido_cai_no_fallback`: 3 frases que NÃO
  batem em nenhuma regex de rota nem no vocabulário de reação —
  `"inverte as cores dessa foto por completo"` (substancial), `"poe oculos
  nele"` e `"manda ver"` (curtas, mas pedido de ação real) — todas +
  `tem_imagem=True` → rota `None` (contra-exemplo que a 1ª versão do plano,
  com o critério de "≤3 palavras", não cobria).

## Verificação

- `poetry run pytest` (agente) — confirmar que os testes novos passam e a
  suíte completa continua só com as mesmas falhas pré-existentes.
- `poetry run ruff check src tests`.
- Sem deploy/commit automático — só quando pedido explicitamente.
