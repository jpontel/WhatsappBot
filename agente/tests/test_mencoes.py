"""Testes de detecção de pessoas cadastradas mencionadas por nome."""

import json

import client.mencoes as mencoes
from config import settings

_PESSOAS = [
    {"nome": "Aline", "jid": "A1"},
    {"nome": "Andrei Souza", "jid": "A2"},
    {"nome": "Jo", "jid": "A3"},  # nome curto — não deve casar (< 3 letras)
]


def _fake_listar(pessoas=_PESSOAS):
    async def _f(_tool, _args):
        return json.dumps(pessoas)

    return _f


def _reset_cache(monkeypatch):
    monkeypatch.setattr(mencoes, "_cache", None)


async def test_detecta_nome_mencionado(monkeypatch):
    _reset_cache(monkeypatch)
    monkeypatch.setattr(mencoes, "chamar_mcp_texto", _fake_listar())

    achados = await mencoes.pessoas_mencionadas("qual a comida favorita da Aline?", None)
    assert [p["jid"] for p in achados] == ["A1"]


async def test_normaliza_acento_e_caixa(monkeypatch):
    _reset_cache(monkeypatch)
    monkeypatch.setattr(mencoes, "chamar_mcp_texto", _fake_listar())

    achados = await mencoes.pessoas_mencionadas("e o ANDREI, o que ele gosta?", None)
    assert [p["jid"] for p in achados] == ["A2"]


async def test_exclui_proprio_remetente(monkeypatch):
    _reset_cache(monkeypatch)
    monkeypatch.setattr(mencoes, "chamar_mcp_texto", _fake_listar())

    achados = await mencoes.pessoas_mencionadas("Aline, cadê você?", "A1")
    assert achados == []


async def test_nao_casa_nome_curto(monkeypatch):
    _reset_cache(monkeypatch)
    monkeypatch.setattr(mencoes, "chamar_mcp_texto", _fake_listar())

    achados = await mencoes.pessoas_mencionadas("jo jo jo, feliz natal", None)
    assert achados == []


async def test_cap_max_pessoas(monkeypatch):
    _reset_cache(monkeypatch)
    pessoas = [{"nome": f"Nome{i}", "jid": f"J{i}"} for i in range(5)]
    monkeypatch.setattr(mencoes, "chamar_mcp_texto", _fake_listar(pessoas))
    monkeypatch.setattr(settings, "memoria_mencoes_max_pessoas", 2)

    texto = " ".join(p["nome"] for p in pessoas)
    achados = await mencoes.pessoas_mencionadas(texto, None)
    assert len(achados) == 2


async def test_cache_evita_segunda_chamada_mcp(monkeypatch):
    _reset_cache(monkeypatch)
    chamadas = []

    async def _contador(_tool, _args):
        chamadas.append(1)
        return json.dumps(_PESSOAS)

    monkeypatch.setattr(mencoes, "chamar_mcp_texto", _contador)
    monkeypatch.setattr(settings, "mencoes_cache_ttl_seg", 60.0)

    await mencoes.pessoas_mencionadas("Aline por aqui", None)
    await mencoes.pessoas_mencionadas("Aline de novo", None)
    assert len(chamadas) == 1


async def test_falha_no_mcp_devolve_lista_vazia(monkeypatch):
    _reset_cache(monkeypatch)

    async def _explode(_tool, _args):
        raise RuntimeError("mcp fora do ar")

    monkeypatch.setattr(mencoes, "chamar_mcp_texto", _explode)

    achados = await mencoes.pessoas_mencionadas("Aline, cadê?", None)
    assert achados == []
