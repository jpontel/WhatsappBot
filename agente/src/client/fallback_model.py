"""Modelo Gemini com fallback automático.

O `gemini-3-flash-preview` (preview) sofre com frequência erros de
`503 UNAVAILABLE` (high demand) e `429 RESOURCE_EXHAUSTED` (cota/uso). Quando
isso acontece, este wrapper troca para o próximo modelo da lista de fallback,
de forma transparente para o agente/sessão (a troca é no nível da chamada ao LLM).
"""

import copy
import logging
from typing import AsyncGenerator

from google.adk.models import Gemini
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai.errors import ClientError, ServerError

logger = logging.getLogger("google_adk.agente.fallback")

# 429 = RESOURCE_EXHAUSTED (cota/uso); 503 = UNAVAILABLE (high demand).
_CODIGOS_SOBRECARGA = {429, 503}


def _eh_sobrecarga(exc: Exception) -> bool:
    return isinstance(exc, (ClientError, ServerError)) and getattr(exc, "code", None) in _CODIGOS_SOBRECARGA


def _eh_creditos_esgotados(exc: Exception) -> bool:
    """429 de billing (conta sem crédito), não sobrecarga de um modelo.

    É inútil cair para outro modelo: o limite é da conta/projeto, então todos
    falham igual. Detectamos pela mensagem ('credits are depleted'/'billing')
    para abortar o fallback de imediato.
    """
    msg = str(exc).lower()
    return "credits are depleted" in msg or "billing" in msg


class FallbackGemini(Gemini):
    """Gemini que cai para o próximo modelo em erros de sobrecarga (429/503)."""

    fallback_models: list[str] = []

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        # Ordem: primário + fallbacks (sem repetir o primário).
        modelos = [self.model] + [m for m in self.fallback_models if m != self.model]

        # `super()` muta contents/config (system instruction, tools, append de
        # user content). Guardamos o estado original para restaurar a cada tentativa.
        contents_orig = copy.deepcopy(llm_request.contents)
        config_orig = copy.deepcopy(llm_request.config)

        for i, modelo in enumerate(modelos):
            if i > 0:
                llm_request.contents = copy.deepcopy(contents_orig)
                llm_request.config = copy.deepcopy(config_orig)
            llm_request.model = modelo

            ja_emitiu = False
            try:
                async for resposta in super().generate_content_async(llm_request, stream):
                    ja_emitiu = True
                    yield resposta
                return
            except (ClientError, ServerError) as exc:
                # Créditos esgotados é problema da conta inteira: nenhum modelo
                # vai responder. Aborta o fallback na hora (não desperdiça tentativas).
                if _eh_creditos_esgotados(exc):
                    logger.error(
                        "Créditos da conta Gemini esgotados (code=%s); abortando fallback",
                        getattr(exc, "code", "?"),
                    )
                    raise
                # Só troca de modelo se foi sobrecarga, ainda há fallback e nada
                # foi emitido (não dá para trocar no meio de um stream já iniciado).
                if _eh_sobrecarga(exc) and not ja_emitiu and i < len(modelos) - 1:
                    proximo = modelos[i + 1]
                    logger.warning(
                        "Modelo %s sobrecarregado (code=%s); caindo para %s",
                        modelo,
                        getattr(exc, "code", "?"),
                        proximo,
                    )
                    continue
                raise
