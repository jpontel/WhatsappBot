import db from '../config/database.js';

// O SQLite não remove acentos no LOWER/LIKE, então uma busca por "alinecheirapo"
// não casava com o nome cadastrado "alineCheiraPó". Registramos uma função SQL
// própria que tira os diacríticos (NFD + remoção das marcas de combinação) para
// comparar nomes sem acento dos dois lados da query.
const semAcento = (texto: unknown): string =>
    (texto == null ? '' : String(texto)).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
db.function('sem_acento', { deterministic: true }, semAcento);

export interface Pessoa {
    id: number;
    numero: string;
    lid: string | null;
    nome: string;
    cadastrado_por: string | null;
    created_at: string;
}

export interface RegistrarPessoaDto {
    numero: string;
    lid?: string | null;
    nome: string;
    cadastradoPor?: string | null;
}

const stmtRegistrar = db.prepare(`
    INSERT INTO pessoas (numero, lid, nome, cadastrado_por)
    VALUES (@numero, @lid, @nome, @cadastrado_por)
    ON CONFLICT(numero) DO UPDATE SET
        nome = excluded.nome,
        lid = excluded.lid
`);

const stmtBuscarPorNumero = db.prepare(`
    SELECT * FROM pessoas WHERE numero = ?
`);

const stmtBuscarPorNome = db.prepare(`
    SELECT * FROM pessoas WHERE sem_acento(LOWER(nome)) LIKE sem_acento(LOWER(?)) ORDER BY nome
`);

const stmtBuscarPorLid = db.prepare(`
    SELECT * FROM pessoas WHERE lid = ?
`);

const stmtListarTodos = db.prepare(`
    SELECT * FROM pessoas ORDER BY nome
`);

export function registrarPessoa(dto: RegistrarPessoaDto): void {
    stmtRegistrar.run({
        numero: dto.numero,
        lid: dto.lid ?? null,
        nome: dto.nome,
        cadastrado_por: dto.cadastradoPor ?? null,
    });
}

export function buscarPorNumero(numero: string): Pessoa | null {
    return (stmtBuscarPorNumero.get(numero) as Pessoa | undefined) ?? null;
}

/** Busca contatos por nome (case-insensitive, parcial). Retorna lista (pode ser ambígua). */
export function buscarPorNome(nome: string): Pessoa[] {
    return stmtBuscarPorNome.all(`%${nome.trim()}%`) as Pessoa[];
}

/** Busca uma pessoa pelo LID (usado quando o mapeamento LID→número não é conhecido). */
export function buscarPorLid(lid: string): Pessoa | null {
    return (stmtBuscarPorLid.get(lid) as Pessoa | undefined) ?? null;
}

/** Todas as pessoas cadastradas, em ordem alfabética de nome. */
export function listarTodos(): Pessoa[] {
    return stmtListarTodos.all() as Pessoa[];
}
