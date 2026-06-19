"""Testes das tools de lembretes agendados (lado agente).

O MCP do bot é mockado (chamar_mcp / chamar_mcp_texto); validamos o contrato:
as tools montam os args certos (incluindo a identidade CONFIÁVEL injetada a
partir do `request_context`), aplicam permissão e tratam erro como dict, sem
levantar exceção.
"""

import json

import pytest

import tools.tools as tools
from shared import request_context


@pytest.fixture
def como():
    """Define a identidade confiável do turno (request_context).

    Uso: `como("5547999", eh_admin=False, registrado=True)`. Não precisa de
    teardown: cada teste async roda no seu próprio contexto (a Task copia o
    contexto na criação), então as mudanças não vazam entre testes.
    """
    def _definir(numero, eh_admin=False, registrado=True):
        request_context.definir(numero, eh_admin, registrado)

    return _definir


def _patch_chamar_mcp(monkeypatch):
    chamadas = []

    async def fake(tool, args):
        chamadas.append((tool, args))

    monkeypatch.setattr(tools, "chamar_mcp", fake)
    return chamadas


# --- agendar_alerta ----------------------------------------------------------

async def test_agendar_recorrente_monta_args(monkeypatch, como):
    como("5547999")
    chamadas = _patch_chamar_mcp(monkeypatch)

    res = await tools.agendar_alerta(
        "5547@s.whatsapp.net", "⏰ escovar os dentes", "recorrente", cron_expression="0 8 * * *"
    )

    assert res == {"status": "ok"}
    tool, args = chamadas[0]
    assert tool == "agendar_mensagem"
    assert args["jid"] == "5547@s.whatsapp.net"
    assert args["tipo"] == "recorrente"
    assert args["cron_expression"] == "0 8 * * *"
    assert args["mensagem"] == "⏰ escovar os dentes"
    # identidade confiável vai como `solicitante`, não do que o LLM passar.
    assert args["solicitante"] == "5547999"


async def test_agendar_once_monta_args(monkeypatch, como):
    como("5547999")
    chamadas = _patch_chamar_mcp(monkeypatch)

    res = await tools.agendar_alerta(
        "120@g.us", "⏰ reunião", "once", run_at="2026-06-04T14:00:00-03:00"
    )

    assert res == {"status": "ok"}
    _, args = chamadas[0]
    assert args["tipo"] == "once"
    assert args["run_at"] == "2026-06-04T14:00:00-03:00"
    # grupo: destino é o próprio jid de origem
    assert args["jid"] == "120@g.us"


async def test_agendar_urgente_passa_flag_e_solicitante(monkeypatch, como):
    como("5547999")
    chamadas = _patch_chamar_mcp(monkeypatch)

    res = await tools.agendar_alerta(
        "5547@s.whatsapp.net", "⏰ remédio", "once",
        run_at="2026-06-04T14:00:00-03:00", urgente=True,
    )

    assert res == {"status": "ok"}
    _, args = chamadas[0]
    assert args["urgente"] is True
    assert args["solicitante"] == "5547999"


async def test_agendar_nao_cadastrado_recusa(monkeypatch, como):
    como(None, registrado=False)
    chamadas = _patch_chamar_mcp(monkeypatch)

    res = await tools.agendar_alerta(
        "x@s.whatsapp.net", "msg", "once", run_at="2026-06-04T14:00:00-03:00"
    )

    assert "erro" in res
    # não chega a chamar o MCP quando não tem permissão
    assert chamadas == []


async def test_agendar_erro_vira_dict(monkeypatch, como):
    como("5547999")

    async def fake(tool, args):
        raise RuntimeError("mcp caiu")

    monkeypatch.setattr(tools, "chamar_mcp", fake)

    res = await tools.agendar_alerta("x@s.whatsapp.net", "msg", "once", run_at="2026-06-04T14:00:00-03:00")

    assert "erro" in res
    assert "mcp caiu" in res["erro"]


# --- listar_alertas ----------------------------------------------------------

async def test_listar_parseia_json_nao_admin(monkeypatch, como):
    como("5547999", eh_admin=False)
    lista = [{"id": 1, "mensagem": "água", "tipo": "recorrente", "cron_expression": "0 8 * * *", "run_at": None}]

    async def fake_texto(tool, args):
        assert tool == "listar_agendamentos"
        # não-admin: manda solicitante e eh_admin=False (bot filtra só os próprios)
        assert args == {"jid": "5547@s.whatsapp.net", "solicitante": "5547999", "eh_admin": False}
        return json.dumps(lista)

    monkeypatch.setattr(tools, "chamar_mcp_texto", fake_texto)

    res = await tools.listar_alertas("5547@s.whatsapp.net")

    assert res["alertas"] == lista


async def test_listar_admin_passa_eh_admin(monkeypatch, como):
    como("5547999", eh_admin=True)

    async def fake_texto(tool, args):
        assert args["eh_admin"] is True
        return "[]"

    monkeypatch.setattr(tools, "chamar_mcp_texto", fake_texto)

    res = await tools.listar_alertas("5547@s.whatsapp.net")

    assert res["alertas"] == []
    assert "aviso" in res


async def test_listar_erro_vira_dict(monkeypatch, como):
    como("5547999")

    async def fake_texto(tool, args):
        raise RuntimeError("sem conexão")

    monkeypatch.setattr(tools, "chamar_mcp_texto", fake_texto)

    res = await tools.listar_alertas("x")

    assert "erro" in res


# --- cancelar_alerta ---------------------------------------------------------

async def test_cancelar_monta_args(monkeypatch, como):
    como("5547999", eh_admin=False)
    chamadas = _patch_chamar_mcp(monkeypatch)

    res = await tools.cancelar_alerta("5547@s.whatsapp.net", 7)

    assert res == {"status": "ok"}
    tool, args = chamadas[0]
    assert tool == "cancelar_agendamento"
    assert args == {
        "jid": "5547@s.whatsapp.net",
        "id": 7,
        "solicitante": "5547999",
        "eh_admin": False,
    }


async def test_cancelar_nao_cadastrado_recusa(monkeypatch, como):
    como(None, registrado=False)
    chamadas = _patch_chamar_mcp(monkeypatch)

    res = await tools.cancelar_alerta("5547@s.whatsapp.net", 7)

    assert "erro" in res
    assert chamadas == []


# --- editar_alerta -----------------------------------------------------------

async def test_editar_so_manda_campos_alterados(monkeypatch, como):
    como("5547999", eh_admin=False)
    chamadas = _patch_chamar_mcp(monkeypatch)

    res = await tools.editar_alerta("5547@s.whatsapp.net", 7, mensagem="novo texto")

    assert res == {"status": "ok"}
    tool, args = chamadas[0]
    assert tool == "editar_agendamento"
    assert args["mensagem"] == "novo texto"
    assert args["solicitante"] == "5547999"
    assert args["eh_admin"] is False
    # campos não informados NÃO vão no payload (não sobrescreve com vazio)
    assert "run_at" not in args
    assert "cron_expression" not in args
    assert "urgente" not in args


async def test_editar_urgente_false_eh_enviado(monkeypatch, como):
    como("5547999")
    chamadas = _patch_chamar_mcp(monkeypatch)

    res = await tools.editar_alerta("5547@s.whatsapp.net", 7, urgente=False)

    assert res == {"status": "ok"}
    _, args = chamadas[0]
    # urgente=False é uma mudança intencional (None = não muda), então vai no payload
    assert args["urgente"] is False


async def test_editar_admin_passa_eh_admin(monkeypatch, como):
    como("5547999", eh_admin=True)
    chamadas = _patch_chamar_mcp(monkeypatch)

    res = await tools.editar_alerta("5547@s.whatsapp.net", 9, run_at="2026-06-05T10:00:00-03:00")

    assert res == {"status": "ok"}
    _, args = chamadas[0]
    assert args["eh_admin"] is True
    assert args["run_at"] == "2026-06-05T10:00:00-03:00"


async def test_editar_nao_cadastrado_recusa(monkeypatch, como):
    como(None, registrado=False)
    chamadas = _patch_chamar_mcp(monkeypatch)

    res = await tools.editar_alerta("5547@s.whatsapp.net", 7, mensagem="x")

    assert "erro" in res
    assert chamadas == []


# --- buscar_contato ----------------------------------------------------------

async def test_buscar_contato_encontra(monkeypatch):
    async def fake_texto(tool, args):
        assert tool == "buscar_pessoa"
        assert args == {"nome": "João"}
        return json.dumps([{"nome": "João", "jid": "5547001@s.whatsapp.net"}])

    monkeypatch.setattr(tools, "chamar_mcp_texto", fake_texto)

    res = await tools.buscar_contato("João")

    assert res["contatos"][0]["jid"] == "5547001@s.whatsapp.net"


async def test_buscar_contato_vazio_avisa(monkeypatch):
    async def fake_texto(tool, args):
        return "[]"

    monkeypatch.setattr(tools, "chamar_mcp_texto", fake_texto)

    res = await tools.buscar_contato("Ninguém")

    assert res["contatos"] == []
    assert "aviso" in res
