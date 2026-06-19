import db from '../config/database.js';

export type TipoAgendamento = 'once' | 'recorrente';
export type StatusAgendamento =
    | 'pendente'
    | 'enviado'
    | 'cancelado'
    | 'erro'
    | 'aguardando_confirmacao'
    | 'confirmado'
    | 'nao_confirmado';

export interface Agendamento {
    id: number;
    chat_id: string;        // JID do chat de origem (= destino do envio)
    contact_id: string;     // quem pediu (remetente); usado p/ confirmar urgente em grupo
    mensagem: string;
    tipo: TipoAgendamento;
    cron_expression: string | null;
    run_at: string | null;  // ISO 8601 com offset
    timezone: string;
    urgente: number;        // 0 | 1
    nag_count: number;
    status: StatusAgendamento;
    created_at: string;
}

export interface NovoAgendamento {
    chatId: string;
    contactId: string;
    mensagem: string;
    tipo: TipoAgendamento;
    cronExpression?: string | undefined;
    runAt?: string | undefined;
    timezone?: string | undefined;
    urgente?: boolean | undefined;
}

// status considerados "vivos" (precisam ser re-registrados no boot).
const STATUS_ATIVOS = "('pendente', 'aguardando_confirmacao')";

export interface CamposAtualizaveis {
    mensagem?: string | undefined;
    runAt?: string | undefined;
    cronExpression?: string | undefined;
    urgente?: boolean | undefined;
}

/**
 * True se `solicitante` é quem pediu o agendamento. Compara nas duas formas
 * (número puro e JID) — mesma lógica usada no scheduler/dispatcher p/ confirmar
 * urgentes (scheduler.service.ts / dispatcher.ts). Centralizado aqui p/ não
 * divergir a normalização.
 */
export function mesmoSolicitante(ag: Agendamento, solicitante: string | null | undefined): boolean {
    if (!solicitante) return false;
    return ag.contact_id === solicitante;
}

class AgendamentoRepository {

    criar(dados: NovoAgendamento): number {
        // urgência só faz sentido para 'once' (recorrente já repete por natureza).
        const urgente = dados.tipo === 'once' && dados.urgente ? 1 : 0;
        const query = db.prepare(`
            INSERT INTO agendamento (chat_id, contact_id, mensagem, tipo, cron_expression, run_at, timezone, urgente, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendente')
        `);
        const info = query.run(
            dados.chatId,
            dados.contactId,
            dados.mensagem,
            dados.tipo,
            // 'once' não usa cron; grava '' para satisfazer o NOT NULL do schema legado.
            dados.tipo === 'recorrente' ? (dados.cronExpression ?? '') : '',
            dados.tipo === 'once' ? (dados.runAt ?? null) : null,
            dados.timezone ?? 'America/Sao_Paulo',
            urgente,
        );
        return Number(info.lastInsertRowid);
    }

    /** Agendamentos "vivos" (pendentes ou em nag) — usado no boot para re-registrar. */
    listarAtivos(): Agendamento[] {
        return db.prepare(`SELECT * FROM agendamento WHERE status IN ${STATUS_ATIVOS}`).all() as Agendamento[];
    }

    /**
     * Agendamentos vivos de um chat — usado pela tool listar. Se `filtroContato`
     * vier, restringe aos que aquele solicitante criou (usado p/ não-admin ver só
     * os próprios).
     */
    listarPorChat(chatId: string, filtroContato?: string): Agendamento[] {
        if (filtroContato) {
            return db
                .prepare(`SELECT * FROM agendamento WHERE chat_id = ? AND contact_id = ? AND status IN ${STATUS_ATIVOS} ORDER BY id`)
                .all(chatId, filtroContato) as Agendamento[];
        }
        return db
            .prepare(`SELECT * FROM agendamento WHERE chat_id = ? AND status IN ${STATUS_ATIVOS} ORDER BY id`)
            .all(chatId) as Agendamento[];
    }

    /** Urgentes em nag (aguardando confirmação) de um chat — usado para detectar resposta. */
    listarAguardandoConfirmacao(chatId: string): Agendamento[] {
        return db
            .prepare("SELECT * FROM agendamento WHERE chat_id = ? AND status = 'aguardando_confirmacao'")
            .all(chatId) as Agendamento[];
    }

    buscarPorId(id: number): Agendamento | undefined {
        return db.prepare('SELECT * FROM agendamento WHERE id = ?').get(id) as Agendamento | undefined;
    }

    marcarEnviado(id: number): void {
        db.prepare("UPDATE agendamento SET status = 'enviado' WHERE id = ?").run(id);
    }

    marcarErro(id: number): void {
        db.prepare("UPDATE agendamento SET status = 'erro' WHERE id = ?").run(id);
    }

    cancelar(id: number): void {
        db.prepare("UPDATE agendamento SET status = 'cancelado' WHERE id = ?").run(id);
    }

    /**
     * Atualiza apenas os campos informados de um agendamento PENDENTE. Retorna
     * o agendamento atualizado (ou undefined se não havia pendente com esse id).
     * Quem chama deve re-registrar no scheduler (o timer/cron antigo continua
     * valendo até ser trocado).
     */
    atualizar(id: number, campos: CamposAtualizaveis): Agendamento | undefined {
        const sets: string[] = [];
        const valores: (string | number | null)[] = [];
        if (campos.mensagem !== undefined) {
            sets.push('mensagem = ?');
            valores.push(campos.mensagem);
        }
        if (campos.runAt !== undefined) {
            sets.push('run_at = ?');
            valores.push(campos.runAt);
        }
        if (campos.cronExpression !== undefined) {
            sets.push('cron_expression = ?');
            valores.push(campos.cronExpression);
        }
        if (campos.urgente !== undefined) {
            sets.push('urgente = ?');
            valores.push(campos.urgente ? 1 : 0);
        }
        if (sets.length === 0) return this.buscarPorId(id);
        valores.push(id);
        const info = db
            .prepare(`UPDATE agendamento SET ${sets.join(', ')} WHERE id = ? AND status = 'pendente'`)
            .run(...valores);
        if (info.changes === 0) return undefined;
        return this.buscarPorId(id);
    }

    // --- fluxo de confirmação (urgente) ---

    marcarAguardandoConfirmacao(id: number): void {
        db.prepare("UPDATE agendamento SET status = 'aguardando_confirmacao' WHERE id = ?").run(id);
    }

    /** Incrementa o contador de reenvios e devolve o novo valor. */
    incrementarNag(id: number): number {
        db.prepare('UPDATE agendamento SET nag_count = nag_count + 1 WHERE id = ?').run(id);
        const row = db.prepare('SELECT nag_count FROM agendamento WHERE id = ?').get(id) as { nag_count: number };
        return row.nag_count;
    }

    marcarConfirmado(id: number): void {
        db.prepare("UPDATE agendamento SET status = 'confirmado' WHERE id = ?").run(id);
    }

    marcarNaoConfirmado(id: number): void {
        db.prepare("UPDATE agendamento SET status = 'nao_confirmado' WHERE id = ?").run(id);
    }
}

export const agendamentoRepository = new AgendamentoRepository();
