# 🤖 WhatsApp Bot + Agente de IA

Bot de WhatsApp **pessoal** com uma persona de IA conversacional. O projeto é um
**monorepo** com dois serviços independentes que cooperam em tempo de execução:
um *client* de WhatsApp (Node/TypeScript) e um *agente* de IA (Python) que
orquestra o bot.

> Identificadores, comandos e mensagens são em **português (pt-BR)**.

---

## Como funciona (visão geral)

```
WhatsApp ──msg──▶ whatsapp-bot ──/p──▶ POST /chat ──▶ agente (ADK + Gemini)
                   (Baileys, TS)                        │
                       ▲                                 │ tool calls (MCP)
                       └───────────── POST /mcp ◀────────┘
                     (envia texto/imagem/áudio/figurinha de volta)
```

São **dois processos**:

| Serviço | Stack | Papel |
|---|---|---|
| [`whatsapp-bot/`](./whatsapp-bot) | Node.js + TypeScript + [Baileys](https://github.com/WhiskeySockets/Baileys) | Conecta ao WhatsApp, despacha comandos, e expõe um **servidor MCP** com as ações no WhatsApp (enviar texto/imagem/figurinha/áudio, reagir). |
| [`agente/`](./agente) | Python + FastAPI + [Google ADK](https://google.github.io/adk-docs/) + Gemini | Hospeda o `LlmAgent` com a persona. Recebe a mensagem, decide a resposta, chama as *tools* (geração de imagem, busca, memória…) e devolve o texto. |

O fluxo é **bidirecional**: o bot chama o agente por HTTP (`POST /chat`); o agente
age no WhatsApp chamando o MCP do bot (`POST /mcp`). Essa separação é proposital —
toda a lógica de IA/persona vive no `agente/`, e o `whatsapp-bot/` é só a interface
com o WhatsApp.

---

## Principais recursos

- **Persona conversacional** — o comando `/p` (ou @menção) manda a mensagem ao
  agente, que responde no personagem, com humor calibrado por um classificador de
  tom/complexidade e histórico de contexto recente.
- **Geração com IA** — imagens, figurinhas (stickers), áudio (TTS) e música
  (Lyria), criados sob demanda e entregues direto no chat.
- **Áudio espontâneo** — de vez em quando a resposta de conversa vira uma **nota de
  voz** em vez de texto (decisão aleatória com peso maior para texto).
- **Anti-vácuo de grupo** — em grupos habilitados, se uma mensagem fica sem resposta
  por alguns minutos, o bot "quebra o vácuo" sozinho (ignorando ruído como risada
  pura, só-emoji ou figurinha).
- **Memória de longo prazo** — memória vetorial por pessoa (texto) + **memória
  visual** (reconhecimento facial) para lembrar de quem aparece nas fotos.
- **Busca** — web e **artigos científicos** (Semantic Scholar / OpenAlex).
- **Semaninha** — colagem 5×5 dos álbuns mais ouvidos da semana (Last.fm), com
  fallback de capa (iTunes → Deezer).
- **Observabilidade** — logs centralizados em memória, comando `/logs` e tool para
  o admin inspecionar o que aconteceu.

---

## Estrutura do repositório

```
.
├── whatsapp-bot/   # client WhatsApp (Baileys, Node/TS) + servidor MCP
├── agente/         # agente ADK (Python/FastAPI) — persona, tools, memória
└── docs/           # planos e documentação de apoio
```

Cada subprojeto tem o próprio README/CLAUDE.md com detalhes de execução.

---

## Rodando localmente

São dois processos. **A ordem importa**: o agente precisa do MCP do bot no ar.

```bash
# 1) sobe o bot (Baileys + MCP na porta 3001)
cd whatsapp-bot && npm install && npm run start

# 2) sobe o agente (FastAPI na porta 8000)
cd agente && poetry install && poetry run uvicorn main:app --app-dir src --reload --port 8000
```

Pré-requisitos:

- **Node 18+** e **Python 3.11+** (+ [Poetry](https://python-poetry.org/)).
- **ffmpeg** no PATH (para converter o áudio do TTS em nota de voz).
- Um `.env` em cada serviço (veja `agente/.env.example`). A chave obrigatória é a
  `GEMINI_API_KEY`; as demais têm default.
- O WhatsApp conecta por **pairing code** (sem QR): na primeira execução o bot
  imprime um código para digitar em *WhatsApp → Aparelhos conectados*.

---

## Tecnologias

`Baileys` · `TypeScript` · `better-sqlite3` · `Model Context Protocol (MCP)` ·
`Python` · `FastAPI` · `Google ADK` · `Gemini` · `sqlite-vec` · `InsightFace`

---

> Projeto pessoal, para fins de estudo e uso próprio.
