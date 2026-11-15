// Buffer em memória dos logs do bot (observabilidade — comando /logs).
// Faz um "tee" no console.log/info/warn/error: continua imprimindo (docker logs)
// E guarda os últimos N registros estruturados, sem tocar nos call sites. A redação
// de segredos/PII é aplicada na LEITURA (recuperar), não no armazenamento.

export type LogItem = { ts: number; nivel: string; comp: string; msg: string };

const MAX = Number(process.env.LOG_BUFFER_MAX) || 500;
const LIMITE_MAX = 100;
const MSG_MAX = 300;

const buffer: LogItem[] = [];

const NIVEIS: Record<string, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };

const RE_SEGREDO = /(AIza[\w-]+|AQ\.[\w-]+|gh[po]_[A-Za-z0-9]+|Bearer\s+[\w.-]+|sk-[A-Za-z0-9]+)/g;
const RE_NUM = /\b\d{10,}\b/g;

function redigir(texto: string): string {
    return texto
        .replace(RE_SEGREDO, '***')
        .replace(RE_NUM, (m) => m.slice(0, 4) + '***');
}

function paraTexto(args: unknown[]): string {
    return args
        .map((a) => {
            if (typeof a === 'string') return a;
            if (a instanceof Error) return `${a.name}: ${a.message}`;
            try {
                return JSON.stringify(a);
            } catch {
                return String(a);
            }
        })
        .join(' ');
}

function push(nivel: string, args: unknown[]): void {
    buffer.push({ ts: Date.now(), nivel, comp: 'bot', msg: paraTexto(args) });
    if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
}

/** Instala o tee no console (idempotente). Chamar cedo no boot. */
export function instalarLogBuffer(): void {
    const c = console as unknown as { __teeInstalado?: boolean };
    if (c.__teeInstalado) return;
    c.__teeInstalado = true;

    const orig = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
    };
    console.log = (...a: unknown[]) => { push('INFO', a); orig.log(...a); };
    console.info = (...a: unknown[]) => { push('INFO', a); orig.info(...a); };
    console.warn = (...a: unknown[]) => { push('WARNING', a); orig.warn(...a); };
    console.error = (...a: unknown[]) => { push('ERROR', a); orig.error(...a); };
}

function fmtTs(epoch: number): string {
    return new Date(epoch).toLocaleTimeString('pt-BR', { hour12: false, timeZone: 'America/Sao_Paulo' });
}

/** Logs filtrados (estruturado, redigido, truncado). `resumo` = contagem por tipo. */
export function recuperarLogs(opts: {
    nivel?: string;
    comp?: string;
    limite?: number;
    resumo?: boolean;
} = {}): { svc: string; total: number; logs?: string[]; resumo?: Record<string, number> } {
    const minimo = NIVEIS[(opts.nivel || 'WARNING').toUpperCase()] ?? 30;
    const limite = Math.max(1, Math.min(opts.limite ?? 30, LIMITE_MAX));

    const itens = buffer
        .filter((r) => (NIVEIS[r.nivel] ?? 0) >= minimo && (!opts.comp || r.comp.includes(opts.comp)))
        .slice(-limite);

    if (opts.resumo) {
        const contagem: Record<string, number> = {};
        for (const r of itens) {
            const k = `${r.nivel} ${r.comp}`;
            contagem[k] = (contagem[k] ?? 0) + 1;
        }
        return { svc: 'bot', total: itens.length, resumo: contagem };
    }

    const logs = itens.map(
        (r) => `${fmtTs(r.ts)} ${r.nivel} ${r.comp}: ${redigir(r.msg).slice(0, MSG_MAX)}`,
    );
    return { svc: 'bot', total: logs.length, logs };
}
