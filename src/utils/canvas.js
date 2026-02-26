const { createCanvas, loadImage } = require('canvas');

class Canvas {
    async criarCanvas(itens) {
        const CELL = 150;           // px por célula
        const GRID = 5;             // 5x5
        const SIZE = CELL * GRID;   // 750x750 total
        const PLACEHOLDER ='https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png';

        while(itens.length < 25)
            itens.push({ imageUrl: PLACEHOLDER, name: '?', artist: '?'});

        // Monta a imagem da semaninha
        const canvas = createCanvas(SIZE, SIZE);
        const context = canvas.getContext('2d');

        context.fillStyle = '#111111';
        context.fillRect(0, 0, SIZE, SIZE);

        for (let i = 0; i < 25; i++) {
            const col = i % GRID;
            const row = Math.floor(i / GRID);

            const x = col * CELL;
            const y = row * CELL;

            try {
                
                const src = itens[i].imageUrl || PLACEHOLDER;
                const image = await loadImage(src);

                context.drawImage(image, x, y, CELL, CELL);

            } catch (error) {
                context.fillStyle = '#2a2a2a';
                context.fillRect(x, y, CELL, CELL);
            }
            
        }

        return canvas.toBuffer('image/png');
    }
}

module.exports = new Canvas();