const db = require('../config/database');

class AgendamentoRepository {

    /**
     * CREATE: Salva um novo agendamento no banco
     */
    salvar(chatId, contactId, mensagem, cronExpression) {
        const query = db.prepare(`
            INSERT INTO agendamento (chat_id, contact_id, mensagem, cron_expression, status)
            VALUES (?, ?, ?, ?, 'pendente')
        `);
        
        const info = query.run(chatId, contactId, mensagem, cronExpression);
        return info.lastInsertRowid; 
    }

    /**
     * READ: Busca todos os agendamentos que estão com status 'pendente'
     * E cujo horário/cron case com o minuto atual.
     * (A verificação do horário faremos no serviço de scheduler usando node-cron)
     */
    buscarPendentes() {
        const query = db.prepare(`
            SELECT id, chat_id, contact_id, mensagem, cron_expression 
            FROM agendamento 
            WHERE status = 'pendente'
        `);
        
        return query.all(); 
    }

    /**
     * UPDATE: Atualiza o status para 'enviado' para não mandar duas vezes
     */
    marcarComoEnviado(id) {
        const query = db.prepare(`
            UPDATE agendamento 
            SET status = 'enviado' 
            WHERE id = ?
        `);
        
        query.run(id);
    }

    /**
     * UPDATE (Falha): Opcional: Se der erro no envio, podemos marcar como falha
     */
    marcarComoFalha(id) {
        const query = db.prepare(`
            UPDATE agendamento 
            SET status = 'erro' 
            WHERE id = ?
        `);
        
        query.run(id);
    }

    /**
     * DELETE: Caso você queira criar um comando para cancelar/apagar um agendamento
     */
    excluir(id) {
        const query = db.prepare('DELETE FROM agendamento WHERE id = ?');
        query.run(id);
    }
}

module.exports = new AgendamentoRepository();
