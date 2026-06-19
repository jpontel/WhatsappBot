import type { WASocket } from '@whiskeysockets/baileys';

// Gerencia o estado "digitando…" (três pontinhos) por chat.
//
// O WhatsApp expira o estado `composing` sozinho em ~10s, então re-enviamos
// periodicamente enquanto houver algo sendo processado. Usa contagem de
// referências por JID: vários /p em rajada (ou de remetentes diferentes no
// mesmo grupo) mantêm um único estado de digitando até o último terminar.

// Intervalo de refresh: precisa ser menor que o timeout de ~10s do WhatsApp.
const REFRESH_MS = 5_000;

type EstadoDigitando = { contador: number; timer: ReturnType<typeof setInterval> };

// Map no nível do módulo: persiste entre mensagens (o carregarComandos reusa o
// cache do import dinâmico, igual ao buffer de lotes do /p).
const estados = new Map<string, EstadoDigitando>();

// Envia o presence sem nunca derrubar o fluxo do comando se a conexão falhar.
async function enviarPresenca(sock: WASocket, jid: string, presenca: 'available' | 'composing' | 'paused'): Promise<void> {
    try {
        await sock.sendPresenceUpdate(presenca, jid);
    } catch (error) {
        console.error(`Erro ao enviar presença '${presenca}' para ${jid}:`, error);
    }
}

// Marca o chat como "digitando". O `composing` só é entregue/exibido se o socket
// estiver inscrito na presença do chat (presenceSubscribe) e marcado como online
// (available) — o markOnlineOnConnect só vale uma vez no boot e o WhatsApp volta
// a nos tratar como offline, descartando os chat-states. Por isso, ao iniciar,
// fazemos subscribe + available antes do composing.
async function abrirDigitando(sock: WASocket, jid: string): Promise<void> {
    try {
        await sock.presenceSubscribe(jid);
    } catch (error) {
        console.error(`Erro ao inscrever na presença de ${jid}:`, error);
    }
    await enviarPresenca(sock, jid, 'available');
    await enviarPresenca(sock, jid, 'composing');
}

// Incrementa o contador; no primeiro, abre o digitando e arma o refresh periódico
// (o composing expira sozinho em ~10s, então re-enviamos a cada REFRESH_MS).
export function iniciarDigitando(sock: WASocket, jid: string): void {
    const existente = estados.get(jid);
    if (existente) {
        existente.contador += 1;
        return;
    }

    void abrirDigitando(sock, jid);
    const timer = setInterval(() => { void enviarPresenca(sock, jid, 'composing'); }, REFRESH_MS);
    estados.set(jid, { contador: 1, timer });
}

// Para de "digitar". Decrementa; ao zerar, limpa o refresh e envia 'paused'.
export function pararDigitando(sock: WASocket, jid: string): void {
    const estado = estados.get(jid);
    if (!estado) return;

    estado.contador -= 1;
    if (estado.contador > 0) return;

    clearInterval(estado.timer);
    estados.delete(jid);
    void enviarPresenca(sock, jid, 'paused');
}
