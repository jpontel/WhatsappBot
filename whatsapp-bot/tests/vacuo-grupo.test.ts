import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Env com janela curta (1s) e feature ligada.
vi.mock('../src/config/env.js', () => ({
    ENV: { VACUO_GRUPO_ATIVO: true, VACUO_GRUPO_DELAY_MS: 1000 },
}));
vi.mock('../src/repository/vacuo.repository.js', () => ({
    estaHabilitado: vi.fn(),
    salvarPendente: vi.fn(),
    removerPendente: vi.fn(),
    listarPendentes: vi.fn(() => []),
}));
vi.mock('../src/repository/pessoa.repository.js', () => ({ buscarPorNumero: vi.fn() }));
vi.mock('../src/core/identidade.js', () => ({
    resolverNumeroRemetente: vi.fn(),
    ehAdminPorJid: vi.fn(),
}));
vi.mock('../src/core/contexto.js', () => ({
    textoParaContexto: vi.fn(),
    ultimaDoChat: vi.fn(),
}));
vi.mock('../src/services/whatsapp.service.js', () => ({
    whatsappService: { recuperarInstancia: vi.fn(() => ({ sendMessage: vi.fn() })) },
}));
vi.mock('../src/core/comandos.js', () => ({ default: vi.fn() }));

import { observar, inicializar, _tamanho, _limpar } from '../src/core/vacuo-grupo.js';
import { estaHabilitado, listarPendentes } from '../src/repository/vacuo.repository.js';
import { buscarPorNumero } from '../src/repository/pessoa.repository.js';
import { resolverNumeroRemetente, ehAdminPorJid } from '../src/core/identidade.js';
import { textoParaContexto, ultimaDoChat } from '../src/core/contexto.js';
import carregarComandos from '../src/core/comandos.js';

const JID = 'grp@g.us';
const sock = {} as any;
let pExecute: ReturnType<typeof vi.fn>;

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
        (listarPendentes as any).mockReturnValue([]);
        pExecute = vi.fn().mockResolvedValue(undefined);
        (carregarComandos as any).mockResolvedValue(new Map([['/p', { name: '/p', execute: pExecute }]]));
    });
    afterEach(() => vi.useRealTimers());

    it('dispara o /p após a janela de silêncio (cadastrado, grupo habilitado)', async () => {
        await observar(sock, msg('m1'), JID, { ehGatilho: false });
        expect(_tamanho()).toBe(1);

        await vi.advanceTimersByTimeAsync(1000);

        expect(pExecute).toHaveBeenCalledOnce();
        expect(pExecute.mock.calls[0]![0].usuarioJid).toBe(JID);
        expect(pExecute.mock.calls[0]![0].conteudo).toBe('oi');
    });

    it('mídia-sozinha (sticker) também agenda', async () => {
        (textoParaContexto as any).mockReturnValue('[figurinha]');
        const m = { key: { id: 'm1', remoteJid: JID, participant: '5511999999999@s.whatsapp.net', fromMe: false }, message: { stickerMessage: {} } } as any;
        await observar(sock, m, JID, { ehGatilho: false });
        expect(_tamanho()).toBe(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(pExecute).toHaveBeenCalledOnce();
    });

    it('grupo NÃO habilitado nunca agenda', async () => {
        (estaHabilitado as any).mockReturnValue(false);
        await observar(sock, msg('m1'), JID, { ehGatilho: false });
        expect(_tamanho()).toBe(0);
    });

    it('mensagem que já aciona o bot (ehGatilho) não agenda', async () => {
        await observar(sock, msg('m1'), JID, { ehGatilho: true });
        expect(_tamanho()).toBe(0);
    });

    it('remetente NÃO cadastrado não agenda', async () => {
        (buscarPorNumero as any).mockReturnValue(null);
        (ehAdminPorJid as any).mockReturnValue(false);
        await observar(sock, msg('m1'), JID, { ehGatilho: false });
        expect(_tamanho()).toBe(0);
    });

    it('nova mensagem antes da janela cancela o disparo anterior', async () => {
        await observar(sock, msg('m1'), JID, { ehGatilho: false });
        expect(_tamanho()).toBe(1);

        (buscarPorNumero as any).mockReturnValue(null);
        (ultimaDoChat as any).mockReturnValue({ msgId: 'm2' });
        await observar(sock, msg('m2'), JID, { ehGatilho: false });
        expect(_tamanho()).toBe(0);

        await vi.advanceTimersByTimeAsync(1000);
        expect(pExecute).not.toHaveBeenCalled();
    });

    it('não dispara se a última msg do grupo mudou quando o timer estoura', async () => {
        await observar(sock, msg('m1'), JID, { ehGatilho: false });
        expect(_tamanho()).toBe(1);

        (ultimaDoChat as any).mockReturnValue({ msgId: 'OUTRA' });
        await vi.advanceTimersByTimeAsync(1000);
        expect(pExecute).not.toHaveBeenCalled();
    });

    it('inicializar() re-arma uma pendência persistida e dispara (pós-restart)', async () => {
        const dto = { conteudo: 'to no vacuo', usuarioJid: JID, msg: msg('mX'), remetenteJid: '5511999999999@s.whatsapp.net', ehAdmin: false };
        (listarPendentes as any).mockReturnValue([
            { grupo_jid: JID, msg_id: 'mX', fire_at: new Date(Date.now() + 500).toISOString(), payload: JSON.stringify(dto) },
        ]);

        inicializar();
        expect(_tamanho()).toBe(1);

        // Restaurado dispara em max(remaining, 10s) = 10s → avança além disso.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(pExecute).toHaveBeenCalledOnce();
        expect(pExecute.mock.calls[0]![0].conteudo).toBe('to no vacuo');
    });

    it('inicializar() descarta pendência vencida há mais de uma janela (estale)', async () => {
        (listarPendentes as any).mockReturnValue([
            { grupo_jid: JID, msg_id: 'velha', fire_at: new Date(Date.now() - 5000).toISOString(), payload: '{}' },
        ]);
        inicializar();
        expect(_tamanho()).toBe(0);
    });
});
