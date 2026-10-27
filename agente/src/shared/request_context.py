"""Identidade CONFIÁVEL do turno, vinda do request HTTP (não do LLM).

Usada para travar permissões de memória no código: as tools leem daqui quem é
o solicitante (número), se é o admin e se é cadastrado — em vez de confiar nos
argumentos que o modelo passa. Propaga via ContextVar dentro do mesmo task
assíncrono que executa `runner.run_async` (e, portanto, as tools).
"""

from contextvars import ContextVar, Token

_numero: ContextVar[str | None] = ContextVar("mem_numero", default=None)
_eh_admin: ContextVar[bool] = ContextVar("mem_eh_admin", default=False)
_registrado: ContextVar[bool] = ContextVar("mem_registrado", default=False)

# Imagem recebida no turno (anexada ou citada), guardada como {base64, mimetype}.
# Fica aqui — e NÃO como argumento de tool — para que a edição de imagem leia os
# bytes direto, sem o LLM ter que carregar ~100KB de base64 (custo de tokens).
_midia: ContextVar[dict | None] = ContextVar("turno_midia", default=None)


def definir(numero: str | None, eh_admin: bool, registrado: bool) -> tuple[Token, Token, Token]:
    return (_numero.set(numero), _eh_admin.set(eh_admin), _registrado.set(registrado))


def limpar(tokens: tuple[Token, Token, Token]) -> None:
    _numero.reset(tokens[0])
    _eh_admin.reset(tokens[1])
    _registrado.reset(tokens[2])


def atual() -> tuple[str | None, bool, bool]:
    """(numero_do_solicitante, eh_admin, registrado)."""
    return _numero.get(), _eh_admin.get(), _registrado.get()


def definir_midia(midia: dict | None) -> Token:
    return _midia.set(midia)


def limpar_midia(token: Token) -> None:
    _midia.reset(token)


def midia_atual() -> dict | None:
    """Imagem do turno ({base64, mimetype}) ou None se não veio imagem."""
    return _midia.get()


# Buffer de contexto recente do turno: as últimas mensagens do chat ANTES do
# gatilho (lista de MensagemContexto). Fica aqui — e NÃO na Content enviada ao
# runner — para que a injeção seja EFÊMERA: um before_model_callback a insere só
# no llm_request do turno, nunca na sessão do ADK (ver client/contexto.py).
_contexto_recente: ContextVar[list | None] = ContextVar("turno_contexto", default=None)


def definir_contexto(itens: list | None) -> Token:
    return _contexto_recente.set(itens)


def limpar_contexto(token: Token) -> None:
    _contexto_recente.reset(token)


def contexto_atual() -> list | None:
    """Contexto recente do turno (lista de MensagemContexto) ou None."""
    return _contexto_recente.get()


# Rota decidida pelo roteador determinístico (v0) e o conjunto de ferramentas
# permitidas naquela rota. `tools_permitidas` None = sem filtro (fallback: todas
# as tools). Lidos pelo before_model_callback que filtra o schema de tools do
# turno. Ver client/roteador.py.
_rota: ContextVar[str | None] = ContextVar("turno_rota", default=None)
_tools_permitidas: ContextVar[frozenset[str] | None] = ContextVar(
    "turno_tools_permitidas", default=None
)
# Sufixo de instrução (system_instruction) montado por rota para o turno. É
# acréscimo FIXO por-turno (não cresce com a conversa): a orientação específica
# da rota + fragmentos condicionais. Lido pelo before_model_callback que reescreve
# o system_instruction. "" = nada a injetar. Ver client/roteador.py.
_instrucao_suplementar: ContextVar[str] = ContextVar(
    "turno_instrucao_suplementar", default=""
)


def definir_rota(
    rota: str | None,
    tools_permitidas: frozenset[str] | None,
    instrucao_suplementar: str = "",
) -> tuple[Token, Token, Token]:
    return (
        _rota.set(rota),
        _tools_permitidas.set(tools_permitidas),
        _instrucao_suplementar.set(instrucao_suplementar),
    )


def limpar_rota(tokens: tuple[Token, Token, Token]) -> None:
    _rota.reset(tokens[0])
    _tools_permitidas.reset(tokens[1])
    _instrucao_suplementar.reset(tokens[2])


def rota_atual() -> str | None:
    return _rota.get()


def tools_permitidas_atual() -> frozenset[str] | None:
    """Nomes de tools permitidas no turno, ou None (= sem filtro / todas)."""
    return _tools_permitidas.get()


def instrucao_suplementar_atual() -> str:
    """Sufixo de instrução do turno (orientação da rota), ou "" se nada a injetar."""
    return _instrucao_suplementar.get()
