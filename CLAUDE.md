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

- `mensagens` — histórico de chat do Gemini por `chat_id`, com `role` ∈ `{user, model}`. `GoogleCloudService._recuperarHistorico` pega os últimos 10 por timestamp e os passa para `ai.chats.create({ history })`, de modo que `/perguntar` tenha estado por conversa do WhatsApp.
- `agendamento` — mensagens de saída agendadas (expressão cron + status). O código do repositório existe, mas ainda não está ligado ao runtime.

### Serviços (`src/services/`)

Cada um é uma classe instanciada por chamada de comando (sem container de DI). Os mais notáveis:
- `GoogleCloudService` — geração de texto + imagem do Gemini. `gerarConteudo` ramifica conforme `chatId` for fornecido: com `chatId`, persiste turnos em `mensagens`; sem, é uma chamada one-shot. As instruções de sistema têm persona e dicionário de gírias hardcoded em português — preserve-os ao editar.
- `LastfmService` — usado pelo `/semaninha` para montar a colagem 5×5 de álbuns da semana. Faz fallback para a Search API do iTunes quando o Last.fm retorna a capa placeholder padrão (identificada pelo hash `2a96cbd8b46e442fc41c2b86b821562f`).
- `whatsappService` (`src/services/whatsapp.service.ts`) — singleton que guarda o `WASocket` ativo, pensado para que o servidor MCP alcance a conexão viva. Atualmente `inicializarInstancia` **não é chamado** em `index.ts` (a linha está comentada), então a tool do MCP lançaria "Whatsapp Socket não inicializado" se fosse invocada.

### Servidor MCP (`src/mcp/mcp.server.ts`)

Esqueleto com uma única tool (`enviar_sticker`) que acessa o `whatsappService` para mandar stickers. A chamada `app.listen(...)` está comentada, então o servidor não sobe de fato no `main()` atual. Para religar, é preciso (a) descomentar `startMcpServer`, (b) chamar `whatsappService.inicializarInstancia(sock)` assim que a conexão abrir, e (c) importar/invocar o servidor a partir de `index.ts`.

### Ambiente

O `.env` é carregado por `src/config/env.ts` — importe esse arquivo primeiro (e apenas via `import './config/env.js'` no topo de `index.ts`) para que `process.env` esteja populado antes que qualquer construtor de serviço o leia. Constantes centralizadas ficam no objeto `ENV` exportado; prefira adicionar variáveis novas lá em vez de ler `process.env` direto. Chaves em uso: `TELEFONE_CELULAR`, `GEMINI_API_KEY`, `LASTFM_API_KEY`/`LASTFM_API_URL`/`LASTFM_SHARED_SECRET`, `CRAFT_API_URL`, `HEAVY_API_URL`/`HEAVY_API_KEY`, `IS_DESENV`, `CHROME_FOLDER_MACOS`/`CHROME_FOLDER_LINUX`.

## Convenções

- Identificadores, comentários, mensagens de log e strings voltadas ao usuário ficam **em português (pt-BR)**. Mantenha o código novo consistente — não traduza nomes existentes para inglês.
- Respostas ao usuário são informais/divertidas (emojis, gírias). Mantenha o tom ao adicionar respostas de comando ou mensagens de erro.
- Erros dentro do `execute` de um comando devem reagir com `❌` na mensagem original e enviar uma resposta de texto curta, sem derrubar o dispatcher.
