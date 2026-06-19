const { default: axios } = require("axios");

const ENDPOINTS = {
    USER_INFO: 'user/info',
    ROUTINES: 'routines',
    EXERCISE_HISTORY: 'exercise_history/{exerciseTemplateId}',
    ROUTINE_FOLDERS: 'routine_folders'
}

class HevyService {
    async recuperarHistoricoExercicios(recuperarHistoricoExerciciosDto: any) {

        if(!recuperarHistoricoExerciciosDto.exerciseTemplateId) 
            throw new Error("Precisa de um template");

        try {
            const response = await axios.get(process.env.HEAVY_API_URL, {
                params: {
                    method: ENDPOINTS.EXERCISE_HISTORY,
                    'api-key': process.env.HEVY_API_KEY,
                    exerciseTemplateId: recuperarHistoricoExerciciosDto.exerciseTemplateId
                }
            });

            return response;
        } catch (error) {
            throw new Error("deu algum bo");
        }
    }

}

module.exports = new HevyService();