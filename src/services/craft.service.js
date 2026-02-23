const { default: axios } = require("axios");

class CraftService {
    async listarDiretorios() {
        try {
            const diretoriosListados = await axios.get(`${process.env.CRAFT_API_URL}folders`);

            return diretoriosListados.data;
        } catch (error) {
            throw new Error("Erro ao listar o documento!");
        }
    }

    async listarDocumentos(diretorio) {
        
        try {
            const documentosListados = await axios.get(`${process.env.CRAFT_API_URL}documents`);

            return documentosListados.data;
        } catch (error) {
            throw new Error("Erro ao listar o documento!");
        }

    }

    async buscarDocumentos() {

        try {
            const documentos = await axios.get(`${process.env.CRAFT_API_URL}documents/search`);

            return documentos.data;
        } catch (error) {
            throw new Error("Erro ao buscar o documento!");
        }

    }

    async recuperarTasks() {

    }

    async criarDocumento() {

    }
}

module.exports = new CraftService();