"""Locks de sessão por chatId, compartilhados entre o /chat e a rotina de retry.

A sessão do ADK é por chatId (= JID). Dois acessos simultâneos à mesma sessão
(dois /chat no mesmo grupo, ou um /chat concorrendo com o retry) colidiam ->
"session has been modified in storage". Serializamos por chatId com um lock
dedicado, vivendo aqui para ser reusado por ambos os lados.
"""

import asyncio

_session_locks: dict[str, asyncio.Lock] = {}


def lock_da_sessao(chat_id: str) -> asyncio.Lock:
    # setdefault não dá await -> atômico no loop asyncio (sem race ao criar).
    return _session_locks.setdefault(chat_id, asyncio.Lock())
