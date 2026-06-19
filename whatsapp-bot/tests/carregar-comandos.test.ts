import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import carregarComandos from '../src/core/comandos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures/commands');

describe('carregarComandos', () => {
    it('carrega apenas módulos com name e execute', async () => {
        const comandos = await carregarComandos(FIXTURES);

        expect(comandos.has('/valido')).toBe(true);
        expect(comandos.has('/outro')).toBe(true);
        expect(comandos.has('/sem-execute')).toBe(false);
    });

    it('não recorre em subdiretórios (arquivados/ é ignorado)', async () => {
        const comandos = await carregarComandos(FIXTURES);

        expect(comandos.has('/nao-deve-carregar')).toBe(false);
    });

    it('retorna Map indexado por name', async () => {
        const comandos = await carregarComandos(FIXTURES);

        const valido = comandos.get('/valido');
        expect(valido).toBeDefined();
        expect(typeof valido.execute).toBe('function');
        expect(valido.name).toBe('/valido');
    });
});
