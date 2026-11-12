import { isJidGroup } from '@whiskeysockets/baileys';
import type { WASocket, WAMessage } from '@whiskeysockets/baileys';
import type { ComandoExecutarDto } from '../dto/comandos.dto.js';
import { ENV } from '../config/env.js';
import {
    estaHabilitado,
    salvarPendente,
    removerPendente,
    listarPendentes,
} from '../repository/vacuo.repository.js';
import { buscarPorNumero } from '../repository/pessoa.repository.js';
import { resolverNumeroRemetente, ehAdminPorJid } from './identidade.js';
import { textoParaContexto, ultimaDoChat } from './contexto.js';
import { whatsappService } from '../services/whatsapp.service.js';
import carregarComandos from './comandos.js';

// Detector de silêncio ("anti-vácuo de grupo"). Para cada grupo HABILITADO, mantém
// um timer: quando uma pessoa CADASTRADA fala e ninguém responde dentro da janela
// (ENV.VACUO_GRUPO_DELAY_MS), o bot responde sozinho reusando o /p. Toda mensagem
// nova no grupo cancela o timer pendente (a última mensagem mudou). O disparo
// resolve o socket vivo na hora (whatsappService), igual ao scheduler.
//
// PERSISTÊNCIA: o timer vive em memória, mas é espelhado no SQLite (vacuo_pendente)
// e re-armado no boot (inicializar), para sobreviver a restart/redeploy. 1 pendência
// por grupo. Node é single-thread → Map síncrono, sem lock.

// dto SEM o socket — o socket vivo é injetado no disparo (robusto a reconexões).
type DtoSemSock = Omit<ComandoExecutarDto, 'sock'>;

interface TimerVivo {
    timer: ReturnType<typeof setTimeout>;
    msgId: string;
}

const timers = new Map<string /* groupJid */, TimerVivo>();

function autorDe(msg: WAMessage): string {
    return msg.pushName || msg.key.participant?.split('@')[0] || 'alguém';
}

// Texto "cru" da mensagem p/ mandar como `conteudo` do /p (ou '' se for mídia
// sozinha — o agente responde com base na mídia + contexto, igual ao @menção).
function textoDaMensagem(msg: WAMessage): string {
    const t = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || msg.message?.videoMessage?.caption
        || '';
    return t.replace(/\s+/g, ' ').trim();
}

// Risada "pura" (a mensagem inteira é só riso): kkkk, rsrs, hahaha, hehe, huehue,
// ksksks. Ancorada em ^$ para não pegar palavra real curta ("era", "rua", "oi").
const RISADA_PURA = /^(?:k{2,}|(?:ha)+|(?:he)+|(?:hi)+|(?:rs)+|(?:hue)+|(?:ks)+k?)$/i;

// Mensagens que são claramente "ruído" e não convidam resposta: risada pura,
// só emoji(s)/pontuação ou figurinha sozinha. Barrar aqui evita o anti-vácuo
// responder a um "KKKKK" ou a uma reação visual — não há vácuo real a quebrar,
// só encheria o saco. Conservador de propósito: qualquer frase real passa.
function naoPedeResposta(msg: WAMessage): boolean {
    if (msg.message?.stickerMessage) return true; // reação visual, não pede resposta

    const texto = textoDaMensagem(msg);
    if (!texto) return false; // imagem/áudio/vídeo sem legenda seguem o fluxo normal

    if (RISADA_PURA.test(texto.replace(/\s+/g, ''))) return true;

    // Sem nenhuma letra nem dígito → só emoji/pontuação/símbolo.
    if (!/[\p{L}\p{N}]/u.test(texto)) return true;

    return false;
}

function cancelar(jid: string, logar: boolean): void {
    const t = timers.get(jid);
    if (!t) return;
    clearTimeout(t.timer);
    timers.delete(jid);
    removerPendente(jid);
    if (logar) console.log(`[anti-vácuo] timer do grupo ${jid} cancelado (chegou mensagem nova)`);
}

// Arma o timer em memória. A persistência (salvarPendente) é feita por quem chama
// (só no agendamento vivo, não no re-arme do boot, que já tem a linha no banco).
function armar(jid: string, msgId: string, dto: DtoSemSock, delayMs: number, restored: boolean): void {
    const timer = setTimeout(() => void disparar(jid, msgId, dto, restored), delayMs);
    timers.set(jid, { timer, msgId });
}

async function disparar(jid: string, msgId: string, dto: DtoSemSock, restored: boolean): Promise<void> {
    timers.delete(jid);
    removerPendente(jid);

    // Guard de corrida: para timers VIVOS, confere se ninguém falou depois (buffer).
    // Para RESTAURADOS pós-restart o buffer está vazio → não dá p/ conferir; dispara
    // best-effort (a janela de graça já foi filtrada no boot).
    if (!restored && ultimaDoChat(jid)?.msgId !== msgId) {
        console.log(`[anti-vácuo] abortado no grupo ${jid} (última msg mudou — ninguém no vácuo)`);
        return;
    }

    console.log(
        `[anti-vácuo] DISPAROU no grupo ${jid} (autor ${autorDe(dto.msg)})${restored ? ' [retomado pós-restart]' : ''}`,
    );
    try {
        const cmdP = (await carregarComandos()).get('/p');
        if (!cmdP) {
            console.warn('[anti-vácuo] /p indisponível — não deu p/ responder');
            return;
        }
        const sock = whatsappService.recuperarInstancia();
        await cmdP.execute({ ...dto, sock });
    } catch (e) {
        console.warn(`[anti-vácuo] falha ao disparar no grupo ${jid}:`, e);
    }
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
    opts: { ehGatilho: boolean },
): Promise<void> {
    if (!ENV.VACUO_GRUPO_ATIVO) return;
    if (!isJidGroup(jid)) return;

    // Toda mensagem nova supera a anterior → cancela o timer pendente.
    cancelar(jid, true);

    // Não reagenda se a msg já aciona o bot, se é eco do próprio bot, ou se o grupo
    // não optou. `estaHabilitado` (lookup por PK, barato) entra ANTES do resolve.
    if (opts.ehGatilho || msg.key.fromMe) return;
    if (!estaHabilitado(jid)) return;
    if (textoParaContexto(msg.message) == null) return;
    if (naoPedeResposta(msg)) {
        console.log(`[anti-vácuo] ignorado no grupo ${jid} (ruído: risada/emoji/figurinha — não arma timer)`);
        return;
    }

    // Só agenda p/ remetente CADASTRADO (admin conta). Só aqui pagamos o resolve.
    const numero = await resolverNumeroRemetente(sock, msg);
    const ehAdmin = ehAdminPorJid(numero);
    if (!ehAdmin && !(numero && buscarPorNumero(numero))) return;

    const msgId = msg.key.id ?? '';
    // Corrida: outra msg pode ter chegado durante o await. Só agenda se esta ainda
    // é a última do buffer do grupo.
    if (ultimaDoChat(jid)?.msgId !== msgId) return;

    const dto: DtoSemSock = {
        conteudo: textoDaMensagem(msg),
        usuarioJid: jid,
        msg,
        remetenteJid: msg.key.participant ?? undefined,
        ehAdmin,
    };
    armar(jid, msgId, dto, ENV.VACUO_GRUPO_DELAY_MS, false);
    const fireAt = new Date(Date.now() + ENV.VACUO_GRUPO_DELAY_MS).toISOString();
    salvarPendente(jid, msgId, fireAt, JSON.stringify(dto));
    console.log(
        `[anti-vácuo] agendado no grupo ${jid} p/ ${autorDe(msg)} — dispara em ${Math.round(ENV.VACUO_GRUPO_DELAY_MS / 1000)}s se ninguém falar`,
    );
}

/**
 * Re-arma no boot os timers que estavam pendentes antes do restart (lidos do
 * SQLite). Calcula o tempo restante; descarta os vencidos há mais de uma janela
 * (velhos demais). Chamar quando o socket já estiver 'open'.
 */
export function inicializar(): void {
    let pendentes;
    try {
        pendentes = listarPendentes();
    } catch (e) {
        console.warn('[anti-vácuo] falha ao ler pendências no boot:', e);
        return;
    }
    const agora = Date.now();
    for (const p of pendentes) {
        let dto: DtoSemSock;
        try {
            dto = JSON.parse(p.payload) as DtoSemSock;
        } catch {
            removerPendente(p.grupo_jid);
            continue;
        }
        const fireAtMs = Date.parse(p.fire_at);
        if (Number.isNaN(fireAtMs) || fireAtMs - agora < -ENV.VACUO_GRUPO_DELAY_MS) {
            // Inválido ou vencido há mais de uma janela → velho demais, descarta.
            removerPendente(p.grupo_jid);
            console.log(`[anti-vácuo] pendência estale descartada (grupo ${p.grupo_jid})`);
            continue;
        }
        // Se já venceu mas dentro da graça, dispara logo — com ~10s p/ o socket subir.
        const delay = Math.max(fireAtMs - agora, 10_000);
        armar(p.grupo_jid, p.msg_id, dto, delay, true);
        console.log(`[anti-vácuo] pendência re-armada (grupo ${p.grupo_jid}) — dispara em ${Math.round(delay / 1000)}s`);
    }
}

// Exposto só para testes (inspecionar/limpar o estado em memória).
export function _tamanho(): number {
    return timers.size;
}
export function _limpar(): void {
    for (const jid of [...timers.keys()]) cancelar(jid, false);
}
