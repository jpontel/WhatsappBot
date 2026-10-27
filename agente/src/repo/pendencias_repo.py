"""Fila de pendências de auto-recuperação do /chat.

Quando um turno do `/chat` falha de forma transiente (IA sobrecarregada,
billing, erro desconhecido), gravamos a conversa como PENDENTE aqui, no mesmo
`agente.db`, em conexão sqlite3 dedicada. Uma rotina externa (client/retry_pendencias.py)
re-tenta de tempos em tempos e, ao resolver, APAGA a linha (resolver = DELETE).

Segue o molde do `memoria_repo`: conexão única, `threading.Lock`,
`PRAGMA busy_timeout`, timestamps no fuso de `settings.timezone` e funções
síncronas expostas ao resto do código (async) via `asyncio.to_thread`.
"""

import asyncio
import sqlite3
import threading
from datetime import datetime
from zoneinfo import ZoneInfo

from config import settings

# --- conexão única ----------------------------------------------------------
_conn: sqlite3.Connection | None = None
_lock = threading.Lock()


def _agora() -> str:
    return datetime.now(ZoneInfo(settings.timezone)).isoformat()


def _caminho_db() -> str:
    # "sqlite+aiosqlite:///./agente.db" -> "./agente.db" (prod: "./data/agente.db")
    url = settings.database_url
    return url.split("///", 1)[1] if "///" in url else "agente.db"


def _conexao() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        conn = sqlite3.connect(_caminho_db(), check_same_thread=False)
        # Compartilha o arquivo com o DatabaseSessionService do ADK; espera o lock
        # em vez de estourar "database is locked".
        conn.execute("PRAGMA busy_timeout=5000")
        conn.row_factory = sqlite3.Row
        conn.execute(
            """CREATE TABLE IF NOT EXISTS pendencias (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL,
                msg_key TEXT NOT NULL,
                mensagem_usuario TEXT NOT NULL,
                contexto TEXT,
                erro TEXT,
                status TEXT NOT NULL DEFAULT 'pendente',
                tentativas INTEGER NOT NULL DEFAULT 0,
                criado_em TEXT NOT NULL,
                atualizado_em TEXT NOT NULL
            )"""
        )
        # Dedup: no máximo UMA pendente por chat (demais chats não colidem).
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_pend_chat ON pendencias(chat_id) WHERE status='pendente'"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pend_status ON pendencias(status)")
        conn.commit()
        _conn = conn
    return _conn


# --- operações de banco (síncronas) -----------------------------------------
def _marcar_pendente_sync(
    chat_id: str, msg_key: str, mensagem: str, contexto: str, erro: str
) -> bool:
    with _lock:
        conn = _conexao()
        agora = _agora()
        existente = conn.execute(
            "SELECT id FROM pendencias WHERE chat_id = ? AND status = 'pendente'",
            [chat_id],
        ).fetchone()
        if existente:
            # Já pendente: atualiza o conteúdo (mantém `tentativas`) e sinaliza
            # que NÃO criou nova linha (o bot não reenvia o "perai").
            conn.execute(
                """UPDATE pendencias
                   SET msg_key = ?, mensagem_usuario = ?, contexto = ?, erro = ?, atualizado_em = ?
                   WHERE id = ?""",
                [msg_key, mensagem, contexto, erro, agora, existente["id"]],
            )
            conn.commit()
            return False
        conn.execute(
            """INSERT INTO pendencias
               (chat_id, msg_key, mensagem_usuario, contexto, erro, status, tentativas, criado_em, atualizado_em)
               VALUES (?, ?, ?, ?, ?, 'pendente', 0, ?, ?)""",
            [chat_id, msg_key, mensagem, contexto, erro, agora, agora],
        )
        conn.commit()
        return True


def _tem_pendente_sync(chat_id: str) -> bool:
    with _lock:
        conn = _conexao()
        row = conn.execute(
            "SELECT 1 FROM pendencias WHERE chat_id = ? AND status = 'pendente' LIMIT 1",
            [chat_id],
        ).fetchone()
        return row is not None


def _listar_pendentes_sync(limite: int) -> list[dict]:
    with _lock:
        conn = _conexao()
        rows = conn.execute(
            "SELECT * FROM pendencias WHERE status = 'pendente' ORDER BY criado_em ASC LIMIT ?",
            [limite],
        ).fetchall()
    # Corte por `max_tentativas` fica a cargo da rotina (ver contrato no módulo).
    return [dict(r) for r in rows]


def _resolver_sync(id_: int) -> None:
    with _lock:
        conn = _conexao()
        conn.execute("DELETE FROM pendencias WHERE id = ?", [id_])
        conn.commit()


def _registrar_tentativa_sync(id_: int) -> int:
    with _lock:
        conn = _conexao()
        conn.execute(
            "UPDATE pendencias SET tentativas = tentativas + 1, atualizado_em = ? WHERE id = ?",
            [_agora(), id_],
        )
        conn.commit()
        row = conn.execute("SELECT tentativas FROM pendencias WHERE id = ?", [id_]).fetchone()
        return row["tentativas"] if row else 0


def _marcar_desistido_sync(id_: int) -> None:
    with _lock:
        conn = _conexao()
        conn.execute(
            "UPDATE pendencias SET status = 'desistido', atualizado_em = ? WHERE id = ?",
            [_agora(), id_],
        )
        conn.commit()


# --- wrappers async (não bloqueiam o event loop) ----------------------------
async def marcar_pendente(
    chat_id: str, msg_key: str, mensagem: str, contexto: str, erro: str
) -> bool:
    """Upsert com dedup por chat. Retorna True se CRIOU, False se já existia."""
    return await asyncio.to_thread(
        _marcar_pendente_sync, chat_id, msg_key, mensagem, contexto, erro
    )


async def tem_pendente(chat_id: str) -> bool:
    return await asyncio.to_thread(_tem_pendente_sync, chat_id)


async def listar_pendentes(limite: int) -> list[dict]:
    return await asyncio.to_thread(_listar_pendentes_sync, limite)


async def resolver(id_: int) -> None:
    """Pendência resolvida = linha APAGADA (DELETE)."""
    await asyncio.to_thread(_resolver_sync, id_)


async def registrar_tentativa(id_: int) -> int:
    """Incrementa `tentativas` e retorna o novo valor."""
    return await asyncio.to_thread(_registrar_tentativa_sync, id_)


async def marcar_desistido(id_: int) -> None:
    await asyncio.to_thread(_marcar_desistido_sync, id_)


# Cria a tabela/índices no import (como o memoria_repo cria o schema).
_conexao()
