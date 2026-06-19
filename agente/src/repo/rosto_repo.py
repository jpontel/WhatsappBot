"""Memória visual: reconhecimento facial de pessoas cadastradas (vetorial).

Espelha o `memoria_repo` (mesmo `agente.db`, sqlite-vec, conexão dedicada,
operações síncronas expostas via `asyncio.to_thread`), mas para ROSTOS:

- Espaço vetorial PRÓPRIO e SEPARADO do texto: o embedding facial vem de um
  modelo dedicado de face-recognition (InsightFace/ArcFace, 512-d), NÃO do
  `gemini-embedding-001`. Identidade de rosto é outra tarefa que embedding
  semântico de texto/imagem não resolve.
- A tabela `rostos` NÃO é particionada por `numero`: a busca é JUSTAMENTE entre
  pessoas ("de quem é este rosto?"). `numero` é só metadado para gerir/apagar.
- Uma pessoa pode ter várias fotos de referência (melhor recall), com teto.

O modelo InsightFace é carregado LAZY (1ª chamada) — importar este módulo não
puxa onnxruntime/opencv nem carrega pesos, pra não pesar no boot do agente.
"""

import asyncio
import base64
import sqlite3
import threading
from datetime import datetime
from zoneinfo import ZoneInfo

import sqlite_vec

from config import settings

# --- conexão única (carrega a extensão uma vez) -----------------------------
_conn: sqlite3.Connection | None = None
_lock = threading.Lock()

# --- modelo InsightFace (carregado lazy, uma vez) ---------------------------
_app = None
_app_lock = threading.Lock()


def _caminho_db() -> str:
    # "sqlite+aiosqlite:///./agente.db" -> "./agente.db" (prod: "./data/agente.db")
    url = settings.database_url
    return url.split("///", 1)[1] if "///" in url else "agente.db"


def _conexao() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        conn = sqlite3.connect(_caminho_db(), check_same_thread=False)
        # Compartilha o arquivo com o ADK e o memoria_repo; espera o lock em vez
        # de estourar "database is locked".
        conn.execute("PRAGMA busy_timeout=5000")
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)
        # numero é metadado comum (NÃO partition key): a busca KNN roda sobre
        # TODAS as pessoas. Distância L2 sobre embeddings normalizados ≈ cosseno.
        conn.execute(
            f"""CREATE VIRTUAL TABLE IF NOT EXISTS rostos USING vec0(
                numero TEXT,
                nome TEXT,
                created_at TEXT,
                embedding float[{settings.rosto_embedding_dim}]
            )"""
        )
        # Foto de referência por pessoa (tabela REGULAR, não vetorial): alimenta a
        # geração de imagem "faça uma imagem com o X e a Y". Uma por pessoa (a
        # última substitui). O vetor (acima) é p/ reconhecer; a foto é p/ gerar.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS rostos_fotos(
                numero TEXT PRIMARY KEY,
                nome TEXT,
                foto BLOB,
                mimetype TEXT,
                created_at TEXT
            )"""
        )
        _conn = conn
    return _conn


# --- embedding facial (InsightFace, lazy) -----------------------------------
def _obter_app():
    """Devolve o app InsightFace, carregando-o (uma vez) na primeira chamada.

    Import e carga de pesos ficam aqui dentro de propósito: só paga quem usa
    rosto, e o boot do agente não depende de onnxruntime/opencv.
    """
    global _app
    if _app is None:
        with _app_lock:
            if _app is None:
                from insightface.app import FaceAnalysis

                # CPU explícito (sem GPU na Linode). det_size menor = mais leve.
                app = FaceAnalysis(
                    name=settings.rosto_model,
                    providers=["CPUExecutionProvider"],
                )
                app.prepare(ctx_id=0, det_size=(640, 640))
                _app = app
    return _app


def _embeddings_faciais_sync(imagem: dict, max_faces: int) -> list[list[float]]:
    """Detecta rostos numa imagem e devolve seus embeddings (512-d, L2-norm).

    Retorna até `max_faces` embeddings, ordenados do rosto mais proeminente
    (maior área de bounding box) para o menor. Lista vazia se não achar rosto
    ou se a imagem não decodificar.
    """
    import cv2
    import numpy as np

    raw = base64.b64decode(imagem["base64"])
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)  # InsightFace espera BGR (como o cv2)
    if img is None:
        return []

    faces = _obter_app().get(img)
    if not faces:
        return []

    def _area(f) -> float:  # noqa: ANN001
        x1, y1, x2, y2 = f.bbox
        return float((x2 - x1) * (y2 - y1))

    faces.sort(key=_area, reverse=True)
    return [f.normed_embedding.tolist() for f in faces[:max_faces]]


# --- operações de banco (síncronas) -----------------------------------------
def _salvar_rosto_sync(numero: str, nome: str, embedding: list[float]) -> dict:
    vec = sqlite_vec.serialize_float32(embedding)
    with _lock:
        conn = _conexao()
        # Dedup: se essa MESMA pessoa já tem um rosto quase idêntico, não duplica
        # (evita gastar slot com o mesmo frame). Match limitado ao próprio numero.
        dup = conn.execute(
            "SELECT distance FROM rostos WHERE numero = ? AND embedding MATCH ? ORDER BY distance LIMIT 1",
            [numero, vec],
        ).fetchone()
        if dup and dup[0] < settings.rosto_distancia_dedup:
            return {"status": "duplicada"}

        created_at = datetime.now(ZoneInfo(settings.timezone)).isoformat()
        conn.execute(
            "INSERT INTO rostos(numero, nome, created_at, embedding) VALUES (?, ?, ?, ?)",
            [numero, nome, created_at, vec],
        )

        # Teto por pessoa: poda as mais antigas (menor rowid) além do limite.
        total = conn.execute("SELECT count(*) FROM rostos WHERE numero = ?", [numero]).fetchone()[0]
        excesso = total - settings.rosto_max_por_pessoa
        if excesso > 0:
            antigas = conn.execute(
                "SELECT rowid FROM rostos WHERE numero = ? ORDER BY rowid LIMIT ?",
                [numero, excesso],
            ).fetchall()
            conn.executemany("DELETE FROM rostos WHERE rowid = ?", [(r[0],) for r in antigas])
        conn.commit()
        return {"status": "ok"}


def _reconhecer_sync(embedding: list[float], limiar: float) -> dict | None:
    vec = sqlite_vec.serialize_float32(embedding)
    with _lock:
        conn = _conexao()
        # SEM filtro de numero: procura o rosto mais próximo ENTRE TODAS as pessoas.
        row = conn.execute(
            "SELECT numero, nome, distance FROM rostos WHERE embedding MATCH ? ORDER BY distance LIMIT 1",
            [vec],
        ).fetchone()
    if not row or row[2] > limiar:
        return None
    return {"numero": row[0], "nome": row[1], "distancia": row[2]}


def _listar_rostos_sync(numero: str) -> list[dict]:
    with _lock:
        conn = _conexao()
        rows = conn.execute(
            "SELECT rowid, nome, created_at FROM rostos WHERE numero = ? ORDER BY rowid",
            [numero],
        ).fetchall()
    return [{"id": r[0], "nome": r[1], "created_at": r[2]} for r in rows]


def _esquecer_rosto_sync(numero: str) -> int:
    with _lock:
        conn = _conexao()
        cur = conn.execute("DELETE FROM rostos WHERE numero = ?", [numero])
        conn.execute("DELETE FROM rostos_fotos WHERE numero = ?", [numero])  # foto junto
        conn.commit()
        return cur.rowcount


def _salvar_foto_rosto_sync(numero: str, nome: str, imagem: dict) -> dict:
    """Guarda a foto de referência da pessoa (uma por pessoa; a última substitui)."""
    foto = base64.b64decode(imagem["base64"])
    mimetype = imagem.get("mimetype") or "image/jpeg"
    created_at = datetime.now(ZoneInfo(settings.timezone)).isoformat()
    with _lock:
        conn = _conexao()
        conn.execute(
            """INSERT INTO rostos_fotos(numero, nome, foto, mimetype, created_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(numero) DO UPDATE SET
                 nome=excluded.nome, foto=excluded.foto,
                 mimetype=excluded.mimetype, created_at=excluded.created_at""",
            [numero, nome, foto, mimetype, created_at],
        )
        conn.commit()
    return {"status": "ok"}


def normalizar_numero(numero: str) -> str:
    """Parte de usuário do JID (antes do '@'), pra casar números de forma robusta.

    A foto é guardada com o JID completo (`5547...@s.whatsapp.net`), mas o LLM às
    vezes passa o número "limpo" (só os dígitos) pra tool de geração. Comparar só
    a parte antes do '@' faz os dois casarem (ex.: "5547..." == "5547...@s.whatsapp.net").
    """
    return (numero or "").split("@", 1)[0].strip()


def _fotos_de_sync(numeros: list[str]) -> list[dict]:
    """Fotos de referência das pessoas pedidas que TÊM foto guardada.

    Match por parte-de-usuário (ver `normalizar_numero`): tolera o LLM passar o
    número com ou sem o sufixo `@s.whatsapp.net`.
    """
    alvo = {normalizar_numero(n) for n in (numeros or []) if normalizar_numero(n)}
    if not alvo:
        return []
    with _lock:
        conn = _conexao()
        # 1) acha os JIDs guardados cuja parte-de-usuário casa (sem carregar BLOBs);
        todos = conn.execute("SELECT numero FROM rostos_fotos").fetchall()
        casados = [r[0] for r in todos if normalizar_numero(r[0]) in alvo]
        if not casados:
            return []
        # 2) carrega só as fotos casadas.
        placeholders = ",".join("?" for _ in casados)
        rows = conn.execute(
            f"SELECT numero, nome, foto, mimetype FROM rostos_fotos WHERE numero IN ({placeholders})",
            casados,
        ).fetchall()
    return [
        {
            "numero": r[0],
            "nome": r[1],
            "base64": base64.b64encode(r[2]).decode("utf-8"),
            "mimetype": r[3],
        }
        for r in rows
    ]


def _contar_sync() -> int:
    """Total de rostos cadastrados (todas as pessoas) — para o early-out."""
    with _lock:
        conn = _conexao()
        return conn.execute("SELECT count(*) FROM rostos").fetchone()[0]


# --- wrappers async (não bloqueiam o event loop) ----------------------------
async def gerar_embeddings_faciais(imagem: dict, max_faces: int) -> list[list[float]]:
    return await asyncio.to_thread(_embeddings_faciais_sync, imagem, max_faces)


async def salvar_rosto(numero: str, nome: str, embedding: list[float]) -> dict:
    return await asyncio.to_thread(_salvar_rosto_sync, numero, nome, embedding)


async def reconhecer(embedding: list[float], limiar: float) -> dict | None:
    return await asyncio.to_thread(_reconhecer_sync, embedding, limiar)


async def listar_rostos(numero: str) -> list[dict]:
    return await asyncio.to_thread(_listar_rostos_sync, numero)


async def esquecer_rosto(numero: str) -> int:
    return await asyncio.to_thread(_esquecer_rosto_sync, numero)


async def salvar_foto_rosto(numero: str, nome: str, imagem: dict) -> dict:
    return await asyncio.to_thread(_salvar_foto_rosto_sync, numero, nome, imagem)


async def fotos_de(numeros: list[str]) -> list[dict]:
    return await asyncio.to_thread(_fotos_de_sync, numeros)


async def contar() -> int:
    return await asyncio.to_thread(_contar_sync)
