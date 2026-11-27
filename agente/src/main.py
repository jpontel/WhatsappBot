import asyncio
import base64
import logging
import os
from contextlib import asynccontextmanager, suppress
from urllib.parse import quote

from fastapi import FastAPI

from api import chat, health, logs
from client.retry_pendencias import loop_retry
from config import settings
from shared import log_buffer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
# Captura todos os logger.* num ring buffer em memória (observabilidade /logs).
log_buffer.instalar()


def _instalar_tracing_langfuse() -> None:
    """Liga o export de spans do ADK (agent run / tool call / model call) via
    OTLP para o Langfuse Cloud. Kill switch: sem `langfuse_public_key`, não faz
    nada — o ADK não chama `maybe_set_otel_providers()` por conta própria num
    FastAPI montado na mão (sem `get_fast_api_app()`), então a chamada é
    obrigatória aqui; só setar as env vars OTEL_EXPORTER_OTLP_* não basta.
    """
    if not settings.langfuse_public_key:
        return

    credenciais = base64.b64encode(
        f"{settings.langfuse_public_key}:{settings.langfuse_secret_key}".encode()
    ).decode()
    os.environ.setdefault(
        "OTEL_EXPORTER_OTLP_ENDPOINT", f"{settings.langfuse_host}/api/public/otel"
    )
    os.environ.setdefault(
        "OTEL_EXPORTER_OTLP_HEADERS",
        f"Authorization={quote(f'Basic {credenciais}', safe='')}",
    )

    from google.adk.telemetry.setup import maybe_set_otel_providers

    maybe_set_otel_providers()


_instalar_tracing_langfuse()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Sobe a rotina de retry de pendências como task de background e a cancela
    no shutdown (o loop dorme antes do 1º ciclo, então não roda no boot).
    """
    tarefa = asyncio.create_task(loop_retry())
    try:
        yield
    finally:
        tarefa.cancel()
        with suppress(asyncio.CancelledError):
            await tarefa


app = FastAPI(title="agente", version="0.1.0", lifespan=lifespan)
app.include_router(health.router)
app.include_router(chat.router)
app.include_router(logs.router)
