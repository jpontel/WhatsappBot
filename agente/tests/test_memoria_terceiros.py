"""Memória de TERCEIROS mencionados por nome na mensagem (só para admin).

Cobre `_recuperar_memorias` (bloco por pessoa + embedding único reaproveitado)
e `_montar_conteudo` (bloco `[memórias-recuperadas]` renomeado, com múltiplos
sub-blocos `[sobre <nome>]`).
"""

import client.mencoes as mencoes
import repo.memoria_repo as memoria_repo
from api.chat import _montar_conteudo, _recuperar_memorias
from schemas.chat import ChatRequest, MsgKey, Remetente


def _req(mensagem="oi", remetente=None) -> ChatRequest:
    return ChatRequest(
        chatId="chat@s.whatsapp.net",
        mensagem=mensagem,
        msgKey=MsgKey(id="1", remoteJid="chat@s.whatsapp.net"),
        remetente=remetente,
    )


def _patch_embedding(monkeypatch):
    chamadas = []

    async def fake_emb(texto):
        chamadas.append(texto)
        return [0.0]

    monkeypatch.setattr(memoria_repo, "gerar_embedding", fake_emb)
    return chamadas


async def test_remetente_registrado_traz_bloco_sobre_voce(monkeypatch):
    _patch_embedding(monkeypatch)

    async def fake_contar(numero):
        return 1 if numero == "R" else 0

    async def fake_top_k(numero, emb, k):
        return [{"categoria": "trabalho", "conteudo": "fato do remetente"}]

    monkeypatch.setattr(memoria_repo, "contar", fake_contar)
    monkeypatch.setattr(memoria_repo, "top_k", fake_top_k)

    req = _req(remetente=Remetente(numero="R", registrado=True, ehAdmin=False))
    texto = await _recuperar_memorias(req)

    assert "[sobre você]" in texto
    assert "fato do remetente" in texto


async def test_admin_mencionando_terceiro_traz_bloco_do_terceiro(monkeypatch):
    chamadas_emb = _patch_embedding(monkeypatch)

    async def fake_mencionados(mensagem, excluir_numero):
        return [{"nome": "Andrei", "jid": "AND"}]

    async def fake_contar(numero):
        return 1 if numero in ("ADMIN", "AND") else 0

    async def fake_top_k(numero, emb, k):
        if numero == "AND":
            return [{"categoria": "gosto", "conteudo": "adora Legião Urbana"}]
        return []

    monkeypatch.setattr(mencoes, "pessoas_mencionadas", fake_mencionados)
    monkeypatch.setattr(memoria_repo, "contar", fake_contar)
    monkeypatch.setattr(memoria_repo, "top_k", fake_top_k)

    req = _req(
        mensagem="qual a banda favorita do Andrei?",
        remetente=Remetente(numero="ADMIN", registrado=True, ehAdmin=True),
    )
    texto = await _recuperar_memorias(req)

    assert "[sobre Andrei]" in texto
    assert "adora Legião Urbana" in texto
    # Um único embedding da mensagem, reaproveitado (não 1 por pessoa).
    assert len(chamadas_emb) == 1


async def test_nao_admin_nao_busca_terceiros(monkeypatch):
    _patch_embedding(monkeypatch)
    chamou = []

    async def fake_mencionados(mensagem, excluir_numero):
        chamou.append(1)
        return []

    async def fake_contar(_numero):
        return 0

    monkeypatch.setattr(mencoes, "pessoas_mencionadas", fake_mencionados)
    monkeypatch.setattr(memoria_repo, "contar", fake_contar)

    req = _req(
        mensagem="qual a banda favorita do Andrei?",
        remetente=Remetente(numero="R", registrado=True, ehAdmin=False),
    )
    await _recuperar_memorias(req)

    assert not chamou  # gate eh_admin impede a busca de terceiros


async def test_sem_fatos_nenhum_bloco():
    req = _req(remetente=Remetente(numero="R", registrado=False, ehAdmin=False))
    texto = await _recuperar_memorias(req)
    assert texto == ""


def test_montar_conteudo_injeta_bloco_renomeado():
    conteudo = _montar_conteudo(_req(), memoria_texto="[sobre você]\n- (x) y\n")
    texto = conteudo.parts[0].text
    assert "[memórias-recuperadas]" in texto
    assert "[sobre você]" in texto
