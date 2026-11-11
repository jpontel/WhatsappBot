import { isJidGroup } from '@whiskeysockets/baileys';
import type { WASocket, WAMessage } from '@whiskeysockets/baileys';
import type { ComandoExecutarDto } from '../dto/comandos.dto.js';
import { ENV } from '../config/env.js';
import { estaHabilitado } from '../repository/vacuo.repository.js';
import { buscarPorNumero } from '../repository/pessoa.repository.js';
import { resolverNumeroRemetente, ehAdminPorJid } from './identidade.js';
import { textoParaContexto, ultimaDoChat } from './contexto.js';

// Detector de silêncio ("anti-vácuo de grupo"). Para cada grupo HABILITADO, mantém
// um timer em memória: quando uma pessoa CADASTRADA fala e ninguém responde dentro
// da janela (ENV.VACUO_GRUPO_DELAY_MS), o bot responde sozinho — reusando o mesmo
// caminho do /p. Toda mensagem nova no grupo cancela o timer pendente (a última
// mensagem mudou); só sobrevive até o fim o timer de quem ficou falando por último
// e sem resposta. Estado é só em memória (janela de minutos; perder num restart é
// inofensivo — best-effort). Node é single-thread → Map síncrono, sem lock.

// Como disparar o /p (injetado pelo dispatcher: `comandos.get('/p')?.execute`).
type Acionar = (dto: ComandoExecutarDto) => Promise<unknown>;

interface ObservarOpts {
    // A mensagem já aciona o bot por outro caminho (comando, @menção, reply, bypass
    // de DM)? Se sim, não é vácuo — cancela e não reagenda.
    ehGatilho: boolean;
    // Como disparar a resposta quando o timer estourar.
    acionar: Acionar | undefined;
}

interface TimerVivo {
    timer: ReturnType<typeof setTimeout>;
    msgId: string;
}

const timers = new Map<string /* groupJid */, TimerVivo>();

function cancelar(jid: string): void {
    const t = timers.get(jid);
    if (!t) return;
    clearTimeout(t.timer);
    timers.delete(jid);
}

// Texto "cru" da mensagem para mandar como `conteudo` do /p (ou '' se for mídia
// sozinha — o agente responde com base na mídia + contexto, igual ao fluxo de
// @menção com foto).
function textoDaMensagem(msg: WAMessage): string {
    const t = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || msg.message?.videoMessage?.caption
        || '';
    return t.replace(/\s+/g, ' ').trim();
}

/**
 * Observa uma mensagem de grupo e (re)agenda — ou cancela — o disparo anti-vácuo.
 * Chamado pelo dispatcher para toda mensagem de grupo, ANTES do descarte dos
 * gatilhos (para também ver as mensagens que não acionam o bot).
 */
export async function observar(
    sock: WASocket,
    msg: WAMessage,
    jid: string,
    opts: ObservarOpts,
): Promise<void> {
    if (!ENV.VACUO_GRUPO_ATIVO) return;
    if (!isJidGroup(jid)) return;

    // Toda mensagem nova no grupo supera a anterior → cancela o timer pendente.
    cancelar(jid);

    // Não reagenda se a msg já aciona o bot por outro caminho, se é eco do próprio
    // bot, ou se o grupo não optou pelo anti-vácuo. O `estaHabilitado` (lookup por
    // PK, barato) entra ANTES do resolve do remetente (async "caro").
    if (opts.ehGatilho || msg.key.fromMe) return;
    if (!estaHabilitado(jid)) return;

    // Precisa ter conteúdo aproveitável — texto OU mídia (vira marcador no buffer).
    if (textoParaContexto(msg.message) == null) return;

    // Só agenda para remetente CADASTRADO (admin também conta). Aqui pagamos o
    // resolverNumeroRemetente async — mas só em grupo habilitado, no caminho frio.
    const numero = await resolverNumeroRemetente(sock, msg);
    const ehAdmin = ehAdminPorJid(numero);
    if (!ehAdmin && !(numero && buscarPorNumero(numero))) return;

    const msgId = msg.key.id ?? '';
    // Corrida: outra mensagem pode ter chegado durante o await acima. Só agenda se
    // esta ainda é a última do buffer do grupo.
    if (ultimaDoChat(jid)?.msgId !== msgId) return;

    const acionar = opts.acionar;
    if (!acionar) return; // sem /p disponível não há como responder

    const dto: ComandoExecutarDto = {
        sock,
        conteudo: textoDaMensagem(msg),
        usuarioJid: jid,
        msg,
        remetenteJid: msg.key.participant ?? undefined,
        ehAdmin,
    };

    const timer = setTimeout(() => {
        void dispararSeAindaNoVacuo(jid, msgId, dto, acionar);
    }, ENV.VACUO_GRUPO_DELAY_MS);

    timers.set(jid, { timer, msgId });
}

/**
 * Chamado quando o timer estoura. Faz a conferência final: a última mensagem do
 * grupo ainda é a que agendou? Se alguém falou depois, não é mais vácuo — aborta.
 */
async function dispararSeAindaNoVacuo(
    jid: string,
    msgId: string,
    dto: ComandoExecutarDto,
    acionar: Acionar,
): Promise<void> {
    timers.delete(jid);
    if (ultimaDoChat(jid)?.msgId !== msgId) return;
    try {
        await acionar(dto);
    } catch (e) {
        console.warn('Anti-vácuo de grupo: falha ao disparar resposta em', jid, e);
    }
}

// Exposto só para testes (inspecionar/limpar o estado em memória).
export function _tamanho(): number {
    return timers.size;
}
export function _limpar(): void {
    for (const jid of [...timers.keys()]) cancelar(jid);
}
