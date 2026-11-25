"""Classificador de TOM e COMPLEXIDADE do turno (sensor por LLM leve — Opção C).

Lê a mensagem atual + um pedaço curto do contexto e devolve `{tom, complexidade}`.
O resultado calibra a resposta de forma determinística (em vez do sorteio cego de
humor): o `tom` escolhe o BALDE de estilos (gate) e a `complexidade` vira uma dica
de tamanho. Ver docs/PLANO-classificador-tom-complexidade.md.

Otimizações: modelo mais barato (flash-lite), prompt fixo curto, contexto enxuto,
saída estruturada (enum), timeout curto e short-circuit determinístico para os
casos triviais (pula a chamada LLM). Qualquer falha cai no fallback NEUTRO — nunca
derruba o turno. Roda em paralelo com memória/rosto no `gather` do /chat.
"""

import asyncio
import json
import logging
import re
from dataclasses import dataclass

from google import genai
from google.genai import types

from config import settings
from schemas.chat import ChatRequest, MensagemContexto

logger = logging.getLogger(__name__)


@dataclass
class Classificacao:
    tom: str  # "serio" | "neutro" | "leve"
    complexidade: str  # "baixa" | "media" | "alta"

    def dica_tamanho(self) -> str:
        return {"baixa": "curto", "media": "médio", "alta": "longo"}.get(self.complexidade, "médio")


# Fallback seguro: registro neutro, tamanho médio. Usado quando o classificador
# está desligado, falha, estoura timeout ou devolve algo inválido.
_FALLBACK = Classificacao(tom="neutro", complexidade="media")

_COMPLEXIDADES = {"baixa", "media", "alta"}

# Short-circuit CONSERVADOR: só pula o LLM para mensagens inequivocamente leves e
# triviais (saudação/risada/agradecimento curtos). Qualquer outra coisa vai pro
# classificador — para NÃO correr o risco de assumir "leve" num desabafo curto.
_TRIVIAL_LEVE = re.compile(
    r"^(oi+|ol[áa]|e?a[íi]|opa|bom dia|boa (tarde|noite)|kk+|he+|ha+|rs+|haha+|"
    r"valeu|vlw|blz|beleza|ok|okay|tmj|obrigad[oa]|vlws?)[\s!?.…😂🤣👍🙏❤️]*$",
    re.IGNORECASE,
)

_SYSTEM = (
    "Você classifica UMA mensagem de chat em pt-BR para calibrar a resposta de um bot. "
    "Devolva SOMENTE o JSON do schema, sem texto extra.\n"
    "tom:\n"
    "- 'serio': assunto sensível/pesado — luto, morte, doença, problema sério, "
    "desabafo emocional, pedido de ajuda real, tristeza.\n"
    "- 'leve': brincadeira, zoeira, provocação, flerte, casual divertido.\n"
    "- 'neutro': informativo/factual sem carga emocional.\n"
    "complexidade:\n"
    "- 'baixa': sim/não, saudação, comentário trivial.\n"
    "- 'media': curiosidade ou pergunta comum.\n"
    "- 'alta': explicação técnica, assunto com várias partes ou que exige raciocínio."
)

_SCHEMA = {
    "type": "object",
    "properties": {
        "tom": {"type": "string", "enum": ["serio", "neutro", "leve"]},
        "complexidade": {"type": "string", "enum": ["baixa", "media", "alta"]},
    },
    "required": ["tom", "complexidade"],
}


def _formatar_contexto(contexto: list[MensagemContexto]) -> str:
    recentes = contexto[-settings.classificador_contexto_max:]
    if not recentes:
        return ""
    linhas = "\n".join(f"{m.autor or '?'}: {m.texto}" for m in recentes)
    return f"[contexto recente]\n{linhas}\n"


async def classificar_turno(req: ChatRequest) -> Classificacao:
    """Classifica o turno. Nunca levanta — devolve o fallback em qualquer erro."""
    if not settings.classificador_ativo:
        return _FALLBACK

    msg = (req.mensagem or "").strip()
    # Mensagem vazia (só menção/mídia) ou trivialmente leve → sem gastar LLM.
    if not msg:
        return _FALLBACK
    if _TRIVIAL_LEVE.match(msg):
        return Classificacao(tom="leve", complexidade="baixa")

    try:
        prompt = f"{_formatar_contexto(req.contexto)}[mensagem a classificar]\n{msg}"
        client = genai.Client(api_key=settings.gemini_api_key)
        resp = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=settings.gemini_model_classificador,
                contents=prompt,
                config=types.GenerateContentConfig(
                    system_instruction=_SYSTEM,
                    response_mime_type="application/json",
                    response_schema=_SCHEMA,
                    temperature=0,
                    max_output_tokens=50,
                ),
            ),
            timeout=settings.classificador_timeout_seg,
        )
        dados = json.loads(resp.text or "{}")
        tom = dados.get("tom")
        comp = dados.get("complexidade")
        if tom not in settings.estilos_por_tom or comp not in _COMPLEXIDADES:
            logger.warning("Classificador devolveu valores inválidos: %r", dados)
            return _FALLBACK
        logger.info("Classificador: tom=%s complexidade=%s", tom, comp)
        return Classificacao(tom=tom, complexidade=comp)
    except Exception:  # noqa: BLE001 - classificador nunca derruba o turno
        logger.warning("Classificador falhou — usando fallback neutro", exc_info=True)
        return _FALLBACK
