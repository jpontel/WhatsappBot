import type { WASocket } from '@whiskeysockets/baileys';

/**
 * Dependências do desligamento gracioso. Usamos getters (em vez de receber o socket
 * direto) porque main() recria o socket a cada reconexão — no momento do SIGTERM
 * precisamos do socket ATUAL, não de uma referência capturada lá no boot.
 */
export interface DesligamentoDeps {
    /** Retorna o socket Baileys vivo no momento do desligamento (ou null se ainda não conectou). */
    obterSocket: () => WASocket | null;
    /** Retorna o saveCreds do useMultiFileAuthState atual, para o flush final das credenciais. */
    obterSalvarCredenciais: () => (() => Promise<void>) | null;
    /** Injetável para teste; em produção cai no process.exit real. */
    sair?: (codigo: number) => void;
    /** Tempo máximo (ms) que esperamos o encerramento limpo antes de forçar a saída. */
    timeoutMs?: number;
}

const SINAIS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/**
 * Executa o encerramento limpo: flush das credenciais + fechamento do socket
 * preservando a sessão (sock.end, NUNCA sock.logout). É idempotente — chamadas
 * repetidas (SIGTERM seguido de SIGINT, p.ex.) só rodam o corpo uma vez.
 *
 * Exportado para teste; o uso normal é via registrarDesligamentoGracioso.
 */
export function criarDesligamento(deps: DesligamentoDeps) {
    const sair = deps.sair ?? ((codigo: number) => process.exit(codigo));
    const timeoutMs = deps.timeoutMs ?? 5000;

    let desligando = false;

    return async function desligar(sinal: string): Promise<void> {
        if (desligando) return; // idempotência: ignora sinais subsequentes
        desligando = true;

        console.log(`\n🛑 Recebido ${sinal}. Encerrando com segurança (preservando sessão)...`);

        // Rede de segurança: se algo travar (ws sem responder), força a saída assim
        // mesmo — melhor sair do que ficar pendurado e levar um SIGKILL no meio.
        const timer = setTimeout(() => {
            console.warn('⏱️ Timeout no desligamento gracioso. Forçando saída.');
            sair(0);
        }, timeoutMs);
        timer.unref?.();

        try {
            // 1) Flush final das credenciais. O Baileys salva via creds.update, mas
            //    garantimos aqui que o último avanço de chave foi gravado no disco.
            const salvar = deps.obterSalvarCredenciais();
            if (salvar) {
                await salvar();
                console.log('💾 Credenciais salvas.');
            }

            // 2) Fecha o socket preservando a sessão. end(undefined) remove os listeners
            //    e fecha o WebSocket; não toca nas credenciais (ao contrário de logout()).
            const sock = deps.obterSocket();
            if (sock) {
                await sock.end(undefined);
                console.log('🔌 Socket encerrado.');
            }
        } catch (erro) {
            console.error('⚠️ Erro durante o desligamento gracioso:', erro);
        } finally {
            clearTimeout(timer);
            console.log('👋 Até a próxima!');
            sair(0);
        }
    };
}

/**
 * Registra (uma única vez) os handlers de SIGTERM/SIGINT que disparam o desligamento
 * gracioso. Idempotente no nível de processo: chamar de novo não duplica listeners.
 */
export function registrarDesligamentoGracioso(deps: DesligamentoDeps): void {
    const flag = '__desligamentoGraciosoRegistrado';
    const proc = process as NodeJS.Process & Record<string, unknown>;
    if (proc[flag]) return;
    proc[flag] = true;

    const desligar = criarDesligamento(deps);

    for (const sinal of SINAIS) {
        process.on(sinal, () => {
            void desligar(sinal);
        });
    }
}
