"""Testes do FallbackGemini: troca de modelo em 429/503, sem depender da API real."""

import pytest
from google.adk.models import Gemini
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from google.genai.errors import ClientError, ServerError

from client.fallback_model import FallbackGemini


def _erro_sobrecarga(code: int) -> Exception:
    status = "UNAVAILABLE" if code == 503 else "RESOURCE_EXHAUSTED"
    corpo = {"error": {"message": "indisponível", "status": status}}
    return (ServerError if code == 503 else ClientError)(code, corpo)


def _resposta(texto: str) -> LlmResponse:
    return LlmResponse(content=types.Content(role="model", parts=[types.Part(text=texto)]))


def _fake_gemini(falham: set[str]):
    """Cria um generate_content_async falso: 503 para modelos em `falham`, senão responde."""

    async def fake(self, llm_request, stream=False):  # noqa: ANN001
        if llm_request.model in falham:
            raise _erro_sobrecarga(503)
        yield _resposta(f"ok:{llm_request.model}")

    return fake


async def test_cai_para_o_proximo_em_503(monkeypatch):
    chamados = []

    async def fake(self, llm_request, stream=False):  # noqa: ANN001
        chamados.append(llm_request.model)
        if llm_request.model == "primario":
            raise _erro_sobrecarga(503)
        yield _resposta(f"ok:{llm_request.model}")

    monkeypatch.setattr(Gemini, "generate_content_async", fake)

    modelo = FallbackGemini(model="primario", fallback_models=["secundario", "terciario"])
    respostas = [r async for r in modelo.generate_content_async(LlmRequest(model="primario"))]

    assert chamados == ["primario", "secundario"]
    assert [r.content.parts[0].text for r in respostas] == ["ok:secundario"]


async def test_429_tambem_dispara_fallback(monkeypatch):
    chamados = []

    async def fake(self, llm_request, stream=False):  # noqa: ANN001
        chamados.append(llm_request.model)
        if llm_request.model in {"primario", "secundario"}:
            raise _erro_sobrecarga(429)
        yield _resposta(f"ok:{llm_request.model}")

    monkeypatch.setattr(Gemini, "generate_content_async", fake)

    modelo = FallbackGemini(model="primario", fallback_models=["secundario", "terciario"])
    respostas = [r async for r in modelo.generate_content_async(LlmRequest(model="primario"))]

    assert chamados == ["primario", "secundario", "terciario"]
    assert [r.content.parts[0].text for r in respostas] == ["ok:terciario"]


async def test_primario_ok_nao_usa_fallback(monkeypatch):
    monkeypatch.setattr(Gemini, "generate_content_async", _fake_gemini(falham=set()))

    modelo = FallbackGemini(model="primario", fallback_models=["secundario"])
    respostas = [r async for r in modelo.generate_content_async(LlmRequest(model="primario"))]

    assert [r.content.parts[0].text for r in respostas] == ["ok:primario"]


async def test_erro_nao_sobrecarga_propaga(monkeypatch):
    async def fake(self, llm_request, stream=False):  # noqa: ANN001
        raise ClientError(400, {"error": {"message": "ruim", "status": "INVALID_ARGUMENT"}})
        yield  # torna a função um gerador

    monkeypatch.setattr(Gemini, "generate_content_async", fake)

    modelo = FallbackGemini(model="primario", fallback_models=["secundario"])
    with pytest.raises(ClientError):
        [r async for r in modelo.generate_content_async(LlmRequest(model="primario"))]


async def test_esgota_fallbacks_propaga_ultimo_erro(monkeypatch):
    monkeypatch.setattr(
        Gemini, "generate_content_async", _fake_gemini(falham={"primario", "secundario"})
    )

    modelo = FallbackGemini(model="primario", fallback_models=["secundario"])
    with pytest.raises(ServerError):
        [r async for r in modelo.generate_content_async(LlmRequest(model="primario"))]
