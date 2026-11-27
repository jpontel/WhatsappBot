# PLANO — Fundação de engenharia: lint, CI, CD automático e observabilidade

## Contexto

Este monorepo (`bot/` = `whatsapp-bot/` + `agente/`) nasceu como um script Node simples e evoluiu para dois serviços cooperando em produção (Baileys + agente ADK). A engenharia em volta não acompanhou:

- **Não há lint** em nenhum dos dois projetos.
- **O CI efetivamente nunca rodou** desde a migração para monorepo em junho/2026 (commit `400d55b`) — o workflow ficou em `whatsapp-bot/.github/workflows/ci.yml`, mas o GitHub Actions só lê `.github/workflows/` na **raiz** do repo. Mesmo movido para o lugar certo, ele quebraria hoje porque usa `npm ci`, que exige `package-lock.json` versionado — e esse arquivo está no `.gitignore`.
- **Deploy é 100% manual** via SSH/rsync para a Linode secundária (`wpp-bot-secondary`), instância com RAM apertada (~4GB) e sessão WhatsApp sensível a restart duplicado (erro `conflict: replaced`).
- **Observabilidade externa inexistente.** Já existe um ring buffer interno (`shared/log_buffer.py` no agente, `core/log-buffer.ts` no bot — ver `docs/PLANO-logs-observabilidade.md`) que alimenta o comando `/logs` e a tool `inspecionar_logs`, pensado para a própria IA se auto-inspecionar via WhatsApp. Isso **não substitui** error tracking persistente nem tracing de execução do agente — são camadas complementares, não concorrentes.

## Decisões já tomadas

1. **npm** como único gestor de pacote do `whatsapp-bot` (remover vestígios de pnpm).
2. CI com **lint + testes** nos dois projetos (não só testes).
3. CD completo (build + deploy via SSH) no merge em `main`, com guard-rail manual na primeira fase dado o histórico de instabilidade da produção.
4. **Observabilidade**: adicionar **Sentry** (erros/crashes, nos dois serviços) e **Langfuse** (tracing de chamadas de LLM/tools do agente). São categorias diferentes de ferramenta — Sentry é "error tracking/APM" genérico; Langfuse é "LLM/agent observability", a categoria relevante especificamente para dev de agentes e o que o usuário quer testar do mercado atual. Ambos via SaaS/free tier, sem subir container novo na VPS já apertada de RAM. Complementam (não substituem) o `/logs` e `inspecionar_logs` já existentes: aquele é para a IA se auto-inspecionar em tempo real via WhatsApp; Sentry/Langfuse são para o humano investigar incidentes e qualidade de execução do agente fora da conversa.

## Fase 0 — Higiene de repositório (pré-requisito)

1. **Destravar `whatsapp-bot/tsconfig.json`, `package.json`, `package-lock.json` E `src/config/env.ts` do `.gitignore`** (`whatsapp-bot/.gitignore:7-17`). **Achado bloqueante da revisão técnica**: `src/config/env.ts` é código-fonte real (carrega `dotenv`, exporta o objeto `ENV` consumido por `index.ts` e por pelo menos mais 6 módulos — `identidade.ts`, `vacuo-grupo.ts`, `contexto.ts`, `commands/perguntar.ts`, `services/lastfm.service.ts`, `services/google-cloud.service.ts`), não um segredo — o único valor sensível nele é um fallback hardcoded de chave pública do Last.fm (`env.ts:11`), já exposto em claro. Hoje "funciona" só porque o deploy é `rsync` do working tree local, que tem o arquivo em disco sem estar commitado. **Num `actions/checkout` de CI (clone limpo do Git), o arquivo não existiria e `tsc --noEmit` falharia com `Cannot find module './config/env.js'` em `index.ts:1`** — isso quebraria a Fase 4 inteira se não for corrigido aqui. Versionar o arquivo junto com `tsconfig.json`/`package.json`/`package-lock.json`.
2. **Remover pnpm**: `git rm whatsapp-bot/pnpm-lock.yaml whatsapp-bot/pnpm-workspace.yaml`; gerar/versionar `package-lock.json` via `npm install`. O `onlyBuiltDependencies` do pnpm não tem equivalente no npm — não precisa ser replicado, `npm install` puro já roda os scripts nativos (é o que o Dockerfile já faz hoje em produção).
   - **Risco residual aceito, documentado explicitamente (não corrigido nesta fase)**: o `Dockerfile:24-29` copia só `package.json` (nunca o lockfile) e roda `npm install` puro — comentário no próprio arquivo explica que o lockfile antigo (era pnpm) causava `"Invalid Version"` no dedup do npm. Isso significa que, mesmo depois de versionarmos um `package-lock.json` novo e usá-lo no CI (via `npm ci`, Fase 4), **o build de produção (Docker) continua resolvendo a árvore de dependências do zero, sem olhar o lockfile** — o que passou no CI não é bit-a-bit o que vai pra produção (drift possível em versões transitivas dentro dos ranges semver). Migrar o Dockerfile para `npm ci` fica fora do escopo desta rodada (exigiria validar que o lockfile FRESCO, gerado do zero, não reproduz o mesmo bug do lockfile legado — o bug era do lockfile antigo dessincronizado, não de lockfiles em geral, mas isso precisa ser testado à parte). Registrar como débito técnico, não ignorar silenciosamente.
3. **Remover arquivo órfão** `whatsapp-bot/docker.compose.yml` (resíduo do setup monolítico antigo, já substituído pelo `docker-compose.yml` da raiz).
4. **Mover o workflow de CI para a raiz**: criar `.github/workflows/`, mover `whatsapp-bot/.github/workflows/ci.yml` para lá (reescrito na Fase 4), remover `whatsapp-bot/.github/` vazio.
5. **Atualizar `whatsapp-bot/CLAUDE.md`** (achado incidental da revisão, não apontado pelo plano original): o arquivo afirma hoje "Não há etapa de build, linter, nem framework de testes configurado" (falso — Vitest já existe e lint é adicionado na Fase 1) e instrui rodar `docker compose -f docker.compose.yml up --build` (o arquivo que a Fase 0.3 remove). Corrigir essas duas afirmações para não desorientar sessões futuras de IA/devs.

Commits pequenos e separados por item.

## Fase 1 — `whatsapp-bot`: lint/format

ESLint flat config + `typescript-eslint` + Prettier (`eslint-config-prettier` para não conflitar).

- `whatsapp-bot/eslint.config.js` — regras mínimas (`@typescript-eslint/no-unused-vars` warn, `no-explicit-any` warn, `no-console` off, já que o bot loga bastante). A strictness principal já vem do `tsconfig.json`.
- `whatsapp-bot/.prettierrc.json` — `semi: true, singleQuote: true, trailingComma: "all", printWidth: 100`.
- `whatsapp-bot/.prettierignore`.
- `package.json`: novas devDeps (`eslint`, `typescript-eslint`, `@eslint/js`, `eslint-config-prettier`, `prettier`) e scripts `lint`, `format`, `format:check`.

**Verificação local:** `npm install && npm run lint && npm run format:check && npm test && npx tsc --noEmit`. Não travar em warnings nesta primeira rodada, só em erros (comportamento padrão do ESLint).

## Fase 2 — `agente`: lint/format

Estender o `[tool.ruff]` já existente em `agente/pyproject.toml`:
```toml
[tool.ruff.lint]
select = ["E", "F", "I", "UP"]
ignore = ["E501"]  # ver nota abaixo

[tool.ruff.format]
```

**Ajuste feito durante a implementação**: `E501` (linha longa) precisou ser ignorado — o projeto tem ~180 linhas de comentário explicativo em pt-BR acima de 100 chars (documentando decisões não-óbvias, como o próprio `agente/CLAUDE.md` pede). Nem subindo `line-length` para 140 isso zera (ainda sobrariam ~109). Reflow manual de ~180 comentários não compensa o risco/esforço para uma regra de estilo, não de correção — `ruff format` já cuida da formatação do código em si.
Sem mypy/black/pre-commit agora (fora do escopo pedido — YAGNI). Documentar comandos (`poetry run ruff check .`, `poetry run ruff format --check .`, `poetry run pytest`) no `agente/CLAUDE.md`.

**Verificação local:** rodar `ruff check`/`ruff format --check`; se o código legado tiver muitos achados (esperado, principalmente import-sort), aplicar `ruff check --fix .` + `ruff format .` como commit único de normalização **antes** de ligar o CI, para ele nascer verde.

## Fase 3 — Observabilidade: Sentry (erros) + Langfuse (tracing de agente)

**3.1. Sentry no `whatsapp-bot`**
- Dependência nova: `@sentry/node`.
- `Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 })` no topo de `src/index.ts`, antes de qualquer outra importação pesada.
- Capturar exceptions não tratadas do processo (`process.on('uncaughtException'/'unhandledRejection')`) e erros já tratados nos handlers de comando existentes, via `Sentry.captureException`.
- Nova env var `SENTRY_DSN` em `whatsapp-bot/.env` (local e produção — adicionada manualmente, não versionada, mesmo padrão de `GEMINI_API_KEY`).

**3.2. Sentry no `agente`**
- Dependência nova: `sentry-sdk[fastapi]`.
- `sentry_sdk.init(dsn=settings.sentry_dsn, traces_sample_rate=0.1)` em `src/main.py`, com a integração FastAPI (captura automática de exceptions não tratadas nas rotas `/chat`, `/health`, `/logs`).
- Nova env var `SENTRY_DSN` em `agente/.env`.

**3.3. Langfuse no `agente`**

**Correção de um achado bloqueante da revisão técnica**: a ideia original ("configuração via env vars, sem mudar lógica") é falsa pelo que o `agente/poetry.lock` mostra. O `google-adk 2.3.0` instalado hoje trava só `opentelemetry-api`/`opentelemetry-sdk` — o exportador OTLP real (`opentelemetry-exporter-otlp-proto-http`) só vem com os extras opcionais `all`/`gcp`/`test` do ADK (`poetry.lock:825-838`), nenhum habilitado no `pyproject.toml` atual. Sem esse pacote instalado, `google/adk/telemetry/setup.py:_get_otel_span_exporter()` nunca consegue importar `OTLPSpanExporter`, e setar as env vars sozinho **não tem efeito nenhum** — nada consome essas variáveis. Além disso, o setup do ADK (`maybe_set_otel_providers()`, em `google/adk/telemetry/setup.py`) não roda automaticamente num FastAPI "cru" como o deste projeto (`src/main.py` monta o `FastAPI()` na mão, sem usar o `get_fast_api_app()` do ADK, que é quem chamaria isso por conta própria) — precisa ser **chamado explicitamente** no startup.

Plano corrigido:
- **Sem dependência de SDK da Langfuse** — como a ingestão é via OTLP genérico (endpoint compatível com OpenTelemetry que o Langfuse Cloud expõe), não precisamos do pacote `langfuse` do PyPI, só do exportador OTLP. Isso também é mais simples (YAGNI): uma dependência a menos.
- Dependência nova: `opentelemetry-exporter-otlp-proto-http` (adicionar direto no `pyproject.toml`, sem puxar o extra `all`/`gcp` inteiro do ADK, que traz dependências pesadas e irrelevantes tipo `google-cloud-bigquery`).
- `src/config.py` (Settings): novos campos `langfuse_public_key: str = ""`, `langfuse_secret_key: str = ""`, `langfuse_host: str = "https://cloud.langfuse.com"`.
- `src/main.py`, antes de `app = FastAPI(...)`: montar `OTEL_EXPORTER_OTLP_ENDPOINT` e `OTEL_EXPORTER_OTLP_HEADERS` em `os.environ` a partir de `settings.langfuse_*` (mesmo padrão já usado em `config.py` para `GOOGLE_API_KEY`) e então chamar explicitamente `from google.adk.telemetry.setup import maybe_set_otel_providers; maybe_set_otel_providers()` — sem essa chamada, o exportador nunca é registrado, independente das env vars estarem corretas.
- Resultado esperado: cada turno de `/chat` vira um trace no Langfuse com mensagem recebida, tool calls do `LlmAgent` (inclusive as chamadas MCP pro bot — `enviar_texto`, `reagir` etc.), tokens consumidos, latência e modelo usado (relevante para o fallback de modelo já existente em `client/fallback_model.py`).
- **Se `langfuse_public_key` estiver vazio** (kill switch, mesmo padrão de `notes_mcp_url` em `config.py`), pular a chamada de `maybe_set_otel_providers()` — não vale a pena pagar overhead de tracing em ambientes onde ninguém vai olhar o dashboard (ex.: dev local sem conta Langfuse criada).

**Risco a observar:** `tracesSampleRate`/`traces_sample_rate` e o export do Langfuse adicionam overhead de rede por request — validar que não piora o timeout de 180s já apertado (`AGENT_TIMEOUT_MS`, documentado no `CLAUDE.md`) na Linode secundária. Se notar latência extra perceptível, reduzir sample rate do Sentry ou confirmar que o export OTLP do Langfuse é assíncrono (`BatchSpanProcessor` já é assíncrono por padrão — confirmado em `google/adk/telemetry/setup.py:_get_otel_span_exporter()` — mas validar em teste real mesmo assim).

**Nota fechada sobre ordem de inicialização (dúvida que a revisão técnica investigou e descartou):** não há risco de `Sentry.init` rodar antes do `dotenv.config()` de `config/env.ts`, mesmo colocando o `Sentry.init` "no topo" do arquivo — `whatsapp-bot` usa ESM puro (`"type": "module"`, `tsconfig.json: module: nodenext`), e em ESM todo `import` estático é resolvido e seus efeitos colaterais executados **antes** de qualquer instrução local do módulo rodar, independente da ordem textual. Mantenha `import './config/env.js'` como import estático (não trocar por `await import(...)` dinâmico, que aí sim quebraria essa garantia). Em produção isso é ainda mais irrelevante, já que `SENTRY_DSN` vem do `environment:`/`env_file` do `docker-compose.yml`, presente em `process.env` antes do Node iniciar.

**Verificação local:** criar conta free tier em Sentry e Langfuse Cloud, setar as envs localmente, rodar uma conversa de teste via `/chat` e um erro forçado em cada serviço; confirmar 1 trace no Langfuse e 1 evento no Sentry de cada serviço.

## Fase 4 — CI: dois workflows na raiz, com `paths:` filter

Dois arquivos independentes (`.github/workflows/ci-whatsapp-bot.yml`, `.github/workflows/ci-agente.yml`), cada um disparando só quando seu diretório muda. Mais simples de ler que um workflow único condicional, e falha de um projeto não assusta quem mexeu só no outro.

- **ci-whatsapp-bot.yml**: jobs `typecheck` (`tsc --noEmit`) e `lint` (eslint + `prettier --check`) usam `npm ci --ignore-scripts` — seguro, porque nenhum dos dois EXECUTA código, só parseia/analisa estaticamente (não precisam dos binários nativos compilados).
  - **Correção de achado bloqueante da revisão técnica**: o job `test` **não pode** usar `--ignore-scripts`. Não é uma hipótese "se algum teste importar" — é uma certeza verificável hoje: `dispatcher.test.ts` e `vacuo-grupo.test.ts` importam `src/repository/pessoa.repository.ts` → `config/database.ts:1` (`better-sqlite3`, nativo); `mcp-tools.test.ts` carrega `src/mcp/mcp.server.ts` → `utils/canvas.ts` (`canvas`, nativo); `carregar-comandos.test.ts` faz `import()` dinâmico de TODO arquivo em `src/commands/`, inclusive os que tocam database/canvas. **5 das 6 suites quebram** com `--ignore-scripts` (só `desligamento.test.ts` fica ileso). O job `test` precisa:
    1. Rodar `npm ci` **sem** `--ignore-scripts` (compila os binários nativos de verdade).
    2. Antes disso, instalar as libs de sistema que `canvas`/`better-sqlite3` exigem para compilar, espelhando `whatsapp-bot/Dockerfile:4-11`: `apt-get install -y python3 build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev` (o runner `ubuntu-latest` não vem com essas libs de cairo/pango pré-instaladas).
  - **Correção de achado importante**: `whatsapp-bot/Dockerfile:19-22` documenta um bug conhecido do npm 10.8.2 (bundlado no `node:20-slim`) que quebra a resolução de árvore deste projeto ("Cannot read properties of null (reading 'edgesOut')"), corrigido ali com `npm install -g npm@11`. O runner `actions/setup-node@v4` com `node-version: 20` pode vir com uma versão de npm igualmente velha/vulnerável a esse bug. Replicar o mesmo `npm install -g npm@11` como primeiro step (antes de `npm ci`) nos três jobs deste workflow, não só no Dockerfile.
- **ci-agente.yml**: jobs `lint` (`ruff check` + `ruff format --check`) e `test` (`pytest`), via Poetry 2.4.1, Python 3.11. Atenção: `insightface` compila extensão nativa — `ubuntu-latest` já vem com toolchain de compilação, mas validar na primeira execução real; se faltar `build-essential`/`libgomp1`/`libglib2.0-0`, adicionar step de `apt-get` espelhando o Dockerfile.

## Fase 5 — CD: deploy automático em merge na `main`

`.github/workflows/deploy.yml`, trigger `push` em `main`, `concurrency: { group: deploy-production, cancel-in-progress: false }` (nunca cancelar um deploy em andamento — risco de deixar o Baileys pela metade de um restart).

Três jobs: `gate-whatsapp-bot` e `gate-agente` (repetem lint+test+typecheck dos dois projetos sempre — não dá pra confiar em `paths:` aqui porque o deploy sempre sobe os dois serviços juntos) e `deploy` (depende dos dois gates):

1. Configura chave SSH a partir de secret.
2. `rsync -az --delete` com excludes: `node_modules`, `.venv`, `.git`, `auth_info_baileys`, `*.db*`, `data`, **`.env`** (crítico — sem esse exclude o `--delete` apagaria os `.env` de produção, incluindo as novas chaves `SENTRY_DSN`/`LANGFUSE_*`, que não são versionadas e só existem no servidor).
3. `ssh ... "cd /root/bot && docker compose up -d --build"` — comando único, nunca `down` seguido de `up` (padrão já documentado no `CLAUDE.md`, evita o erro `conflict: replaced` do Baileys).

**Secrets necessários (configuração manual do usuário no GitHub — fora do alcance do `gh` local, sem permissão de admin neste repo):** `DEPLOY_SSH_KEY` (conteúdo de `linode_secondary/id_ed25519`), `DEPLOY_HOST`, `DEPLOY_USER`.

**Decisão explícita sobre a duplicação de gate (confirmada pela revisão técnica):** rodar lint+test+typecheck de novo dentro de `deploy.yml`, em vez de só confiar nos checks de `ci-*.yml` do PR, é redundante em minutos de CI mas é a escolha consciente certa **hoje**, porque o histórico deste repo (`git log`) mostra commits diretos em `main` sem exigir PR/branch protection — os gates do `deploy.yml` são a única rede de segurança contra um push direto não validado. Se no futuro o fluxo passar a ser sempre via PR com branch protection (required status checks nos workflows de CI), os gates do `deploy.yml` passam a ser desperdício puro e podem ser removidos em favor de `needs: []` direto após o merge. Registrado aqui para não ser esquecido quando esse dia chegar.

**Segurança da etapa de SSH (fechamento de achado nice-to-have):** o GitHub Actions já mascara automaticamente qualquer valor vindo de `secrets.*` em logs, inclusive via `echo` — risco de vazamento por log é baixo por padrão. Ainda assim, a etapa de configuração da chave deve: escrever a chave privada em arquivo temporário com `chmod 600` imediatamente após criar o arquivo (nunca deixar com permissão default antes do chmod); usar `ssh-keyscan` para popular `known_hosts` em vez de `StrictHostKeyChecking=no` isolado (reduz exposição a MITM na primeira conexão); e garantir que nenhum step subsequente rode `actions/upload-artifact` apontando para o `$HOME/.ssh` ou qualquer diretório que contenha a chave.

**Nota sobre os excludes do rsync (fechamento de achado nice-to-have):** o `docker-compose.yml:14-18,34-36` da raiz usa **volumes nomeados** (`bot_db`, `agente_db`) para os SQLite, não bind mounts dentro de `/root/bot/` — ou seja, mesmo sem excluir `data` do rsync, o `--delete` nunca atingiria esses dados (eles vivem na área de storage do Docker, fora da árvore sincronizada). A única pasta bind-montada sensível é `auth_info_baileys`, já excluída. O exclude de `data` no passo 2 acima é defensivo/redundante dado o uso de volumes nomeados — mantido mesmo assim por segurança (custo zero, evita surpresa se alguém trocar o compose para bind mount no futuro).

## Fase 6 — Guard-rail de produção (crítico, não pular)

Rollout em 3 estágios, dado o histórico de instabilidade:

- **Estágio A**: antes de criar `deploy.yml`, rodar manualmente via SSH o comando exato que o workflow vai usar (rsync com os excludes acima + `docker compose up -d --build`), confirmando que a sessão sobrevive.
- **Estágio B**: `environment: production` no job `deploy`, com **Required reviewers** configurado manualmente pelo usuário em Settings → Environments (ação de admin). O pipeline roda sozinho até o gate, mas o SSH real só dispara com aprovação humana no GitHub.
- **Estágio C**: só depois de alguns deploys aprovados manualmente sem incidente, remover o required reviewer — CD passa a ser 100% automático.

Checklist a repetir nos primeiros deploys de teste: confirmar via `docker ps` que há só 1 `bot-baileys`/1 `agente-adk` antes; rodar o comando manualmente uma vez; checar `docker logs -f bot-baileys` logo após o rebuild (sem `conflict: replaced` nem `401 loggedOut`, sessão reconecta sem novo QR); só então criar o workflow com o Environment protegido.

## Arquivos a criar/editar/remover

**Criar**: `.github/workflows/ci-whatsapp-bot.yml`, `.github/workflows/ci-agente.yml`, `.github/workflows/deploy.yml`, `whatsapp-bot/eslint.config.js`, `whatsapp-bot/.prettierrc.json`, `whatsapp-bot/.prettierignore`.

**Editar**: `whatsapp-bot/.gitignore`, `whatsapp-bot/package.json`, `whatsapp-bot/src/index.ts` (init Sentry), `whatsapp-bot/CLAUDE.md` (corrigir afirmações desatualizadas sobre lint/testes/compose — Fase 0.5), `agente/pyproject.toml` (lint + `opentelemetry-exporter-otlp-proto-http`), `agente/src/main.py` (init Sentry + `maybe_set_otel_providers()`), `agente/src/config.py` (novas Settings: `sentry_dsn`, `langfuse_public_key`, `langfuse_secret_key`, `langfuse_host`), `agente/CLAUDE.md`.

**Remover**: `whatsapp-bot/pnpm-lock.yaml`, `whatsapp-bot/pnpm-workspace.yaml`, `whatsapp-bot/docker.compose.yml`, `whatsapp-bot/.github/` (dir inteiro).

**Versionar pela 1ª vez**: `whatsapp-bot/tsconfig.json`, `whatsapp-bot/package-lock.json`, `whatsapp-bot/src/config/env.ts` (achado bloqueante da revisão — ver Fase 0.1).

**Novas env vars** (adicionadas manualmente nos `.env` de cada serviço, local e produção — não versionadas): `SENTRY_DSN` (whatsapp-bot e agente), `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` (agente).

## Verificação end-to-end

1. `whatsapp-bot`: `npm install && npm run lint && npm run format:check && npm test && npx tsc --noEmit` — tudo verde localmente antes de confiar no CI. Adicional (fecha o achado bloqueante do `env.ts`/CI): simular um clone limpo antes de abrir o 1º PR — `git clone --depth 1 file://$(pwd) /tmp/clean-clone-whatsapp-bot && cd /tmp/clean-clone-whatsapp-bot/whatsapp-bot && npm ci && npx tsc --noEmit` — se isso falhar por módulo não encontrado, algo ainda está preso no `.gitignore`.
2. `agente`: `poetry install && poetry run ruff check . && poetry run ruff format --check . && poetry run pytest` — tudo verde localmente.
3. Observabilidade: com envs de Sentry/Langfuse setadas localmente, rodar uma conversa de teste via `/chat` e um erro forçado em cada serviço; confirmar trace no Langfuse (validando especificamente que `maybe_set_otel_providers()` foi chamado e o pacote `opentelemetry-exporter-otlp-proto-http` está instalado — sem isso, nenhum trace chega, mesmo com as env vars certas) e evento no Sentry.
4. Abrir um PR de teste e confirmar que `ci-whatsapp-bot.yml`/`ci-agente.yml` aparecem rodando no GitHub Actions (prova de que saíram do limbo em que estavam), que cada um dispara só com mudanças no seu diretório, e que o job `test` do `ci-whatsapp-bot.yml` passa de fato com os módulos nativos compilados (não só `typecheck`/`lint`).
5. Deploy automático só é ligado após Estágio A do guard-rail (teste manual via SSH) e nasce com Required reviewer ativo (Estágio B) — nunca ativar `deploy.yml` direto em modo 100% automático na primeira vez.

## Status da implementação

Fases 0–5 implementadas e commitadas (`6bf8e05`). `deploy.yml` existe mas está **inerte** — não roda nada perigoso até:
1. Secrets `DEPLOY_SSH_KEY` (conteúdo de `linode_secondary/id_ed25519`), `DEPLOY_HOST`, `DEPLOY_USER` (`root`) serem cadastrados manualmente em Settings → Secrets (ação de admin, fora do alcance do `gh` local).
2. O Environment `production` ser criado manualmente em Settings → Environments, com **Required reviewers** (Estágio B) — sem isso, o job `deploy` roda sem portão nenhum no primeiro push à main após os secrets existirem.
3. Estágio A (teste manual via SSH do comando exato de rsync+`docker compose up -d --build`) ser feito **antes** de confiar no workflow.

Até esses 3 passos manuais serem feitos, o arquivo commitado não tem efeito nenhum (job falha cedo por falta de secrets, não derruba nada). Fase 6 (guard-rail) descrita acima permanece válida como checklist de rollout.

## Débito técnico descoberto durante a implementação (Fase 1)

Ao rodar `npm test` de verdade pela primeira vez (nunca tinha rodado em CI), apareceram **5 falhas reais e pré-existentes**, sem relação com lint/CI:
- `tests/perguntar.test.ts`: coalesce de `/p` diz "lote de 3" mas recebe 4 mensagens; resposta com texto `null` não reage com 💅 como esperado (2 testes).
- `tests/vacuo-grupo.test.ts`: contagem de "mídia-sozinha (sticker)" não incrementa como esperado.

Decisão: **manter o job `test` do CI ligado mesmo assim** — ele nasce vermelho nesses 2 arquivos, mas isso é informação real que estava escondida (o CI nunca rodou antes). Investigar/corrigir esses bugs é tarefa separada, fora do escopo desta fundação de engenharia.

A mesma situação se repetiu no `agente` (Fase 2): `pytest` revelou **6 falhas pré-existentes** (não relacionadas a lint) — `tests/test_audio.py` e `tests/test_envio_imagem.py` referenciam `tools.enviar_audio_gerado`/`tools.enviar_imagem_buscada`, que não existem mais em `tools/tools.py` (renomeadas ou removidas sem atualizar os testes); `tests/test_rosto.py::test_registrar_rosto_ok` usa um fixture de imagem base64 malformado. Mesma decisão: CI entra ligado mesmo vermelho nesses pontos — investigar é tarefa separada.

Também descoberto e corrigido durante a implementação (não estava no plano original):
- `whatsapp-bot/package.json` tinha `@anthropic-ai/claude-code` como dependência de runtime (inclusão acidental) — essa é a causa REAL do bug "Invalid Version" que o `Dockerfile` atribuía ao lockfile legado/pnpm. Removida.
- `tsc --noEmit` tinha 11 erros de tipo pré-existentes (mismatch de `exactOptionalPropertyTypes` em 6 handlers do `mcp.server.ts`, parâmetro implícito `any` em `craft.service.ts`, acesso a array possivelmente `undefined` em `dispatcher.test.ts`) — todos corrigidos (só anotação de tipo, sem mudança de lógica).
- `eslint .` tinha 21 erros vindos de 4 arquivos mortos/vestígio (CommonJS incompatível com ESM, sem importadores: `whatsapp.client.js`, `baileys.client.ts`, `craft.service.ts`, `heavy.service.ts`) — excluídos do lint via `ignores`, e 1 erro real (`prefer-const` em `lastfm.service.ts`) corrigido.
- Todo o código-fonte precisou de uma passada única de `prettier --write .` (41 arquivos), já que nenhum formatter rodou antes.

## Resumo da revisão técnica (`/revisao-tecnica-plano`)

Fechados nesta rodada:
- **Bloqueante**: `src/config/env.ts` preso no `.gitignore` e nunca versionado — quebraria `tsc`/CI num clone limpo. Fechado na Fase 0.1.
- **Bloqueante**: job `test` do CI com `npm ci --ignore-scripts` quebraria 5 de 6 suites (dependência real de `better-sqlite3`/`canvas`). Fechado na Fase 4 — `test` roda sem a flag, com libs de sistema instaladas antes.
- **Bloqueante/importante**: premissa de que Langfuse funcionaria "só com env vars" era falsa — faltava o pacote exportador OTLP e a chamada explícita de setup do ADK. Fechado na Fase 3.3 (dependência certa + chamada `maybe_set_otel_providers()`).
- **Importante**: bug conhecido do npm 10.8.2 (documentado no Dockerfile) poderia se repetir no runner do CI. Fechado com step de upgrade do npm nos workflows (Fase 4).
- **Importante**: descasamento entre o lockfile novo (usado no CI) e o `Dockerfile` (que ignora lockfile por design). Não corrigido nesta rodada — registrado como **risco residual aceito e documentado** na Fase 0.2, já que corrigir exigiria validar separadamente se o bug antigo não se repete com um lockfile fresco.
- **Nice-to-have**: dúvida sobre ordem `Sentry.init` vs. `dotenv` — investigada e descartada (ESM hoisting resolve isso sozinho); nota deixada na Fase 3 para não reabrir a dúvida à toa.
- **Nice-to-have**: segurança da etapa SSH e necessidade real dos excludes do rsync — fechados com orientação explícita na Fase 5.
- **Decisão consciente, não bloqueante**: duplicação de gates de CI no `deploy.yml` — mantida por ser a rede de segurança certa dado que este repo não usa branch protection hoje; documentado como ponto a revisitar se isso mudar.
