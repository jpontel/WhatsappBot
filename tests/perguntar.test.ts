import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@whiskeysockets/baileys', () => ({
    downloadMediaMessage: vi.fn(),
    isJidGroup: (jid?: string) => !!jid?.endsWith('@g.us'),
    isLidUser: (jid?: string) => !!jid?.endsWith('@lid'),
    isPnUser: (jid?: string) => !!jid?.endsWith('@s.whatsapp.net'),
    jidNormalizedUser: (jid?: string) => jid ?? '',
}));

vi.mock('../src/repository/pessoa.repository.js', () => ({
    buscarPorNumero: vi.fn(() => null),
}));

vi.mock('axios', () => {
    const post = vi.fn();
    const isAxiosError = vi.fn();
    return {
        default: { post, isAxiosError },
        post,
        isAxiosError,
    };
});

vi.mock('../src/config/env.js', () => ({
    ENV: { AGENT_URL: 'http://test-agent:8000' },
}));

import axios from 'axios';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import perguntar from '../src/commands/perguntar.js';

function mockSock() {
    return { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
}

function dtoBase() {
    const sock = mockSock();
    const msg = {
        key: { id: 'm1', remoteJid: '5511@s.whatsapp.net', fromMe: false },
        message: { conversation: '/p oi' },
    } as any;
    return {
        sock,
        msg,
        usuarioJid: '5511@s.whatsapp.net',
        conteudo: 'oi',
    };
}

describe('comando /p (ponte para o agente)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('expõe metadados corretos', () => {
        expect(perguntar.name).toBe('/p');
        expect(typeof perguntar.execute).toBe('function');
    });

    it('sem conteúdo: reage ❌ e envia texto de erro, não chama o agente', async () => {
        const dto = dtoBase();
        dto.conteudo = '';

        await perguntar.execute(dto);

        expect(axios.post).not.toHaveBeenCalled();
        expect(dto.sock.sendMessage).toHaveBeenCalledWith(
            dto.usuarioJid,
            { react: { text: '❌', key: dto.msg.key } },
        );
        expect(dto.sock.sendMessage).toHaveBeenCalledWith(
            dto.usuarioJid,
            { text: "Precisa mandar uma pergunta!!! 🤨" },
        );
    });

    it('happy path: POSTa no agente, envia texto retornado e reage 💅', async () => {
        const dto = dtoBase();
        (axios.post as any).mockResolvedValue({ data: { texto: 'Canberra 🦘', tools_acionadas: [] } });

        await perguntar.execute(dto);

        expect(axios.post).toHaveBeenCalledOnce();
        const [url, payload] = (axios.post as any).mock.calls[0];
        expect(url).toBe('http://test-agent:8000/chat');
        expect(payload).toMatchObject({
            chatId: dto.usuarioJid,
            mensagem: 'oi',
            msgKey: dto.msg.key,
            midia: null,
            remetente: { numero: '5511@s.whatsapp.net', nome: null, registrado: false, ehDono: false },
        });

        expect(dto.sock.sendMessage).toHaveBeenCalledWith(
            dto.usuarioJid,
            { react: { text: '⏳', key: dto.msg.key } },
        );
        expect(dto.sock.sendMessage).toHaveBeenCalledWith(
            dto.usuarioJid,
            { text: 'Canberra 🦘' },
        );
        expect(dto.sock.sendMessage).toHaveBeenCalledWith(
            dto.usuarioJid,
            { react: { text: '💅', key: dto.msg.key } },
        );
    });

    it('texto null no response: não envia mensagem de texto, apenas reage 💅', async () => {
        const dto = dtoBase();
        (axios.post as any).mockResolvedValue({ data: { texto: null, tools_acionadas: ['enviar_sticker'] } });

        await perguntar.execute(dto);

        const enviosTexto = (dto.sock.sendMessage as any).mock.calls.filter(
            ([, payload]: any[]) => 'text' in payload,
        );
        expect(enviosTexto).toHaveLength(0);

        expect(dto.sock.sendMessage).toHaveBeenCalledWith(
            dto.usuarioJid,
            { react: { text: '💅', key: dto.msg.key } },
        );
    });

    it('envia mídia citada como base64 no payload', async () => {
        const dto = dtoBase();
        dto.msg.message = {
            extendedTextMessage: {
                text: '/p descreve essa imagem',
                contextInfo: {
                    quotedMessage: {
                        imageMessage: { mimetype: 'image/png' },
                    },
                },
            },
        };
        (downloadMediaMessage as any).mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        (axios.post as any).mockResolvedValue({ data: { texto: 'uma imagem 🖼️', tools_acionadas: [] } });

        await perguntar.execute(dto);

        const payload = (axios.post as any).mock.calls[0][1];
        expect(payload.midia).toEqual({
            base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
            mimetype: 'image/png',
        });
    });

    it('ECONNREFUSED: reage ❌ e envia mensagem de "agente fora do ar"', async () => {
        const dto = dtoBase();
        const err: any = new Error('connect ECONNREFUSED');
        err.code = 'ECONNREFUSED';
        err.isAxiosError = true;
        (axios.isAxiosError as any).mockReturnValue(true);
        (axios.post as any).mockRejectedValue(err);

        await perguntar.execute(dto);

        expect(dto.sock.sendMessage).toHaveBeenCalledWith(
            dto.usuarioJid,
            { react: { text: '❌', key: dto.msg.key } },
        );
        expect(dto.sock.sendMessage).toHaveBeenCalledWith(
            dto.usuarioJid,
            { text: "❌ Agente fora do ar, tenta de novo daqui a pouco 🥲" },
        );
    });

    it('erro genérico: reage ❌ e envia mensagem padrão', async () => {
        const dto = dtoBase();
        (axios.isAxiosError as any).mockReturnValue(false);
        (axios.post as any).mockRejectedValue(new Error('erro genérico'));

        await perguntar.execute(dto);

        expect(dto.sock.sendMessage).toHaveBeenCalledWith(
            dto.usuarioJid,
            { react: { text: '❌', key: dto.msg.key } },
        );
        expect(dto.sock.sendMessage).toHaveBeenCalledWith(
            dto.usuarioJid,
            { text: "❌ Ixe, deu ruim na IA :p" },
        );
    });
});
