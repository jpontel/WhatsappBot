import db from '../config/database.js';

// Opt-in por grupo do anti-vácuo de grupo (feature responder-no-vácuo). Espelha
// o padrão de pessoa.repository: statements preparados + funções síncronas. O
// `estaHabilitado` é consultado no hot path do dispatcher para TODA mensagem de
// grupo, então precisa ser barato (lookup por PK) — por isso fica em SQLite sync.

const stmtHabilitar = db.prepare(`
    INSERT INTO grupo_vacuo (jid, habilitado, atualizado_em)
    VALUES (?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(jid) DO UPDATE SET habilitado = 1, atualizado_em = CURRENT_TIMESTAMP
`);

const stmtDesabilitar = db.prepare(`
    INSERT INTO grupo_vacuo (jid, habilitado, atualizado_em)
    VALUES (?, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(jid) DO UPDATE SET habilitado = 0, atualizado_em = CURRENT_TIMESTAMP
`);

const stmtEstaHabilitado = db.prepare(`SELECT habilitado FROM grupo_vacuo WHERE jid = ?`);

const stmtListar = db.prepare(`SELECT jid FROM grupo_vacuo WHERE habilitado = 1 ORDER BY jid`);

/** Liga o anti-vácuo no grupo (upsert). */
export function habilitar(jid: string): void {
    stmtHabilitar.run(jid);
}

/** Desliga o anti-vácuo no grupo (upsert). */
export function desabilitar(jid: string): void {
    stmtDesabilitar.run(jid);
}

/** True se o anti-vácuo está ligado no grupo. Barato (lookup por PK). */
export function estaHabilitado(jid: string): boolean {
    const row = stmtEstaHabilitado.get(jid) as { habilitado: number } | undefined;
    return row?.habilitado === 1;
}

/** JIDs dos grupos com anti-vácuo ligado. */
export function listar(): string[] {
    return (stmtListar.all() as { jid: string }[]).map((r) => r.jid);
}

// --- persistência dos timers pendentes (sobreviver a restart) ----------------
// O detector (vacuo-grupo) mantém os timers em memória, mas grava um espelho aqui
// para re-armar no boot. 1 pendência por grupo (mesma semântica do Map).

export interface VacuoPendente {
    grupo_jid: string;
    msg_id: string;
    fire_at: string;
    payload: string;
}

const stmtSalvarPendente = db.prepare(`
    INSERT INTO vacuo_pendente (grupo_jid, msg_id, fire_at, payload)
    VALUES (@grupo_jid, @msg_id, @fire_at, @payload)
    ON CONFLICT(grupo_jid) DO UPDATE SET
        msg_id = excluded.msg_id, fire_at = excluded.fire_at, payload = excluded.payload, criado_em = CURRENT_TIMESTAMP
`);

const stmtRemoverPendente = db.prepare(`DELETE FROM vacuo_pendente WHERE grupo_jid = ?`);

const stmtListarPendentes = db.prepare(`SELECT grupo_jid, msg_id, fire_at, payload FROM vacuo_pendente`);

/** Grava (upsert) o timer pendente de um grupo. */
export function salvarPendente(grupoJid: string, msgId: string, fireAt: string, payload: string): void {
    stmtSalvarPendente.run({ grupo_jid: grupoJid, msg_id: msgId, fire_at: fireAt, payload });
}

/** Remove o timer pendente de um grupo (ao cancelar ou disparar). */
export function removerPendente(grupoJid: string): void {
    stmtRemoverPendente.run(grupoJid);
}

/** Todos os timers pendentes (lidos no boot p/ re-armar). */
export function listarPendentes(): VacuoPendente[] {
    return stmtListarPendentes.all() as VacuoPendente[];
}
