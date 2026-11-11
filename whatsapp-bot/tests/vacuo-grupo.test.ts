import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Env com janela curta (1s) e feature ligada.
vi.mock('../src/config/env.js', () => ({
    ENV: { VACUO_GRUPO_ATIVO: true, VACUO_GRUPO_DELAY_MS: 1000 },
}));
vi.mock('../src/repository/vacuo.repository.js', () => ({ estaHabilitado: vi.fn() }));
vi.mock('../src/repository/pessoa.repository.js', () => ({ buscarPorNumero: vi.fn() }));
vi.mock('../src/core/identidade.js', () => ({
    resolverNumeroRemetente: vi.fn(),
    ehAdminPorJid: vi.fn(),
}));
vi.mock('../src/core/contexto.js', () => ({
    textoParaContexto: vi.fn(),
    ultimaDoChat: vi.fn(),
}));

import { observar, _tamanho, _limpar } from '../src/core/vacuo-grupo.js';
import { estaHabilitado } from '../src/repository/vacuo.repository.js';
import { buscarPorNumero } from '../src/repository/pessoa.repository.js';
import { resolverNumeroRemetente, ehAdminPorJid } from '../src/core/identidade.js';
import { textoParaContexto, ultimaDoChat } from '../src/core/contexto.js';

const JID = 'grp@g.us';
const sock = {} as any;

function msg(id: string, text = 'oi') {
    return {
        key: { id, remoteJid: JID, participant: '5511999999999@s.whatsapp.net', fromMe: false },
        message: { conversation: text },
    } as any;
}

describe('vacuo-grupo (detector de silêncio)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        _limpar();
        (estaHabilitado as any).mockReturnValue(true);
        (textoParaContexto as any).mockReturnValue('oi');
        (resolverNumeroRemetente as any).mockResolvedValue('5511999999999@s.whatsapp.net');
        (ehAdminPorJid as any).mockReturnValue(false);
        (buscarPorNumero as any).mockReturnValue({ id: 1, nome: 'Fulano' });
        (ultimaDoChat as any).mockReturnValue({ msgId: 'm1' });
    });
    afterEach(() => vi.useRealTimers());

    it('dispara o /p após a janela de silêncio (cadastrado, grupo habilitado)', async () => {
        const acionar = vi.fn().mockResolvedValue(undefined);
        await observar(sock, msg('m1'), JID, { ehGatilho: false, acionar });
        expect(_tamanho()).toBe(1);

        await vi.advanceTimersByTimeAsync(1000);

        expect(acionar).toHaveBeenCalledOnce();
        expect(acionar.mock.calls[0][0].usuarioJid).toBe(JID);
        expect(acionar.mock.calls[0][0].conteudo).toBe('oi');
    });

    it('mídia-sozinha (sticker) também agenda', async () => {
        (textoParaContexto as any).mockReturnValue('[figurinha]');
        const acionar = vi.fn().mockResolvedValue(undefined);
        const m = { key: { id: 'm1', remoteJid: JID, participant: '5511999999999@s.whatsapp.net', fromMe: false }, message: { stickerMessage: {} } } as any;
        await observar(sock, m, JID, { ehGatilho: false, acionar });
        expect(_tamanho()).toBe(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(acionar).toHaveBeenCalledOnce();
    });

    it('grupo NÃO habilitado nunca agenda', async () => {
        (estaHabilitado as any).mockReturnValue(false);
        const acionar = vi.fn();
        await observar(sock, msg('m1'), JID, { ehGatilho: false, acionar });
        expect(_tamanho()).toBe(0);
    });

    it('mensagem que já aciona o bot (ehGatilho) não agenda', async () => {
        const acionar = vi.fn();
        await observar(sock, msg('m1'), JID, { ehGatilho: true, acionar });
        expect(_tamanho()).toBe(0);
    });

    it('remetente NÃO cadastrado não agenda', async () => {
        (buscarPorNumero as any).mockReturnValue(null);
        (ehAdminPorJid as any).mockReturnValue(false);
        const acionar = vi.fn();
        await observar(sock, msg('m1'), JID, { ehGatilho: false, acionar });
        expect(_tamanho()).toBe(0);
    });

    it('nova mensagem antes da janela cancela o disparo anterior', async () => {
        const acionar = vi.fn().mockResolvedValue(undefined);
        await observar(sock, msg('m1'), JID, { ehGatilho: false, acionar });
        expect(_tamanho()).toBe(1);

        // Chega uma segunda msg (de não-cadastrado): cancela e não reagenda.
        (buscarPorNumero as any).mockReturnValue(null);
        (ultimaDoChat as any).mockReturnValue({ msgId: 'm2' });
        await observar(sock, msg('m2'), JID, { ehGatilho: false, acionar });
        expect(_tamanho()).toBe(0);

        await vi.advanceTimersByTimeAsync(1000);
        expect(acionar).not.toHaveBeenCalled();
    });

    it('não dispara se a última msg do grupo mudou quando o timer estoura', async () => {
        const acionar = vi.fn().mockResolvedValue(undefined);
        await observar(sock, msg('m1'), JID, { ehGatilho: false, acionar });
        expect(_tamanho()).toBe(1);

        // Alguém falou (buffer mudou) sem passar pelo observar (ex.: corrida).
        (ultimaDoChat as any).mockReturnValue({ msgId: 'OUTRA' });
        await vi.advanceTimersByTimeAsync(1000);
        expect(acionar).not.toHaveBeenCalled();
    });
});
