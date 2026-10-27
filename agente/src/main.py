import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI

from api import chat, health
from client.retry_pendencias import loop_retry

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)


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
