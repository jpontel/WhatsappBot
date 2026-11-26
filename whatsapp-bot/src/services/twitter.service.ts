import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import youtubedlDefault from 'youtube-dl-exec';

// O pacote (CommonJS) exporta a própria função; os tipos sob NodeNext não a
// expõem como chamável, então tipamos explicitamente o callable.
const youtubedl = youtubedlDefault as unknown as (
    url: string,
    flags: Record<string, unknown>,
) => Promise<any>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../../temp_videos');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

export class TwitterService {

    async baixarVideo(url: string): Promise<string> {
        const timestamp = Date.now();
        const outputPath = path.join(OUTPUT_DIR, `video_twitter_${timestamp}.mp4`);

        console.log(`Iniciando download do vídeo do twitter/x: ${url}`);

        try {
            await youtubedl(url, {
                format: 'best[ext=mp4][height<=1080]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best',
                output: outputPath,
                noCheckCertificates: true,
                noWarnings: true,
                preferFreeFormats: true,
                addHeader: ['referer:twitter.com', 'user-agent:googlebot'],
            });

            console.log('Download concluído!');
            return outputPath;

        } catch (error) {
            console.error('Erro ao baixar o vídeo do twitter/x:', error);
            throw new Error('Não consegui baixar esse vídeo. Pode ser um tweet privado/apagado, sem vídeo, ou o X bloqueou a tentativa — tenta outro link.');
        }
    }
}

export const twitterService = new TwitterService();
