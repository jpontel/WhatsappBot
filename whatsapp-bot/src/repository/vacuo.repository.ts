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
