import { createCanvas, loadImage } from 'canvas';
import type { CanvasRenderingContext2D } from 'canvas';

export class Canvas {
    async criarCanvas(itens: any) {
        const CELL = 150;           // px por célula
        const GRID = 5;             // 5x5
        const SIZE = CELL * GRID;   // 750x750 total

        // Completa até 25 células com tiles VAZIOS (sem nome) — antes empurrava o
        // placeholder-estrela do Last.fm, que ficava feio. Agora vira tile liso.
        while(itens.length < 25)
            itens.push({ imageUrl: null, name: '', artist: '' });

        const canvas = createCanvas(SIZE, SIZE);
        const context = canvas.getContext('2d');

        context.fillStyle = '#111111';
        context.fillRect(0, 0, SIZE, SIZE);

        const promises = itens.slice(0, 25).map(async(item: any, i: number) => {
            const col = i % GRID;
            const row = Math.floor(i / GRID);

            const x = col * CELL;
            const y = row * CELL;

            // Só tenta carregar se houver URL de verdade. Sem capa (ou falha no
            // download) → tile com o nome do álbum, em vez da estrela do Last.fm.
            if (item.imageUrl) {
                try {
                    const image = await loadImage(item.imageUrl);
                    context.drawImage(image, x, y, CELL, CELL);
                    return;
                } catch {
                    // cai pro tile de texto abaixo
                }
            }

            this.desenharTileTexto(context, x, y, CELL, item.name, item.artist);
        });

        await Promise.all(promises);

        return canvas.toBuffer('image/jpeg', { quality: 0.8 });
    }

    // Tile de fallback quando não há capa: fundo escuro + nome do álbum (e artista
    // menor). Célula sem nome (padding) fica só o fundo liso.
    private desenharTileTexto(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        cell: number,
        nome?: string,
        artista?: string,
    ): void {
        ctx.save();
        ctx.fillStyle = '#242424';
        ctx.fillRect(x, y, cell, cell);
        ctx.strokeStyle = '#333333';
        ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);

        const tituloNome = (nome || '').trim();
        const tituloArtista = (artista || '').trim();
        if (!tituloNome && !tituloArtista) {
            ctx.restore();
            return; // padding: só o fundo
        }

        const pad = 10;
        const maxW = cell - pad * 2;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        // Nome do álbum (branco, até 4 linhas).
        ctx.font = 'bold 12px sans-serif';
        const linhas = this.quebrarTexto(ctx, tituloNome || '?', maxW, 4);
        const lh = 15;
        const alturaArtista = tituloArtista ? 14 : 0;
        const alturaTotal = linhas.length * lh + alturaArtista;

        let ty = y + Math.max((cell - alturaTotal) / 2, pad);
        ctx.fillStyle = '#e8e8e8';
        for (const linha of linhas) {
            ctx.fillText(linha, x + cell / 2, ty, maxW);
            ty += lh;
        }

        // Artista (cinza, 1 linha).
        if (tituloArtista) {
            ctx.font = '10px sans-serif';
            ctx.fillStyle = '#9a9a9a';
            const art = this.quebrarTexto(ctx, tituloArtista, maxW, 1)[0] ?? '';
            ctx.fillText(art, x + cell / 2, ty + 2, maxW);
        }

        ctx.restore();
    }

    // Quebra `texto` em até `maxLinhas` linhas que cabem em `maxW`. Se estourar,
    // corta a última linha com reticências. Palavra sozinha gigante é truncada.
    private quebrarTexto(
        ctx: CanvasRenderingContext2D,
        texto: string,
        maxW: number,
        maxLinhas: number,
    ): string[] {
        const palavras = String(texto).split(/\s+/).filter(Boolean);
        const linhas: string[] = [];
        let atual = '';

        for (const palavra of palavras) {
            const tentativa = atual ? `${atual} ${palavra}` : palavra;
            if (ctx.measureText(tentativa).width <= maxW || !atual) {
                atual = tentativa;
            } else {
                linhas.push(atual);
                atual = palavra;
                if (linhas.length === maxLinhas) break;
            }
        }
        if (linhas.length < maxLinhas && atual) linhas.push(atual);

        // Estourou o nº de linhas e ainda há texto → reticências na última.
        if (linhas.length === maxLinhas) {
            let ultima = linhas[maxLinhas - 1] ?? '';
            const juntou = linhas.join(' ');
            if (juntou.length < texto.trim().length) {
                while (ultima.length > 1 && ctx.measureText(`${ultima}…`).width > maxW) {
                    ultima = ultima.slice(0, -1);
                }
                linhas[maxLinhas - 1] = `${ultima}…`;
            }
        }

        return linhas;
    }
}
