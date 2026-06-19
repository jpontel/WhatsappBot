"""Garante que /chat serializa requisições por chatId (corrige o erro de
'session has been modified in storage' quando há 2 /p simultâneos no mesmo grupo).
"""

import asyncio

import api.chat as chat_mod
from schemas.chat import ChatRequest, MsgKey


def _req(chat_id: str) -> ChatRequest:
    return ChatRequest(chatId=chat_id, mensagem="oi", msgKey=MsgKey(id="1", remoteJid=chat_id))


def _instrumentar(monkeypatch):
    """Substitui sessão (no-op) e runner por um fake que mede concorrência por sessão."""
    estado = {"ativos": {}, "pico": {}, "ativos_global": 0, "pico_global": 0}

    async def _sessao_noop(_chat_id):
        return None

    monkeypatch.setattr(chat_mod, "_garantir_sessao", _sessao_noop)

    async def fake_run(*, user_id, session_id, new_message):
        estado["ativos"][session_id] = estado["ativos"].get(session_id, 0) + 1
        estado["pico"][session_id] = max(estado["pico"].get(session_id, 0), estado["ativos"][session_id])
        estado["ativos_global"] += 1
        estado["pico_global"] = max(estado["pico_global"], estado["ativos_global"])
        try:
            await asyncio.sleep(0.05)
        finally:
            estado["ativos"][session_id] -= 1
            estado["ativos_global"] -= 1
        return
        yield  # torna a função um async generator (nunca emite eventos)

    monkeypatch.setattr(chat_mod.runner, "run_async", fake_run)
    return estado


async def test_mesma_sessao_serializa(monkeypatch):
    estado = _instrumentar(monkeypatch)
    chat_mod._session_locks.clear()

    await asyncio.gather(*(chat_mod.chat(_req("grupo@g.us")) for _ in range(4)))

    # Nunca houve duas execuções simultâneas na MESMA sessão.
    assert estado["pico"]["grupo@g.us"] == 1
    assert estado["pico_global"] == 1


async def test_sessoes_diferentes_rodam_em_paralelo(monkeypatch):
    estado = _instrumentar(monkeypatch)
    chat_mod._session_locks.clear()

    await asyncio.gather(chat_mod.chat(_req("a@g.us")), chat_mod.chat(_req("b@g.us")))

    # O lock é POR sessão: sessões distintas rodam em paralelo (pico global = 2).
    assert estado["pico_global"] == 2
