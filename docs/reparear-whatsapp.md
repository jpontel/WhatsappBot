# Rotina de re-pareamento do WhatsApp (Baileys)

Procedimento para reconectar o bot ao WhatsApp quando a sessão **trava, dá 401 (loggedOut) ou fica presa no meio do pareamento**.

Automatizado pelo script [`reparear.sh`](../reparear.sh) na raiz do projeto.

## Quando usar

Sintomas de que a sessão "quebrou" e precisa re-parear:

- o log repete `⚠️ Conexão fechada (401). Tentando em 5s...`;
- o container sobe mas nunca mostra `✅ Bot conectado e pronto!`;
- um código de pareamento foi gerado mas **não foi digitado a tempo** (expirou), e reiniciar sozinho não resolve.

> **Causa comum do 401:** o `auth_info_baileys` fica com **credenciais parciais** de uma tentativa anterior não concluída. O WhatsApp passa a recusar a conexão. A correção é **apagar essa pasta** e parear do zero.

## O que o script faz

1. derruba o container (`docker compose down`);
2. **apaga** `whatsapp-bot/auth_info_baileys` (o cache/estado da sessão);
3. reconstrói e sobe **só o bot** (`docker compose up -d --build --no-deps whatsapp-bot`);
4. observa o log e imprime o novo **código de pareamento**;
5. **aborta sozinho** se levar 401 ou se o código não sair em ~120 s — e **para o container** para não ficar martelando o número (reinício em excesso agrava o bloqueio temporário do WhatsApp).

> ⚠️ **Destrutivo:** isto **desloga** a sessão atual deste servidor. Confirme que está no servidor certo — o script mostra o `TELEFONE_CELULAR` configurado antes de seguir.

## Como rodar

**No servidor** (dentro de `/root/bot`):

```bash
cd /root/bot
bash reparear.sh          # pede confirmação
bash reparear.sh -y       # sem pergunta
```

**Remoto, da máquina de dev** (instância secundária como exemplo):

```bash
ssh -i linode_secondary/id_ed25519 root@172.237.48.33 'bash /root/bot/reparear.sh -y'
```

Assim que o código aparecer, digite no celular pareado:
**WhatsApp → Aparelhos conectados → Conectar um aparelho → Conectar com número de telefone.**

## Códigos de saída

| Código | Significado | Ação |
|---|---|---|
| `0` | código gerado (ou já estava conectado) | digitar o código no celular |
| `2` | 401 — número recusado (provável bloqueio temporário) | esperar ~15–30 min e rodar de novo |
| `3` | nenhum código na janela de tempo | checar o log impresso; rodar de novo |

## Regra de ouro

**Tentativa única por vez.** Se der 401 ou timeout, o script já para o container — **não fique reiniciando**, porque cada tentativa num intervalo curto piora o bloqueio do WhatsApp. Espere o cooldown e rode `reparear.sh` de novo.

## Confirmar que pareou

```bash
docker logs --since 3m bot-baileys | grep "conectado e pronto"
ls whatsapp-bot/auth_info_baileys | wc -l    # centenas/milhares de arquivos = sessão salva
```
