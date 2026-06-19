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
