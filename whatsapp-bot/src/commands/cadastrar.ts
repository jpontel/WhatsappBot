import type { ComandoExecutarDto } from '../dto/comandos.dto.js';
import { resolverNumero, resolverNumeroRemetente } from '../core/identidade.js';
import { registrarPessoa } from '../repository/pessoa.repository.js';

export default {
    name: '/cadastrar',
    description: 'Cadastra uma pessoa do grupo: /cadastrar <nome> @menção (só o admin)',

    execute: async (dto: ComandoExecutarDto) => {
        const { sock, msg, usuarioJid, conteudo, ehAdmin } = dto;

        const reagir = (text: string) => sock.sendMessage(usuarioJid, { react: { text, key: msg.key } });

        const numeroRemetente = await resolverNumeroRemetente(sock, msg);

        // Admin é identificado por JID (ADMIN_JID) no dispatcher; aqui só checamos o flag.
        if (!ehAdmin) {
            await reagir('❌');
            return await sock.sendMessage(usuarioJid, { text: 'Só o admin pode cadastrar gente 😤' });
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
