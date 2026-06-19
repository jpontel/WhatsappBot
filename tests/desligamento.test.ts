import { describe, it, expect, vi, beforeEach } from 'vitest';
import { criarDesligamento } from '../src/core/desligamento.js';

function fazerDeps(over: Partial<Parameters<typeof criarDesligamento>[0]> = {}) {
    const end = vi.fn().mockResolvedValue(undefined);
    const logout = vi.fn().mockResolvedValue(undefined);
    const sock = { end, logout } as any;
    const salvar = vi.fn().mockResolvedValue(undefined);
    const sair = vi.fn();

    const deps = {
        obterSocket: () => sock,
        obterSalvarCredenciais: () => salvar,
        sair,
        timeoutMs: 1000,
        ...over,
    };

    return { deps, end, logout, salvar, sair };
}

describe('criarDesligamento', () => {
    beforeEach(() => vi.clearAllMocks());

    it('salva credenciais, encerra o socket com end(undefined) e sai com código 0', async () => {
        const { deps, end, salvar, sair } = fazerDeps();
        const desligar = criarDesligamento(deps);

        await desligar('SIGTERM');

        expect(salvar).toHaveBeenCalledOnce();
        expect(end).toHaveBeenCalledWith(undefined);
        expect(sair).toHaveBeenCalledWith(0);
    });

    it('NUNCA chama logout (preserva a sessão)', async () => {
        const { deps, logout } = fazerDeps();
        const desligar = criarDesligamento(deps);

        await desligar('SIGTERM');

        expect(logout).not.toHaveBeenCalled();
    });

    it('é idempotente: sinais repetidos rodam o corpo uma única vez', async () => {
        const { deps, end, salvar, sair } = fazerDeps();
        const desligar = criarDesligamento(deps);

        await Promise.all([desligar('SIGTERM'), desligar('SIGINT'), desligar('SIGTERM')]);

        expect(salvar).toHaveBeenCalledOnce();
        expect(end).toHaveBeenCalledOnce();
        expect(sair).toHaveBeenCalledOnce();
    });

    it('flush ANTES de encerrar o socket (ordem importa p/ não perder o último ratchet)', async () => {
        const ordem: string[] = [];
        const salvar = vi.fn(async () => { ordem.push('salvar'); });
        const end = vi.fn(async () => { ordem.push('end'); });
        const { deps } = fazerDeps({
            obterSalvarCredenciais: () => salvar,
            obterSocket: () => ({ end }) as any,
        });

        await criarDesligamento(deps)('SIGTERM');

        expect(ordem).toEqual(['salvar', 'end']);
    });

    it('ainda sai com 0 mesmo se salvar credenciais lançar (best-effort)', async () => {
        const { deps, sair } = fazerDeps({
            obterSalvarCredenciais: () => vi.fn().mockRejectedValue(new Error('disco cheio')),
        });

        await criarDesligamento(deps)('SIGTERM');

        expect(sair).toHaveBeenCalledWith(0);
    });

    it('não quebra quando ainda não há socket nem saveCreds (boot inicial)', async () => {
        const { deps, sair } = fazerDeps({
            obterSocket: () => null,
            obterSalvarCredenciais: () => null,
        });

        await criarDesligamento(deps)('SIGINT');

        expect(sair).toHaveBeenCalledWith(0);
    });
});
