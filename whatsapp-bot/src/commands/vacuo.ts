import { isJidGroup } from '@whiskeysockets/baileys';
import type { ComandoExecutarDto } from '../dto/comandos.dto.js';
import { habilitar, desabilitar, estaHabilitado } from '../repository/vacuo.repository.js';

// Opt-in do anti-vácuo de grupo, por grupo. Só funciona dentro de um grupo;
// ligar/desligar é restrito ao admin. Sem argumento, mostra o status (qualquer um).
export default {
    name: '/vacuo',
    description: 'Liga/desliga o anti-vácuo neste grupo: /vacuo on|off (só o admin)',

    execute: async (dto: ComandoExecutarDto) => {
        const { sock, msg, usuarioJid, conteudo, ehAdmin } = dto;
        const reagir = (text: string) => sock.sendMessage(usuarioJid, { react: { text, key: msg.key } });

        if (!isJidGroup(usuarioJid)) {
            await reagir('❌');
            return await sock.sendMessage(usuarioJid, {
                text: 'o anti-vácuo é coisa de grupo 😌 usa isso dentro de um grupo.',
            });
        }

        const opcao = conteudo.trim().toLowerCase();

        // Sem argumento: só mostra o status atual (liberado p/ qualquer um).
        if (!opcao) {
            return await sock.sendMessage(usuarioJid, {
                text: estaHabilitado(usuarioJid)
                    ? 'anti-vácuo tá *ligado* aqui 💅 (/vacuo off pra desligar)'
                    : 'anti-vácuo tá *desligado* aqui 😴 (/vacuo on pra ligar)',
            });
        }

        if (!ehAdmin) {
            await reagir('❌');
            return await sock.sendMessage(usuarioJid, { text: 'só o admin liga/desliga o anti-vácuo 😤' });
        }

        if (opcao === 'on' || opcao === 'ligar' || opcao === 'ativar') {
            habilitar(usuarioJid);
            await reagir('✅');
            return await sock.sendMessage(usuarioJid, {
                text: 'prontinho, anti-vácuo *ligado* nesse grupo 💅 ninguém fica mais no vácuo 😎',
            });
        }

        if (opcao === 'off' || opcao === 'desligar' || opcao === 'desativar') {
            desabilitar(usuarioJid);
            await reagir('✅');
            return await sock.sendMessage(usuarioJid, { text: 'beleza, anti-vácuo *desligado* nesse grupo 😴' });
        }

        await reagir('❌');
        return await sock.sendMessage(usuarioJid, { text: 'não entendi 🤨 usa /vacuo on ou /vacuo off' });
    },
};
