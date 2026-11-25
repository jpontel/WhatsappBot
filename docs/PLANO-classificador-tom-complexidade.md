# PLANO — Classificador de Tom e Complexidade (Opção C)

## Contexto e problema

Dois parâmetros que moldam a resposta da LulaDroid hoje **não são determinísticos nem sensíveis ao contexto**:

1. **Tamanho da resposta** (`instruction.py`, item 4): é só uma instrução textual; o LLM escolhe pequeno/médio/grande por conta própria. Funciona razoável, mas sem garantia.
2. **Humor / `estilo_da_vez`** (`api/chat.py:81`): é **sorteado aleatoriamente** a cada turno —
   ```python
   estilo_da_vez = random.choice(settings.estilos_resposta)
   ```
   O sorteio foi feito para dar **variedade** (anti-repetição), mas **ignora o contexto**: uma mensagem séria/triste pode receber "malícia de duplo sentido" ou "deboche seco" aleatório — tom inadequado.

**Agravante descoberto:** os 9 `estilos_resposta` atuais são **todos** debochados/sarcásticos/maliciosos. Não há **nenhum** registro sério no pool — então, mesmo que o bot "quisesse" ser sóbrio numa hora delicada, ele não tem estilo para isso.

## Objetivo

Trocar a aleatoriedade cega por uma decisão **informada pelo contexto**, via um **classificador LLM leve** (Opção C) que lê a conversa e devolve `{ complexidade, tom }`. Esses sinais alimentam:
- o **tamanho** da resposta (dica), e
- a **seleção do humor** (sorteio restrito ao registro certo — mantém a variedade dentro do tom adequado).

Meta de engenharia: **máxima robustez com mínimo custo de token e latência**.

---

## Visão geral do mecanismo

```
mensagem + contexto recente
          │
          ▼
  [CLASSIFICADOR LLM leve]  ──►  { complexidade: baixa|media|alta,
   (flash-lite, prompt curto,          tom: serio|neutro|leve }
    saída estruturada)
          │
          ├──► complexidade ──► dica_tamanho (injeta no [contexto-sistema])
          │
          └──► tom ──► balde de estilos[tom] ──► random.choice(balde) ──► estilo_da_vez
```

É a **Opção C (sensor LLM)** alimentando a **política de gate (Opção A)**: o tom define de qual *balde* de estilos o humor é sorteado. A variedade continua (ainda há sorteio), mas dentro do registro certo.

---

## Design otimizado (token + velocidade)

As decisões abaixo são o que torna o C barato:

1. **Modelo mínimo.** Usar o modelo mais rápido/barato disponível (ex.: `gemini-3.5-flash-lite`) num setting dedicado `gemini_model_classificador`. Classificar é tarefa trivial — não precisa do modelo da resposta.

2. **Prompt minúsculo e FIXO.** System prompt curto (~150-200 tokens) só com a tarefa + os enums. Sendo fixo, é **cacheável** (implicit/context caching do Gemini) → nas chamadas seguintes, essa parte sai muito mais barata.

3. **Contexto enxuto.** Mandar só a **mensagem atual + as últimas 2-3** mensagens do `[contexto-recente]` — NÃO as 10. Tom e complexidade se definem pelo turno atual + vizinhança imediata; mandar histórico longo é desperdício.

4. **Saída estruturada (enum).** Forçar um JSON schema com 2 campos enumerados → a saída tem ~10-15 tokens e é parseável sem ambiguidade. Sem texto livre.

5. **Paralelismo (latência "escondida").** Encaixar a chamada no `asyncio.gather` que **já existe** em `chat.py:203` (`_recuperar_memorias` + `_reconhecer_rosto`). Como esses já rodam antes de montar o prompt, o classificador roda **em paralelo** com eles → o custo de parede é `max(classificador, memória, rosto)`, não a soma.

6. **Short-circuit determinístico (opcional, economiza ~token).** Um filtro barato ANTES da chamada LLM: mensagens triviais/óbvias (muito curtas, saudação pura, sem sinal sensível) → assume `{complexidade: baixa, tom: leve}` e **pula o classificador**. Só chama o LLM quando há ambiguidade real. Reduz a frequência de chamadas (e o custo médio) sem perder robustez nos casos que importam.

7. **Fallback seguro.** Se a chamada falhar/estourar timeout → cai no comportamento atual (`random.choice` sobre todos os estilos) ou default `neutro`. **Nunca** bloqueia nem derruba o turno.

---

## Fluxo detalhado (onde encaixa no código)

1. **`/chat` recebe o turno** (`api/chat.py`).
2. Dentro do `async with lock_da_sessao`, no bloco do `asyncio.gather` (hoje `:203`), **adicionar** `_classificar_turno(req)` como 3º participante:
   ```python
   memoria_texto, rosto_texto, classif = await asyncio.gather(
       _recuperar_memorias(req),
       _reconhecer_rosto(req),
       _classificar_turno(req),   # novo — roda em paralelo
   )
   ```
3. `_classificar_turno` aplica o **short-circuit** (otim. 6); se não resolver, chama o classificador LLM leve e devolve `{complexidade, tom}` (com fallback).
4. `_montar_conteudo` usa `classif`:
   - `estilo_da_vez = random.choice(settings.estilos_por_tom[classif.tom])` (gate).
   - injeta `dica_tamanho: <curto|medio|longo>` no `[contexto-sistema]`.
5. `instruction.py` (itens 4 e 5) passa a **referenciar** esses campos: "respeite `dica_tamanho`" e "o `estilo_da_vez` já vem adequado ao tom — encarne-o".

---

## Saída do classificador

```json
{ "complexidade": "baixa | media | alta", "tom": "serio | neutro | leve" }
```

- `complexidade` → `dica_tamanho`: baixa→curto, media→médio, alta→longo.
- `tom` → balde de estilos.

### Baldes de estilo (gate) — SOMENTE particionando os 9 estilos atuais

**Decisão:** não criar estilos novos agora. O gate é só uma repartição dos `estilos_resposta` que já existem em 3 baldes, do mais provocativo ao mais brando:

| Tom | Estilos existentes (sorteia entre eles) |
|---|---|
| `leve` | deboche seco e curto · sarcasmo afiado e afrontoso · empolgação debochada · malícia de duplo sentido · provocação travessa/flerte zoeiro |
| `neutro` | ironia blasé/preguiçosa · deboche carinhoso |
| `serio` | **(stopgap — os mais brandos que temos)** deboche carinhoso · fingindo paciência com a pergunta |

> ⚠️ **Limitação assumida (por ora):** não existe registro de fato sério no pool — todos os 9 estilos são debochados. O balde `serio` usa os **menos agressivos** só para EVITAR o pior (jogar malícia/frieza/sarcasmo afrontoso numa conversa pesada). Não é o ideal; quando quiser, a melhoria futura é escrever estilos sóbrios/empáticos dedicados (sem precisar mexer no mecanismo — é só preencher o balde).

---

## Mudanças no código

| Arquivo | Mudança |
|---|---|
| `agente/src/config.py` | `gemini_model_classificador` (default flash-lite); `estilos_por_tom: dict[str,list[str]]` = **repartição dos 9 `estilos_resposta` atuais** em leve/neutro/serio (sem estilos novos); flags `classificador_ativo`, `classificador_contexto_max=3`. |
| `agente/src/client/classificador.py` *(novo)* | `async classificar_turno(mensagem, contexto) -> Classificacao`; short-circuit heurístico + chamada LLM (genai direto, schema, modelo leve) + fallback. |
| `agente/src/api/chat.py` | entra no `asyncio.gather`; `_montar_conteudo` usa `tom`→balde e injeta `dica_tamanho`. |
| `agente/src/client/instruction.py` | itens 4 e 5 passam a referenciar `dica_tamanho` e o `estilo_da_vez` já-adequado. |

---

## Estimativa de impacto

> Premissas: modelo do classificador = `gemini-3.5-flash-lite`; turno "típico" de resposta ≈ **8.000 tokens de entrada** (instrução ~5k + histórico + contexto + bloco de sistema) e ~30-150 de saída; medir o real depois via `usage_metadata` no `agente.db`.

### Tokens (por turno)

| Item | Entrada | Saída |
|---|---|---|
| Chamada do classificador | ~300-400 tok (prompt fixo ~180 + msg ~40 + 2-3 ctx ~90) | ~10-15 tok |
| **Acréscimo vs. turno típico (~8k in)** | **~+4%** (≈ +350 tok) | desprezível |
| Com **short-circuit** pulando ~50% dos turnos triviais | **~+2% em média** (≈ +175 tok) | desprezível |
| Com **prompt caching** do system fixo (~180 tok) | parte cacheada custa fração do normal → acréscimo efetivo ainda menor | — |

**Resumo tokens:** acréscimo pequeno e *fixo* (não cresce com o tempo/uso, respeitando a regra de token do projeto). Da ordem de **+2 a +4% de entrada por turno**, saída irrelevante.

### Latência (por turno)

| Cenário | Acréscimo de parede |
|---|---|
| Classificador sozinho (flash-lite, prompt mínimo, saída enum) | ~0,25-0,55 s |
| **Rodando em paralelo** no `gather` existente (memória/rosto já ocupam esse tempo) | **~+0,1-0,4 s** (fica "escondido" atrás do gather) |
| Sem paralelismo (sequencial) | ~+0,25-0,55 s |
| Com short-circuit (pula a chamada nos triviais) | **~0 s** nesses turnos |

**Resumo latência:** no desenho otimizado (paralelo + short-circuit), o acréscimo típico é **~+0,1-0,4 s** — cerca de **+3 a +10%** sobre um turno de resposta de ~1,5-6 s. Bem dentro do teto de 180 s do bot.

---

## Riscos e mitigações

- **Classificação errada** (ex.: sarcasmo lido como sério) → mitigar com fallback para `neutro` (registro seguro) e logar a decisão para auditoria/ajuste do prompt.
- **Mais uma peça que pode falhar** → timeout curto (ex.: 5 s) + fallback para o `random.choice` atual; nunca bloqueia o turno.
- **Curadoria dos baldes** → trabalho humano de classificar/escrever estilos (principalmente o balde `serio`, inexistente hoje).
- **Over-engineering** → o short-circuit garante que casos triviais não paguem o custo; se a heurística sozinha já resolver a maioria, reavaliar se o LLM compensa.

---

## Fases de implementação

1. **Baldes**: repartir os 9 `estilos_resposta` atuais em `estilos_por_tom` (leve/neutro/serio) no `config.py` — **sem criar estilos novos** (serio = os mais brandos, stopgap).
2. **Classificador**: `classificador.py` com short-circuit + chamada LLM (schema) + fallback + log.
3. **Integração**: encaixar no `gather`, usar tom→balde e `dica_tamanho` no `_montar_conteudo`; ajustar instrução.
4. **Medição**: comparar `prompt_token_count` e latência antes/depois (via `usage_metadata`), validar que o acréscimo bate com a estimativa.
5. **Ajuste fino**: calibrar o prompt do classificador e os gatilhos do short-circuit com casos reais.
