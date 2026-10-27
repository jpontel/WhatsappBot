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


class MensagemContexto(BaseModel):
    """Uma mensagem do buffer de contexto recente (anteriores ao gatilho).

    `autor` pode faltar (None) — aí a linha injetada no prompt fica só com o
    texto. `texto` pode ser um marcador de mídia ("[imagem]", "[áudio] legenda")
    que o bot já capa do lado dele.
    """
    autor: str | None = None
    texto: str


class ChatRequest(BaseModel):
    chatId: str = Field(description="JID do WhatsApp; usado como user_id e session_id no ADK.")
    mensagem: str
    msgKey: MsgKey
    midia: Midia | None = None
    remetente: Remetente | None = None
    citacao: Citacao | None = None
    # Últimas N mensagens do chat ANTES do gatilho (ordem cronológica, já SEM a
    # mensagem-gatilho). Opcional (default lista vazia) → compatível com clientes
    # que não mandam. Injetado de forma EFÊMERA no prompt do turno (nunca entra na
    # sessão do ADK) — ver client/contexto.py.
    contexto: list[MensagemContexto] = Field(
        default_factory=list,
        description="Últimas mensagens do chat antes do gatilho (contexto efêmero do turno).",
    )


class ChatResponse(BaseModel):
    texto: str | None = None
    tools_acionadas: list[str] = Field(default_factory=list)
    # Rota escolhida pelo roteador determinístico (v0) — telemetria/observabilidade.
    # None = fallback (nenhuma regra casou; LLM recebeu todas as tools).
    rota: str | None = None
    # Soft-fail já tratado: o turno falhou mas viramos a conversa PENDENTE e uma
    # rotina re-tenta sozinha — o bot NÃO reage com ❌ (não é erro pro usuário).
    pendente: bool = False
