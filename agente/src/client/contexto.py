"""Injeção EFÊMERA do contexto recente no prompt do turno.

O bot manda no `/chat` um campo `contexto`: as últimas N mensagens do chat ANTES
da mensagem-gatilho (já SEM o gatilho). Essas mensagens servem de pano de fundo
para o LLM entender o pedido — mas NÃO podem virar histórico permanente.

Por isso elas NÃO entram na `Content` enviada ao runner (que o ADK persistiria na
sessão). Em vez disso, este `before_model_callback` as injeta DIRETO no
`llm_request.contents` do turno — igual ao `historico.py`, que muta a janela
enviada ao modelo sem tocar no banco. Resultado: o bloco de contexto existe só
durante aquela chamada ao modelo e some depois (efêmero, não-cumulativo).

Impacto em tokens ([SEGURANÇA]): acréscimo FIXO por-turno (não cresce com a
conversa — não é persistido) e com teto por QUANTIDADE (`contexto_max_itens`).
"""

import logging

from google.adk.models.llm_request import LlmRequest
from google.genai import types

from config import settings
from shared import request_context

logger = logging.getLogger(__name__)


def injetar_contexto(callback_context, llm_request: LlmRequest):  # noqa: ANN001 - assinatura ADK
    """Insere o bloco `[contexto-recente]` logo antes da mensagem-gatilho.

    Lê o buffer de `request_context.contexto_atual()`. Vazio/None → não faz nada.
    Aplica o clamp `settings.contexto_max_itens` (defesa caso o payload venha
    maior que o teto) e monta UM `types.Content(role="user")` com uma linha por
    mensagem no formato `Autor: texto`. Insere imediatamente ANTES da última
    `Content` (a mensagem-gatilho do turno) — dois turnos `user` seguidos são
    válidos para o Gemini. Só muta `llm_request.contents`; NUNCA grava na sessão.

    Retorna None: apenas mutamos `llm_request.contents` in-place e seguimos.
    """
    itens = request_context.contexto_atual()
    if not itens:
        return None

    # Clamp defensivo por quantidade: fica só com as últimas N (mais recentes).
    if len(itens) > settings.contexto_max_itens:
        itens = itens[-settings.contexto_max_itens:]

    linhas: list[str] = []
    for msg in itens:
        autor = getattr(msg, "autor", None)
        texto = getattr(msg, "texto", None) or ""
        linhas.append(f"{autor}: {texto}" if autor else texto)

    bloco = (
        "[contexto-recente]\n"
        "(metadado silencioso: últimas mensagens do chat ANTES de te acionarem — "
        "pano de fundo para entender o pedido; NÃO responda a elas diretamente, "
        "NÃO as repita)\n"
        + "\n".join(linhas)
    )

    content = types.Content(role="user", parts=[types.Part(text=bloco)])

    contents = llm_request.contents
    if contents:
        # Insere logo ANTES da última Content (a mensagem-gatilho do turno).
        contents.insert(len(contents) - 1, content)
    else:
        # Fallback seguro: contents vazio/estranho → só anexa, sem quebrar.
        llm_request.contents = [content]

    logger.info("Contexto recente injetado: %d mensagens.", len(linhas))
    return None
