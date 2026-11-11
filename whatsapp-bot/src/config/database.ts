import DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// O SQLite fica em data/ para ser persistido por um volume Docker dedicado.
const dataDir = path.join(__dirname, '../../data');
fs.mkdirSync(dataDir, { recursive: true });

const db: Database = new DatabaseConstructor(path.join(dataDir, 'whatsapp-bot.db'))

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
    chat_id TEXT NOT NULL,           -- JID do chat de ORIGEM (= destino do envio): grupo ou privado
    contact_id TEXT NOT NULL,        -- quem pediu (remetente); só referência, nunca destino
    mensagem TEXT NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'once',   -- 'once' (uma vez) | 'recorrente'
    cron_expression TEXT,            -- usado quando tipo='recorrente'
    run_at TEXT,                     -- ISO 8601 com offset, usado quando tipo='once'
    timezone TEXT DEFAULT 'America/Sao_Paulo',
    urgente INTEGER NOT NULL DEFAULT 0,  -- 1 = exige confirmação; reenvia a cada 3min até responder
    nag_count INTEGER NOT NULL DEFAULT 0, -- nº de reenvios já feitos enquanto aguarda confirmação
    -- pendente (ativo) | enviado | cancelado | erro
    -- aguardando_confirmacao (urgente já disparou, no nag) | confirmado | nao_confirmado (teto do nag)
    status TEXT DEFAULT 'pendente',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pessoas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT NOT NULL UNIQUE,   -- PN normalizado <num>@s.whatsapp.net (chave canônica de match)
    lid TEXT,                       -- LID conhecido (fallback/observabilidade)
    nome TEXT NOT NULL,             -- rótulo informado no /cadastrar
    cadastrado_por TEXT,            -- numero (PN) de quem cadastrou
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS grupo_vacuo (
    jid TEXT PRIMARY KEY,                    -- JID do grupo (@g.us)
    habilitado INTEGER NOT NULL DEFAULT 0,   -- 1 = anti-vácuo ligado neste grupo (opt-in)
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS vacuo_pendente (
    grupo_jid TEXT PRIMARY KEY,              -- 1 timer pendente por grupo (espelha o Map em memória)
    msg_id TEXT NOT NULL,                    -- id da mensagem que armou o timer
    fire_at TEXT NOT NULL,                   -- ISO 8601: quando o timer deve disparar
    payload TEXT NOT NULL,                   -- JSON do dto (sem sock) p/ reconstruir no boot
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migração idempotente: o DB de produção já tinha a tabela `agendamento` no schema
// antigo (sem tipo/run_at/timezone). O CREATE TABLE IF NOT EXISTS acima não altera
// tabelas existentes, então adicionamos as colunas que faltarem aqui.
const colunasAgendamento = new Set(
    (db.prepare("PRAGMA table_info(agendamento)").all() as { name: string }[]).map((c) => c.name),
);
const adicionarColuna = (nome: string, ddl: string): void => {
    if (!colunasAgendamento.has(nome)) {
        db.exec(`ALTER TABLE agendamento ADD COLUMN ${ddl};`);
    }
};
adicionarColuna('tipo', "tipo TEXT NOT NULL DEFAULT 'once'");
adicionarColuna('run_at', 'run_at TEXT');
adicionarColuna('timezone', "timezone TEXT DEFAULT 'America/Sao_Paulo'");
adicionarColuna('urgente', 'urgente INTEGER NOT NULL DEFAULT 0');
adicionarColuna('nag_count', 'nag_count INTEGER NOT NULL DEFAULT 0');

export default db;