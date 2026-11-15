# Plano de implementação — Apple Notes no agente via MCP (Plano B: ponte stdio→HTTP)

> **Status:** **código do agente IMPLEMENTADO** (branch `feat/apple-notes-mcp`), inerte por
> padrão (`NOTES_MCP_URL` vazio = kill switch). Falta a infra manual: Parte 1 (Mac) e Parte 2
> (rede Linode). Duas rodadas de revisão adversarial aplicadas (v3 abaixo).
> **Decisão:** entre Forma A (stdio sobre SSH) e Forma B (ponte stdio→HTTP), venceu a
> **B** — espelha o padrão `StreamableHTTP` que o agente já usa, não toca no `Dockerfile`,
> troca chave SSH por bearer-token e evita os bugs de reconexão stdio do adk-python 2.x.
> Ver o comparativo que originou esta escolha (dois pareceres independentes).
>
> **Revisão crítica aplicada (v2).** Uma revisão adversarial achou furos; este doc já os
> incorpora. Mudanças principais:
> - **Acesso a Notes é SÓ do admin** (dono do Mac). Gate por `eh_admin` no `tool_filter`
>   (cobre rota E fallback) + na rota do roteador. Ver §6.2 e §6.3.
> - Segredo/IP **nunca** no compose versionado (repo público) — só `.env` gitignored. §6.1.
> - Nomes de tool mantêm **hífen** (kebab-case): o ADK 2.3 não renomeia e o Gemini aceita
>   hífen — trocar por underscore QUEBRARIA o casamento. §6.2.
> - Timeout curto no toolset: o ADK resolve TODOS os toolsets a cada turno (antes do
>   roteador), então Mac fora = imposto de latência por-turno. §6.2 / §8.
> - Ordem do roteador: `notas` ANTES de `memoria`/`cadastro`. §6.3.
>
> **2ª revisão adversarial (v3) — ajustes aplicados ao código:**
> - **`_RE_NOTAS` ampliado**: cobre "registra/anota **na nota**…" (sem "minha") — senão
>   cairia em cadastro. Validado com 13 casos de `decidir_rota` (0 regressões). §6.3.
> - **B1 simplificado (KISS)**: as vars vão em `agente/.env` e são injetadas pelo `env_file`
>   já existente do compose (`docker-compose.yml:28-29`) — **sem interpolação `${VAR}`**, sem
>   tocar no YAML. §6.1.
> - **I2 quantificado**: com o Mac fora, o `@retry_on_errors` do ADK re-tenta 1× →
>   custo **~2×timeout por turno** (por isso `timeout=4s`); em turnos multi-chamada o custo
>   multiplica → reforça a disciplina do kill switch. §6.2 / §8.
> - Confirmado contra o ADK 2.3.0: gate lê a identidade certa (`gather` copia o contexto;
>   cache por `invocation_id` único por turno → sem vazamento entre requests); `timeout`/
>   `sse_read_timeout`/`headers` existem em `StreamableHTTPConnectionParams`.

---

## 1. Objetivo

Dar ao agente duas capacidades sobre o **Apple Notes** do usuário:

1. **Escrever notas** com informação que o usuário pedir.
2. **Consultar notas específicas** (buscar por título/conteúdo e ler o corpo).

O servidor que fala com o Notes é o [`sweetrb/apple-notes-mcp`](https://github.com/sweetrb/apple-notes-mcp)
(Node, transporte **stdio**, roda **no Mac** via AppleScript + Shortcuts + leitura do
NoteStore). Como ele só fala stdio local e o agente roda em Docker na Linode, uma **ponte
`supergateway`** no Mac embrulha o stdio em **StreamableHTTP**, e o agente conecta por URL —
idêntico a como já conecta no MCP do bot.

---

## 2. Arquitetura final

```
Mac (sempre ligado + Tailscale)                 Linode (deploy atual)
┌───────────────────────────────────┐          ┌──────────────────────────────┐
│ Notes.app                          │          │ bot-baileys (MCP :3001)       │
│ apple-notes-mcp  (stdio)           │          │ agente-adk (FastAPI :8000)    │
│   ▲ stdio                          │          │   ├ MCPToolset → bot (HTTP)   │
│ supergateway --stateful            │◀──HTTP───│   └ MCPToolset → Notes (HTTP) │  ← NOVO
│   expõe :8787 na iface tailnet     │ (tailnet)│                               │
└───────────────────────────────────┘          └──────────────────────────────┘
        token bearer no header                   container só precisa de ROTA
                                                  até o IP tailnet do Mac (via host)
```

Pontos-chave:
- **Container intocado**: nada de `openssh-client`/chave no `Dockerfile`. O agente só ganha
  mais um `MCPToolset` apontando para uma URL.
- **Alcance de rede [HIPÓTESE A TESTAR, não fato]**: a intenção é o container `agente-adk`
  falar com o IP tailnet do Mac roteando pelo **host** (Tailscale no host Linode), sem
  Tailscale dentro do container. **Isso NÃO é automático** — depende de `ip_forward`,
  possivelmente `--accept-routes`/MagicDNS e regras de SNAT/iptables do Tailscale. Tratar
  como premissa a validar no passo 5.3; se falhar, cair nos fallbacks (rota/sidecar).

---

## 3. Pré-requisitos (decisões a confirmar antes de começar)

- [ ] **Mac que fique ligado e na tailnet** (desktop de preferência; laptop com tampa fechada
      dorme). Este é o calcanhar comum a qualquer caminho de Apple Notes confiável.
- [ ] Mac com **Node 20+**.
- [ ] **Tailscale** no Mac **e** no host da Linode (mesma tailnet).
- [ ] Advanced Data Protection pode ficar **ligado** (AppleScript lê local; não depende de CloudKit).

---

## 4. Parte 1 — Configuração no Mac

### 4.1 Instalar o apple-notes-mcp e conceder permissões
```bash
npx -y apple-notes-mcp@latest setup     # importa os Shortcuts assinados e abre os prompts
```
Conceder no macOS (System Settings → Privacy & Security):
- **Automation** → permitir controlar o **Notes.app** (prompt na 1ª leitura/escrita).
- **Full Disk Access** → adicionar o binário do Node/npx **manualmente** (macOS não pede).
  Necessário para `query-notes`/`export`/estado de checklist.
- **Shortcuts** importados (feito pelo `setup`).

Testar isolado antes da ponte:
```bash
npx -y apple-notes-mcp@latest        # deve subir o servidor MCP em stdio sem erro
```

### 4.2 Instalar e subir a ponte supergateway
```bash
npm i -g supergateway
```
Rodar em modo **stateful** (mantém um processo `apple-notes-mcp` vivo e reusado — evita o
cold start de AppleScript a cada chamada) bindando **só na interface tailnet** e com token:
```bash
supergateway \
  --stdio "npx -y apple-notes-mcp@latest" \
  --outputTransport streamableHttp \
  --stateful \
  --sessionTimeout 600000 \
  --host <IP_TAILNET_DO_MAC> \
  --port 8787 \
  --oauth2Bearer "<TOKEN_LONGO_ALEATORIO>" \
  --healthEndpoint /health
```
> ⚠️ **Nunca** usar `--host 0.0.0.0` (exporia para fora da tailnet). Bindar no IP tailnet
> do Mac já restringe o acesso à rede privada; o token é a 2ª camada.

### 4.3 Manter a ponte viva (launchd) e o Mac acordado
- Criar um `LaunchAgent` (`~/Library/LaunchAgents/com.user.apple-notes-bridge.plist`) com
  `KeepAlive=true` e `RunAtLoad=true` chamando o comando do 4.2 (via um script `.sh` wrapper
  para não colocar o token no plist em claro — ler de arquivo com `chmod 600`).
- Evitar sleep do serviço: rodar sob `caffeinate -s` **ou** ajustar `pmset`/"Prevent sleeping"
  nas configurações de energia. `KeepAlive` reinicia o **proxy**, mas **não acorda o Mac** —
  por isso o Mac precisa estar configurado para não dormir.

> ⚠️ **[TCC sob launchd]** As permissões (Automation p/ Notes + Full Disk Access) concedidas
> ao `node` quando você testa via `npx` no **Terminal** podem **NÃO valer** para o `node`
> lançado pelo **LaunchAgent** — o "processo responsável" (attribution do TCC) é outro, e não
> há GUI para responder prompts de automação em serviço. Além disso, LaunchAgent exige uma
> **sessão GUI logada** (Mac "ligado mas deslogado" não roda). Validar o bridge rodando por
> launchd lendo/escrevendo Notes de fato (checklist §9), não só o teste no Terminal. Se o TCC
> bloquear, conceder Full Disk Access ao binário correto e/ou rodar via app com
> Info.plist/`launchctl` no domínio da sessão GUI (`gui/<uid>`).

### 4.4 Validar do lado da Linode
```bash
curl -H "Authorization: Bearer <TOKEN>" http://<IP_TAILNET_DO_MAC>:8787/health   # 200
```

---

## 5. Parte 2 — Rede na Linode (host + container)

1. **Tailscale no host** da Linode (`tailscale up`), na mesma tailnet do Mac.
2. Confirmar que o **host** alcança o Mac: `ping <IP_TAILNET_DO_MAC>` / `curl .../health`.
3. Confirmar que o **container** alcança (o tráfego outbound do container é roteado pelo host;
   IPs tailnet `100.64.0.0/10` saem pela `tailscale0` do host — não precisa Tailscale dentro
   do container):
   ```bash
   docker exec agente-adk sh -lc 'wget -qO- --header="Authorization: Bearer <TOKEN>" http://<IP_TAILNET_DO_MAC>:8787/health'
   ```
   - **[VERIFICAR]** Se o container NÃO alcançar (política de firewall/NAT), alternativas em
     ordem de preferência: (a) `extra_hosts`/rota estática no compose; (b) publicar a ponte
     num hostname MagicDNS; (c) só então considerar sidecar Tailscale. Medir antes de decidir.

---

## 6. Parte 3 — Código do agente

Todas as mudanças são em `agente/src/`. **Zero** mudança no `Dockerfile`.

### 6.1 Config (`src/config.py`)
Adicionar dois campos em `Settings` (perto de `mcp_url`, linha ~113):
```python
    notes_mcp_url: str = ""              # vazio = integração de Notes DESLIGADA (kill switch)
    notes_mcp_token: str = ""            # bearer p/ a ponte supergateway
```
Já implementado (4 campos, com os defaults abaixo). `.env` (prod, **não versionado**) recebe
`NOTES_MCP_URL=http://<ip-tailnet>:8787/mcp` e `NOTES_MCP_TOKEN=...`:
```python
    notes_mcp_url: str = ""              # vazio = DESLIGADO (kill switch)
    notes_mcp_token: str = ""
    notes_mcp_timeout_seg: float = 4.0        # handshake/listagem — curto (ver I2)
    notes_mcp_sse_timeout_seg: float = 120.0  # leitura do stream — < 180s do bot
```

> ✅ **[B1 — corrigido, KISS]** As vars vão **só em `agente/.env`** (gitignored) e são
> injetadas no container pelo **`env_file: ./agente/.env`** que o serviço `agente` JÁ tem
> (`docker-compose.yml:28-29`). **Zero mudança no YAML, zero interpolação.** NUNCA pôr o
> token/IP literais no `docker-compose.yml` (versionado, repo público — commit `81f8822`).
> Nota: a interpolação `${VAR}` do Compose lê do `.env` da **raiz do compose** (`/root/bot/.env`),
> NÃO de `agente/.env` — por isso o caminho certo aqui é o `env_file`, não `${VAR}`. IP do Mac
> em `docs/OPS-PROD.local.md` (gitignored).

### 6.2 Segundo MCPToolset (`src/client/root_agent.py`)
Espelhar o `mcp_toolset` existente (linhas 66-69), com **filtro restritivo + gate de
identidade**. Duas restrições no mesmo `tool_filter`:
1. **Subconjunto seguro** (YAGNI + segurança: nada de `delete-note`/`rename-folder` por ora).
2. **[B2] Só admin.** O `tool_filter` recebe `(tool, readonly_context)` e roda por request
   durante a resolução de `canonical_tools`; a identidade CONFIÁVEL do turno está no
   `request_context` (ContextVar propagada no task do `runner.run_async`). Se o solicitante
   NÃO for admin, o filtro devolve `False` para TODAS as tools de Notes → elas não são
   expostas **nem na rota `notas` nem no fallback**. Isso resolve o vazamento do fallback
   (onde o roteador não filtra) num único ponto.

```python
from shared import request_context

# [I1] Nomes em KEBAB-CASE (hífen) — confirmado: o ADK 2.3 NÃO renomeia tools MCP
# (mcp_tool.py:182,206) e o Gemini aceita hífen no nome. NÃO trocar por underscore:
# o tool_filter casa `tool.name` cru e o roteador casa `fd.name` — underscore quebraria
# em silêncio (tools de Notes nunca expostas).
_NOTES_TOOLS_EXPOSTAS = {
    "create-note",        # escrever nota nova
    "search-notes",       # buscar por título/conteúdo
    "get-note-content",   # ler o corpo de uma nota   (ver M2: confirmar grafia no boot)
    "append-to-note",     # anexar a uma nota existente
    "list-folders",       # listar pastas (contexto p/ criar na pasta certa)
}

def _expor_tool_notes(tool, readonly_context=None) -> bool:  # noqa: ANN001
    # [B2] gate de identidade: Notes é dado PESSOAL do dono do Mac → só admin.
    _numero, eh_admin, _registrado = request_context.atual()
    if not eh_admin:
        return False
    return tool.name in _NOTES_TOOLS_EXPOSTAS

notes_toolset = (
    MCPToolset(
        connection_params=StreamableHTTPConnectionParams(
            url=settings.notes_mcp_url,
            headers={"Authorization": f"Bearer {settings.notes_mcp_token}"},
            timeout=settings.notes_mcp_timeout_seg,          # [I2] curto (ver abaixo)
            sse_read_timeout=settings.notes_mcp_sse_timeout_seg,  # [M3] < 180s do bot
        ),
        tool_filter=_expor_tool_notes,
    )
    if settings.notes_mcp_url            # kill switch: sem URL, não registra nada
    else None
)
```
E adicionar à lista `tools=[...]` do `LlmAgent` (linha 114) **condicionalmente**:
```python
    tools=[
        mcp_toolset,
        *( [notes_toolset] if notes_toolset else [] ),
        buscar_web,
        ...
    ],
```
Novos campos em `Settings` (§6.1): `notes_mcp_timeout_seg: float = 3.0` e
`notes_mcp_sse_timeout_seg: float = 120.0`.

> **[VERIFICAR — barato] request_context no tool_filter.** Confirmar que `request_context.atual()`
> já está populado quando `canonical_tools` resolve os toolsets (é o mesmo task do
> `runner.run_async`; `asyncio.gather` copia o contexto — deve valer). Logar `eh_admin` dentro
> de `_expor_tool_notes` num teste admin e num não-admin. Se por algum motivo a ContextVar
> não propagar até ali, mover o gate para o fallback do `filtrar_tools` por identidade.

> **[I2 — esclarecido] Degradação É graciosa, mas há imposto de latência por-turno.**
> O `MCPToolset.__init__` é lazy (não conecta no boot) → o `agente-adk` **sobe normal com a
> ponte fora**. A descoberta de tools falha **por request** e o ADK a embrulha em try/except
> (`llm_agent.py:184-192`) devolvendo `[]` sem derrubar o `/chat` — logo **try/except na
> montagem é inútil**, não incluir. PORÉM: `canonical_tools` resolve TODOS os toolsets a cada
> `/chat` **antes** do roteador (que só poda o schema depois). Com o Mac fora, cada mensagem
> — inclusive conversa fora da rota `notas` — paga `timeout × retry` tentando a ponte. Por
> isso o `timeout` curto (3s) e a disciplina de **esvaziar `NOTES_MCP_URL`** quando o Mac
> estiver sabidamente fora.

### 6.3 Roteador — nova rota `notas` (`src/client/roteador.py`)
Para a regra `[SEGURANÇA]` de tokens: as tools de Notes **só** devem aparecer no schema
quando a mensagem for sobre notas. Três edições:

(a) Em `_TOOLS_POR_ROTA` (linha ~51), adicionar:
```python
    "notas": frozenset({
        "create-note", "search-notes", "get-note-content",
        "append-to-note", "list-folders",   # casar com a grafia real (ver 6.2)
    }),
```
(b) Regex + regra em `decidir_rota`. **[B2] Gate por `eh_admin`** (espelha `rosto`/`cadastro`).
**[I3] Posicionar ANTES da regra de `memoria` (e, para admin, antes de `cadastro`)** — senão
`_RE_MEMORIA` (que casa `anota\w*`, `roteador.py:110`) e `_RE_CADASTRO` (`registr\w*`)
sequestram "anota na apple notes…"/"registra na nota…" do admin.
```python
_RE_NOTAS = re.compile(
    r"\b(anota\w* (na|no) (notas|apple notes)|minhas? notas?|na minha nota"
    r"|cria\w* (uma )?nota|nova nota|busca\w* (a|na|minha) nota|abre a nota"
    r"|o que (tem|ta|esta) (na|em) (nota|notas)|no (meu )?apple notes)\b"
)
...
    # [B2+I3] Apple Notes — SÓ admin, e ANTES de cadastro/memória para não ser
    # sequestrada por `registr\w*`/`anota\w*`. Colocar logo após a rota "ajuda" (0),
    # junto das demais rotas de admin (rosto/cadastro).
    if eh_admin and _RE_NOTAS.search(m):
        return "notas"
```
> ⚠️ **Desambiguar de `memoria` (memória vetorial interna) × `notas` (Apple Notes).** Como
> `notas` é gateada a admin e vem ANTES, "anota na apple notes que X" do admin → `notas`;
> "guarda que eu gosto de X" (sem menção a nota) → segue para `memoria` normalmente. Teste
> as duas frases no fechamento.

(c) Fragmento de instrução `INSTRUCAO_POR_ROTA["notas"]` em `instruction.py`, curto,
ensinando: usar `search-notes`+`get-note-content` para consultar; `create-note` para
escrever; confirmar título/pasta; **não** despejar o corpo inteiro de volta no chat se for
grande (o corpo devolvido pode ser *lossy* — imagens viram placeholder). Mantê-lo enxuto
(acréscimo fixo por-turno, não cumulativo).

---

## 7. [SEGURANÇA] — verificação de impacto em tokens (obrigatória, ver agente/CLAUDE.md)

1. **O que adiciona ao prompt?** O schema das ≤5 tools de Notes — e **só para o admin**: o
   `tool_filter` (§6.2) remove as tools de Notes de qualquer não-admin, então para todos os
   outros usuários o acréscimo é **zero** (inclusive no fallback). Para o admin, aparecem na
   rota `notas` e no fallback dele (igual às demais tools).
2. **É por-turno e cresce com o tempo?** **Não é cumulativo.** Acréscimo fixo (schema das
   tools) e podado pelo roteador fora da rota `notas`.
3. **Tem teto?** Sim: o `tool_filter` expõe no máx. 5 tools; `get-note-content` pode devolver
   corpo grande → a instrução orienta a **não** reinjetar corpo volumoso (regra: respostas de
   tool grandes são o maior peso por-turno). Se necessário, truncar o retorno.
4. **Medir:** conferir `prompt_token_count` no `usage_metadata` (em `agente.db`) num turno de
   rota `notas` antes/depois de dar por pronto.

---

## 8. Riscos e mitigações

| Risco | Sev. | Mitigação |
|---|---|---|
| **[B2] Notes pessoal exposto a outros usuários** | **Alta** | gate `eh_admin` no `tool_filter` (cobre rota E fallback) + na rota (§6.2/§6.3) |
| **[B1] Segredo/IP em compose público** | **Alta** | só `.env` gitignored + `${VAR}`; nunca literal no YAML (§6.1) |
| Mac dorme / sai da tailnet → Notes fora do ar | Alta | Mac de mesa sempre ligado + `caffeinate`/`pmset`; degradação graciosa + `timeout` curto |
| **[I2] Imposto de latência por-turno com Mac fora** | Média | `timeout=3s`; esvaziar `NOTES_MCP_URL` (kill switch) quando Mac fora |
| Container não alcança a tailnet | Média-alta | **hipótese**, não fato — validar no passo 5.3; fallback `extra_hosts`/MagicDNS/sidecar |
| **[I1] Nome de tool (resolvido)** | Baixa | ADK 2.3 NÃO renomeia + Gemini aceita hífen → manter kebab-case nos dois lugares |
| `search-notes`/`get-note-content` lento estoura 180s do bot | Média | `sse_read_timeout` < 180s; instrução p/ busca estreita; não reinjetar corpo grande |
| **[I3] Rota `notas` × `memoria`/`cadastro`** | Média | `notas` gateada a admin e ANTES delas no `decidir_rota` |
| **[TCC] permissões não valem sob launchd** | Média | validar o bridge rodando por LaunchAgent (Mac logado) lendo/escrevendo Notes de fato |
| Rotação de token exige restart do agente | Baixa | header é capturado na construção do toolset; documentado — alinhar com kill switch |
| Token/endpoint exposto | Baixa | bind na iface tailnet (nunca 0.0.0.0) + bearer; token fora do git |

---

## 9. Checklist de validação end-to-end

- [ ] `curl .../health` com token responde 200 **do container** `agente-adk`.
- [ ] No boot/1ª chamada, logar os **nomes reais** das tools de Notes (M2: confirmar
      `list-folders`, `get-note-content` vs `get-note-plaintext`) antes de congelar a lista.
- [ ] **[B2] Admin**: "cria uma nota chamada X com conteúdo Y" → nota aparece no Apple Notes.
- [ ] **[B2] Admin**: "o que tem na minha nota X?" → agente busca e responde o conteúdo.
- [ ] **[B2] NÃO-admin**: mesma frase → tools de Notes NÃO expostas (logar `eh_admin=False`
      no `_expor_tool_notes`); agente não acessa Notes nem no fallback.
- [ ] Turno que **não** é de notas (admin): logs do roteador mostram tools de Notes **podadas**.
- [ ] Mac desligado: `/chat` continua respondendo texto (degradação graciosa); medir o
      acréscimo de latência por-turno e validar que o `timeout=3s` o mantém aceitável.
- [ ] **[TCC]** bridge rodando por **launchd** (não só no Terminal) consegue ler/escrever Notes.
- [ ] `prompt_token_count` conferido num turno de rota `notas` (admin).

---

## 10. Kill switch / rollback

- **Desligar sem deploy de código:** esvaziar `NOTES_MCP_URL` (6.1) → `notes_toolset` vira
  `None` e nada de Notes é registrado. Reiniciar o `agente-adk`.
- **Rollback de código:** remover o 2º toolset de `tools=[...]` e a rota `notas` do roteador.
- **No Mac:** `launchctl unload` do LaunchAgent derruba a ponte.

---

## 11. Esforço estimado

- Código do agente (config + toolset + rota + instrução): ~1h (trivial, espelha o existente).
- Mac (apple-notes-mcp + permissões + supergateway + launchd): ~2–3h.
- Rede Linode (tailscale host + validar alcance do container): ~1–3h (sorvedouro provável).
- Depuração/validação (nomes de tool, degradação, tokens): ~1–2h.
- **Total: ~4–8h**, dominado por rede/permissões — não por código.
