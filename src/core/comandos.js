const fs = require('fs');
const path = require('path');

function carregarComandos() {
    const comandos = new Map();

    const arquivosComandos = path.join(__dirname, '../commands');
    const listaComandos = fs.readdirSync(arquivosComandos).filter(file => file.endsWith('.js'));

    for(const comando of listaComandos) {
        const comandoCarregado = require(path.join(arquivosComandos, comando));

        if(comandoCarregado.name && comandoCarregado.execute)
            comandos.set(comandoCarregado.name, comandoCarregado); 
    }
    
    return comandos;
}

module.exports = carregarComandos;
