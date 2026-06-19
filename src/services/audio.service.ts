import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../../temp_audio');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

export class AudioService {

    /**
     * Converte bytes de áudio (ex.: WAV vindo do TTS do Gemini) em OGG/Opus —
     * o formato que o WhatsApp usa para nota de voz (PTT). Grava um arquivo
     * temporário de entrada, transcodifica via ffmpeg e devolve o caminho do
     * `.ogg`. O arquivo de entrada é removido aqui; o `.ogg` deve ser apagado
     * por quem chama após o envio.
     */
    async converterParaOpus(bytes: Buffer): Promise<string> {
        const timestamp = Date.now();
        const entrada = path.join(OUTPUT_DIR, `tts_${timestamp}.in`);
        const saida = path.join(OUTPUT_DIR, `tts_${timestamp}.ogg`);

        fs.writeFileSync(entrada, bytes);

        try {
            // ffmpeg autodetecta o container de entrada (WAV/MP3/etc).
            await execFileAsync('ffmpeg', [
                '-y',
                '-i', entrada,
                '-c:a', 'libopus',
                '-b:a', '32k',
                '-ar', '48000',
                '-ac', '1',
                saida,
            ]);
            return saida;
        } catch (error) {
            // limpa a saída parcial se a transcodificação falhou
            if (fs.existsSync(saida)) {
                try { fs.unlinkSync(saida); } catch { /* ignora limpeza */ }
            }
            console.error('Erro ao transcodificar áudio para opus:', error);
            throw new Error('Não consegui converter o áudio para nota de voz.');
        } finally {
            if (fs.existsSync(entrada)) {
                try { fs.unlinkSync(entrada); } catch { /* ignora limpeza */ }
            }
        }
    }
}

export const audioService = new AudioService();
