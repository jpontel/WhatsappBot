import { describe, it, expect, vi, beforeEach } from 'vitest';

const sock = { sendMessage: vi.fn().mockResolvedValue(undefined) };
const recuperarInstancia = vi.fn(() => sock);

vi.mock('../src/services/whatsapp.service.js', () => ({
    whatsappService: {
        get recuperarInstancia() { return recuperarInstancia; },
    },
}));

vi.mock('wa-sticker-formatter', () => ({
    StickerTypes: { CROPPED: 'cropped' },
    Sticker: class {
        constructor(_buffer: Buffer, _opts: unknown) {}
        async toBuffer() { return Buffer.from('sticker-bytes'); }
    },
}));

import {
    enviarTextoHandler,
    enviarImagemHandler,
    enviarStickerHandler,
    reagirHandler,
} from '../src/mcp/mcp.server.js';

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

beforeEach(() => {
    vi.clearAllMocks();
    recuperarInstancia.mockReturnValue(sock);
});

describe('enviarTextoHandler', () => {
    it('envia texto e retorna sucesso', async () => {
        const r = await enviarTextoHandler({ jid: '5511@s.whatsapp.net', texto: 'oi' });

        expect(sock.sendMessage).toHaveBeenCalledWith('5511@s.whatsapp.net', { text: 'oi' });
        expect(r.isError).toBeUndefined();
        expect(r.content[0]?.text).toContain('✅');
    });

    it('retorna isError quando recuperarInstancia lança', async () => {
        recuperarInstancia.mockImplementation(() => { throw new Error('socket offline'); });

        const r = await enviarTextoHandler({ jid: '5511@s.whatsapp.net', texto: 'oi' });

        expect(r.isError).toBe(true);
        expect(r.content[0]?.text).toContain('socket offline');
    });
});

describe('enviarImagemHandler', () => {
    it('envia imagem com legenda', async () => {
        const r = await enviarImagemHandler({
            jid: '5511@s.whatsapp.net',
            mediaBase64: PNG_B64,
            legenda: 'olha isso',
        });

        const [jid, payload] = (sock.sendMessage as any).mock.calls[0];
        expect(jid).toBe('5511@s.whatsapp.net');
        expect(payload.image).toBeInstanceOf(Buffer);
        expect(payload.caption).toBe('olha isso');
        expect(r.isError).toBeUndefined();
    });

    it('envia imagem sem legenda quando não informada (sem chave caption no payload)', async () => {
        await enviarImagemHandler({ jid: '5511@s.whatsapp.net', mediaBase64: PNG_B64 });

        const [, payload] = (sock.sendMessage as any).mock.calls[0];
        expect(payload).not.toHaveProperty('caption');
    });

    it('retorna isError quando recuperarInstancia lança', async () => {
        recuperarInstancia.mockImplementation(() => { throw new Error('off'); });

        const r = await enviarImagemHandler({ jid: '5511@s.whatsapp.net', mediaBase64: PNG_B64 });

        expect(r.isError).toBe(true);
    });
});

describe('enviarStickerHandler', () => {
    it('envia sticker convertendo PNG e retorna sucesso', async () => {
        const r = await enviarStickerHandler({ jid: '5511@s.whatsapp.net', mediaBase64: PNG_B64 });

        const [jid, payload] = (sock.sendMessage as any).mock.calls[0];
        expect(jid).toBe('5511@s.whatsapp.net');
        expect(payload.sticker).toBeInstanceOf(Buffer);
        expect(r.isError).toBeUndefined();
    });

    it('retorna isError quando recuperarInstancia lança', async () => {
        recuperarInstancia.mockImplementation(() => { throw new Error('off'); });

        const r = await enviarStickerHandler({ jid: '5511@s.whatsapp.net', mediaBase64: PNG_B64 });

        expect(r.isError).toBe(true);
    });
});

describe('reagirHandler', () => {
    const msgKey = { id: 'm1', remoteJid: '5511@s.whatsapp.net', fromMe: false };

    it('reage com o emoji passado', async () => {
        const r = await reagirHandler({ jid: '5511@s.whatsapp.net', msgKey, emoji: '⏳' });

        expect(sock.sendMessage).toHaveBeenCalledWith(
            '5511@s.whatsapp.net',
            { react: { text: '⏳', key: msgKey } },
        );
        expect(r.isError).toBeUndefined();
    });

    it('retorna isError quando recuperarInstancia lança', async () => {
        recuperarInstancia.mockImplementation(() => { throw new Error('off'); });

        const r = await reagirHandler({ jid: '5511@s.whatsapp.net', msgKey, emoji: '⏳' });

        expect(r.isError).toBe(true);
    });
});
