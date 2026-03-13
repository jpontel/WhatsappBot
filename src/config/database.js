const Database = require('better-sqlite3');
const path = require('node:path');

const db = new Database(path.join(__dirname, '../../historico_conversas.db'));

db.exec(`
    CREATE TABLE IF NOT EXISTS mensagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,      -- 'user' (eu) ou 'model' (gemini)
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

module.exports = db;