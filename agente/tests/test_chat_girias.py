"""Garante o sorteio/injeção de `girias_permitidas` no [contexto-sistema],
evitando que a persona sempre caia nos mesmos termos genéricos do dicionário
(ex.: "avisa", "old bbs").
"""

from api.chat import _montar_conteudo
from config import settings
from schemas.chat import ChatRequest, MsgKey


def _req() -> ChatRequest:
    return ChatRequest(chatId="grupo@g.us", mensagem="oi", msgKey=MsgKey(id="1", remoteJid="grupo@g.us"))


def _texto_contexto() -> str:
    conteudo = _montar_conteudo(_req())
    return conteudo.parts[0].text


def test_girias_permitidas_aparece_no_contexto():
    assert "girias_permitidas:" in _texto_contexto()


def test_girias_permitidas_e_subconjunto_valido():
    texto = _texto_contexto()
    linha = next(linha for linha in texto.splitlines() if linha.startswith("girias_permitidas:"))
    girias = [g.strip() for g in linha.split(":", 1)[1].split(",") if g.strip()]

    assert len(girias) == min(settings.girias_por_turno, len(settings.girias_disponiveis))
    assert set(girias).issubset(set(settings.girias_disponiveis))


def test_girias_permitidas_varia_entre_turnos():
    amostras = {tuple(sorted(_texto_contexto().split("girias_permitidas: ")[1].split("\n")[0].split(", "))) for _ in range(30)}
    assert len(amostras) > 1
