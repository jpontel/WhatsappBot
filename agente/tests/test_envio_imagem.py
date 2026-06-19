"""E2E do envio de imagem/figurinha: a mídia (base64) é entregue via MCP no
servidor e NUNCA volta para o modelo (evita o hang de re-emitir base64).

O MCP do bot e a fonte da imagem (Tavily/Gemini) são mockados; o que validamos
é o contrato: a tool chama o MCP certo com o base64 e devolve só um status curto.
"""

import tools.tools as tools

# base64 "grande" para simular uma imagem real (o que travava quando ia pro modelo).
_B64_GRANDE = "QUJDRA" * 20000  # ~120 KB


def _patch_mcp(monkeypatch):
    enviados = []

    async def fake_mcp(tool, args):
        enviados.append((tool, args))

    monkeypatch.setattr(tools, "chamar_mcp", fake_mcp)
    return enviados


async def test_imagem_buscada_entrega_via_mcp_sem_base64_no_retorno(monkeypatch):
    enviados = _patch_mcp(monkeypatch)

    async def fake_buscar(query):
        assert query == "gato siamês"
        return {"base64": _B64_GRANDE, "mimetype": "image/jpeg", "url": "http://x/y.jpg", "titulo": "gato"}

    monkeypatch.setattr(tools, "buscar_imagem", fake_buscar)

    res = await tools.enviar_imagem_buscada("gato siamês", "5511@s.whatsapp.net")

    # 1) o MCP recebeu a imagem (base64) no servidor
    assert len(enviados) == 1
    tool, args = enviados[0]
    assert tool == "enviar_imagem"
    assert args["jid"] == "5511@s.whatsapp.net"
    assert args["mediaBase64"] == _B64_GRANDE
    assert args["legenda"] == "gato"
    # 2) o retorno para o MODELO é pequeno e SEM base64 (núcleo do fix)
    assert "base64" not in res
    assert _B64_GRANDE not in str(res)
    assert res["status"] == "ok"
    assert len(str(res)) < 300


async def test_sticker_gerado_chama_enviar_sticker(monkeypatch):
    enviados = _patch_mcp(monkeypatch)

    async def fake_gerar(prompt):
        return {"base64": _B64_GRANDE, "mimetype": "image/png"}

    monkeypatch.setattr(tools, "gerar_imagem", fake_gerar)

    res = await tools.enviar_sticker_gerado("um dragão fofo", "5511@s.whatsapp.net")

    assert [t for t, _ in enviados] == ["enviar_sticker"]
    assert enviados[0][1]["mediaBase64"] == _B64_GRANDE
    assert "base64" not in res and res["status"] == "ok"


async def test_erro_na_fonte_nao_chama_mcp(monkeypatch):
    enviados = _patch_mcp(monkeypatch)

    async def fake_buscar(query):
        return {"erro": "nada encontrado"}

    monkeypatch.setattr(tools, "buscar_imagem", fake_buscar)

    res = await tools.enviar_imagem_buscada("xyz", "5511@s.whatsapp.net")

    assert res == {"erro": "nada encontrado"}
    assert enviados == []  # não tenta enviar se a busca falhou


async def test_falha_no_mcp_retorna_erro(monkeypatch):
    async def fake_buscar(query):
        return {"base64": _B64_GRANDE, "mimetype": "image/jpeg", "url": "u", "titulo": ""}

    async def fake_mcp(tool, args):
        raise RuntimeError("socket fechado")

    monkeypatch.setattr(tools, "buscar_imagem", fake_buscar)
    monkeypatch.setattr(tools, "chamar_mcp", fake_mcp)

    res = await tools.enviar_imagem_buscada("gato", "5511@s.whatsapp.net")

    assert "erro" in res
    assert "MCP" in res["erro"]
