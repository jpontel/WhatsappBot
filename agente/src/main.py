import logging

from fastapi import FastAPI

from api import chat, health

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

app = FastAPI(title="agente", version="0.1.0")
app.include_router(health.router)
app.include_router(chat.router)
