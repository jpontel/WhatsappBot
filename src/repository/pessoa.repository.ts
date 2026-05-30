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
