"""Testes do salvamento forçado (tool_config=ANY restrito a salvar_memoria).

Cobre:
- `deve_forcar_salvamento`: gatilho da rota "memoria" + guard de conteúdo
  mínimo (≥3 palavras após o verbo-gatilho), fatiando a mensagem NORMALIZADA
  de ponta a ponta.
- `forcar_salvamento` (before_model_callback): só seta tool_config=ANY na 1ª
  chamada do turno — usando `google.genai.types.Part`/`Content` DE VERDADE
  (não um dublê com atributo solto), para não escapar de uma regressão no
  nome do atributo (`function_response`, snake_case).
"""

from google.adk.models import LlmRequest
from google.genai import types

import client.roteador as roteador
import shared.request_context as rc


def test_deve_forcar_com_conteudo_substancial():
    assert roteador.deve_forcar_salvamento("guarda que a Aline nasceu em março") is True


def test_deve_forcar_com_acento_e_maiuscula():
    assert roteador.deve_forcar_salvamento("ANOTA que o Andrei adora Legião Urbana") is True


def test_nao_forca_sem_conteudo_substancial():
    # só o verbo-gatilho, sem fato nenhum depois.
    assert roteador.deve_forcar_salvamento("anota que") is False


def test_nao_forca_mensagem_sem_gatilho():
    assert roteador.deve_forcar_salvamento("oi, como você está?") is False


def test_forca_com_frase_trivial_mas_com_3_palavras(monkeypatch):
    # Guard é só "3+ palavras depois", não qualidade do conteúdo — risco
    # residual aceito e documentado no plano.
    assert roteador.deve_forcar_salvamento("nao esquece que hoje e sexta") is True


def _llm_request(tools_names=("salvar_memoria",), function_response=False) -> LlmRequest:
    fds = [types.FunctionDeclaration(name=n) for n in tools_names]
    config = types.GenerateContentConfig(tools=[types.Tool(function_declarations=fds)])
    parts = [types.Part(text="oi")]
    if function_response:
        parts.append(
            types.Part(function_response=types.FunctionResponse(name="salvar_memoria", response={"status": "ok"}))
        )
    content = types.Content(role="user", parts=parts)
    return LlmRequest(model="x", contents=[content], config=config)


def test_forca_na_1a_chamada_do_turno():
    req = _llm_request()
    tokens = rc.definir_rota("memoria", frozenset({"salvar_memoria"}), "", True)
    try:
        roteador.forcar_salvamento(None, req)
        assert req.config.tool_config is not None
        assert req.config.tool_config.function_calling_config.mode == types.FunctionCallingConfigMode.ANY
        assert req.config.tool_config.function_calling_config.allowed_function_names == ["salvar_memoria"]
    finally:
        rc.limpar_rota(tokens)


def test_nao_forca_na_2a_chamada_do_turno_apos_tool_response():
    req = _llm_request(function_response=True)
    tokens = rc.definir_rota("memoria", frozenset({"salvar_memoria"}), "", True)
    try:
        roteador.forcar_salvamento(None, req)
        assert req.config.tool_config is None
    finally:
        rc.limpar_rota(tokens)


def test_nao_forca_quando_gatilho_desligado():
    req = _llm_request()
    tokens = rc.definir_rota("memoria", frozenset({"salvar_memoria"}), "", False)
    try:
        roteador.forcar_salvamento(None, req)
        assert req.config.tool_config is None
    finally:
        rc.limpar_rota(tokens)


def test_turno_ja_executou_tool_le_atributo_snake_case():
    req = _llm_request(function_response=True)
    assert roteador._turno_ja_executou_tool(req) is True


def test_turno_nao_executou_tool_sem_function_response():
    req = _llm_request(function_response=False)
    assert roteador._turno_ja_executou_tool(req) is False
