import axios from 'axios';
import type { ComandoExecutarDto } from '../dto/comandos.dto.js';
import { ENV } from '../config/env.js';
import { recuperarLogs } from '../core/log-buffer.js';

const MAX_CHARS = 3500; // teto da mensagem no WhatsApp (legibilidade + token)

type Resultado = {
    svc: string;
    total: number;
    logs?: string[];
    resumo?: Record<string, number>;
    erro?: string;
};

function bloco(titulo: string, r: Resultado, resumo: boolean): string {
    if (r.erro) return `*${titulo}*: ⚠️ ${r.erro}`;
    if (resumo) {
        const linhas = Object.entries(r.resumo ?? {}).map(([k, v]) => `  ${v}× ${k}`);
        return `*${titulo}* (${r.total}):\n${linhas.join('\n') || '  (nada)'}`;
    }
    const linhas = (r.logs ?? []);
    return `*${titulo}* (${r.total}):\n${linhas.join('\n') || '  (nada)'}`;
}

export default {
    name: '/logs',
    description: 'Últimos logs do bot + agente (só admin): /logs [erros|tudo|resumo]',

    execute: async (dto: ComandoExecutarDto) => {
        const { sock, usuarioJid, conteudo, msg, ehAdmin } = dto;
        const reagir = (t: string) => sock.sendMessage(usuarioJid, { react: { text: t, key: msg.key } });

        if (!ehAdmin) {
            await reagir('❌');
            return await sock.sendMessage(usuarioJid, { text: 'só o admin vê os logs 😤' });
        }

        const arg = conteudo.trim().toLowerCase();
        const resumo = arg === 'resumo';
        const nivel = (arg === 'tudo' || arg === 'info') ? 'INFO'
            : (arg === 'erros' || arg === 'erro') ? 'ERROR'
                : 'WARNING';
        const limite = 30;

        const bot = recuperarLogs({ nivel, limite, resumo }) as Resultado;

        let agente: Resultado;
        try {
            const resp = await axios.get(`${ENV.AGENT_URL}/logs`, {
                params: { nivel, limite, resumo },
                timeout: 10_000,
            });
            agente = resp.data as Resultado;
        } catch {
            agente = { svc: 'agente', total: 0, erro: 'agente inacessível' };
        }

        const cabecalho = `🗒️ *Logs* — nível ≥ ${nivel}${resumo ? ' (resumo)' : ''}`;
        let texto = [cabecalho, bloco('BOT', bot, resumo), bloco('AGENTE', agente, resumo)].join('\n\n');
        if (texto.length > MAX_CHARS) texto = texto.slice(0, MAX_CHARS) + '\n…(cortado)';

        return await sock.sendMessage(usuarioJid, { text: texto });
    },
};
