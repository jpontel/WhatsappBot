"""Detecção de pessoas CADASTRADAS mencionadas por nome numa mensagem.

Generaliza, para TERCEIROS, o mesmo mecanismo que já existe para o próprio
remetente (`api/chat._recuperar_memorias`): se o texto menciona o nome de
alguém cadastrado, buscamos a memória dessa pessoa e injetamos ambientalmente
— sem depender do LLM decidir chamar `buscar_contato` + `listar_memorias` por
conta própria. Ver docs/PLANO-memoria-terceiros.md.
"""

import json
import logging
import re
import time

from client.roteador import _norm
from config import settings
from shared.mcp_client import chamar_mcp_texto

logger = logging.getLogger(__name__)

# Cache de processo da lista de pessoas cadastradas — evita um round-trip ao
# MCP do bot em TODO turno (cadastro muda raramente, só via /cadastrar).
_cache: tuple[float, list[dict]] | None = None


async def _listar_pessoas() -> list[dict]:
    global _cache
    agora = time.monotonic()
    if _cache is not None:
        carimbo, pessoas = _cache
        if agora - carimbo < settings.mencoes_cache_ttl_seg:
            return pessoas
    texto = await chamar_mcp_texto("listar_pessoas", {})
    pessoas = json.loads(texto) if texto else []
    _cache = (agora, pessoas)
    return pessoas


async def pessoas_mencionadas(mensagem: str, excluir_numero: str | None) -> list[dict]:
    """Pessoas cadastradas mencionadas PELO NOME no texto (dedup por numero).

    Casa qualquer token do nome (≥3 letras, para evitar falso-positivo com
    partículas curtas tipo "da"/"de") como palavra inteira no texto
    normalizado. Exclui `excluir_numero` (o próprio remetente — já coberto
    pelo caminho existente de `_recuperar_memorias`). Cap em
    `settings.memoria_mencoes_max_pessoas`.
    """
    try:
        pessoas = await _listar_pessoas()
    except Exception:  # noqa: BLE001
        logger.exception("Falha ao listar pessoas para detecção de menções")
        return []

    m = _norm(mensagem)
    encontradas: list[dict] = []
    vistos: set[str] = set()
    for pessoa in pessoas:
        numero = pessoa.get("jid")
        nome = pessoa.get("nome") or ""
        if not numero or numero == excluir_numero or numero in vistos:
            continue
        tokens = [t for t in _norm(nome).split() if len(t) >= 3]
        if any(re.search(rf"\b{re.escape(t)}\b", m) for t in tokens):
            vistos.add(numero)
            encontradas.append(pessoa)
        if len(encontradas) >= settings.memoria_mencoes_max_pessoas:
            break
    return encontradas
