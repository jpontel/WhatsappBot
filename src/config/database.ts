import DatabaseConstructor from 'better-sqlite3'; 
import type { Database } from 'better-sqlite3'; 
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db: Database = new DatabaseConstructor(path.join(__dirname, '../../whatsapp-bot.db'))

db.exec(`
    CREATE TABLE IF NOT EXISTS mensagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,      -- 'user' (eu) ou 'model' (gemini)
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS agendamento (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    mensagem TEXT NOT NULL,
    cron_expression TEXT NOT NULL,
    status TEXT DEFAULT 'pendente',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

export default db;