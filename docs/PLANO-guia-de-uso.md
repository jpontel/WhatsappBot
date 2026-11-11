# PLANO — Guia de Uso (gatilho "como você funciona")

## Objetivo

Quando QUALQUER usuário perguntar sobre o funcionamento do bot, a LulaDroid responde
com suas capacidades **filtradas pelo nível do usuário** (admin vê mais, comum vê
menos). Dois casos:

1. **Lista completa** — "como você funciona?", "o que você faz?", "quais seus
   comandos?" → catálogo das funcionalidades do nível daquela pessoa.
2. **Cherry-pick (função específica)** — "você sabe salvar meu rosto? como que é?",
   "como eu crio um lembrete?" → explica **só aquela** função (como usar), ainda
   respeitando o nível (se for de admin e a pessoa não for, diz que é só do admin).

## Mecanismo (encaixa na arquitetura de rotas já existente)

Reusa o **roteador determinístico** (`client/roteador.py`) + **instrução modular por
rota** (`client/instruction.py`), para NÃO inflar tokens nos outros turnos.

- **Nova rota `ajuda`** no roteador: uma regex de "meta-pergunta" (`_RE_AJUDA`)
  detecta a intenção de ajuda/guia. Checada CEDO em `decidir_rota` (antes das rotas
  de ação), para "como funciona X" não cair em geração/edição/etc.
- **Fragmento `INSTRUCAO_POR_ROTA["ajuda"]`**: o CATÁLOGO das funcionalidades em 2
  camadas (comum / admin), com um "como usar" curto por função (para o cherry-pick),
  e a instrução de **filtrar por `eh_admin`** (já disponível no `[contexto-sistema]`)
  e de **responder só a função específica** quando a pergunta for pontual. Só carrega
  no turno de ajuda (token-disciplinado).
- **Tools da rota `ajuda` = nenhuma** (`frozenset()` + base): é explicação, não
  execução → zero schema de tool no prompt. E `ajuda` NÃO é rota de ação (sem reação
  ⏳/💅).
- **Rede de segurança = o próprio fallback** (decisão): quando a regex NÃO pega a
  frase, o turno cai no fallback do roteador, que já concatena TODOS os fragmentos —
  **incluindo o `ajuda`**. Então o catálogo + as regras chegam ao LLM mesmo num miss,
  sem precisar de regra no núcleo. Por isso **NÃO** adicionamos item novo no núcleo
  (evita custo fixo de ~180 tok/turno para um recurso raro). O gatilho é
  determinístico (regex); a resposta usa o LLM só para render em persona + cherry-pick.

O filtro por nível é feito pelo LLM usando `eh_admin` do contexto — não precisa de
código novo de permissão (o catálogo diz o que é de admin; a persona omite isso para
não-admin).

## Camadas do catálogo (mantido à mão no fragmento)

**Comum (todos):** conversa/curiosidades · busca web e artigos científicos · imagens
(criar/buscar/editar/converter em figurinha) · figurinhas · áudio (TTS) e música ·
lembretes seus (criar/listar/cancelar) · memória sua (cadastrado) · semaninha/charts
Last.fm · mencionar alguém (@) e listar o grupo · baixar música/vídeo do YouTube ·
responde por menção/reply/anti-vácuo · reconhece rostos conhecidos em fotos.

**Só admin (além do comum):** cadastrar pessoas (`/cadastrar <nome> @menção` · pelo
número · `/cadastrar -listar`) · cadastrar/corrigir rostos (foto + "esse é o fulano")
· gerenciar a memória de QUALQUER pessoa · `/vacuo on|off` (anti-vácuo do grupo) ·
lembretes para/de terceiros e mexer em qualquer lembrete do chat.

> Fonte única = o fragmento. Ao adicionar/remover uma tool, atualizar o catálogo aqui
> (mesma disciplina de manter a instrução). Auto-derivar do registro de tools seria o
> ideal "sempre atualizado", mas exige anotar cada tool com {descrição p/ usuário,
> flag de admin} — fora de escopo por ora (YAGNI).

## Arquivos

| Arquivo | Mudança |
|---|---|
| `agente/src/client/roteador.py` | `_RE_AJUDA` + regra em `decidir_rota` (cedo) + `"ajuda": frozenset()` em `_TOOLS_POR_ROTA` + excluir `ajuda` de `eh_rota_de_acao`. |
| `agente/src/client/instruction.py` | `INSTRUCAO_POR_ROTA["ajuda"]` (catálogo 2 camadas + how-tos + filtro por nível + cherry-pick). **Sem** item novo no núcleo. |

## Validação

- Smoke de `decidir_rota` com frases: "como você funciona" / "o que você faz" /
  "você sabe salvar meu rosto? como?" / "quais meus comandos" → rota `ajuda`; e
  contra-exemplos de ação ("faz uma imagem de gato", "me lembra amanhã") → NÃO caem
  em `ajuda`.
- `py_compile` dos dois arquivos.
