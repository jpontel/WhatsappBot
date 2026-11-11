"""Buffer em memória dos logs do agente (observabilidade — /logs e auto-inspeção).

Um `logging.Handler` no logger RAIZ captura TODOS os `logger.*` já existentes (sem
tocar nos call sites) e guarda os últimos N registros estruturados num deque.
`recuperar()` filtra por nível/componente, REDIGE segredos/PII, trunca e (opcional)
resume — para caber em poucos tokens quando o resultado vai para a IA.

Store = memória (rápido, sem infra, sem contenção). Perde no restart — ok para
"estado recente"; histórico persistente fica para uma fase futura (logs.db).
"""

import logging
import re
from collections import deque
from datetime import datetime
from zoneinfo import ZoneInfo

from config import settings

_NIVEIS = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40, "CRITICAL": 50}

_buffer: deque[dict] = deque(maxlen=settings.log_buffer_max)

# Redação: chaves/token de API e números longos (telefone/JID) antes de expor.
_RE_SEGREDO = re.compile(
    r"(AIza[\w\-]+|AQ\.[\w\-]+|gh[po]_[A-Za-z0-9]+|Bearer\s+[\w\-.]+|sk-[A-Za-z0-9]+)"
)
_RE_NUM = re.compile(r"\b\d{10,}\b")


def _redigir(texto: str) -> str:
    t = _RE_SEGREDO.sub("***", texto)
    t = _RE_NUM.sub(lambda m: m.group()[:4] + "***", t)
    return t


class RingBufferHandler(logging.Handler):
    """Empurra cada registro para o deque. Nunca levanta (não pode quebrar o app)."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            _buffer.append({
                "ts": record.created,
                "nivel": record.levelname,
                "comp": record.name,
                "msg": record.getMessage(),
            })
        except Exception:  # noqa: BLE001 - logging nunca derruba o app
            pass


def instalar() -> None:
    """Pluga o handler no logger raiz (idempotente). Chamar no startup."""
    raiz = logging.getLogger()
    if not any(isinstance(h, RingBufferHandler) for h in raiz.handlers):
        raiz.addHandler(RingBufferHandler())


def _fmt_ts(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, ZoneInfo(settings.timezone)).strftime("%H:%M:%S")


def recuperar(
    nivel: str = "WARNING",
    comp: str | None = None,
    limite: int = 30,
    resumo: bool = False,
) -> dict:
    """Logs filtrados (estruturado, redigido, truncado). `resumo` = contagem por tipo."""
    minimo = _NIVEIS.get((nivel or "").upper(), 30)
    limite = max(1, min(limite, settings.log_limite_max))

    itens = [
        r for r in _buffer
        if _NIVEIS.get(r["nivel"], 0) >= minimo and (not comp or comp in r["comp"])
    ][-limite:]

    if resumo:
        contagem: dict[str, int] = {}
        for r in itens:
            k = f'{r["nivel"]} {r["comp"]}'
            contagem[k] = contagem.get(k, 0) + 1
        return {"svc": "agente", "total": len(itens), "resumo": contagem}

    linhas = [
        f'{_fmt_ts(r["ts"])} {r["nivel"]} {r["comp"]}: {_redigir(r["msg"])[:settings.log_msg_max]}'
        for r in itens
    ]
    return {"svc": "agente", "total": len(linhas), "logs": linhas}
