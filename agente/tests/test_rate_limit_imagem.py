"""Testes do rate limit de GERAÇÃO de imagens por usuário (janela deslizante).

O teto é por número (identidade confiável do turno via request_context) e conta
só geração/edição com IA — busca na web e áudio ficam de fora. A janela é em
memória; aqui controlamos o tempo via monkeypatch de `time.monotonic`.
"""

from contextlib import contextmanager

import tools.tools as tools
import shared.request_context as rc
from config import settings


@contextmanager
def _ident(numero, eh_admin=False, registrado=True):
    tk = rc.definir(numero, eh_admin, registrado)
    try:
        yield
    finally:
        rc.limpar(tk)


def _reset():
    with tools._geracao_lock:
        tools._geracao_hist.clear()


# --- lógica do helper --------------------------------------------------------

def test_acumula_ate_o_teto_e_bloqueia(monkeypatch):
    monkeypatch.setattr(settings, "imagem_rate_max", 3)
    monkeypatch.setattr(settings, "imagem_rate_janela_seg", 300)
    _reset()
    with _ident("A"):
        assert tools._checar_limite_geracao() is None   # 1
        assert tools._checar_limite_geracao() is None   # 2
        assert tools._checar_limite_geracao() is None   # 3
        estouro = tools._checar_limite_geracao()        # 4 → bloqueia
    assert estouro and "Limite" in estouro


def test_escopo_por_usuario(monkeypatch):
    monkeypatch.setattr(settings, "imagem_rate_max", 1)
    monkeypatch.setattr(settings, "imagem_rate_janela_seg", 300)
    _reset()
    with _ident("A"):
        assert tools._checar_limite_geracao() is None
        assert tools._checar_limite_geracao() is not None   # A estourou
    with _ident("B"):
        assert tools._checar_limite_geracao() is None       # B é independente


def test_jid_e_numero_puro_sao_o_mesmo_balde(monkeypatch):
    # O número pode chegar puro ("A") ou como JID ("A@s.whatsapp.net"): mesma chave.
    monkeypatch.setattr(settings, "imagem_rate_max", 1)
    monkeypatch.setattr(settings, "imagem_rate_janela_seg", 300)
    _reset()
    with _ident("A"):
        assert tools._checar_limite_geracao() is None
    with _ident("A@s.whatsapp.net"):
        assert tools._checar_limite_geracao() is not None   # conta junto com "A"


def test_janela_desliza_e_libera(monkeypatch):
    monkeypatch.setattr(settings, "imagem_rate_max", 2)
    monkeypatch.setattr(settings, "imagem_rate_janela_seg", 300)
    relogio = {"t": 1000.0}
    monkeypatch.setattr(tools.time, "monotonic", lambda: relogio["t"])
    _reset()
    with _ident("A"):
        assert tools._checar_limite_geracao() is None       # t=1000
        assert tools._checar_limite_geracao() is None       # t=1000
        assert tools._checar_limite_geracao() is not None   # t=1000 → estourou
        relogio["t"] += 301                                 # saiu da janela
        assert tools._checar_limite_geracao() is None       # liberou


# --- integração: o gate aborta a geração ANTES de chamar a API ---------------

async def test_gerar_imagem_aborta_no_limite_sem_tocar_na_api(monkeypatch):
    # max=0 bloqueia logo de cara; o retorno {erro} prova que nem criou o client
    # genai (se tocasse na API, falharia/gastaria — aqui nem chega lá).
    monkeypatch.setattr(settings, "imagem_rate_max", 0)
    _reset()
    with _ident("A"):
        res = await tools.gerar_imagem("um gato de óculos")
    assert "erro" in res and "Limite" in res["erro"]
