import db from '../config/database.js';

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
    SELECT * FROM pessoas WHERE LOWER(nome) LIKE LOWER(?) ORDER BY nome
`);

const stmtBuscarPorLid = db.prepare(`
    SELECT * FROM pessoas WHERE lid = ?
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
