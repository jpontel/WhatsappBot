"""Endpoint de recuperação dos logs do agente (consumido pelo /logs do bot).

É interno (só o bot chama, pela rede do compose). O gate de admin fica no comando
`/logs` do bot; aqui só servimos o buffer filtrado/redigido.
"""

from fastapi import APIRouter

from shared import log_buffer

router = APIRouter()


@router.get("/logs")
async def logs(
    nivel: str = "WARNING",
    comp: str | None = None,
    limite: int = 30,
    resumo: bool = False,
) -> dict:
    return log_buffer.recuperar(nivel=nivel, comp=comp, limite=limite, resumo=resumo)
