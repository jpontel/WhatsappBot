# Plano: Rodar o bot numa conta/número separado

> Documento de planejamento técnico — pt-BR. Data: 2026-05-29.
> Objetivo: tirar o bot da **minha conta pessoal do WhatsApp** e colocá-lo num **número dedicado**, com foco em simplicidade (KISS).

---

## 1. Contexto e diagnóstico do código atual

Hoje o bot loga na **minha própria conta pessoal** via *pairing code* usando o meu número. Isso causa três problemas:

1. Minhas mensagens próprias chegam com `fromMe=true` e o bot reage como se eu fosse "o admin".
2. O bot se mistura com meu uso pessoal do WhatsApp (mesma sessão, mesmo aparelho lógico).
3. Não há separação de identidade entre "eu" e "o assistente".

### O que o código faz hoje

**`src/index.ts`** — conexão e autenticação:
- `useMultiFileAuthState('auth_info_baileys')` guarda a sessão em disco (pasta `auth_info_baileys/`).
- Autentica por **pairing code**, não QR (`printQRInTerminal: false`).
- Na primeira execução chama `sock.requestPairingCode(telefone)`, onde:
  ```ts
  const telefone = process.env.TELEFONE_CELULAR ?? "";   // index.ts:43
  // ...
  const code = await sock.requestPairingCode(telefone);  // index.ts:80
  ```
- **Conclusão importante:** o Baileys aceita **qualquer número** no `requestPairingCode`. A troca de conta no código é mínima — basta trocar `TELEFONE_CELULAR` e limpar `auth_info_baileys/`. Confirmado.

**`.env`** — variáveis relevantes:
```
TELEFONE_CELULAR=REMOVIDO_TEL          # número logado hoje (a "minha conta")
TELEFONE_CELULAR_PROD=REMOVIDO_TEL     # número definido, mas NÃO usado pelo index.ts
```
> O `index.ts` só lê `TELEFONE_CELULAR`. O `..._PROD` está órfão (nenhum código o consome).

**`src/core/dispatcher.ts`** — filtro de mensagens:
```ts
const JID_IGNORADO = 'REMOVIDO_TEL';   // dispatcher.ts:6
// ...
if (
    msg.key.remoteJid === JID_IGNORADO              // dispatcher.ts:31  (BUG latente)
    || msg.key.remoteJid?.endsWith('@newsletter')
) {
    return;
}
```
- **Bug latente:** `remoteJid` vem no formato `REMOVIDO_TEL@s.whatsapp.net`, mas a comparação é com a string crua `'REMOVIDO_TEL'`. Logo **esse `if` nunca casa** — o filtro está quebrado e o número não é de fato ignorado hoje.
- Pior: o `return` (em vez de `continue`) aborta o lote inteiro de mensagens, não só a mensagem atual.
- **Não há filtro de `fromMe`** no dispatcher. Toda mensagem que vira comando é executada, inclusive as minhas próprias (`fromMe=true`). É exatamente por isso que o bot "age como se fosse eu".

**`src/dto/comandos.dto.ts`** — já existe um campo previsto para `fromMe` (comentado como "mensagem partiu da própria conta do admin"), mas o dispatcher não o popula nem o usa.

**`src/config/baileys.client.ts`** — arquivo legado/vestígio com `const number = 'REMOVIDO_TEL'` hardcoded; não está no fluxo ativo (o entrypoint é `index.ts`). Citado só para inventário.

---

## 2. Abordagens para ter um número separado (pesquisa 2025/2026)

### Tabela comparativa

| Abordagem | O que é | Custo aprox. | Risco de ban (Meta) | Esforço de código |
|---|---|---|---|---|
| **A. Chip/SIM físico dedicado + WhatsApp normal** | Um segundo número real (chip pré-pago) registrado num WhatsApp comum, pareado pelo Baileys. | Chip pré-pago BR: ~R$ 10–20 uma vez + recarga mínima p/ manter ativo. | **Médio** (intrínseco ao Baileys, mas é o cenário "mais natural" possível). | **Mínimo** (trocar `TELEFONE_CELULAR`, limpar auth). |
| **B. eSIM / número virtual (Google Voice, Twilio, eSIM de dados)** | Número não-físico. | eSIM dados BR ~US$ 4–10; Google Voice/Twilio variável. | **Alto / inviável p/ registro**: números virtuais muitas vezes **não recebem o OTP** de SMS/voz que o WhatsApp exige; eSIM **só de dados não tem número**. | Mínimo no código, mas **alto atrito no registro**. |
| **C. WhatsApp Business (app) em número separado** | Mesmo que A, mas usando o app WhatsApp Business em vez do normal. | Igual a A (precisa de um número que receba OTP). | **Médio** (igual ao normal sob a ótica do Baileys — Baileys parea ambos como "linked device"). | Mínimo (idêntico a A). |
| **D. WhatsApp Business Cloud API oficial (Meta)** | API oficial da Meta via BSP/Cloud. Substitui o Baileys. | **Pago por mensagem**; mensagens de serviço dentro da janela de 24h são grátis, templates de marketing BR ~US$ 0,0625/msg + markup do BSP. | **Nulo** (é o caminho sancionado — não há risco de ban por automação). | **Alto** (reescrever toda a camada de envio/recebimento e o servidor MCP; trocar Baileys por webhooks da Cloud API). |
| **E. Aparelho/emulador secundário só p/ registrar** | Usar um celular antigo ou emulador Android para instalar o WhatsApp, registrar o número e depois parear o Baileys como linked device. | Custo do número (chip) + aparelho que você já tenha. | **Médio** (o registro fica mais "humano"; útil quando você não quer instalar no seu telefone principal). | Mínimo (mesmo fluxo de A). |

### Notas por abordagem

- **A — Chip físico dedicado.** É a mais simples e a mais robusta. Um número real recebe o OTP sem fricção, sobrevive a re-pareamentos eventuais, e é o cenário que menos "destoa" para os modelos de detecção da Meta. Você instala o WhatsApp num aparelho qualquer com esse chip, registra, e depois parea o Baileys como dispositivo conectado (linked device) — exatamente o que o bot já faz hoje, só que com outro número.

- **B — Virtual.** Pesquisa confirma o problema clássico: WhatsApp exige verificação de posse do número via SMS ou ligação. Números virtuais (Google Voice, muitos Twilio, IVR-only) frequentemente **não conseguem receber o OTP**, e eSIMs **só de dados não vêm com número**. Resultado: ou não registra, ou registra com fricção e risco de perder o número. **Não recomendado** para KISS.

- **C — Business app.** Para o Baileys tanto faz: ele parea o número como linked device independentemente de ser WhatsApp normal ou Business. O Business app dá perfil comercial/etiquetas, mas **não reduz o risco de ban do Baileys** (o risco vem de automatizar via biblioteca não-oficial, não do tipo de app). Sem ganho real para o seu caso.

- **D — Cloud API oficial.** É o **único caminho sem risco de ban**, porque é sancionado pela Meta. Mas: (1) é pago por mensagem; (2) muda o paradigma — recebimento por **webhooks** em vez de socket vivo, envio por chamadas REST; (3) exigiria **reescrever** a integração Baileys e adaptar o servidor MCP (`enviar_texto`, `enviar_imagem`, `enviar_sticker`, `reagir`). Figurinhas e reações têm suporte limitado/diferente na Cloud API. **Esforço alto** — só vale se o objetivo virar "produção séria / nunca tomar ban". Para um bot pessoal, é overkill.

- **E — Emulador/aparelho secundário.** Variante de A; útil só se você não quiser colocar um segundo chip no seu telefone. O custo extra é zero se você já tem um celular velho.

### Sobre risco de ban com Baileys (vale para A, C, E)

A pesquisa é consistente: **qualquer** automação fora da API oficial carrega risco de bloqueio — Baileys incluído. Pontos-chave para mitigar num número novo:
- **Aquecer o número**: nos primeiros ~7 dias, pouca atividade (dezenas de msgs/dia), crescendo gradualmente. Número novo que dispara muita mensagem é lido como spammer.
- **Evitar re-pareamentos frequentes** da sessão Baileys (re-pares raros são ok; frequentes elevam o risco) — ou seja, **não apagar `auth_info_baileys/` à toa**.
- Os modelos da Meta pesam *reply-ratio* baixo, contatos "estranhos" (fora do seu grafo) e timing robótico. Como aqui o bot conversa só com você/contatos conhecidos, o perfil de risco é relativamente baixo, mas **não nulo**.

---

## 3. Recomendação KISS

**Abordagem A — segundo chip/SIM físico dedicado + WhatsApp normal + pairing code.**

Por quê:
1. **Custo baixo e único** (um chip pré-pago).
2. **Registro sem fricção** — número real recebe o OTP que o WhatsApp exige (resolve o calcanhar de aquiles das opções virtuais).
3. **Mudança de código mínima** — o Baileys já aceita qualquer número no pairing; trocamos `TELEFONE_CELULAR` e limpamos a sessão.
4. **Separa de fato** identidade pessoal × bot: as minhas mensagens deixam de ser "do admin", e o bot passa a ter número próprio.
5. Mantém todo o resto do projeto (MCP, agente, comandos) **intacto** — diferente da Cloud API, que exigiria reescrita.

Se um dia o objetivo virar "zero risco de ban / produção", aí sim migrar para a **Cloud API oficial (D)**. Para uso pessoal, A é a escolha certa.

---

## 4. Passo a passo de implementação (Abordagem A)

### Passo 0 — Provisionar o número (fora do código)
1. Comprar um chip pré-pago dedicado (qualquer operadora). Anotar o número no formato internacional sem `+`, ex.: `55DDDNÚMERO`.
2. Instalar o WhatsApp num aparelho (pode ser um celular antigo) com esse chip e **registrar o número** (recebe o OTP via SMS).
3. Deixar o número "descansar" e fazer alguma atividade humana leve antes de plugar o bot (aquecimento).

### Passo 1 — Trocar o número no `.env`
Arquivo: `/Users/admin/repositorio/Pessoal/bot/whatsapp-bot/.env`
- Apontar `TELEFONE_CELULAR` para o **novo número do bot** (substituir `REMOVIDO_TEL`).
- Recomendo guardar o número pessoal numa nova variável, ex. `ADMIN_JID`, para o filtro de `fromMe` (ver Passo 3). Algo como:
  ```
  TELEFONE_CELULAR=55DDDNUMERODOBOT       # número dedicado do bot (pairing)
  ADMIN_JID=REMOVIDO_TEL@s.whatsapp.net   # seu número pessoal, p/ identificar o "admin"
  ```
  > A variável órfã `TELEFONE_CELULAR_PROD=REMOVIDO_TEL` pode ser removida (não é lida por ninguém no fluxo ativo).

### Passo 2 — Limpar a sessão antiga e parear o novo número
1. Parar o bot.
2. Apagar a sessão antiga (caminho absoluto):
   ```bash
   rm -rf /Users/admin/repositorio/Pessoal/bot/whatsapp-bot/auth_info_baileys
   ```
   > Confirme o conteúdo antes com `ls -la /Users/admin/repositorio/Pessoal/bot/whatsapp-bot/auth_info_baileys` (regra de operações destrutivas).
3. Subir o bot (`npm run start`). O `index.ts` vai gerar um novo **pairing code** para o novo número.
4. No celular do bot: WhatsApp → Aparelhos conectados → Conectar aparelho → "Conectar com número de telefone" → digitar o código impresso no terminal.

Nenhuma alteração de código é necessária nos passos 1–2 além do `.env` — `index.ts:43` e `index.ts:80` já leem `TELEFONE_CELULAR` dinamicamente.

### Passo 3 — Ajustes de código no dispatcher
Arquivo: `/Users/admin/repositorio/Pessoal/bot/whatsapp-bot/src/core/dispatcher.ts`

**3a. Corrigir o filtro quebrado (`JID_IGNORADO`).** Hoje compara `remoteJid` (com `@s.whatsapp.net`) contra a string crua `'REMOVIDO_TEL'`, então nunca casa. Além disso usa `return` (aborta o lote) onde deveria usar `continue` (pula só a mensagem). Decidir:
- Se o objetivo do `JID_IGNORADO` era ignorar mensagens de/para um número específico, normalizar a comparação (comparar só os dígitos do JID) **e** trocar `return` por `continue`.
- Se não há mais motivo para esse filtro (o número era o antigo `..._PROD`), **remover** `JID_IGNORADO` e o `if` correspondente — mais KISS.

**3b. Parar de assumir `fromMe` como "admin" / não reagir às próprias mensagens do bot.** Com número dedicado, mensagens `fromMe=true` agora são **mensagens do próprio bot** (ecos das respostas que ele envia). Processá-las como comando pode causar loop ou ruído. Recomendo ignorar `fromMe` no dispatcher:
```ts
for (const msg of messageDto.messages) {
    if (
        msg.key.fromMe                                  // mensagens do próprio bot — ignorar
        || msg.key.remoteJid?.endsWith('@newsletter')
        // || <filtro de JID normalizado, se mantido>
    ) {
        continue;                                       // pular só esta msg, não abortar o lote
    }
    // ...
}
```
> Se quiser que **você** (admin) continue podendo mandar comandos por uma conversa com o bot, isso passa a funcionar naturalmente: suas mensagens chegam como `fromMe=false` na conta do bot (você é um contato remoto para ele). O conceito de "admin via fromMe" some — o admin passa a ser identificado pelo JID (`ADMIN_JID`), se necessário em algum comando.

**3c. (Opcional) Popular `dto.fromMe`.** O DTO em `src/dto/comandos.dto.ts` já prevê o campo. Se algum comando precisar saber quem mandou, passar `fromMe: !!msg.key.fromMe` e/ou comparar `jid` com `ADMIN_JID` no `ComandoExecutarDto`.

### Passo 4 — Limpeza de vestígios (opcional, recomendado)
- Remover o hardcode `const number = 'REMOVIDO_TEL'` em `src/config/baileys.client.ts` (arquivo legado fora do fluxo) ou apagar o arquivo se confirmado morto.
- Remover `TELEFONE_CELULAR_PROD` do `.env`.

### Passo 5 — Validar
1. Mandar uma mensagem de comando (ex.: `/p ...`) **de outro número** (o seu pessoal) **para o número do bot**.
2. Conferir no log `📩 Mensagem de ...` e a reação/resposta.
3. Confirmar que o bot **não** reage às próprias mensagens de saída (`fromMe`).

---

## 5. Resumo executivo

- O bot hoje loga na conta pessoal só por causa de `TELEFONE_CELULAR` no `.env`; o Baileys aceita qualquer número no pairing, então **a troca é de configuração, não de arquitetura**.
- Recomendação KISS: **segundo chip físico dedicado** (Abordagem A). Custo baixo, registro sem fricção, código quase intacto.
- Mudanças de código concretas: trocar `TELEFONE_CELULAR` + limpar `auth_info_baileys/`; corrigir/remover o `JID_IGNORADO` quebrado em `dispatcher.ts`; adicionar filtro `msg.key.fromMe` (com `continue`) para o bot não reagir às próprias mensagens; opcionalmente identificar o admin por `ADMIN_JID`.
- Números virtuais (B) esbarram no OTP; Business app (C) não reduz risco; Cloud API oficial (D) é o único caminho sem ban, porém exige reescrita — reservar para um eventual "modo produção".

### Fontes
- WhatsApp Automation Ban Risk: Safe vs Unsafe Tools — https://blog.kraya-ai.com/whatsapp-automation-ban-risk
- High number of bans on WhatsApp! (Baileys issue #1869) — https://github.com/WhiskeySockets/Baileys/issues/1869
- baileys-antiban (warm-up / padrões humanos) — https://github.com/kobie3717/baileys-antiban
- Twilio: registrar número próprio para WhatsApp (OTP) — https://help.twilio.com/articles/360052171393
- yowsup #698: registro WhatsApp em números virtuais — https://github.com/tgalal/yowsup/issues/698
- WhatsApp Business API Pricing 2026 — https://www.engagelab.com/blog/whatsapp-business-api-pricing
- WhatsApp Cloud API: Setup & Cost Guide (2026) — https://chatarmin.com/en/blog/whatsapp-cloudapi
- Can I use WhatsApp with an eSIM? (registro precisa de SMS) — https://www.nomadesim.com/blog/will-travel-esim-change-whatsapp-number
