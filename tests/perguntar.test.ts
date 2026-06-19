import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@whiskeysockets/baileys', () => ({
    downloadMediaMessage: vi.fn(),
    isJidGroup: (jid?: string) => !!jid?.endsWith('@g.us'),
    isLidUser: (jid?: string) => !!jid?.endsWith('@lid'),
    isPnUser: (jid?: string) => !!jid?.endsWith('@s.whatsapp.net'),
    jidNormalizedUser: (jid?: string) => jid ?? '',
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

vi.mock('../src/repository/pessoa.repository.js', () => ({
    buscarPorNumero: vi.fn(() => null),
}));

import axios from 'axios';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import perguntar from '../src/commands/perguntar.js';

const DEBOUNCE_MS = 3_000;

function mockSock() {
    return { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
}

function dto(opts: { sock?: any; conteudo?: string; id?: string; remoteJid?: string; participant?: string } = {}) {
    const remoteJid = opts.remoteJid ?? '5511@s.whatsapp.net';
    const key: any = { id: opts.id ?? 'm1', remoteJid, fromMe: false };
    if (opts.participant) key.participant = opts.participant;
    return {
        sock: opts.sock ?? mockSock(),
        msg: { key, message: { conversation: `/p ${opts.conteudo ?? 'oi'}` } } as any,
        usuarioJid: remoteJid,
        conteudo: opts.conteudo ?? 'oi',
    };
}

/** Avança o debounce e deixa os microtasks (axios/sendMessage) resolverem. */
async function dispararLote() {
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
}

describe('comando /p (ponte para o agente, com debounce)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        (axios.post as any).mockResolvedValue({ data: { texto: 'ok', tools_acionadas: [] } });
    });
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('expõe metadados corretos', () => {
        expect(perguntar.name).toBe('/p');
        expect(typeof perguntar.execute).toBe('function');
    });

    it('sem conteúdo: reage ❌ e não agenda lote', async () => {
        const d = dto({ conteudo: '' });
        await perguntar.execute(d);
        await dispararLote();

        expect(axios.post).not.toHaveBeenCalled();
        expect(d.sock.sendMessage).toHaveBeenCalledWith(d.usuarioJid, { react: { text: '❌', key: d.msg.key } });
        expect(d.sock.sendMessage).toHaveBeenCalledWith(d.usuarioJid, { text: "Precisa mandar uma pergunta!!! 🤨" });
    });

    it('1 mensagem: reage ⏳, POSTa após a janela, envia texto e reage 💅', async () => {
        const d = dto({ conteudo: 'capital da australia' });

        await perguntar.execute(d);
        expect(d.sock.sendMessage).toHaveBeenCalledWith(d.usuarioJid, { react: { text: '⏳', key: d.msg.key } });
        expect(axios.post).not.toHaveBeenCalled(); // ainda dentro da janela

        await dispararLote();

        expect(axios.post).toHaveBeenCalledOnce();
        const [url, payload] = (axios.post as any).mock.calls[0];
        expect(url).toBe('http://test-agent:8000/chat');
        expect(payload).toMatchObject({
            chatId: d.usuarioJid,
            mensagem: 'capital da australia',
            midia: null,
            remetente: { numero: '5511@s.whatsapp.net', nome: null, registrado: false, ehAdmin: false },
        });
        expect(d.sock.sendMessage).toHaveBeenCalledWith(d.usuarioJid, { text: 'ok' });
        expect(d.sock.sendMessage).toHaveBeenCalledWith(d.usuarioJid, { react: { text: '💅', key: d.msg.key } });
    });

    it('coalesce: 3 /p do mesmo remetente na janela viram 1 POST com lote e 💅 em todos', async () => {
        const sock = mockSock();
        const d1 = dto({ sock, conteudo: 'um', id: 'a' });
        const d2 = dto({ sock, conteudo: 'dois', id: 'b' });
        const d3 = dto({ sock, conteudo: 'tres', id: 'c' });

        await perguntar.execute(d1);
        await perguntar.execute(d2);
        await perguntar.execute(d3);
        await dispararLote();

        expect(axios.post).toHaveBeenCalledOnce();
        const payload = (axios.post as any).mock.calls[0][1];
        expect(payload.mensagem).toContain('lote de 3');
        expect(payload.mensagem).toContain('1. um');
        expect(payload.mensagem).toContain('2. dois');
        expect(payload.mensagem).toContain('3. tres');

        for (const id of ['a', 'b', 'c']) {
            expect(sock.sendMessage).toHaveBeenCalledWith(
                d1.usuarioJid,
                { react: { text: '💅', key: expect.objectContaining({ id }) } },
            );
        }
    });

    it('remetentes diferentes no mesmo grupo geram lotes (POSTs) separados', async () => {
        const sock = mockSock();
        const a = dto({ sock, conteudo: 'do ana', id: 'a', remoteJid: 'grupo@g.us', participant: '5511@s.whatsapp.net' });
        const b = dto({ sock, conteudo: 'do bia', id: 'b', remoteJid: 'grupo@g.us', participant: '5522@s.whatsapp.net' });

        await perguntar.execute(a);
        await perguntar.execute(b);
        await dispararLote();

        expect(axios.post).toHaveBeenCalledTimes(2);
        const mensagens = (axios.post as any).mock.calls.map((c: any[]) => c[1].mensagem);
        expect(mensagens).toContain('do ana');
        expect(mensagens).toContain('do bia');
    });

    it('texto null no response: não envia texto, só reage 💅', async () => {
        (axios.post as any).mockResolvedValue({ data: { texto: null, tools_acionadas: ['enviar_sticker_buscado'] } });
        const d = dto({ conteudo: 'manda figurinha' });

        await perguntar.execute(d);
        await dispararLote();

        const enviosTexto = (d.sock.sendMessage as any).mock.calls.filter(([, p]: any[]) => 'text' in p);
        expect(enviosTexto).toHaveLength(0);
        expect(d.sock.sendMessage).toHaveBeenCalledWith(d.usuarioJid, { react: { text: '💅', key: d.msg.key } });
    });

    it('envia mídia citada como base64 no payload', async () => {
        const d = dto({ conteudo: 'descreve' });
        d.msg.message = {
            extendedTextMessage: {
                text: '/p descreve',
                contextInfo: { quotedMessage: { imageMessage: { mimetype: 'image/png' } } },
            },
        };
        (downloadMediaMessage as any).mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

        await perguntar.execute(d);
        await dispararLote();

        const payload = (axios.post as any).mock.calls[0][1];
        expect(payload.midia).toEqual({
            base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
            mimetype: 'image/png',
        });
    });

    it('ECONNREFUSED: reage ❌ e avisa que o agente está fora do ar', async () => {
        const err: any = new Error('connect ECONNREFUSED');
        err.code = 'ECONNREFUSED';
        (axios.isAxiosError as any).mockReturnValue(true);
        (axios.post as any).mockRejectedValue(err);
        const d = dto({ conteudo: 'oi' });

        await perguntar.execute(d);
        await dispararLote();

        expect(d.sock.sendMessage).toHaveBeenCalledWith(d.usuarioJid, { react: { text: '❌', key: d.msg.key } });
        expect(d.sock.sendMessage).toHaveBeenCalledWith(d.usuarioJid, { text: "❌ Agente fora do ar, tenta de novo daqui a pouco 🥲" });
    });

    it('erro genérico: reage ❌ e envia mensagem padrão', async () => {
        (axios.isAxiosError as any).mockReturnValue(false);
        (axios.post as any).mockRejectedValue(new Error('boom'));
        const d = dto({ conteudo: 'oi' });

        await perguntar.execute(d);
        await dispararLote();

        expect(d.sock.sendMessage).toHaveBeenCalledWith(d.usuarioJid, { react: { text: '❌', key: d.msg.key } });
        expect(d.sock.sendMessage).toHaveBeenCalledWith(d.usuarioJid, { text: "❌ Ixe, deu ruim na IA :p" });
    });
});
