import cron from 'node-cron';
import { whatsappService } from './whatsapp.service.js';
import { agendamentoRepository, type Agendamento } from '../repository/agendamento.repository.js';

// Lembretes 'once' atrasados (ex.: bot ficou fora do ar) só disparam se o atraso
// for menor que esta janela; acima disso são marcados como erro (evita spam de
// lembretes velhos ao reiniciar).
const GRACE_MS = 6 * 60 * 60 * 1000;

// Teto para o envio: se o sock.sendMessage não resolver nesse tempo (ex.: JID
// inexistente, em que o Baileys fica esperando ack), abortamos. Sem isso um
// envio pendurado deixaria um 'once' preso em 'pendente' para sempre.
const ENVIO_TIMEOUT_MS = 30 * 1000;

// Lembretes URGENTES: depois de disparar, reenviam a cada NAG_INTERVALO_MS até o
// solicitante responder no chat. Para não virar spam infinito, desistem após
// NAG_MAX reenvios (≈30min com intervalo de 3min) e marcam 'nao_confirmado'.
// O intervalo é configurável por env (NAG_INTERVALO_MS) — útil para testes.
const NAG_INTERVALO_MS = Number(process.env.NAG_INTERVALO_MS) || 3 * 60 * 1000;
const NAG_MAX = 10;

function comTimeout<T>(promessa: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
        promessa,
        new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout de envio (${ms}ms)`)), ms)),
    ]);
}

interface TarefaViva {
    parar: () => void;
}

class SchedulerService {
    private tarefas = new Map<number, TarefaViva>();
    // Ids das mensagens de lembrete que NÓS enviamos. Os reenvios do bot voltam
    // como upsert no chat; a dedupe é por ID (não por `fromMe`), evitando que o
    // próprio lembrete seja confundido com a "resposta" que encerra a cobrança.
    private idsLembrete = new Set<string>();

    /** True se a mensagem (id) foi um lembrete/reenvio disparado por nós. */
    foiLembrete(msgId: string | null | undefined): boolean {
        return !!msgId && this.idsLembrete.has(msgId);
    }

    /** Carrega os agendamentos ativos do banco e registra cada um. Chamado no boot. */
    inicializar(): void {
        const ativos = agendamentoRepository.listarAtivos();
        for (const ag of ativos) {
            this.registrar(ag);
        }
        console.log(`⏰ Scheduler iniciado: ${ativos.length} agendamento(s) ativo(s).`);
    }

    /** Registra a tarefa em memória conforme o tipo/estado. DB é a fonte de verdade. */
    registrar(ag: Agendamento): void {
        // Urgente que já disparou e está aguardando resposta (ex.: retomada no boot):
        // não reenvia agora, só religa o ciclo de cobrança (nag).
        if (ag.status === 'aguardando_confirmacao') {
            this.retomarNag(ag);
            return;
        }
        if (ag.tipo === 'recorrente') {
            this.registrarRecorrente(ag);
        } else {
            this.registrarUnico(ag);
        }
    }

    private registrarRecorrente(ag: Agendamento): void {
        if (!ag.cron_expression || !cron.validate(ag.cron_expression)) {
            console.error(`⏰ Cron inválido no agendamento ${ag.id}: "${ag.cron_expression}"`);
            agendamentoRepository.marcarErro(ag.id);
            return;
        }
        const task = cron.schedule(
            ag.cron_expression,
            () => { void this.disparar(ag, false); },
            { timezone: ag.timezone },
        );
        this.tarefas.set(ag.id, { parar: () => task.stop() });
    }

    private registrarUnico(ag: Agendamento): void {
        if (!ag.run_at) {
            console.error(`⏰ Agendamento 'once' ${ag.id} sem run_at.`);
            agendamentoRepository.marcarErro(ag.id);
            return;
        }
        const alvo = Date.parse(ag.run_at);
        if (Number.isNaN(alvo)) {
            console.error(`⏰ run_at inválido no agendamento ${ag.id}: "${ag.run_at}"`);
            agendamentoRepository.marcarErro(ag.id);
            return;
        }
        const delay = alvo - Date.now();
        if (delay <= 0) {
            // Já passou: dispara se dentro da janela de tolerância; senão marca como perdido.
            if (delay > -GRACE_MS) {
                void this.disparar(ag, true);
            } else {
                console.warn(`⏰ Agendamento ${ag.id} perdido (atraso > grace); marcando erro.`);
                agendamentoRepository.marcarErro(ag.id);
            }
            return;
        }
        const timer = setTimeout(() => { void this.disparar(ag, true); }, delay);
        this.tarefas.set(ag.id, { parar: () => clearTimeout(timer) });
    }

    /** Apenas envia a mensagem para o chat de ORIGEM (chat_id). */
    private async enviar(ag: Agendamento): Promise<void> {
        const sock = whatsappService.recuperarInstancia();
        const enviado = await comTimeout(
            sock.sendMessage(ag.chat_id, { text: ag.mensagem }),
            ENVIO_TIMEOUT_MS,
        );
        const mid = enviado?.key?.id;
        if (mid) {
            this.idsLembrete.add(mid);
            // Mantém o set pequeno (só precisa lembrar dos envios recentes).
            if (this.idsLembrete.size > 200) {
                this.idsLembrete.delete(this.idsLembrete.values().next().value as string);
            }
        }
    }

    /** Dispara o lembrete no horário. Urgente 'once' entra no ciclo de cobrança. */
    private async disparar(ag: Agendamento, ehUnico: boolean): Promise<void> {
        try {
            await this.enviar(ag);
        } catch (error) {
            console.error(`⏰ Falha ao disparar agendamento ${ag.id}:`, (error as Error).message);
            if (ehUnico) {
                agendamentoRepository.marcarErro(ag.id);
                this.removerTarefa(ag.id);
            }
            return;
        }
        if (ehUnico && ag.urgente) {
            this.iniciarNag(ag);
        } else if (ehUnico) {
            agendamentoRepository.marcarEnviado(ag.id);
            this.removerTarefa(ag.id);
        }
        // recorrente: segue ativo, nada a fazer.
    }

    /** Entra no estado de cobrança: marca aguardando e agenda os reenvios a cada 3min. */
    private iniciarNag(ag: Agendamento): void {
        agendamentoRepository.marcarAguardandoConfirmacao(ag.id);
        this.agendarNag(ag.id);
    }

    /** Retoma a cobrança de um urgente que já estava aguardando (ex.: boot). */
    private retomarNag(ag: Agendamento): void {
        if (ag.nag_count >= NAG_MAX) {
            agendamentoRepository.marcarNaoConfirmado(ag.id);
            return;
        }
        this.agendarNag(ag.id);
    }

    private agendarNag(id: number): void {
        const timer = setInterval(() => { void this.nagTick(id); }, NAG_INTERVALO_MS);
        this.tarefas.set(id, { parar: () => clearInterval(timer) });
    }

    /** Um ciclo de cobrança: reenvia o aviso; desiste ao atingir o teto. */
    private async nagTick(id: number): Promise<void> {
        const ag = agendamentoRepository.buscarPorId(id);
        if (!ag || ag.status !== 'aguardando_confirmacao') {
            this.removerTarefa(id);
            return;
        }
        try {
            await this.enviar(ag);
        } catch (error) {
            console.error(`⏰ Falha no reenvio (nag) do agendamento ${id}:`, (error as Error).message);
        }
        const count = agendamentoRepository.incrementarNag(id);
        if (count >= NAG_MAX) {
            agendamentoRepository.marcarNaoConfirmado(id);
            this.removerTarefa(id);
        }
    }

    /** Solicitante respondeu: encerra a cobrança do urgente. Retorna true se havia algo. */
    confirmar(id: number): boolean {
        const ag = agendamentoRepository.buscarPorId(id);
        if (!ag || ag.status !== 'aguardando_confirmacao') return false;
        this.removerTarefa(id);
        agendamentoRepository.marcarConfirmado(id);
        return true;
    }

    /** Cancela uma tarefa (para o timer/cron/nag) e marca como cancelada no banco. */
    cancelar(id: number): void {
        this.removerTarefa(id);
        agendamentoRepository.cancelar(id);
    }

    /**
     * Troca os dados de um agendamento em memória: para o timer/cron antigo e
     * registra de novo com o estado atualizado (o banco já foi atualizado por
     * quem chamou). Use após editar mensagem/horário de um agendamento pendente.
     */
    reagendar(ag: Agendamento): void {
        this.removerTarefa(ag.id);
        this.registrar(ag);
    }

    private removerTarefa(id: number): void {
        const tarefa = this.tarefas.get(id);
        if (tarefa) {
            tarefa.parar();
            this.tarefas.delete(id);
        }
    }
}

export const schedulerService = new SchedulerService();
