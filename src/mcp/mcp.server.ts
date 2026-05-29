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
        async ({ jid, mediaBase64 }) => {
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

                return {
                    content: [{
                        type: "text",
                        text: `✅ Figurinha enviada para ${jid}`
                    }]
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{
                        type: "text",
                        text: `❌ Falha ao enviar sticker: ${(error as Error).message}`
                    }]
                };
            }
        }
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
