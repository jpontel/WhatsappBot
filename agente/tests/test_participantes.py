"""Testes da tool `listar_participantes` (lista de membros do grupo, lado agente).

O MCP do bot é mockado; validamos o contrato: monta os args certos, parseia o
JSON e trata vazio/erro como dict (sem levantar).
"""

import json

import tools.tools as tools


async def test_listar_participantes_parseia_json(monkeypatch):
    lista = [
        {"nome": "Guigo", "cadastrado": True},
        {"nome": "5547999", "cadastrado": False},
    ]

    async def fake_texto(tool, args):
        assert tool == "listar_participantes_grupo"
        assert args == {"jid": "120@g.us"}
        return json.dumps(lista)

    monkeypatch.setattr(tools, "chamar_mcp_texto", fake_texto)

    res = await tools.listar_participantes("120@g.us")

    assert res["participantes"] == lista


async def test_listar_participantes_vazio_avisa(monkeypatch):
    async def fake_texto(tool, args):
        return "[]"

    monkeypatch.setattr(tools, "chamar_mcp_texto", fake_texto)

    res = await tools.listar_participantes("5547@s.whatsapp.net")

    assert res["participantes"] == []
    assert "aviso" in res


async def test_listar_participantes_erro_vira_dict(monkeypatch):
    async def fake_texto(tool, args):
        raise RuntimeError("não é um grupo")

    monkeypatch.setattr(tools, "chamar_mcp_texto", fake_texto)

    res = await tools.listar_participantes("x")

    assert "erro" in res
