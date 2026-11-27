"""Testes da memória visual (reconhecimento facial).

Níveis: (1) tools com gate admin-only via request_context (mock do repo, sem
InsightFace); (2) o repo de verdade (sqlite-vec) com embeddings determinísticos
num .db temp — a geração de embedding facial (InsightFace) é sempre contornada,
então os testes não carregam o modelo.
"""

import base64 as _b64
from contextlib import contextmanager

import repo.rosto_repo as rosto_repo
import shared.request_context as rc
import tools.tools as tools
from config import settings


def _vec(i: int, dim: int = 512) -> list[float]:
    v = [0.0] * dim
    v[i] = 1.0
    return v


_FOTO = {"base64": "x", "mimetype": "image/jpeg"}


@contextmanager
def _ident(numero, eh_admin=False, registrado=True, midia=None):
    tk = rc.definir(numero, eh_admin, registrado)
    tkm = rc.definir_midia(midia)
    try:
        yield
    finally:
        rc.limpar_midia(tkm)
        rc.limpar(tk)


# --- nível tool: cadastro (gate admin-only, foto do turno) --------------------


async def test_registrar_rosto_ok(monkeypatch):
    async def fake_embs(_midia, _n):
        return [_vec(0)]

    async def fake_salvar(num, nome, _emb):
        assert num == "B" and nome == "João"
        return {"status": "ok"}

    monkeypatch.setattr(rosto_repo, "gerar_embeddings_faciais", fake_embs)
    monkeypatch.setattr(rosto_repo, "salvar_rosto", fake_salvar)

    with _ident("ADMIN", eh_admin=True, midia=_FOTO):
        assert await tools.registrar_rosto("B", "João") == {"status": "ok"}


async def test_registrar_rosto_nao_admin(monkeypatch):
    chamou = []
    monkeypatch.setattr(rosto_repo, "gerar_embeddings_faciais", lambda *a: chamou.append(1))

    with _ident("A", eh_admin=False, midia=_FOTO):
        res = await tools.registrar_rosto("A", "Ana")

    assert "erro" in res
    assert not chamou  # gate barra antes de tocar o repo/modelo


async def test_registrar_rosto_sem_foto():
    with _ident("ADMIN", eh_admin=True, midia=None):
        res = await tools.registrar_rosto("B", "João")
    assert "erro" in res and "foto" in res["erro"].lower()


async def test_registrar_rosto_sem_rosto_detectado(monkeypatch):
    async def fake_embs(_midia, _n):
        return []  # nenhum rosto na foto

    monkeypatch.setattr(rosto_repo, "gerar_embeddings_faciais", fake_embs)

    with _ident("ADMIN", eh_admin=True, midia=_FOTO):
        res = await tools.registrar_rosto("B", "João")
    assert "erro" in res and "rosto" in res["erro"].lower()


async def test_esquecer_rosto_ok(monkeypatch):
    async def fake_esq(num):
        assert num == "B"
        return 2

    monkeypatch.setattr(rosto_repo, "esquecer_rosto", fake_esq)
    with _ident("ADMIN", eh_admin=True):
        assert await tools.esquecer_rosto("B") == {"status": "ok", "removidos": 2}


async def test_esquecer_rosto_nao_admin(monkeypatch):
    chamou = []
    monkeypatch.setattr(rosto_repo, "esquecer_rosto", lambda n: chamou.append(n))
    with _ident("A", eh_admin=False):
        res = await tools.esquecer_rosto("B")
    assert "erro" in res and not chamou


# --- nível repo (sqlite-vec real, embeddings determinísticos) ----------------


async def test_repo_rostos_fluxo(monkeypatch, tmp_path):
    rosto_repo._conn = None
    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{tmp_path}/r.db")
    try:
        assert await rosto_repo.contar() == 0

        await rosto_repo.salvar_rosto("A", "Ana", _vec(0))
        await rosto_repo.salvar_rosto("B", "Bia", _vec(5))
        assert await rosto_repo.contar() == 2

        # reconhece o rosto mais próximo ENTRE TODAS as pessoas
        m = await rosto_repo.reconhecer(_vec(0), settings.rosto_distancia_max)
        assert m["numero"] == "A" and m["nome"] == "Ana"

        # rosto distante de todos (acima do limiar) -> sem match
        assert await rosto_repo.reconhecer(_vec(100), settings.rosto_distancia_max) is None

        # dedup: rosto ~idêntico da MESMA pessoa não duplica
        d = await rosto_repo.salvar_rosto("A", "Ana", _vec(0))
        assert d["status"] == "duplicada"
        assert await rosto_repo.contar() == 2

        # esquecer remove TODOS os rostos da pessoa
        assert await rosto_repo.esquecer_rosto("A") == 1
        assert await rosto_repo.reconhecer(_vec(0), settings.rosto_distancia_max) is None
        assert await rosto_repo.contar() == 1
    finally:
        rosto_repo._conn = None


async def test_repo_teto_por_pessoa(monkeypatch, tmp_path):
    rosto_repo._conn = None
    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{tmp_path}/r2.db")
    monkeypatch.setattr(settings, "rosto_max_por_pessoa", 3)
    try:
        for i in range(5):  # 5 rostos distintos da mesma pessoa
            await rosto_repo.salvar_rosto("A", "Ana", _vec(i))
        # teto 3 -> poda os mais antigos, sobram 3
        assert await rosto_repo.contar() == 3
    finally:
        rosto_repo._conn = None


# --- foto de referência (geração de imagem com pessoas) ----------------------


def _foto(conteudo: bytes, mimetype="image/jpeg") -> dict:
    return {"base64": _b64.b64encode(conteudo).decode(), "mimetype": mimetype}


async def test_repo_fotos_fluxo(monkeypatch, tmp_path):
    rosto_repo._conn = None
    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{tmp_path}/rf.db")
    try:
        fa, fb = _foto(b"AAA", "image/jpeg"), _foto(b"BBB", "image/png")
        await rosto_repo.salvar_foto_rosto("A", "Ana", fa)
        await rosto_repo.salvar_foto_rosto("B", "Bia", fb)

        # fotos_de só devolve quem TEM foto (C fica de fora)
        fotos = await rosto_repo.fotos_de(["A", "B", "C"])
        by = {f["numero"]: f for f in fotos}
        assert set(by) == {"A", "B"}
        assert by["A"]["base64"] == fa["base64"] and by["A"]["mimetype"] == "image/jpeg"
        assert by["B"]["nome"] == "Bia"

        # UPSERT: re-salvar A substitui (continua 1 por pessoa)
        fa2 = _foto(b"AAA-novo", "image/webp")
        await rosto_repo.salvar_foto_rosto("A", "Ana", fa2)
        fotos = await rosto_repo.fotos_de(["A"])
        assert len(fotos) == 1 and fotos[0]["base64"] == fa2["base64"]

        # esquecer_rosto apaga a foto também
        await rosto_repo.esquecer_rosto("A")
        assert await rosto_repo.fotos_de(["A"]) == []
        assert len(await rosto_repo.fotos_de(["B"])) == 1  # B intacto
    finally:
        rosto_repo._conn = None


# --- tool de geração com pessoas (gate + resolução de nomes + faltantes) ----


def _mock_buscar_contato(monkeypatch, mapa: dict[str, list[dict]]):
    """mapa: nome -> lista de contatos (como buscar_contato devolveria)."""

    async def fake(nome):
        return {"contatos": mapa.get(nome, [])}

    monkeypatch.setattr(tools, "buscar_contato", fake)


async def _fake_gen_ok(_prompt, _imagens):
    return {"base64": "g", "mimetype": "image/png"}


async def _fake_mcp_noop(_tool, _args):
    pass


async def test_gerar_com_pessoas_nao_cadastrado(monkeypatch):
    chamou = []
    monkeypatch.setattr(rosto_repo, "fotos_de", lambda n: chamou.append(n))
    with _ident(None, registrado=False):
        res = await tools.gerar_e_enviar_imagem_com_pessoas("x", ["Ana"], "JID")
    assert "erro" in res and not chamou


async def test_gerar_com_pessoas_nome_nao_encontrado(monkeypatch):
    chamou = []
    monkeypatch.setattr(rosto_repo, "fotos_de", lambda n: chamou.append(n))
    _mock_buscar_contato(monkeypatch, {})  # nenhum nome resolve

    with _ident("U", registrado=True):
        res = await tools.gerar_e_enviar_imagem_com_pessoas("x", ["Zeca"], "JID")
    assert "erro" in res and "Zeca" in res["erro"] and not chamou


async def test_gerar_com_pessoas_nome_ambiguo(monkeypatch):
    chamou = []
    monkeypatch.setattr(rosto_repo, "fotos_de", lambda n: chamou.append(n))
    _mock_buscar_contato(
        monkeypatch,
        {
            "Fulano": [
                {"nome": "Fulano da Silva", "jid": "A@s.whatsapp.net"},
                {"nome": "Fulano Souza", "jid": "B@s.whatsapp.net"},
            ],
        },
    )

    with _ident("U", registrado=True):
        res = await tools.gerar_e_enviar_imagem_com_pessoas("x", ["Fulano"], "JID")
    assert "erro" in res and "Fulano da Silva" in res["erro"] and "Fulano Souza" in res["erro"]
    assert not chamou


async def test_gerar_com_pessoas_ambiguo_mas_com_match_exato(monkeypatch):
    """ "Ana" bate em "Ana" E "Mariana" por LIKE parcial, mas a igualdade exata
    desempata automaticamente, sem erro."""

    async def fake_fotos(nums):
        return [{"numero": n, "nome": n, "base64": "img", "mimetype": "image/jpeg"} for n in nums]

    monkeypatch.setattr(rosto_repo, "fotos_de", fake_fotos)
    monkeypatch.setattr(tools, "gerar_imagem_com_referencias", _fake_gen_ok)
    monkeypatch.setattr(tools, "chamar_mcp", _fake_mcp_noop)
    _mock_buscar_contato(
        monkeypatch,
        {
            "Ana": [
                {"nome": "Ana", "jid": "A@s.whatsapp.net"},
                {"nome": "Mariana", "jid": "M@s.whatsapp.net"},
            ],
        },
    )

    with _ident("U", registrado=True):
        res = await tools.gerar_e_enviar_imagem_com_pessoas("x", ["Ana"], "JID")
    assert res.get("status") == "ok"


async def test_gerar_com_pessoas_sem_foto_de_alguem(monkeypatch):
    async def fake_fotos(_nums):
        return [
            {"numero": "A@s.whatsapp.net", "nome": "Ana", "base64": "x", "mimetype": "image/jpeg"}
        ]  # falta B

    monkeypatch.setattr(rosto_repo, "fotos_de", fake_fotos)
    _mock_buscar_contato(
        monkeypatch,
        {
            "Ana": [{"nome": "Ana", "jid": "A@s.whatsapp.net"}],
            "Beto": [{"nome": "Beto", "jid": "B@s.whatsapp.net"}],
        },
    )
    with _ident("U", registrado=True):
        res = await tools.gerar_e_enviar_imagem_com_pessoas("x", ["Ana", "Beto"], "JID")
    assert "erro" in res and "Beto" in res["erro"]


async def test_gerar_com_pessoas_ok(monkeypatch):
    async def fake_fotos(nums):
        return [{"numero": n, "nome": n, "base64": "img", "mimetype": "image/jpeg"} for n in nums]

    async def fake_gen(prompt, imagens):
        assert len(imagens) == 2  # X e Y
        return {"base64": "gerada", "mimetype": "image/png"}

    chamadas = []

    async def fake_mcp(tool, args):
        chamadas.append(tool)

    monkeypatch.setattr(rosto_repo, "fotos_de", fake_fotos)
    monkeypatch.setattr(tools, "gerar_imagem_com_referencias", fake_gen)
    monkeypatch.setattr(tools, "chamar_mcp", fake_mcp)
    _mock_buscar_contato(
        monkeypatch,
        {
            "X": [{"nome": "X", "jid": "X@s.whatsapp.net"}],
            "Y": [{"nome": "Y", "jid": "Y@s.whatsapp.net"}],
        },
    )

    with _ident("U", registrado=True):
        res = await tools.gerar_e_enviar_imagem_com_pessoas("praia", ["X", "Y"], "JID")
    assert res.get("status") == "ok"
    assert chamadas == ["enviar_imagem"]


async def test_gerar_com_pessoas_regressao_dois_nomes_distintos(monkeypatch):
    """Regressão direta do bug relatado: 2 nomes distintos têm que resolver
    para 2 jids DIFERENTES e gerar com 2 fotos distintas — nunca duplicar."""

    async def fake_fotos(nums):
        assert nums == ["EDU@s.whatsapp.net", "ANDREI@s.whatsapp.net"]
        return [
            {"numero": n, "nome": n, "base64": f"img-{n}", "mimetype": "image/jpeg"} for n in nums
        ]

    recebidas = []

    async def fake_gen(prompt, imagens):
        recebidas.extend(imagens)
        return {"base64": "gerada", "mimetype": "image/png"}

    monkeypatch.setattr(rosto_repo, "fotos_de", fake_fotos)
    monkeypatch.setattr(tools, "gerar_imagem_com_referencias", fake_gen)
    monkeypatch.setattr(tools, "chamar_mcp", _fake_mcp_noop)
    _mock_buscar_contato(
        monkeypatch,
        {
            "edubecks": [{"nome": "edubecks", "jid": "EDU@s.whatsapp.net"}],
            "andrei": [{"nome": "andrei", "jid": "ANDREI@s.whatsapp.net"}],
        },
    )

    with _ident("U", registrado=True):
        res = await tools.gerar_e_enviar_imagem_com_pessoas("praia", ["edubecks", "andrei"], "JID")

    assert res.get("status") == "ok"
    assert len(recebidas) == 2
    assert recebidas[0]["base64"] != recebidas[1]["base64"]


async def test_gerar_com_pessoas_inclui_foto_do_turno_como_referencia(monkeypatch):
    """Regressão: "adiciona o Fulano nessa foto" tem que preservar a foto do
    turno como referência extra — sem isso o Gemini inventa rostos genéricos
    pras pessoas citadas (só tinha as fotos de rosto cadastradas, sem a cena
    original).
    """

    async def fake_fotos(nums):
        return [{"numero": n, "nome": n, "base64": "img", "mimetype": "image/jpeg"} for n in nums]

    recebidas = []

    async def fake_gen(prompt, imagens):
        recebidas.extend(imagens)
        return {"base64": "gerada", "mimetype": "image/png"}

    async def fake_mcp(tool, args):
        pass

    monkeypatch.setattr(rosto_repo, "fotos_de", fake_fotos)
    monkeypatch.setattr(tools, "gerar_imagem_com_referencias", fake_gen)
    monkeypatch.setattr(tools, "chamar_mcp", fake_mcp)
    _mock_buscar_contato(monkeypatch, {"Aline": [{"nome": "A", "jid": "A"}]})

    foto_turno = {"base64": "foto-do-turno", "mimetype": "image/jpeg"}
    with _ident("U", registrado=True, midia=foto_turno):
        res = await tools.gerar_e_enviar_imagem_com_pessoas("adiciona a Aline", ["Aline"], "JID")

    assert res.get("status") == "ok"
    # Foto do turno vem PRIMEIRO (é a cena base a preservar) + 1 foto de rosto.
    assert recebidas == [
        foto_turno,
        {"numero": "A", "nome": "A", "base64": "img", "mimetype": "image/jpeg"},
    ]


async def test_gerar_com_pessoas_sem_foto_no_turno_nao_adiciona_nada(monkeypatch):
    """Caminho normal (cena nova, sem foto no turno) continua igual."""

    async def fake_fotos(nums):
        return [{"numero": n, "nome": n, "base64": "img", "mimetype": "image/jpeg"} for n in nums]

    recebidas = []

    async def fake_gen(prompt, imagens):
        recebidas.extend(imagens)
        return {"base64": "gerada", "mimetype": "image/png"}

    async def fake_mcp(tool, args):
        pass

    monkeypatch.setattr(rosto_repo, "fotos_de", fake_fotos)
    monkeypatch.setattr(tools, "gerar_imagem_com_referencias", fake_gen)
    monkeypatch.setattr(tools, "chamar_mcp", fake_mcp)
    _mock_buscar_contato(monkeypatch, {"Ana": [{"nome": "A", "jid": "A"}]})

    with _ident("U", registrado=True):  # sem midia
        res = await tools.gerar_e_enviar_imagem_com_pessoas("praia", ["Ana"], "JID")

    assert res.get("status") == "ok"
    assert recebidas == [{"numero": "A", "nome": "A", "base64": "img", "mimetype": "image/jpeg"}]


async def test_fotos_de_casa_numero_com_ou_sem_sufixo(monkeypatch, tmp_path):
    """Regressão: foto guardada com JID completo deve casar com número 'limpo'."""
    rosto_repo._conn = None
    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{tmp_path}/rn.db")
    try:
        # guardado com JID completo (como o buscar_contato devolve no cadastro)
        await rosto_repo.salvar_foto_rosto("555199416342@s.whatsapp.net", "Beck", _foto(b"BK"))
        # consultado com o número "limpo" (como o LLM às vezes passa) -> casa
        fotos = await rosto_repo.fotos_de(["555199416342"])
        assert len(fotos) == 1 and fotos[0]["nome"] == "Beck"
        # caminho inverso também (guardado limpo, consultado com sufixo)
        await rosto_repo.salvar_foto_rosto("550000000000", "Fulano", _foto(b"LT"))
        fotos = await rosto_repo.fotos_de(["550000000000@s.whatsapp.net"])
        assert len(fotos) == 1 and fotos[0]["nome"] == "Fulano"
    finally:
        rosto_repo._conn = None


async def test_gerar_com_pessoas_numero_sem_sufixo(monkeypatch):
    """Regressão: a reconciliação achados/faltando via normalizar_numero precisa
    casar o jid que buscar_contato resolve com o número salvo em rostos_fotos,
    mesmo quando os formatos (com/sem sufixo) divergem."""

    async def fake_fotos(_nums):
        return [
            {"numero": "555199416342", "nome": "Beck", "base64": "img", "mimetype": "image/jpeg"}
        ]

    async def fake_gen(prompt, imagens):
        return {"base64": "g", "mimetype": "image/png"}

    enviados = []

    async def fake_mcp(tool, args):
        enviados.append(tool)

    monkeypatch.setattr(rosto_repo, "fotos_de", fake_fotos)
    monkeypatch.setattr(tools, "gerar_imagem_com_referencias", fake_gen)
    monkeypatch.setattr(tools, "chamar_mcp", fake_mcp)
    _mock_buscar_contato(
        monkeypatch,
        {
            "Beck": [{"nome": "Beck", "jid": "555199416342@s.whatsapp.net"}],
        },
    )

    with _ident("U", registrado=True):
        res = await tools.gerar_e_enviar_imagem_com_pessoas("x", ["Beck"], "JID")
    assert res.get("status") == "ok" and enviados == ["enviar_imagem"], res


async def test_gerar_com_pessoas_incluir_remetente_sem_nomes(monkeypatch):
    async def fake_fotos(nums):
        assert nums == ["PROPRIO"]
        return [{"numero": "PROPRIO", "nome": "Você", "base64": "img", "mimetype": "image/jpeg"}]

    monkeypatch.setattr(rosto_repo, "fotos_de", fake_fotos)
    monkeypatch.setattr(tools, "gerar_imagem_com_referencias", _fake_gen_ok)
    monkeypatch.setattr(tools, "chamar_mcp", _fake_mcp_noop)

    with _ident("PROPRIO", registrado=True):
        res = await tools.gerar_e_enviar_imagem_com_pessoas(
            "selfie", [], "JID", incluir_remetente=True
        )
    assert res.get("status") == "ok"


async def test_gerar_com_pessoas_incluir_remetente_respeita_teto(monkeypatch):
    monkeypatch.setattr(settings, "rosto_gen_max_pessoas", 2)
    recebidos_nums = []

    async def fake_fotos(nums):
        recebidos_nums.extend(nums)
        return [{"numero": n, "nome": n, "base64": "img", "mimetype": "image/jpeg"} for n in nums]

    monkeypatch.setattr(rosto_repo, "fotos_de", fake_fotos)
    monkeypatch.setattr(tools, "gerar_imagem_com_referencias", _fake_gen_ok)
    monkeypatch.setattr(tools, "chamar_mcp", _fake_mcp_noop)
    _mock_buscar_contato(
        monkeypatch,
        {
            "A": [{"nome": "A", "jid": "A"}],
            "B": [{"nome": "B", "jid": "B"}],
            "C": [{"nome": "C", "jid": "C"}],
        },
    )

    with _ident("PROPRIO", registrado=True):
        res = await tools.gerar_e_enviar_imagem_com_pessoas(
            "festa", ["A", "B", "C"], "JID", incluir_remetente=True
        )

    assert res.get("status") == "ok"
    # remetente + só 1 nomeado (teto=2) -> nunca 3
    assert len(recebidos_nums) == 2
    assert recebidos_nums[0] == "PROPRIO"
