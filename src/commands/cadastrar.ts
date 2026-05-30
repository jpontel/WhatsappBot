import { areJidsSameUser } from '@whiskeysockets/baileys';
import type { ComandoExecutarDto } from '../dto/comandos.dto.js';
import { ENV } from '../config/env.js';
import { resolverNumero, resolverNumeroRemetente } from '../core/identidade.js';
import { registrarPessoa } from '../repository/pessoa.repository.js';

/** Normaliza o DONO_JID configurado (aceita número puro ou JID completo). */
function donoJidNormalizado(): string | undefined {
    const bruto = ENV.DONO_JID?.trim();
    if (!bruto) return undefined;
    return bruto.includes('@') ? bruto : `${bruto}@s.whatsapp.net`;
}

export default {
    name: '/cadastrar',
    description: 'Cadastra uma pessoa do grupo: /cadastrar <nome> @menção (só o dono)',

    execute: async (dto: ComandoExecutarDto) => {
        const { sock, msg, usuarioJid, conteudo, ehDono } = dto;

        const reagir = (text: string) => sock.sendMessage(usuarioJid, { react: { text, key: msg.key } });

        const numeroRemetente = await resolverNumeroRemetente(sock, msg);

        // Dono = mensagem própria (fromMe) OU remetente que bate com DONO_JID (modo conta separada).
        const dono = donoJidNormalizado();
        const ehDonoEfetivo = !!ehDono || (!!dono && areJidsSameUser(numeroRemetente ?? undefined, dono));

        if (!ehDonoEfetivo) {
            await reagir('❌');
            return await sock.sendMessage(usuarioJid, { text: 'Só o dono pode cadastrar gente 😤' });
        }

        const mencaoLid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];

        if (!mencaoLid) {
            await reagir('❌');
            return await sock.sendMessage(usuarioJid, {
                text: 'Mencione a pessoa pra cadastrar 🙏\nEx: /cadastrar Maria @fulano',
            });
        }

        // A menção aparece no texto como @<dígitos>; tiramos esses tokens pra sobrar só o nome.
        const nome = conteudo.replace(/@\d+/g, '').replace(/\s+/g, ' ').trim();

        if (!nome) {
            await reagir('❌');
            return await sock.sendMessage(usuarioJid, {
                text: 'Faltou o nome 🤨\nEx: /cadastrar Maria @fulano',
            });
        }

        const numero = await resolverNumero(sock, mencaoLid);

        if (!numero) {
            await reagir('❌');
            return await sock.sendMessage(usuarioJid, {
                text: 'Não consegui descobrir o número dessa pessoa 😕\nPede pra ela mandar uma mensagem no grupo e tenta de novo.',
            });
        }

        registrarPessoa({
            numero,
            lid: mencaoLid,
            nome,
            cadastradoPor: numeroRemetente,
        });

        await reagir('✅');
        return await sock.sendMessage(usuarioJid, { text: `Cadastrei *${nome}* 👍` });
    },
};
