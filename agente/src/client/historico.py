"""Corte de histórico antes de chamar o modelo.

O ADK (`DatabaseSessionService`) carrega e reenvia a SESSÃO INTEIRA a cada
turno — todos os eventos desde a primeira mensagem. Isso tem dois custos:

1. tokens/latência crescem sem teto conforme a conversa envelhece;
2. o modelo passa a IMITAR chamadas de tool antigas que estão no histórico,
   inclusive nomes errados que ele mesmo alucinou no passado (foi o que
   travou o sticker: `enviar_sticker_gerado` gravado e copiado indefinidamente).

Aqui registramos um `before_model_callback` que mantém só as últimas
`settings.historico_max_itens` entradas de `llm_request.contents`. Não toca no
banco — só limita o que vai para o LLM naquele turno.
"""

import logging

from google.adk.models.llm_request import LlmRequest
from google.genai import types

from config import settings

logger = logging.getLogger(__name__)


def _tem_function_response(content: types.Content) -> bool:
    """True se a entrada carrega um `function_response` (resultado de tool)."""
    for parte in content.parts or []:
        if getattr(parte, "function_response", None) is not None:
            return True
    return False


def _eh_mensagem_usuario(content: types.Content) -> bool:
    """True se a entrada é uma mensagem REAL do usuário (não resultado de tool).

    Início válido para o Gemini: a janela tem de abrir num turno de usuário.
    Resultados de tool chegam com role 'user' mas carregam `function_response`
    — não contam como início válido.
    """
    return content.role == "user" and not _tem_function_response(content)


def limitar_historico(callback_context, llm_request: LlmRequest):  # noqa: ANN001 - assinatura ADK
    """Mantém só as últimas N entradas do histórico enviado ao modelo.

    Cuidado com o pareamento: o Gemini rejeita uma `function_response` sem o
    `function_call` par ("function_response without function_call") E uma
    `function_call` que não venha logo após um turno de usuário ou de
    `function_response` ("function call turn comes immediately after a user
    turn..."). Esse segundo caso acontecia quando um turno morria com a tool
    alucinada/com erro: ficava gravada uma `function_call` órfã que, depois do
    corte, caía no INÍCIO da janela e derrubava todos os turnos seguintes.

    Por isso, depois de cortar, descartamos do INÍCIO da janela tudo que não
    seja uma mensagem real do usuário — garantindo que ela sempre comece num
    início válido (sem `function_response`/`function_call` órfã na frente).

    Retorna None: apenas mutamos `llm_request.contents` in-place e seguimos.
    """
    contents = llm_request.contents or []
    limite = settings.historico_max_itens
    if len(contents) <= limite:
        return None

    janela = contents[-limite:]

    # A janela tem de abrir numa mensagem real do usuário: descarta do começo
    # function_response/function_call órfãs (a chamada/resposta par ficou fora).
    while janela and not _eh_mensagem_usuario(janela[0]):
        janela.pop(0)

    removidos = len(contents) - len(janela)
    if removidos > 0:
        logger.info("Histórico cortado: %d entradas antigas omitidas (mantidas %d).", removidos, len(janela))
    llm_request.contents = janela
    return None
