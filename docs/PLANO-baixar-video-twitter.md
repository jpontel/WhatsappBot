# Baixar vídeo do Twitter/X — espelhando o padrão do YouTube

## Contexto

O bot já baixa vídeos do YouTube via `youtube-dl-exec` (wrapper do motor **yt-dlp**), que também suporta nativamente `twitter.com`/`x.com` — confirmado em `whatsapp-bot/package.json` (`"youtube-dl-exec": "^3.1.3"`). **Não é preciso instalar nenhuma dependência nova**, nem em Node nem em Python.

Decisão já tomada com o usuário: duplicar o padrão do YouTube num arquivo novo (`twitter.service.ts`), sem generalizar/refatorar `youtube.service.ts` — mínima mudança, consistente com o código já em produção.

Durante a investigação foi descoberto um **gap de roteamento real** no `agente/`: o roteador determinístico (`roteador.py`) restringe as tools que o LLM vê por turno, por "rota". A rota `"busca"` casa **qualquer** `https?://` antes de qualquer outra regra específica de vídeo, e só expõe `{buscar_web, buscar_artigos, deepsearch_artigos}`. Como `baixar_video_youtube` não está em nenhuma rota (só é ensinada no fallback, `INSTRUCAO_SEM_ROTA`), qualquer mensagem "baixa esse vídeo \<link\>" — que sempre contém URL — cai erroneamente na rota "busca" e a tool nunca aparece pro LLM. Isso provavelmente já afeta o download de YouTube em produção hoje. Este plano corrige o gap criando uma rota `"video"` com prioridade sobre `"busca"`, cobrindo YouTube e Twitter/X juntos.

Confirmado por leitura de `root_agent.py`: a exposição de tools MCP usa uma **deny-list** (`_MCP_TOOLS_OCULTAS`), não allowlist — então `baixar_video_twitter` aparece automaticamente assim que registrada no MCP, sem precisar tocar em `root_agent.py`.

## Arquivos a tocar

### 1. `whatsapp-bot/src/services/twitter.service.ts` (novo)

Espelha `youtube.service.ts`, só o método `baixarVideo` (sem `baixarVideoEmMp3`/metadados — fora de escopo):

```ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import youtubedlDefault from 'youtube-dl-exec';

const youtubedl = youtubedlDefault as unknown as (
    url: string,
    flags: Record<string, unknown>,
) => Promise<any>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../../temp_videos');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

export class TwitterService {
    async baixarVideo(url: string): Promise<string> {
        const timestamp = Date.now();
        const outputPath = path.join(OUTPUT_DIR, `video_twitter_${timestamp}.mp4`);
        console.log(`Iniciando download do vídeo do twitter/x: ${url}`);
        try {
            await youtubedl(url, {
                format: 'best[ext=mp4][height<=1080]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best',
                output: outputPath,
                noCheckCertificates: true,
                noWarnings: true,
                preferFreeFormats: true,
                addHeader: ['referer:twitter.com', 'user-agent:googlebot'],
            });
            console.log('Download concluído!');
            return outputPath;
        } catch (error) {
            console.error('Erro ao baixar o vídeo do twitter/x:', error);
            throw new Error('Não consegui baixar esse vídeo. Pode ser um tweet privado/apagado, sem vídeo, ou o X bloqueou a tentativa — tenta outro link.');
        }
    }
}

export const twitterService = new TwitterService();
```

Nome do arquivo de saída (`video_twitter_*.mp4`) evita colisão com os arquivos do YouTube no mesmo `temp_videos/`.

> **Revisão técnica:** a mensagem de erro foi ajustada (vs. a genérica "bloqueou ou link inválido" copiada do YouTube) porque tweet privado/apagado e vídeo ausente são bem mais comuns no X do que no YouTube — diferenciar por tipo de erro exigiria parsear a saída do yt-dlp (não vale o esforço agora, YAGNI), mas a mensagem única pode cobrir os casos mais prováveis em vez de insinuar só "bloqueio".

### 2. `whatsapp-bot/src/mcp/mcp.server.ts` — handler + registro

- Import: `import { twitterService } from "../services/twitter.service.js";`
- Handler novo (ao lado de `baixarVideoYoutubeHandler`, mesma estrutura — path local via Baileys, cleanup em `finally`):

```ts
export async function baixarVideoTwitterHandler(
    { jid, url }: { jid: string; url: string }
): Promise<McpToolResult> {
    let caminho: string | null = null;
    try {
        const sock = whatsappService.recuperarInstancia();
        caminho = await twitterService.baixarVideo(url);
        await sock.sendMessage(jid, { video: { url: caminho } });
        return ok(`✅ Vídeo enviado para ${jid}`);
    } catch (error) {
        return fail(`❌ Falha ao baixar/enviar o vídeo: ${(error as Error).message}`);
    } finally {
        if (caminho && fs.existsSync(caminho)) {
            try { fs.unlinkSync(caminho); } catch { /* ignora limpeza */ }
        }
    }
}
```

- Registro da tool MCP (ao lado de `baixar_video_youtube`):

```ts
server.registerTool(
    "baixar_video_twitter",
    {
        description: "Baixa um vídeo de um link do Twitter/X (twitter.com ou x.com) e ENVIA como vídeo para o JID. Use para 'baixa esse vídeo <link>' quando o link for do Twitter/X.",
        inputSchema: {
            jid: z.string().describe("JID do destinatário (ex: 5547999999999@s.whatsapp.net)"),
            url: z.string().describe("Link do Twitter/X do vídeo (twitter.com ou x.com).")
        }
    },
    baixarVideoTwitterHandler
);
```

### 3. `agente/src/client/roteador.py` — nova rota `"video"` com prioridade sobre `"busca"`

> **Revisão técnica (crítica adversarial):** a primeira versão deste regex usava um conjunto de verbos fraco/ambíguo (`manda`, `me manda`, `envia`, `me envia`, `pega`) e aceitava o par verbo+substantivo SEM exigir URL na mensagem. Isso reproduzia exatamente a classe de bug que o próprio `roteador.py` já documenta ("regex genérica roubando rota específica" — ver comentários em `_RE_MEMORIA_EXPLICITA`, `_RE_ROSTO_MENCAO`, `_RE_LEMBRETE_RECALL`): a frase **"busca um vídeo bom de yoga e me manda o link"** (sem URL, pedido real de `buscar_web`) batia em `manda`+`vídeo` e roubava a rota "video", escondendo `buscar_web` exatamente do turno que precisa dela. Da mesma forma, `"pega"` não tem precedente em nenhuma outra regra do arquivo e casaria em frases como `"pega essa ideia de vídeo e monta um roteiro"`. Versão corrigida abaixo: verbos restritos a `baixar`/`download` (os únicos que inequivocamente significam "baixar um arquivo"), e o par verbo+substantivo só vale **se também houver uma URL genérica na mensagem** — sem URL não há o que baixar, então não há ambiguidade de rota a perder.

Novas regexes (perto de `_RE_BUSCA`):

```python
# Download de vídeo (YouTube ou Twitter/X). Verbos restritos a baixar/download
# (não "manda"/"envia"/"pega" — ambíguos demais, ver comentário em decidir_rota).
_RE_VIDEO_VERBO = re.compile(r"\b(baix\w*|download)\b")
_RE_VIDEO_NOUN = re.compile(r"\bvideo\w*\b")
_RE_VIDEO_URL = re.compile(r"https?://[^\s]*\b(twitter\.com|x\.com|youtube\.com|youtu\.be)\b")
```

Nova entrada em `_TOOLS_POR_ROTA` (perto de `"busca"`):

```python
"video": frozenset({"baixar_video_youtube", "baixar_video_twitter"}),
```

Nova checagem em `decidir_rota`, **antes** da checagem de `_RE_BUSCA`:

```python
# 7.5) Download de vídeo (YouTube/Twitter-X). ANTES da busca — toda mensagem
# desse tipo contém URL e bateria em _RE_BUSCA primeiro, roubando a rota.
# Duas formas de casar: (a) a URL já é de um domínio de vídeo conhecido — não
# precisa de verbo explícito; (b) verbo baixar/download + substantivo "vídeo"
# E alguma URL (genérica) na mensagem — a exigência de URL aqui evita que um
# pedido de BUSCA sobre vídeo (ex.: "busca um vídeo bom de yoga e me manda o
# link", sem nenhuma URL) seja roubado desta rota (achado da revisão técnica:
# sem essa exigência, essa frase perdia acesso a `buscar_web`).
if _RE_VIDEO_URL.search(m) or (
    _RE_VIDEO_VERBO.search(m) and _RE_VIDEO_NOUN.search(m) and re.search(r"https?://", m)
):
    return "video"

# 8) Busca factual / científica / URL.
if _RE_BUSCA.search(m):
    return "busca"
```

**Risco residual aceito:** um link encurtado `t.co` sozinho, sem verbo de baixar e sem o domínio final visível (ex.: usuário cola só o link curto, sem dizer "baixa"), continua caindo na rota "busca" (comportamento pré-existente, não piorado por este plano) — o LLM não teria lá a tool de download, mas também não há como diferenciar isso de um link genérico que o usuário só quer que seja pesquisado/comentado sem seguir o yt-dlp. Se isso se mostrar um caso de uso comum na prática, tratar depois como ajuste incremental (resolver o redirect do `t.co` antes do roteador não compensa a complexidade agora).

### 4. `agente/src/client/instruction.py` — mover texto do YouTube + adicionar Twitter

- Remover a linha de `baixar_video_youtube` de `INSTRUCAO_SEM_ROTA` (a linha de `baixar_musica` permanece lá, fora de escopo).
- Criar `INSTRUCAO_POR_ROTA["video"]`:

```python
"video": """\
[USO DE TOOLS — DOWNLOAD DE VÍDEO]:
- `baixar_video_youtube(usuario_jid, url)`: baixa e ENVIA o vídeo de um link do YouTube. Use para "baixa esse vídeo <link>" quando o link for do YouTube (youtube.com/youtu.be). Retorna status (já enviou) → confirme com uma frase curta.
- `baixar_video_twitter(usuario_jid, url)`: baixa e ENVIA o vídeo de um link do Twitter/X (twitter.com ou x.com). Use para "baixa esse vídeo <link>" quando o link for do Twitter/X. Retorna status (já enviou) → confirme com uma frase curta.
- Identifique QUAL tool usar pelo domínio do link na mensagem. Se o link não for de nenhum desses domínios, explique com leveza que só sabe baixar vídeo do YouTube ou Twitter/X por enquanto.
""",
```

`instrucao_suplementar` já concatena todos os `INSTRUCAO_POR_ROTA.values()` no fallback — mover o texto pra lá não perde nada quando `rota=None`.

- Opcional (consistência, não afeta roteamento): atualizar a linha de capacidades em `INSTRUCAO_POR_ROTA["ajuda"]` de "Baixar música/vídeo de link do YouTube." para "Baixar música de link do YouTube; baixar vídeo de link do YouTube ou do Twitter/X."

### 5. `agente/src/client/root_agent.py` — sem mudanças

Confirmado: deny-list (`_MCP_TOOLS_OCULTAS`), não allowlist. A tool nova aparece automaticamente.

## Fora de escopo

- Áudio/mp3 de Twitter.
- Generalizar os dois serviços num só (rejeitado explicitamente) — aceita-se a duplicação literal do bootstrap de `OUTPUT_DIR` entre `youtube.service.ts` e `twitter.service.ts` (2ª ocorrência, ainda dentro da "regra do 3"; uma 3ª tool de download deve disparar a extração de um helper comum).
- Normalização x.com/twitter.com no backend (yt-dlp já trata ambos).

## Riscos residuais aceitos (da revisão técnica)

- **Tool errada por confusão de domínio**: se o LLM chamar `baixar_video_youtube` para um link do X (ou vice-versa), o header fixo `referer` de cada serviço (`referer:youtube.com` / `referer:twitter.com`) pode fazer o yt-dlp falhar no domínio errado, e o usuário recebe uma mensagem de erro que menciona o serviço errado (ex.: "YouTube bloqueou" quando o link era do X). Mitigado pela instrução explícita de seleção por domínio (seção 4), mas não eliminado — não vale adicionar detecção de domínio no backend Node agora (YAGNI; a seleção de tool já é responsabilidade do LLM em todo o resto do agente).
- **Sem teto de tamanho/resolução do vídeo baixado**: nem o YouTube nem este plano implementam limite de tamanho de arquivo ou de resolução — risco pré-existente (herdado do YouTube, não introduzido aqui) de um vídeo grande estourar o timeout de 180s do bot (`AGENT_TIMEOUT_MS`) ou o limite prático de envio de vídeo do Baileys. Mitigado parcialmente porque vídeos de X tendem a ser mais curtos que os de YouTube. Não implementado agora por ser um problema maior que o escopo desta tool (afeta também o YouTube já em produção) — candidato a um plano próprio se vídeos grandes derem problema na prática.
- **Naming `usuario_jid` (instrução) vs. `jid` (schema MCP real)**: a entrada de instrução para `baixar_video_twitter` segue o mesmo texto (`usuario_jid`) já usado para `baixar_video_youtube` hoje — inconsistência pré-existente, não uma regressão deste plano. Não corrigida aqui para não tocar em texto do YouTube fora do escopo pedido.

## Verificação manual

1. `npm run start` no `whatsapp-bot/` — confirmar boot sem erro de import (extensões `.js` em imports relativos, NodeNext).
2. Testar a tool isolada via MCP Inspector (`npm run inspect:mcp`) com uma URL real de `x.com`: vídeo chega no WhatsApp e `temp_videos/video_twitter_*.mp4` é apagado depois.
3. Fim-a-fim via `/p baixa esse vídeo https://x.com/<conta>/status/<id>` com as duas stacks rodando.
4. Conferir no log do agente (`uvicorn` stdout) a linha `"Roteador: rota=video — tools N→2"` — confirma que a rota escolhida foi "video", não "busca"/fallback.
5. Repetir com link do YouTube e confirmar a mesma rota "video" — valida que o bug preexistente (YouTube caindo em "busca") foi corrigido, não só o caso novo.
6. Testar link sem vídeo (tweet só texto/imagem) e confirmar mensagem de erro amigável chega ao usuário sem derrubar o processo Node.
7. Forçar erro e confirmar que não sobra arquivo órfão em `temp_videos/`.
8. **Regressão de roteamento (achado da revisão técnica)**: mandar `/p busca um vídeo bom de yoga e me manda o link` (sem nenhuma URL) e confirmar no log que a rota escolhida é `"busca"` (ou fallback), **não** `"video"` — garante que `buscar_web` continua disponível para pedidos de busca que mencionam "vídeo" sem link.
9. Mandar uma frase com `"pega"` + "vídeo" sem intenção de download (ex.: `/p pega essa ideia de vídeo e monta um roteiro pra mim`) e confirmar que NÃO cai na rota `"video"` (o verbo foi removido do regex justamente por esse motivo).
