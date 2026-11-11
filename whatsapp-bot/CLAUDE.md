# CLAUDE.md

Este arquivo fornece orientações para o Claude Code (claude.ai/code) ao trabalhar com o código deste repositório.

## Comandos de execução / desenvolvimento

```bash
npm run start           # tsx watch em src/index.ts (entrypoint)
npm run start:debug     # tsx com --inspect para o debugger do Node
npm run inspect:mcp     # inicia o @modelcontextprotocol/inspector contra o servidor MCP
```

**Não há etapa de build, linter, nem framework de testes configurado** — o `tsx` executa TypeScript diretamente. O único `start` é modo de desenvolvimento (watch).

Docker: `docker compose -f docker.compose.yml up --build` (o arquivo se chama `docker.compose.yml`, e não o convencional `docker-compose.yml`). O contêiner monta `auth_info_baileys/` para que a sessão do WhatsApp sobreviva aos rebuilds.

## Pegadinhas do sistema de módulos

- `package.json` define `"type": "module"` e `tsconfig.json` usa `module: nodenext` + `verbatimModuleSyntax: true` + `isolatedModules: true`.
- Imports relativos locais **devem usar a extensão `.js`** mesmo quando estiverem importando um arquivo `.ts` (ex.: `import x from './services/foo.service.js'`). Isso é inegociável sob o NodeNext.
- Imports apenas de tipos devem usar `import type { ... }` (o `verbatimModuleSyntax` força isso).
- Alguns arquivos legados (ex.: `src/repository/agendamento.repository.ts`, `src/services/youtube.service.ts`) ainda usam CommonJS (`require`/`module.exports`). Eles não vão carregar com a configuração ESM atual e precisam ser convertidos antes de serem religados.

## Arquitetura

Este é um bot de WhatsApp pessoal (comandos e identificadores em português). Ele se conecta ao WhatsApp via **Baileys** (`@whiskeysockets/baileys`), não via whatsapp-web.js — arquivos antigos como `whatsapp.client.js` e similares são vestígios.

### Fluxo de conexão (`src/index.ts`)

`main()` cria um socket Baileys usando `useMultiFileAuthState('auth_info_baileys')` e autentica via **pairing code** (sem QR): na primeira execução ele chama `sock.requestPairingCode(TELEFONE_CELULAR)` e imprime o código no terminal. Em `connection.update === 'close'` ele reconecta automaticamente, exceto quando o motivo da desconexão for `loggedOut`. Desconexões que exigem reinício usam um atraso maior, de 15s; as demais, 5s.

`messages.upsert` é o ponto único de dispatch — `enviarMensagem(sock, messageDto)` filtra newsletters e um JID hardcoded, extrai o texto de `conversation`/`extendedTextMessage`/legenda de imagem ou vídeo, separa o primeiro token como nome do comando, e busca no mapa de comandos.

### Sistema de comandos (`src/core/comandos.ts` + `src/commands/`)

Os comandos são descobertos automaticamente: `carregarComandos()` lê todo arquivo `.ts`/`.js` em `src/commands/`, faz `import()` dinâmico, e registra qualquer um cujo default export tenha `name` e `execute`. **Para adicionar um comando, basta criar um arquivo com este formato — sem etapa de registro:**

```ts
import type { ComandoExecutarDto } from '../dto/comandos.dto.js';

export default {
    name: '/exemplo',                      // primeiro token digitado pelo usuário; convenção: barra inicial
    description: '...',
    execute: async (dto: ComandoExecutarDto) => { /* ... */ }
};
```

`ComandoExecutarDto` (`src/dto/comandos.dto.ts`) carrega `{ sock, usuarioJid, conteudo, msg }`, onde `conteudo` é o restante da mensagem após o token do comando. Os comandos geralmente reagem à `msg.key` com um emoji para sinalizar progresso (`⏳` → `✅`/`❌`/`💅`).

O reload acontece **a cada mensagem recebida** (`carregarComandos()` é chamado dentro de `enviarMensagem`). Isso significa que edições em arquivos de comando entram em vigor sem reiniciar, mas também significa que `src/commands/` não deve conter arquivos que não sejam comandos — `src/commands/arquivados/` é um subdiretório de comandos desativados, e só é ignorado porque o `readdirSync` não é recursivo.

### Persistência (`src/config/database.ts`)

`better-sqlite3` apontando para `whatsapp-bot.db` (commitado no repo). Duas tabelas são criadas automaticamente no import:

- `mensagens` — legado. Antes guardava o histórico de chat do `/p` por `chat_id`. Hoje o `/p` é só uma ponte HTTP para o projeto `agente/`, que gerencia sessão própria (ADK `DatabaseSessionService` em `agente.db`). A tabela continua sendo criada mas não é mais lida/escrita pelos comandos ativos.
- `agendamento` — mensagens de saída agendadas (expressão cron + status). O código do repositório existe, mas ainda não está ligado ao runtime.

### Serviços (`src/services/`)

Cada um é uma classe instanciada por chamada de comando (sem container de DI). Os mais notáveis:
- `GoogleCloudService` — geração de texto + imagem do Gemini. **Não é mais usado pelo `/p`** (que virou ponte para o `agente/`); fica disponível para outros comandos que ainda precisem chamar Gemini direto. A persona/dicionário de gírias hardcoded aqui foi migrada para `agente/src/agente/agent/instruction.py` — se editar a persona, edite no agente.
- `LastfmService` — usado pelo `/semaninha` para montar a colagem 5×5 de álbuns da semana. Faz fallback para a Search API do iTunes quando o Last.fm retorna a capa placeholder padrão (identificada pelo hash `2a96cbd8b46e442fc41c2b86b821562f`).
- `whatsappService` (`src/services/whatsapp.service.ts`) — singleton que guarda o `WASocket` ativo, pensado para que o servidor MCP alcance a conexão viva. Atualmente `inicializarInstancia` **não é chamado** em `index.ts` (a linha está comentada), então a tool do MCP lançaria "Whatsapp Socket não inicializado" se fosse invocada.

### Servidor MCP (`src/mcp/mcp.server.ts`)

Sobe no boot (`startMcpServer()` chamado em `index.ts:160`) em `http://localhost:${MCP_PORT}/mcp` (default 3001), modo `StreamableHTTPServerTransport` **stateless** — 1 server novo por request HTTP, sem sessão persistente. `whatsappService.inicializarInstancia(sock)` é chamado em `connection === 'open'` (`index.ts:72`).

Tools registradas hoje (todas usam `whatsappService.recuperarInstancia()` para acessar o socket vivo):
- `enviar_texto(jid, texto)` — mensagem de texto.
- `enviar_imagem(jid, mediaBase64, legenda?)` — imagem PNG/JPG.
- `enviar_sticker(jid, mediaBase64)` — converte PNG/JPG em figurinha via `wa-sticker-formatter`.
- `reagir(jid, msgKey, emoji)` — reação na mensagem original; `msgKey` é o objeto `proto.IMessageKey` (id/remoteJid/fromMe/participant).

Para adicionar uma tool nova, replicar o padrão (`server.registerTool(nome, { description, inputSchema: zodShape }, handler)`) — `handler` deve devolver `{ content: [...] }` em sucesso e `{ isError: true, content: [...] }` em falha. **Não** expor tool genérica de "executar comando" — verbos de domínio dão schemas mais claros para o LLM consumidor.

O consumidor atual é o projeto `agente/` (na raiz do repo, fora deste diretório).

### Ambiente

O `.env` é carregado por `src/config/env.ts` — importe esse arquivo primeiro (e apenas via `import './config/env.js'` no topo de `index.ts`) para que `process.env` esteja populado antes que qualquer construtor de serviço o leia. Constantes centralizadas ficam no objeto `ENV` exportado; prefira adicionar variáveis novas lá em vez de ler `process.env` direto. Chaves em uso: `TELEFONE_CELULAR`, `GEMINI_API_KEY`, `LASTFM_API_KEY`/`LASTFM_API_URL`/`LASTFM_SHARED_SECRET`, `CRAFT_API_URL`, `HEAVY_API_URL`/`HEAVY_API_KEY`, `IS_DESENV`, `CHROME_FOLDER_MACOS`/`CHROME_FOLDER_LINUX`, `MCP_PORT` (default 3001), `AGENT_URL` (default `http://localhost:8000` — URL base do projeto `agente/`, usada pelo `/p`), `VACUO_GRUPO_ATIVO` (default `true`; só desliga com `false`) e `VACUO_GRUPO_DELAY_MS` (default `300000` = 5 min) — anti-vácuo de grupo (opt-in por grupo via `/vacuo on|off`).

## Convenções

- Identificadores, comentários, mensagens de log e strings voltadas ao usuário ficam **em português (pt-BR)**. Mantenha o código novo consistente — não traduza nomes existentes para inglês.
- Respostas ao usuário são informais/divertidas (emojis, gírias). Mantenha o tom ao adicionar respostas de comando ou mensagens de erro.
- Erros dentro do `execute` de um comando devem reagir com `❌` na mensagem original e enviar uma resposta de texto curta, sem derrubar o dispatcher.
