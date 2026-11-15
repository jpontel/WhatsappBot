import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { whatsappService } from "../services/whatsapp.service.js";
import { youtubeService } from "../services/youtube.service.js";
import { audioService } from "../services/audio.service.js";
import { LastfmService } from "../services/lastfm.service.js";
import { Canvas } from "../utils/canvas.js";
import { Sticker, StickerTypes } from 'wa-sticker-formatter';
import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import cron from 'node-cron';
import { ENV } from "../config/env.js";
import { z } from 'zod';
import { agendamentoRepository, mesmoSolicitante } from "../repository/agendamento.repository.js";
import { schedulerService } from "../services/scheduler.service.js";
import { buscarPorNome, buscarPorNumero, buscarPorLid, registrarPessoa, type Pessoa } from "../repository/pessoa.repository.js";
import { resolverNumero, resolverLid, normalizarNonoDigito } from "../core/identidade.js";
import { isJidGroup, isLidUser, isPnUser, jidNormalizedUser } from "@whiskeysockets/baileys";

const lastfmService = new LastfmService();

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
            type: StickerTypes.FULL,
            quality: 30
        });

        const stickerBuffer = await sticker.toBuffer();
        await sock.sendMessage(jid, { sticker: stickerBuffer });

        return ok(`✅ Figurinha enviada para ${jid}`);
    } catch (error) {
        return fail(`❌ Falha ao enviar sticker: ${(error as Error).message}`);
    }
}

export async function enviarAudioHandler(
    { jid, mediaBase64 }: { jid: string; mediaBase64: string }
): Promise<McpToolResult> {
    let caminho: string | null = null;
    try {
        const sock = whatsappService.recuperarInstancia();
        const buffer = Buffer.from(mediaBase64, 'base64');
        caminho = await audioService.converterParaOpus(buffer);

        // ptt: true → o WhatsApp trata como nota de voz (não player de música).
        await sock.sendMessage(jid, {
            audio: { url: caminho },
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
        });

        return ok(`✅ Áudio enviado para ${jid}`);
    } catch (error) {
        return fail(`❌ Falha ao enviar áudio: ${(error as Error).message}`);
    } finally {
        if (caminho && fs.existsSync(caminho)) {
            try { fs.unlinkSync(caminho); } catch { /* ignora limpeza */ }
        }
    }
}

// Remove invisíveis (zero-width/BOM) e espaços para checar se há conteúdo real.
function textoVazio(texto: string | null | undefined): boolean {
    return !((texto ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim());
}

export async function enviarTextoHandler(
    { jid, texto }: { jid: string; texto: string }
): Promise<McpToolResult> {
    try {
        // Ignora texto vazio/em-branco: ao mandar só áudio, o modelo às vezes
        // chama enviar_texto com conteúdo vazio, gerando uma bolha em branco.
        if (textoVazio(texto)) {
            return ok('Texto vazio — nada enviado.');
        }
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

export async function chartsLastfmHandler(
    { usuario }: { usuario: string }
): Promise<McpToolResult> {
    try {
        const charts = await lastfmService.listarMaisOuvidasSemana(usuario);
        if (!charts?.length) return ok(`Nenhuma música ouvida na semana para ${usuario}.`);

        const linhas = charts
            .map((c: { posicao: number; musica: string; artista: string; contagem: number }) =>
                `${c.posicao}. ${c.musica} — ${c.artista} (${c.contagem}x)`)
            .join('\n');

        return ok(`Mais ouvidas da semana de ${usuario}:\n${linhas}`);
    } catch (error) {
        return fail(`❌ Falha ao buscar charts: ${(error as Error).message}`);
    }
}

export async function baixarMusicaHandler(
    { jid, url }: { jid: string; url: string }
): Promise<McpToolResult> {
    let caminho: string | null = null;
    try {
        const sock = whatsappService.recuperarInstancia();
        caminho = await youtubeService.baixarVideoEmMp3(url);
        await sock.sendMessage(jid, { audio: { url: caminho }, mimetype: 'audio/mpeg' });
        return ok(`✅ Áudio enviado para ${jid}`);
    } catch (error) {
        return fail(`❌ Falha ao baixar/enviar a música: ${(error as Error).message}`);
    } finally {
        if (caminho && fs.existsSync(caminho)) {
            try { fs.unlinkSync(caminho); } catch { /* ignora limpeza */ }
        }
    }
}

export async function baixarVideoYoutubeHandler(
    { jid, url }: { jid: string; url: string }
): Promise<McpToolResult> {
    let caminho: string | null = null;
    try {
        const sock = whatsappService.recuperarInstancia();
        caminho = await youtubeService.baixarVideo(url);
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

export async function agendarMensagemHandler(
    { jid, mensagem, tipo, cron_expression, run_at, timezone, solicitante, urgente }: {
        jid: string;
        mensagem: string;
        tipo: 'once' | 'recorrente';
        cron_expression?: string;
        run_at?: string;
        timezone?: string;
        solicitante?: string;
        urgente?: boolean;
    }
): Promise<McpToolResult> {
    try {
        if (tipo === 'recorrente') {
            if (!cron_expression || !cron.validate(cron_expression)) {
                return fail(`❌ cron_expression inválida ou ausente: "${cron_expression ?? ''}"`);
            }
        } else {
            if (!run_at || Number.isNaN(Date.parse(run_at))) {
                return fail(`❌ run_at inválido ou ausente: "${run_at ?? ''}"`);
            }
        }

        const id = agendamentoRepository.criar({
            chatId: jid,                      // destino = chat de origem
            contactId: solicitante ?? jid,    // quem pediu (identidade CONFIÁVEL; base de permissão)
            mensagem,
            tipo,
            cronExpression: cron_expression,
            runAt: run_at,
            timezone: timezone ?? 'America/Sao_Paulo',
            urgente,
        });

        const novo = agendamentoRepository.buscarPorId(id);
        if (novo) schedulerService.registrar(novo);

        const flagUrgente = tipo === 'once' && urgente ? ' [URGENTE]' : '';
        return ok(`✅ Agendamento criado (id ${id}, tipo ${tipo}${flagUrgente}).`);
    } catch (error) {
        return fail(`❌ Falha ao agendar: ${(error as Error).message}`);
    }
}

export async function listarAgendamentosHandler(
    { jid, solicitante, eh_admin }: { jid: string; solicitante?: string; eh_admin?: boolean }
): Promise<McpToolResult> {
    try {
        // Admin vê todos do chat; não-admin vê só os que ele mesmo criou.
        const filtro = eh_admin ? undefined : solicitante;
        const lista = agendamentoRepository.listarPorChat(jid, filtro).map((a) => ({
            id: a.id,
            mensagem: a.mensagem,
            tipo: a.tipo,
            cron_expression: a.cron_expression,
            run_at: a.run_at,
            urgente: a.urgente === 1,
            status: a.status,
        }));
        return ok(JSON.stringify(lista));
    } catch (error) {
        return fail(`❌ Falha ao listar agendamentos: ${(error as Error).message}`);
    }
}

/**
 * Permissão de mexer num agendamento: admin pode em qualquer um; demais só no que
 * eles mesmos criaram. Retorna mensagem de erro (string) se NÃO pode, ou null se
 * pode. O agendamento já deve ter sido validado (existe, é do chat, pendente).
 */
function negarSeSemPermissao(
    ag: ReturnType<typeof agendamentoRepository.buscarPorId>,
    solicitante: string | undefined,
    ehAdmin: boolean,
): string | null {
    if (!ag) return null;
    if (ehAdmin || mesmoSolicitante(ag, solicitante)) return null;
    return `❌ Esse lembrete (id ${ag.id}) não é seu — só quem criou (ou o admin) pode mexer nele.`;
}

export async function cancelarAgendamentoHandler(
    { jid, id, solicitante, eh_admin }: { jid: string; id: number; solicitante?: string; eh_admin?: boolean }
): Promise<McpToolResult> {
    try {
        const ag = agendamentoRepository.buscarPorId(id);
        if (!ag || ag.chat_id !== jid || ag.status !== 'pendente') {
            return fail(`❌ Agendamento ${id} não encontrado para este chat.`);
        }
        const erro = negarSeSemPermissao(ag, solicitante, !!eh_admin);
        if (erro) return fail(erro);
        schedulerService.cancelar(id);
        return ok(`✅ Agendamento ${id} cancelado.`);
    } catch (error) {
        return fail(`❌ Falha ao cancelar agendamento: ${(error as Error).message}`);
    }
}

export async function editarAgendamentoHandler(
    { jid, id, solicitante, eh_admin, mensagem, run_at, cron_expression, urgente }: {
        jid: string;
        id: number;
        solicitante?: string;
        eh_admin?: boolean;
        mensagem?: string;
        run_at?: string;
        cron_expression?: string;
        urgente?: boolean;
    }
): Promise<McpToolResult> {
    try {
        const ag = agendamentoRepository.buscarPorId(id);
        if (!ag || ag.chat_id !== jid || ag.status !== 'pendente') {
            return fail(`❌ Agendamento ${id} não encontrado para este chat.`);
        }
        const erro = negarSeSemPermissao(ag, solicitante, !!eh_admin);
        if (erro) return fail(erro);

        // Valida os campos de horário conforme o tipo do agendamento.
        if (cron_expression !== undefined) {
            if (ag.tipo !== 'recorrente') return fail('❌ cron_expression só vale para lembrete recorrente.');
            if (!cron.validate(cron_expression)) return fail(`❌ cron_expression inválida: "${cron_expression}".`);
        }
        if (run_at !== undefined) {
            if (ag.tipo !== 'once') return fail('❌ run_at só vale para lembrete de uma vez (once).');
            if (Number.isNaN(Date.parse(run_at))) return fail(`❌ run_at inválido: "${run_at}".`);
        }

        const atualizado = agendamentoRepository.atualizar(id, {
            mensagem,
            runAt: run_at,
            cronExpression: cron_expression,
            urgente,
        });
        if (!atualizado) return fail(`❌ Não foi possível atualizar o agendamento ${id}.`);

        // Re-registra: para o timer/cron antigo e religa com os novos dados.
        schedulerService.reagendar(atualizado);
        return ok(`✅ Agendamento ${id} atualizado.`);
    } catch (error) {
        return fail(`❌ Falha ao editar agendamento: ${(error as Error).message}`);
    }
}

export async function buscarContatoHandler(
    { nome }: { nome: string }
): Promise<McpToolResult> {
    try {
        const contatos = buscarPorNome(nome).map((p) => ({ nome: p.nome, jid: p.numero }));
        return ok(JSON.stringify(contatos));
    } catch (error) {
        return fail(`❌ Falha ao buscar contato: ${(error as Error).message}`);
    }
}

export async function listarParticipantesGrupoHandler(
    { jid }: { jid: string }
): Promise<McpToolResult> {
    try {
        if (!isJidGroup(jid)) {
            return fail('❌ Isso não é um grupo — só dá para listar participantes em grupos.');
        }
        const sock = whatsappService.recuperarInstancia();
        const meta = await sock.groupMetadata(jid);

        const lista = await Promise.all(
            (meta.participants ?? []).map(async (p) => {
                // Resolve o nome: cadastrado (por número ou LID) > número legível > desconhecido.
                const numero = await resolverNumero(sock, p.id);
                const pessoa = (numero ? buscarPorNumero(numero) : null) ?? buscarPorLid(p.id);
                if (pessoa) return { nome: pessoa.nome, cadastrado: true };
                const legivel = numero ? numero.split('@')[0] : null;
                return { nome: legivel ?? '(desconhecido)', cadastrado: false };
            }),
        );
        return ok(JSON.stringify(lista));
    } catch (error) {
        return fail(`❌ Falha ao listar participantes do grupo: ${(error as Error).message}`);
    }
}

// --- Menção (@) -------------------------------------------------------------
// Posta no chat uma mensagem com a menção REAL do WhatsApp (que notifica) para
// quem está cadastrado; quem não está, vira texto puro (sem ping). Toda a
// resolução nome→cadastro→JID acontece aqui (o agente nunca vê LID/número).

const MAX_MENCOES = 10;

type MencaoResultado = {
    nome: string;
    pingado: boolean;
    motivo?: 'nao_cadastrado' | 'ambiguo' | 'fora_do_grupo';
};

/** Escapa metacaracteres de regex num literal (nome do usuário). */
function escaparRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Melhor pessoa para um nome: igualdade exata (ci) > parcial único > ambíguo/nenhum. */
function melhorPessoa(nome: string): { pessoa: Pessoa | null; ambiguo: boolean } {
    const matches = buscarPorNome(nome);
    if (matches.length === 0) return { pessoa: null, ambiguo: false };
    const alvo = nome.trim().toLowerCase();
    const exatos = matches.filter((p) => p.nome.trim().toLowerCase() === alvo);
    if (exatos.length === 1) return { pessoa: exatos[0]!, ambiguo: false };
    if (exatos.length > 1) return { pessoa: null, ambiguo: true };
    if (matches.length === 1) return { pessoa: matches[0]!, ambiguo: false };
    return { pessoa: null, ambiguo: true };
}

export async function enviarMencaoHandler(
    { jid, texto, nomes }: { jid: string; texto: string; nomes: string[] }
): Promise<McpToolResult> {
    try {
        if (textoVazio(texto)) {
            return fail('Texto vazio — nada a enviar.');
        }
        const sock = whatsappService.recuperarInstancia();
        const ehGrupo = isJidGroup(jid);

        // Índice dos participantes do grupo: usamos o `participant.id` cru como
        // JID da menção (já é a forma EXATA que o grupo endereça — LID ou PN),
        // o que é mais confiável que adivinhar pelo addressingMode.
        const porLid = new Map<string, string>();
        const porPn = new Map<string, string>();
        if (ehGrupo) {
            try {
                const meta = await sock.groupMetadata(jid);
                for (const p of meta.participants ?? []) {
                    if (isLidUser(p.id)) porLid.set(jidNormalizedUser(p.id), p.id);
                    else if (isPnUser(p.id)) porPn.set(jidNormalizedUser(p.id), p.id);
                }
            } catch {
                // Sem metadata → tudo vira texto puro (não derruba a tool).
            }
        }

        const resultados: MencaoResultado[] = [];
        const mentions: string[] = [];
        const pingados: { nome: string; digits: string }[] = [];
        const textoPuro: string[] = [];

        for (const nome of nomes.slice(0, MAX_MENCOES)) {
            const { pessoa, ambiguo } = melhorPessoa(nome);
            if (ambiguo) { resultados.push({ nome, pingado: false, motivo: 'ambiguo' }); textoPuro.push(nome); continue; }
            if (!pessoa) { resultados.push({ nome, pingado: false, motivo: 'nao_cadastrado' }); textoPuro.push(nome); continue; }

            // Acha o JID do participante: lid do cadastro > pn > reverso PN→LID.
            let mentionJid: string | undefined;
            if (ehGrupo) {
                if (pessoa.lid && porLid.has(jidNormalizedUser(pessoa.lid))) {
                    mentionJid = porLid.get(jidNormalizedUser(pessoa.lid));
                } else if (porPn.has(jidNormalizedUser(pessoa.numero))) {
                    mentionJid = porPn.get(jidNormalizedUser(pessoa.numero));
                } else {
                    const lidRev = await resolverLid(sock, pessoa.numero);
                    if (lidRev && porLid.has(lidRev)) mentionJid = porLid.get(lidRev);
                }
            }
            if (!mentionJid) {
                // Cadastrado mas fora do grupo (ou DM): sem ping útil → texto puro.
                resultados.push({ nome, pingado: false, motivo: 'fora_do_grupo' });
                textoPuro.push(nome);
                continue;
            }

            mentions.push(mentionJid);
            pingados.push({ nome, digits: mentionJid.split('@')[0]! });
            resultados.push({ nome, pingado: true });
        }

        // Substituição segura no texto. Lookahead Unicode (não \b, por acento/
        // nome composto). Pingados primeiro viram placeholder (pra não reprocessar
        // os dígitos), depois os placeholders viram @digits; texto-puro perde o @.
        let textoFinal = texto;
        const placeholders: { ph: string; digits: string }[] = [];
        [...pingados].sort((a, b) => b.nome.length - a.nome.length).forEach((item, i) => {
            const ph = String.fromCharCode(0) + i + String.fromCharCode(0);
            const re = new RegExp(`@${escaparRegex(item.nome)}(?![\\p{L}\\p{N}_])`, 'giu');
            let achou = false;
            textoFinal = textoFinal.replace(re, () => { achou = true; return ph; });
            // Invariante: todo JID em `mentions` precisa de um @digits no texto.
            if (!achou) textoFinal = textoFinal ? `${textoFinal} ${ph}` : ph;
            placeholders.push({ ph, digits: item.digits });
        });
        [...textoPuro].sort((a, b) => b.length - a.length).forEach((nome) => {
            const re = new RegExp(`@(${escaparRegex(nome)})(?![\\p{L}\\p{N}_])`, 'giu');
            textoFinal = textoFinal.replace(re, '$1');
        });
        for (const { ph, digits } of placeholders) {
            textoFinal = textoFinal.split(ph).join(`@${digits}`);
        }

        const mentionsUnicas = [...new Set(mentions)];
        await sock.sendMessage(jid, { text: textoFinal, mentions: mentionsUnicas });
        return ok(JSON.stringify(resultados));
    } catch (error) {
        return fail(`❌ Falha ao enviar menção: ${(error as Error).message}`);
    }
}

export async function cadastrarPessoaHandler(
    { nome, numero }: { nome: string; numero: string }
): Promise<McpToolResult> {
    try {
        const nomeLimpo = (nome ?? '').trim();
        if (!nomeLimpo) return fail('❌ Nome vazio — informe o nome da pessoa.');

        // Número canônico: só dígitos → remove o 9º dígito BR → <digitos>@s.whatsapp.net.
        // Precisa casar EXATAMENTE com o que buscarPorNumero (usado no /p) consulta depois.
        const digitos = (numero ?? '').replace(/\D/g, '');
        if (!digitos) return fail('❌ Número vazio ou sem dígitos.');

        const numeroCanonico = jidNormalizedUser(`${normalizarNonoDigito(digitos)}@s.whatsapp.net`);

        // Best-effort: tenta descobrir o LID (pode vir null — tudo bem).
        let lid: string | null = null;
        try {
            const sock = whatsappService.recuperarInstancia();
            lid = await resolverLid(sock, numeroCanonico);
        } catch {
            // Sem socket vivo / sem mapeamento → segue sem LID.
        }

        registrarPessoa({ numero: numeroCanonico, lid, nome: nomeLimpo, cadastradoPor: null });

        return ok(JSON.stringify({ status: 'ok', nome: nomeLimpo, numero: numeroCanonico }));
    } catch (error) {
        return fail(`❌ Falha ao cadastrar pessoa: ${(error as Error).message}`);
    }
}

export async function gerarEEnviarSemaninhaHandler(
    { usuario, jid }: { usuario: string; jid: string }
): Promise<McpToolResult> {
    try {
        const sock = whatsappService.recuperarInstancia();

        const albums = await lastfmService.recuperarAlbumsMaisOuvidosSemana(usuario);
        const semaninha = await new Canvas().criarCanvas(albums);

        await sock.sendMessage(jid, {
            image: semaninha,
            mimetype: 'image/jpeg',
            caption: `Semaninha do ${usuario}`,
        });

        return ok(JSON.stringify({ status: 'ok' }));
    } catch (error) {
        return fail(`❌ Falha ao gerar/enviar semaninha: ${(error as Error).message}`);
    }
}

function inicializarServidor() {
    const server = new McpServer({
        name: 'Megatron-Whatsapp-Bridge',
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
        "enviar_audio",
        {
            description: "Envia um áudio como NOTA DE VOZ (PTT) do WhatsApp para o JID. Recebe o áudio em base64 (ex: WAV do TTS); o bot converte para opus e envia como voz.",
            inputSchema: {
                jid: z.string().describe("JID do destinatário (ex: 5547999999999@s.whatsapp.net)"),
                mediaBase64: z.string().describe("Áudio em base64 (WAV/MP3/etc), sem prefixo 'data:'.")
            }
        },
        enviarAudioHandler
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

    server.registerTool(
        "charts_lastfm",
        {
            description: "Retorna as 10 músicas mais ouvidas na última semana de um usuário do Last.fm (texto). Requer o nome de usuário do Last.fm.",
            inputSchema: {
                usuario: z.string().describe("Nome de usuário no Last.fm.")
            }
        },
        chartsLastfmHandler
    );

    server.registerTool(
        "baixar_musica",
        {
            description: "Baixa o áudio (mp3) de um link do YouTube e ENVIA como áudio para o JID. Use para 'baixa essa música <link>'.",
            inputSchema: {
                jid: z.string().describe("JID do destinatário (ex: 5547999999999@s.whatsapp.net)"),
                url: z.string().describe("Link do YouTube da música.")
            }
        },
        baixarMusicaHandler
    );

    server.registerTool(
        "baixar_video_youtube",
        {
            description: "Baixa um vídeo do YouTube e ENVIA como vídeo para o JID. Use para 'baixa esse vídeo <link>'.",
            inputSchema: {
                jid: z.string().describe("JID do destinatário (ex: 5547999999999@s.whatsapp.net)"),
                url: z.string().describe("Link do YouTube do vídeo.")
            }
        },
        baixarVideoYoutubeHandler
    );

    server.registerTool(
        "agendar_mensagem",
        {
            description: "Agenda o envio de uma mensagem (lembrete) para um JID em um horário futuro. " +
                "Use tipo='recorrente' com cron_expression (ex: '0 8 * * *' = todo dia 8h) ou " +
                "tipo='once' com run_at (data/hora ISO 8601 com offset). O envio vai SEMPRE para o `jid` informado.",
            inputSchema: {
                jid: z.string().describe("JID do chat de ORIGEM/destino (grupo @g.us ou privado @s.whatsapp.net)."),
                mensagem: z.string().describe("Texto do lembrete a ser enviado no horário. Suporta Markdown do WhatsApp."),
                tipo: z.enum(['once', 'recorrente']).describe("'once' = uma vez; 'recorrente' = repete pelo cron."),
                cron_expression: z.string().optional().describe("Expressão cron (obrigatória se tipo='recorrente'). Ex: '0 8 * * 1' = seg 8h."),
                run_at: z.string().optional().describe("Data/hora ISO 8601 com offset (obrigatória se tipo='once'). Ex: '2026-06-04T14:00:00-03:00'."),
                timezone: z.string().optional().describe("Fuso (default 'America/Sao_Paulo')."),
                solicitante: z.string().optional().describe("Identidade CONFIÁVEL de quem pediu (passe o remetente_numero do contexto). Vira a base de permissão p/ cancelar/editar depois."),
                urgente: z.boolean().optional().describe("Se true (só para tipo='once'), reenvia a cada 3min até o solicitante responder no chat.")
            }
        },
        agendarMensagemHandler
    );

    server.registerTool(
        "listar_agendamentos",
        {
            description: "Lista os agendamentos (lembretes) ativos de um chat. Retorna JSON com id, mensagem, tipo, cron_expression e run_at. " +
                "O admin vê todos do chat; os demais veem só os que eles mesmos criaram.",
            inputSchema: {
                jid: z.string().describe("JID do chat cujos agendamentos serão listados."),
                solicitante: z.string().optional().describe("Identidade CONFIÁVEL de quem está pedindo (remetente_numero do contexto)."),
                eh_admin: z.boolean().optional().describe("True se quem pede é o admin (vê todos do chat).")
            }
        },
        listarAgendamentosHandler
    );

    server.registerTool(
        "cancelar_agendamento",
        {
            description: "Cancela um agendamento (lembrete) ativo pelo id. Só cancela se o id pertencer ao chat E se quem pede for o admin ou quem criou o agendamento.",
            inputSchema: {
                jid: z.string().describe("JID do chat admin do agendamento."),
                id: z.number().describe("Id do agendamento a cancelar (obtido via listar_agendamentos)."),
                solicitante: z.string().optional().describe("Identidade CONFIÁVEL de quem está pedindo (remetente_numero do contexto)."),
                eh_admin: z.boolean().optional().describe("True se quem pede é o admin (pode cancelar qualquer um).")
            }
        },
        cancelarAgendamentoHandler
    );

    server.registerTool(
        "editar_agendamento",
        {
            description: "Edita um agendamento (lembrete) PENDENTE pelo id: muda mensagem e/ou horário (run_at p/ once, cron_expression p/ recorrente) e/ou urgência. " +
                "Só edita se o id pertencer ao chat E se quem pede for o admin ou quem criou. Informe apenas os campos que mudam.",
            inputSchema: {
                jid: z.string().describe("JID do chat admin do agendamento."),
                id: z.number().describe("Id do agendamento a editar (obtido via listar_agendamentos)."),
                solicitante: z.string().optional().describe("Identidade CONFIÁVEL de quem está pedindo (remetente_numero do contexto)."),
                eh_admin: z.boolean().optional().describe("True se quem pede é o admin (pode editar qualquer um)."),
                mensagem: z.string().optional().describe("Novo texto do lembrete."),
                run_at: z.string().optional().describe("Novo horário ISO 8601 com offset (só p/ tipo='once'). Ex: '2026-06-04T14:00:00-03:00'."),
                cron_expression: z.string().optional().describe("Nova expressão cron (só p/ tipo='recorrente')."),
                urgente: z.boolean().optional().describe("Liga/desliga a urgência (só faz efeito em tipo='once').")
            }
        },
        editarAgendamentoHandler
    );

    server.registerTool(
        "buscar_pessoa",
        {
            description: "Busca contatos CADASTRADOS pelo nome (case-insensitive, parcial). Use para resolver " +
                "o destinatário de um lembrete dirigido a OUTRA pessoa (ex.: 'lembre o João de...'). " +
                "Retorna JSON [{nome, jid}]. Lista vazia = ninguém com esse nome; mais de um = pedir desambiguação.",
            inputSchema: {
                nome: z.string().describe("Nome (ou parte) do contato a procurar.")
            }
        },
        buscarContatoHandler
    );

    server.registerTool(
        "listar_participantes_grupo",
        {
            description: "Lista os participantes de um GRUPO do WhatsApp (só os nomes). Use quando pedirem " +
                "'quem está no grupo?', 'quem tá aqui?'. Retorna JSON [{nome, cadastrado}] — cadastrados vêm com o nome real; " +
                "os demais com o número ou '(desconhecido)'. Em chat privado (não-grupo) retorna erro.",
            inputSchema: {
                jid: z.string().describe("JID do grupo (use o usuario_jid do contexto; deve terminar em @g.us).")
            }
        },
        listarParticipantesGrupoHandler
    );

    server.registerTool(
        "enviar_mencao",
        {
            description: "Posta uma mensagem no chat MENCIONANDO (@) pessoas, disparando a NOTIFICAÇÃO real do WhatsApp para quem é CADASTRADO. " +
                "Use quando pedirem para avisar/mencionar/chamar alguém. Escreva a mensagem em 'texto' colocando @<nome> exatamente onde cada menção deve aparecer, " +
                "e liste os nomes mencionados em 'nomes'. Quem não estiver cadastrado (ou não estiver no grupo) entra como texto puro, sem ping. " +
                "Retorna JSON [{nome, pingado, motivo?}] — use para saber quem foi notificado de verdade.",
            inputSchema: {
                jid: z.string().describe("JID do chat onde postar (use o usuario_jid do contexto)."),
                texto: z.string().describe("Mensagem a enviar, com @<nome> no ponto de cada menção. Suporta Markdown do WhatsApp."),
                nomes: z.array(z.string()).describe("Nomes das pessoas a mencionar (como o usuário as chamou).")
            }
        },
        enviarMencaoHandler
    );

    server.registerTool(
        "cadastrar_pessoa",
        {
            description: "Cadastra (ou atualiza) uma pessoa na agenda do bot a partir do nome e do número cru. " +
                "Use quando pedirem para cadastrar/registrar alguém informando o telefone. O número é normalizado " +
                "para a forma canônica do projeto (para casar com buscas futuras). A permissão (quem pode cadastrar) " +
                "é controlada pelo agente — esta tool apenas grava.",
            inputSchema: {
                nome: z.string().describe("Nome da pessoa a cadastrar."),
                numero: z.string().describe("Número em qualquer formato: +55 11 91234-5678, 5511912345678, etc.")
            }
        },
        cadastrarPessoaHandler
    );

    server.registerTool(
        "gerar_e_enviar_semaninha",
        {
            description: "Gera a colagem 5×5 dos álbuns mais ouvidos da semana no Last.fm de um usuário e ENVIA a imagem para o JID. " +
                "Use para 'semaninha do <usuario>'.",
            inputSchema: {
                usuario: z.string().describe("Usuário do Last.fm."),
                jid: z.string().describe("JID do destino (ex: 5547999999999@s.whatsapp.net ou grupo @g.us).")
            }
        },
        gerarEEnviarSemaninhaHandler
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
