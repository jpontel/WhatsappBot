import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(filename);

export default async function carregarComandos() {
    const comandos = new Map();

    const comandosArquivos = path.join(__dirname, '../commands');
    const comandosLista = fs.readdirSync(comandosArquivos).filter(file => file.endsWith('.js') || file.endsWith('.ts'));

    for(const arquivo of comandosLista) {
        const arquivoCaminho = path.join(comandosArquivos, arquivo);
        const urlArquivo = pathToFileURL(arquivoCaminho).href;
        
        const modulo = await import(urlArquivo);
        const comandoCarregado = modulo.default || modulo;

        if(comandoCarregado.name && comandoCarregado.execute) {
            comandos.set(comandoCarregado.name, comandoCarregado);
        }
    }

    return comandos;
}