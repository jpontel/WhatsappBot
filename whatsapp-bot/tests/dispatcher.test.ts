import { describe, it, expect, vi } from 'vitest';
import { enviarMensagem, type Comando } from '../src/core/dispatcher.js';

// O bypass em DM consulta pessoa.repository (buscarPorNumero) para saber se o
// remetente é cadastrado — mockado aqui para controlar isso sem tocar no SQLite.
vi.mock('../src/repository/pessoa.repository.js', () => ({
    buscarPorNumero: vi.fn(),
}));
import { buscarPorNumero } from '../src/repository/pessoa.repository.js';

// Anti-vácuo de grupo: isolado aqui (não queremos tocar o SQLite nem agendar
// timers nestes testes de dispatch). Grupo sempre "não habilitado".
vi.mock('../src/repository/vacuo.repository.js', () => ({
    estaHabilitado: () => false,
    habilitar: vi.fn(),
    desabilitar: vi.fn(),
    listar: () => [],
}));

function mockSock() {
    return { sendMessage: vi.fn() } as any;
}

function carregadorCom(comandos: Comando[]) {
    const map = new Map<string, Comando>();
    for (const c of comandos) map.set(c.name, c);
    return async () => map;
}

function msgComTexto(remoteJid: string, text: string) {
    return {
        key: { id: 'm1', remoteJid, fromMe: false },
        message: { conversation: text },
    } as any;
}

// Sock com identidade do bot (número 41), p/ exercitar o gatilho por menção.
function mockSockBot() {
    return { sendMessage: vi.fn(), user: { id: '550000000001@s.whatsapp.net' } } as any;
}

function msgComMencao(remoteJid: string, text: string, mentionedJid: string[], fromMe = false) {
    return {
        key: { id: 'm1', remoteJid, fromMe },
        message: { extendedTextMessage: { text, contextInfo: { mentionedJid } } },
    } as any;
}

// Foto com legenda: a menção fica em imageMessage.contextInfo (não em extendedTextMessage).
function msgFotoComMencao(remoteJid: string, caption: string, mentionedJid: string[], fromMe = false) {
    return {
        key: { id: 'm1', remoteJid, fromMe },
        message: { imageMessage: { caption, contextInfo: { mentionedJid } } },
    } as any;
}

// Reply (quote) a uma mensagem: contextInfo.participant = autor da msg citada;
// quotedMessage presente marca que é um reply de verdade.
function msgReplyA(remoteJid: string, text: string, autorCitado: string, fromMe = false) {
    return {
        key: { id: 'm1', remoteJid, participant: '5511888888888@s.whatsapp.net', fromMe },
        message: {
            extendedTextMessage: {
                text,
                contextInfo: { participant: autorCitado, stanzaId: 'BOT1', quotedMessage: { conversation: 'msg do bot' } },
            },
        },
    } as any;
}

describe('enviarMensagem (dispatcher)', () => {
    it('ignora messageDto.type diferente de "notify"', async () => {
        const execute = vi.fn();
        const carregador = carregadorCom([{ name: '/oi', execute }]);

        await enviarMensagem(
            mockSock(),
            { messages: [msgComTexto('5511@s.whatsapp.net', '/oi')], type: 'append' },
            carregador,
        );

        expect(execute).not.toHaveBeenCalled();
    });

    it('processa mensagens do número do admin (não há mais JID ignorado)', async () => {
        const execute = vi.fn();
        const carregador = carregadorCom([{ name: '/oi', execute }]);

        await enviarMensagem(
            mockSock(),
            { messages: [msgComTexto('550000000002@s.whatsapp.net', '/oi')], type: 'notify' },
            carregador,
        );

        expect(execute).toHaveBeenCalledOnce();
    });

    it('ignora JIDs de newsletter', async () => {
        const execute = vi.fn();
        const carregador = carregadorCom([{ name: '/oi', execute }]);

        await enviarMensagem(
            mockSock(),
            { messages: [msgComTexto('120363xxx@newsletter', '/oi')], type: 'notify' },
            carregador,
        );

        expect(execute).not.toHaveBeenCalled();
    });

    it('extrai texto de extendedTextMessage', async () => {
        const execute = vi.fn();
        const carregador = carregadorCom([{ name: '/oi', execute }]);

        const msg = {
            key: { id: 'x', remoteJid: '5511@s.whatsapp.net', fromMe: false },
            message: { extendedTextMessage: { text: '/oi mundo' } },
        } as any;

        await enviarMensagem(
            mockSock(),
            { messages: [msg], type: 'notify' },
            carregador,
        );

        expect(execute).toHaveBeenCalledOnce();
        expect(execute.mock.calls[0][0].conteudo).toBe('mundo');
    });

    it('extrai texto de caption de imagem', async () => {
        const execute = vi.fn();
        const carregador = carregadorCom([{ name: '/oi', execute }]);

        const msg = {
            key: { id: 'x', remoteJid: '5511@s.whatsapp.net', fromMe: false },
            message: { imageMessage: { caption: '/oi com foto' } },
        } as any;

        await enviarMensagem(
            mockSock(),
            { messages: [msg], type: 'notify' },
            carregador,
        );

        expect(execute).toHaveBeenCalledOnce();
        expect(execute.mock.calls[0][0].conteudo).toBe('com foto');
    });

    it('chama execute do comando certo com ComandoExecutarDto correto', async () => {
        const execute = vi.fn();
        const carregador = carregadorCom([
            { name: '/oi', execute },
            { name: '/tchau', execute: vi.fn() },
        ]);
        const sock = mockSock();

        const msg = msgComTexto('5511@s.whatsapp.net', '/oi pessoal');

        await enviarMensagem(
            sock,
            { messages: [msg], type: 'notify' },
            carregador,
        );

        expect(execute).toHaveBeenCalledOnce();
        const dto = execute.mock.calls[0][0];
        expect(dto.sock).toBe(sock);
        expect(dto.conteudo).toBe('pessoal');
        expect(dto.usuarioJid).toBe('5511@s.whatsapp.net');
        expect(dto.msg).toBe(msg);
    });

    it('ignora token que não bate com nenhum comando', async () => {
        const execute = vi.fn();
        const carregador = carregadorCom([{ name: '/oi', execute }]);

        await enviarMensagem(
            mockSock(),
            { messages: [msgComTexto('5511@s.whatsapp.net', 'oi sem barra')], type: 'notify' },
            carregador,
        );

        expect(execute).not.toHaveBeenCalled();
    });

    it('normaliza token do comando para lowercase', async () => {
        const execute = vi.fn();
        const carregador = carregadorCom([{ name: '/oi', execute }]);

        await enviarMensagem(
            mockSock(),
            { messages: [msgComTexto('5511@s.whatsapp.net', '/OI mundo')], type: 'notify' },
            carregador,
        );

        expect(execute).toHaveBeenCalledOnce();
    });

    it('menção ao bot aciona o /p com o texto sem a menção', async () => {
        const execute = vi.fn();
        const carregador = carregadorCom([{ name: '/p', execute }]);

        await enviarMensagem(
            mockSockBot(),
            { messages: [msgComMencao('123@g.us', '@550000000001 qual a capital', ['550000000001@s.whatsapp.net'])], type: 'notify' },
            carregador,
        );

        expect(execute).toHaveBeenCalledOnce();
        expect(execute.mock.calls[0][0].conteudo).toBe('qual a capital');
    });

    it('reply a uma mensagem do PRÓPRIO bot aciona o /p sem @menção', async () => {
        const execute = vi.fn();
        const carregador = carregadorCom([{ name: '/p', execute }]);

        await enviarMensagem(
            mockSockBot(),
            { messages: [msgReplyA('123@g.us', 'e aí', '550000000001@s.whatsapp.net')], type: 'notify' },
            carregador,
        );

        expect(execute).toHaveBeenCalledOnce();
        expect(execute.mock.calls[0][0].conteudo).toBe('e aí');
    });

    it('reply a OUTRA pessoa (não o bot) NÃO aciona o /p', async () => {
        const execute = vi.fn();
        const carregador = carregadorCom([{ name: '/p', execute }]);

        await enviarMensagem(
            mockSockBot(),
            { messages: [msgReplyA('123@g.us', 'e aí', '5599999999999@s.whatsapp.net')], type: 'notify' },
            carregador,
        );

        expect(execute).not.toHaveBeenCalled();
    });

    it('/p explícito + menção não dispara duas vezes', async () => {
        const execute = vi.fn();
        const carregador = carregadorCom([{ name: '/p', execute }]);

        await enviarMensagem(
            mockSockBot(),
            { messages: [msgComMencao('123@g.us', '/p oi', ['550000000001@s.whatsapp.net'])], type: 'notify' },
            carregador,
        );

        expect(execute).toHaveBeenCalledOnce();
        expect(execute.mock.calls[0][0].conteudo).toBe('oi');
    });

    it('menção em mensagem fromMe (eco do bot) não dispara', async () => {
        const execute = vi.fn();
        const carregador = carregadorCom([{ name: '/p', execute }]);

        await enviarMensagem(
            mockSockBot(),
            { messages: [msgComMencao('123@g.us', '@550000000001 oi', ['550000000001@s.whatsapp.net'], true)], type: 'notify' },
            carregador,
        );

        expect(execute).not.toHaveBeenCalled();
    });

    it('menção SEM texto aciona o /p (responde pelo contexto)', async () => {
        // Comportamento atual (commit 6c2d45a): ser mencionada, mesmo sem texto,
        // já aciona o /p — o agente responde com base no [contexto-recente].
        const execute = vi.fn();
        const carregador = carregadorCom([{ name: '/p', execute }]);
        const sock = mockSockBot();

        await enviarMensagem(
            sock,
            { messages: [msgComMencao('123@g.us', '@550000000001', ['550000000001@s.whatsapp.net'])], type: 'notify' },
            carregador,
        );

        expect(execute).toHaveBeenCalledOnce();
        expect(execute.mock.calls[0][0].conteudo).toBe('');
    });

    it('menção na legenda de uma FOTO aciona o /p', async () => {
        const execute = vi.fn();
        const carregador = carregadorCom([{ name: '/p', execute }]);

        await enviarMensagem(
            mockSockBot(),
            { messages: [msgFotoComMencao('123@g.us', '@550000000001 quem é essa pessoa', ['550000000001@s.whatsapp.net'])], type: 'notify' },
            carregador,
        );

        expect(execute).toHaveBeenCalledOnce();
        expect(execute.mock.calls[0][0].conteudo).toBe('quem é essa pessoa');
    });

    it('DM de pessoa CADASTRADA aciona o /p sem /p nem @menção (bypass)', async () => {
        (buscarPorNumero as any).mockReturnValue({ id: 1, numero: '5511999998888@s.whatsapp.net', nome: 'Fulano' });
        const execute = vi.fn();
        const carregador = carregadorCom([{ name: '/p', execute }]);

        await enviarMensagem(
            mockSock(),
            { messages: [msgComTexto('5511999998888@s.whatsapp.net', 'oi luladroid tudo bem')], type: 'notify' },
            carregador,
        );

        expect(execute).toHaveBeenCalledOnce();
        expect(execute.mock.calls[0][0].conteudo).toBe('oi luladroid tudo bem');
    });

    it('DM de pessoa NÃO cadastrada não aciona o /p', async () => {
        (buscarPorNumero as any).mockReturnValue(null);
        const execute = vi.fn();
        const carregador = carregadorCom([{ name: '/p', execute }]);

        await enviarMensagem(
            mockSock(),
            { messages: [msgComTexto('5511777776666@s.whatsapp.net', 'oi luladroid')], type: 'notify' },
            carregador,
        );

        expect(execute).not.toHaveBeenCalled();
    });

    it('em GRUPO o bypass não vale, mesmo para cadastrado (exige /p ou @menção)', async () => {
        (buscarPorNumero as any).mockReturnValue({ id: 1, numero: '5511999998888@s.whatsapp.net', nome: 'Fulano' });
        const execute = vi.fn();
        const carregador = carregadorCom([{ name: '/p', execute }]);

        await enviarMensagem(
            mockSock(),
            { messages: [msgComTexto('123@g.us', 'oi pessoal')], type: 'notify' },
            carregador,
        );

        expect(execute).not.toHaveBeenCalled();
    });
});
