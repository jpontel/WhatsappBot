from google.adk.sessions import DatabaseSessionService

from config import settings

APP_NAME = "agente"

session_service = DatabaseSessionService(db_url=settings.database_url)
