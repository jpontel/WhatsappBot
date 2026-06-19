"""Testes da memória de longo prazo.

Níveis: (1) tools com permissão travada via request_context (mock do repo);
(2) o repo de verdade (sqlite-vec) com embeddings determinísticos num .db temp.
"""

from contextlib import contextmanager

import repo.memoria_repo as memoria_repo
import shared.request_context as rc
import tools.tools as tools
from config import settings


def _vec(i: int, dim: int = 768) -> list[float]:
    v = [0.0] * dim
    v[i] = 1.0
    return v


@contextmanager
def _ident(numero, eh_admin=False, registrado=True):
    tk = rc.definir(numero, eh_admin, registrado)
    try:
        yield
    finally:
        rc.limpar(tk)


# --- nível tool: caminho feliz (mock do repo) -------------------------------

async def test_salvar_memoria_ok(monkeypatch):
    async def fake_emb(_t):
        return _vec(0)

    async def fake_salvar(num, cat, cont, emb):
        assert num == "A"  # alvo resolvido = próprio
        return {"status": "ok"}

    monkeypatch.setattr(memoria_repo, "gerar_embedding", fake_emb)
    monkeypatch.setattr(memoria_repo, "salvar", fake_salvar)

    with _ident("A"):
        assert await tools.salvar_memoria("A", "trabalho", "x") == {"status": "ok"}


async def test_salvar_memoria_erro_vira_dict(monkeypatch):
    async def fake_emb(_t):
        raise RuntimeError("boom")

    monkeypatch.setattr(memoria_repo, "gerar_embedding", fake_emb)

    with _ident("A"):
        res = await tools.salvar_memoria("A", "c", "x")
    assert "erro" in res and "boom" in res["erro"]


async def test_listar_memorias_vazio(monkeypatch):
    async def fake_listar(_num):
        return []

    monkeypatch.setattr(memoria_repo, "listar", fake_listar)

    with _ident("A"):
        res = await tools.listar_memorias("A")
    assert res["memorias"] == [] and "aviso" in res


async def test_esquecer_memoria(monkeypatch):
    async def fake_ok(_num, _id):
        return True

    monkeypatch.setattr(memoria_repo, "esquecer", fake_ok)
    with _ident("A"):
        assert await tools.esquecer_memoria("A", 1) == {"status": "ok"}


# --- nível tool: PERMISSÃO (travada no código) ------------------------------

async def test_nao_admin_nao_acessa_memoria_alheia(monkeypatch):
    chamou = []
    monkeypatch.setattr(memoria_repo, "listar", lambda n: chamou.append(n))

    with _ident("A", eh_admin=False):
        res = await tools.listar_memorias("OUTRO_NUMERO")

    assert "erro" in res
    assert not chamou  # nem chegou a consultar o repo


async def test_nao_admin_acessa_a_propria(monkeypatch):
    async def fake_listar(num):
        assert num == "A"
        return [{"id": 1, "categoria": "x", "conteudo": "c", "created_at": "t"}]

    monkeypatch.setattr(memoria_repo, "listar", fake_listar)
    # mesmo passando vazio, resolve para o próprio número
    with _ident("A", eh_admin=False):
        res = await tools.listar_memorias("")
    assert res["memorias"][0]["id"] == 1


async def test_admin_acessa_memoria_de_outro(monkeypatch):
    async def fake_listar(num):
        assert num == "B"  # admin mira outra pessoa
        return [{"id": 9, "categoria": "x", "conteudo": "c", "created_at": "t"}]

    monkeypatch.setattr(memoria_repo, "listar", fake_listar)
    with _ident("ADMIN", eh_admin=True):
        res = await tools.listar_memorias("B")
    assert res["memorias"][0]["id"] == 9


async def test_nao_cadastrado_sem_memoria():
    with _ident(None, eh_admin=False, registrado=False):
        res = await tools.salvar_memoria("X", "c", "y")
    assert "erro" in res and "cadastrada" in res["erro"].lower()


# --- nível repo (sqlite-vec real, embeddings determinísticos) ----------------

async def test_repo_vec0_fluxo(monkeypatch, tmp_path):
    memoria_repo._conn = None
    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{tmp_path}/m.db")
    try:
        await memoria_repo.salvar("A", "trabalho", "trabalho", _vec(0))
        await memoria_repo.salvar("A", "data", "data", _vec(5))
        await memoria_repo.salvar("B", "x", "outra pessoa", _vec(0))

        assert await memoria_repo.contar("A") == 2
        assert await memoria_repo.contar("B") == 1

        top = await memoria_repo.top_k("A", _vec(0), 2)
        assert top[0]["conteudo"] == "trabalho"

        d = await memoria_repo.salvar("A", "trabalho", "trabalho", _vec(0))
        assert d["status"] == "duplicada"
        assert await memoria_repo.contar("A") == 2

        ms = await memoria_repo.listar("A")
        assert len(ms) == 2
        assert await memoria_repo.esquecer("A", ms[0]["id"]) is True
        assert await memoria_repo.contar("A") == 1
    finally:
        memoria_repo._conn = None
