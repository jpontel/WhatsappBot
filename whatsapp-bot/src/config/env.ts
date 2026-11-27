import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const ENV = {
    LASTFM_API_URL: process.env.LASTFM_API_URL,
    LASTFM_API_KEY: process.env.LASTFM_API_KEY ?? '0e358d2f6c90fa329f83e3f463dede60',
    LASTFM_SHARED_SECRET: process.env.LASTFM_SHARED_SECRET,
    CRAFT_API_URL: process.env.CRAFT_API_URL,
    CHROME_FOLDER_MACOS: process.env.CHROME_FOLDER_MACOS,
    CHROME_FOLDER_LINUX: process.env.CHROME_FOLDER_LINUX,
    IS_DESENV: process.env.IS_DESENV,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    HEAVY_API_URL: process.env.HEAVY_API_URL,
    HEAVY_API_KEY: process.env.HEAVY_API_KEY,
    TELEFONE_CELULAR: process.env.TELEFONE_CELULAR,
    MCP_PORT: process.env.MCP_PORT,
    AGENT_URL: process.env.AGENT_URL ?? 'http://localhost:8000',
    // JID/número do admin. Quando o bot roda numa conta dedicada, as mensagens do
    // admin chegam como fromMe=false — então o identificamos por este JID.
    ADMIN_JID: process.env.ADMIN_JID,
    // Nome do admin exposto ao agente (persona). Default 'guigo'.
    ADMIN_NOME: process.env.ADMIN_NOME ?? 'guigo',
    // Teto de mensagens de contexto recente enviadas ao agente junto do gatilho
    // (/p ou @menção). Number('') / NaN caem no default 10.
    CONTEXTO_MAX_MSGS: Number(process.env.CONTEXTO_MAX_MSGS) || 10,
    // Anti-vácuo de grupo: master switch (default ligado; só desliga com 'false')
    // e janela de silêncio antes do bot responder (default 5 min). O opt-in por
    // grupo é à parte (tabela grupo_vacuo); este é só o liga/desliga global.
    VACUO_GRUPO_ATIVO: process.env.VACUO_GRUPO_ATIVO !== 'false',
    VACUO_GRUPO_DELAY_MS: Number(process.env.VACUO_GRUPO_DELAY_MS) || 5 * 60 * 1000,
};

console.log('Configurações carregadas:', !!process.env.GEMINI_API_KEY);
if (!process.env.ADMIN_JID)
    console.warn('⚠️ ADMIN_JID não definido — nenhum remetente será admin.');
