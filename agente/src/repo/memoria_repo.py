"""Memória de longo prazo por usuário (vetorial, via sqlite-vec).

Guarda trechos relevantes por pessoa (`numero`) com embedding e recupera os
mais similares (KNN). Persistência no mesmo arquivo do `agente.db` (tabela
virtual `vec0`), em conexão sqlite3 dedicada. As funções de banco são síncronas
e expostas ao resto do código (async) via `asyncio.to_thread`.
"""

import asyncio
import math
import sqlite3
import threading
from datetime import datetime
from zoneinfo import ZoneInfo

import sqlite_vec
from google import genai
from google.genai import types

from config import settings

# --- conexão única (carrega a extensão uma vez) -----------------------------
_conn: sqlite3.Connection | None = None
_lock = threading.Lock()


def _norm(numero: str) -> str:
    """Parte de usuário do número (antes do '@'), p/ casar "puro" vs JID.

    A memória é salva com o número puro (`remetente_numero`), mas a listagem via
    `buscar_contato` consulta com o JID completo (`...@s.whatsapp.net`).
    Normalizar ambos para a parte antes do '@' faz a chave casar — espelha
    `rosto_repo.normalizar_numero` (mesmo bug, já resolvido no lado do rosto).
    """
    return (numero or "").split("@", 1)[0].strip()


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
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)
        conn.execute(
            f"""CREATE VIRTUAL TABLE IF NOT EXISTS memorias USING vec0(
                numero TEXT partition key,
                categoria TEXT,
                conteudo TEXT,
                created_at TEXT,
                embedding float[{settings.embedding_dim}]
            )"""
        )
        _conn = conn
    return _conn


# --- embedding (async, via genai) -------------------------------------------
async def gerar_embedding(texto: str) -> list[float]:
    """Gera o vetor de embedding (normalizado) de um texto.

    Usa `output_dimensionality` para truncar ao tamanho da tabela e normaliza
    (L2) — ao truncar embeddings MRL o vetor não vem normalizado, e a distância
    L2 do sqlite-vec sobre vetores normalizados equivale ao cosseno.
    """
    client = genai.Client(api_key=settings.gemini_api_key)
    resp = await client.aio.models.embed_content(
        model=settings.embedding_model,
        contents=texto,
        config=types.EmbedContentConfig(output_dimensionality=settings.embedding_dim),
    )
    vals = list(resp.embeddings[0].values)
    norma = math.sqrt(sum(x * x for x in vals)) or 1.0
    return [x / norma for x in vals]


# --- operações de banco (síncronas) -----------------------------------------
def _salvar_sync(numero: str, categoria: str, conteudo: str, embedding: list[float]) -> dict:
    numero = _norm(numero)
    vec = sqlite_vec.serialize_float32(embedding)
    with _lock:
        conn = _conexao()
        # Dedup: se já existe algo muito parecido dessa pessoa, não duplica.
        dup = conn.execute(
            "SELECT conteudo, distance FROM memorias WHERE numero = ? AND embedding MATCH ? ORDER BY distance LIMIT 1",
            [numero, vec],
        ).fetchone()
        if dup and dup[1] < settings.memoria_distancia_dedup:
            return {"status": "duplicada", "conteudo": dup[0]}

        created_at = datetime.now(ZoneInfo(settings.timezone)).isoformat()
        conn.execute(
            "INSERT INTO memorias(numero, categoria, conteudo, created_at, embedding) VALUES (?, ?, ?, ?, ?)",
            [numero, categoria, conteudo, created_at, vec],
        )

        # Teto por pessoa: poda as mais antigas (menor rowid) além do limite.
        total = conn.execute("SELECT count(*) FROM memorias WHERE numero = ?", [numero]).fetchone()[0]
        excesso = total - settings.memoria_max_por_pessoa
        if excesso > 0:
            antigas = conn.execute(
                "SELECT rowid FROM memorias WHERE numero = ? ORDER BY rowid LIMIT ?",
                [numero, excesso],
            ).fetchall()
            conn.executemany("DELETE FROM memorias WHERE rowid = ?", [(r[0],) for r in antigas])
        conn.commit()
        return {"status": "ok"}


def _top_k_sync(numero: str, embedding: list[float], k: int) -> list[dict]:
    numero = _norm(numero)
    vec = sqlite_vec.serialize_float32(embedding)
    with _lock:
        conn = _conexao()
        rows = conn.execute(
            """SELECT categoria, conteudo, distance FROM memorias
               WHERE numero = ? AND embedding MATCH ? ORDER BY distance LIMIT ?""",
            [numero, vec, k],
        ).fetchall()
    return [
        {"categoria": r[0], "conteudo": r[1], "distancia": r[2]}
        for r in rows
        if r[2] <= settings.memoria_distancia_max
    ]


def _listar_sync(numero: str) -> list[dict]:
    numero = _norm(numero)
    with _lock:
        conn = _conexao()
        rows = conn.execute(
            "SELECT rowid, categoria, conteudo, created_at FROM memorias WHERE numero = ? ORDER BY rowid",
            [numero],
        ).fetchall()
    return [{"id": r[0], "categoria": r[1], "conteudo": r[2], "created_at": r[3]} for r in rows]


def _esquecer_sync(numero: str, id_: int) -> bool:
    numero = _norm(numero)
    with _lock:
        conn = _conexao()
        cur = conn.execute("DELETE FROM memorias WHERE rowid = ? AND numero = ?", [id_, numero])
        conn.commit()
        return cur.rowcount > 0


def _contar_sync(numero: str) -> int:
    numero = _norm(numero)
    with _lock:
        conn = _conexao()
        return conn.execute("SELECT count(*) FROM memorias WHERE numero = ?", [numero]).fetchone()[0]


# --- wrappers async (não bloqueiam o event loop) ----------------------------
async def salvar(numero: str, categoria: str, conteudo: str, embedding: list[float]) -> dict:
    return await asyncio.to_thread(_salvar_sync, numero, categoria, conteudo, embedding)


async def top_k(numero: str, embedding: list[float], k: int) -> list[dict]:
    return await asyncio.to_thread(_top_k_sync, numero, embedding, k)


async def listar(numero: str) -> list[dict]:
    return await asyncio.to_thread(_listar_sync, numero)


async def esquecer(numero: str, id_: int) -> bool:
    return await asyncio.to_thread(_esquecer_sync, numero, id_)


async def contar(numero: str) -> int:
    return await asyncio.to_thread(_contar_sync, numero)
