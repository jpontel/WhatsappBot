from pydantic import BaseModel, Field


class MsgKey(BaseModel):
    id: str
    remoteJid: str
    fromMe: bool | None = None
    participant: str | None = None


class Midia(BaseModel):
    base64: str
    mimetype: str


class Remetente(BaseModel):
    numero: str | None = None
    nome: str | None = None
    registrado: bool = False
    ehAdmin: bool = False


class Citacao(BaseModel):
    """Mensagem que o usuário respondeu/citou ao mandar o /p."""
    texto: str | None = None
    autor: str | None = None


class ChatRequest(BaseModel):
    chatId: str = Field(description="JID do WhatsApp; usado como user_id e session_id no ADK.")
    mensagem: str
    msgKey: MsgKey
    midia: Midia | None = None
    remetente: Remetente | None = None
    citacao: Citacao | None = None


class ChatResponse(BaseModel):
    texto: str | None = None
    tools_acionadas: list[str] = Field(default_factory=list)
