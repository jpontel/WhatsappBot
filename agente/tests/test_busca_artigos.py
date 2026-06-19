"""Testes das tools de recuperação de artigos científicos.

As APIs externas (Semantic Scholar e OpenAlex) são mockadas via um fake do
`httpx.AsyncClient`; o que validamos é o contrato: a tool monta a requisição
certa, mapeia os campos da resposta e devolve `{"artigos": [...]}` ou
`{"erro": "..."}` (nunca levanta exceção).
"""

import tools.tools as tools


class _FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


class _FakeClient:
    """Substitui httpx.AsyncClient: registra a chamada e devolve `payload`."""

    def __init__(self, payload, capturado, erro=None, **kwargs):
        self._payload = payload
        self._capturado = capturado
        self._erro = erro
        self._kwargs = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        pass

    async def get(self, url, params=None, **kwargs):
        self._capturado["url"] = url
        self._capturado["params"] = params
        self._capturado["headers"] = self._kwargs.get("headers")
        if self._erro is not None:
            raise self._erro
        return _FakeResp(self._payload)


def _patch_httpx(monkeypatch, payload, erro=None):
    """Faz tools.httpx.AsyncClient(...) devolver um cliente fake. Retorna o dict capturado."""
    capturado = {}
    monkeypatch.setattr(
        tools.httpx,
        "AsyncClient",
        lambda **kwargs: _FakeClient(payload, capturado, erro=erro, **kwargs),
    )
    return capturado


# --- Semantic Scholar (buscar_artigos) ---------------------------------------

_S2_PAYLOAD = {
    "data": [
        {
            "title": "Coffee and longevity",
            "year": 2021,
            "authors": [{"name": "A. Silva"}, {"name": "B. Souza"}, {"name": "C. Lima"}, {"name": "D. Reis"}],
            "url": "https://example.org/paper1",
            "citationCount": 42,
            "tldr": {"text": "Café moderado associa-se a maior longevidade."},
            "openAccessPdf": {"url": "https://example.org/paper1.pdf"},
            "venue": "Journal of Nutrition",
        }
    ]
}


async def test_buscar_artigos_mapeia_campos(monkeypatch):
    cap = _patch_httpx(monkeypatch, _S2_PAYLOAD)

    res = await tools.buscar_artigos("café e longevidade")

    assert "erro" not in res
    art = res["artigos"][0]
    assert art["titulo"] == "Coffee and longevity"
    assert art["ano"] == 2021
    # >3 autores -> corta em 3 e adiciona "et al."
    assert art["autores"] == "A. Silva, B. Souza, C. Lima et al."
    assert art["tldr"] == "Café moderado associa-se a maior longevidade."
    assert art["citacoes"] == 42
    assert art["pdf_aberto"] == "https://example.org/paper1.pdf"
    # a query foi enviada nos params
    assert cap["params"]["query"] == "café e longevidade"


async def test_buscar_artigos_sem_key_nao_envia_header(monkeypatch):
    monkeypatch.setattr(tools.settings, "semantic_scholar_api_key", "")
    cap = _patch_httpx(monkeypatch, _S2_PAYLOAD)

    await tools.buscar_artigos("x")

    assert cap["headers"] == {}


async def test_buscar_artigos_com_key_envia_header(monkeypatch):
    monkeypatch.setattr(tools.settings, "semantic_scholar_api_key", "minha-key")
    cap = _patch_httpx(monkeypatch, _S2_PAYLOAD)

    await tools.buscar_artigos("x")

    assert cap["headers"]["x-api-key"] == "minha-key"


async def test_buscar_artigos_erro_vira_dict(monkeypatch):
    _patch_httpx(monkeypatch, {}, erro=RuntimeError("boom"))

    res = await tools.buscar_artigos("x")

    assert "erro" in res
    assert "boom" in res["erro"]


async def test_buscar_artigos_vazio(monkeypatch):
    _patch_httpx(monkeypatch, {"data": []})

    res = await tools.buscar_artigos("nada")

    assert "erro" in res


# --- OpenAlex (deepsearch_artigos) -------------------------------------------

_OPENALEX_PAYLOAD = {
    "results": [
        {
            "title": "Deep dive on topic",
            "publication_year": 2023,
            "authorships": [{"author": {"display_name": "E. Costa"}}],
            "cited_by_count": 100,
            "abstract_inverted_index": {"Café": [0], "faz": [1], "bem": [2]},
            "primary_location": {"source": {"display_name": "Nature"}},
            "doi": "https://doi.org/10.1/abc",
            "open_access": {"is_oa": True},
        }
    ]
}


async def test_deepsearch_mapeia_e_remonta_abstract(monkeypatch):
    cap = _patch_httpx(monkeypatch, _OPENALEX_PAYLOAD)

    res = await tools.deepsearch_artigos("café")

    art = res["artigos"][0]
    assert art["titulo"] == "Deep dive on topic"
    assert art["resumo"] == "Café faz bem"
    assert art["citacoes"] == 100
    assert art["url"] == "https://doi.org/10.1/abc"
    assert art["open_access"] is True
    # sem filtros -> sem param "filter" e ordena por citações
    assert "filter" not in cap["params"]
    assert cap["params"]["sort"] == "cited_by_count:desc"


async def test_deepsearch_monta_filtros(monkeypatch):
    cap = _patch_httpx(monkeypatch, _OPENALEX_PAYLOAD)

    await tools.deepsearch_artigos("café", desde_ano=2020, apenas_open_access=True)

    assert cap["params"]["filter"] == "publication_year:>2019,is_oa:true"


async def test_deepsearch_erro_vira_dict(monkeypatch):
    _patch_httpx(monkeypatch, {}, erro=RuntimeError("falha rede"))

    res = await tools.deepsearch_artigos("x")

    assert "erro" in res
    assert "falha rede" in res["erro"]


# --- helper de reconstrução do abstract --------------------------------------

def test_remontar_abstract_ordena_palavras():
    indice = {"mundo": [1], "olá": [0], "lindo": [2]}
    assert tools._remontar_abstract(indice) == "olá mundo lindo"


def test_remontar_abstract_vazio():
    assert tools._remontar_abstract({}) == ""


def test_remontar_abstract_trunca():
    indice = {"palavra": list(range(100))}  # 100 ocorrências -> texto longo
    res = tools._remontar_abstract(indice, max_chars=20)
    assert len(res) <= 21  # 20 chars + "…"
    assert res.endswith("…")
