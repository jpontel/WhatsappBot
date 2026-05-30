import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { whatsappService } from "../services/whatsapp.service.js";
import { Sticker, StickerTypes } from 'wa-sticker-formatter';
import express, { type Request, type Response } from 'express';
import { ENV } from "../config/env.js";
import { z } from 'zod';

const app = express();
// imagens base64 estouram o limite padrão de 100kb do express
app.use(express.json({ limit: '20mb' }));

type McpToolResult = {
    content: { type: "text"; text: string }[];
    isError?: boolean;
};

function ok(text: string): McpToolResult {
    return { content: [{ type: "text", text }] };
}

function fail(text: string): McpToolResult {
    return { isError: true, content: [{ type: "text", text }] };
}

export async function enviarStickerHandler(
    { jid, mediaBase64 }: { jid: string; mediaBase64: string }
): Promise<McpToolResult> {
    try {
        const sock = whatsappService.recuperarInstancia();
        const buffer = Buffer.from(mediaBase64, 'base64');

        const sticker = new Sticker(buffer, {
            pack: 'bot do guigo',
            author: 'guig0',
            type: StickerTypes.CROPPED,
            quality: 30
        });

        const stickerBuffer = await sticker.toBuffer();
        await sock.sendMessage(jid, { sticker: stickerBuffer });

        return ok(`✅ Figurinha enviada para ${jid}`);
    } catch (error) {
        return fail(`❌ Falha ao enviar sticker: ${(error as Error).message}`);
    }
}

export async function enviarTextoHandler(
    { jid, texto }: { jid: string; texto: string }
): Promise<McpToolResult> {
    try {
        const sock = whatsappService.recuperarInstancia();
        await sock.sendMessage(jid, { text: texto });
        return ok(`✅ Mensagem enviada para ${jid}`);
    } catch (error) {
        return fail(`❌ Falha ao enviar texto: ${(error as Error).message}`);
    }
}

export async function enviarImagemHandler(
    { jid, mediaBase64, legenda }: { jid: string; mediaBase64: string; legenda?: string }
): Promise<McpToolResult> {
    try {
        const sock = whatsappService.recuperarInstancia();
        const buffer = Buffer.from(mediaBase64, 'base64');

        await sock.sendMessage(jid, {
            image: buffer,
            ...(legenda ? { caption: legenda } : {})
        });

        return ok(`✅ Imagem enviada para ${jid}`);
    } catch (error) {
        return fail(`❌ Falha ao enviar imagem: ${(error as Error).message}`);
    }
}

type MsgKeyInput = {
    id: string;
    remoteJid: string;
    fromMe?: boolean;
    participant?: string;
};

export async function reagirHandler(
    { jid, msgKey, emoji }: { jid: string; msgKey: MsgKeyInput; emoji: string }
): Promise<McpToolResult> {
    try {
        const sock = whatsappService.recuperarInstancia();
        await sock.sendMessage(jid, {
            react: { text: emoji, key: msgKey as never }
        });
        return ok(`✅ Reação '${emoji}' aplicada em ${jid}`);
    } catch (error) {
        return fail(`❌ Falha ao reagir: ${(error as Error).message}`);
    }
}

function inicializarServidor() {
    const server = new McpServer({
        name: 'Clarice-Whatsapp-Bridge',
        version: '1.0'
    });

    server.registerTool(
        "enviar_sticker",
        {
            description: "Converte uma imagem (PNG/JPG) em figurinha do WhatsApp e envia para o JID informado.",
            inputSchema: {
                jid: z.string().describe("JID do destinatário (ex: 5547999999999@s.whatsapp.net)"),
                mediaBase64: z.string().describe("Imagem em base64, sem o prefixo 'data:image/...;base64,'")
            }
        },
        enviarStickerHandler
    );

    server.registerTool(
        "enviar_texto",
        {
            description: "Envia uma mensagem de texto para o JID informado.",
            inputSchema: {
                jid: z.string().describe("JID do destinatário (ex: 5547999999999@s.whatsapp.net)"),
                texto: z.string().describe("Conteúdo da mensagem. Suporta formatação Markdown do WhatsApp (*negrito*, _itálico_, ~tachado~).")
            }
        },
        enviarTextoHandler
    );

    server.registerTool(
        "enviar_imagem",
        {
            description: "Envia uma imagem (PNG/JPG) para o JID informado, opcionalmente com legenda.",
            inputSchema: {
                jid: z.string().describe("JID do destinatário (ex: 5547999999999@s.whatsapp.net)"),
                mediaBase64: z.string().describe("Imagem em base64, sem o prefixo 'data:image/...;base64,'"),
                legenda: z.string().optional().describe("Legenda opcional da imagem.")
            }
        },
        enviarImagemHandler
    );

    server.registerTool(
        "reagir",
        {
            description: "Reage à mensagem original com um emoji. Use para sinalizar progresso (⏳, ✅, ❌, 💅, etc).",
            inputSchema: {
                jid: z.string().describe("JID do destinatário (ex: 5547999999999@s.whatsapp.net)"),
                msgKey: z.object({
                    id: z.string(),
                    remoteJid: z.string(),
                    fromMe: z.boolean().optional(),
                    participant: z.string().optional()
                }).describe("Chave da mensagem original (msg.key vinda do Baileys)."),
                emoji: z.string().describe("Emoji da reação (ex: '⏳'). Passar string vazia remove a reação.")
            }
        },
        reagirHandler
    );

    return server;
}

app.post("/mcp", async (req: Request, res: Response) => {
    const server = inicializarServidor();
    // omitir sessionIdGenerator → modo stateless (1 server por request, sem sessão persistente)
    const transport = new StreamableHTTPServerTransport({});

    res.on('close', () => {
        transport.close();
        server.close();
    });

    // cast: o tipo Transport da SDK declara onclose como obrigatório, mas a implementação
    // marca como opcional — incompatível com exactOptionalPropertyTypes do tsconfig.
    await server.connect(transport as never);
    await transport.handleRequest(req, res, req.body);
});

export function startMcpServer() {
    const PORT = Number(ENV.MCP_PORT) || 3001;
    app.listen(PORT, () => {
        console.log('=============================================');
        console.log(`🚀 MCP Server escutando em http://localhost:${PORT}/mcp`);
        console.log('=============================================');
    });
}
