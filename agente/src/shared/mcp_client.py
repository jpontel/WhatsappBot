"""Cliente MCP server-to-server.

Permite que tools do agente chamem as tools MCP do bot (enviar_imagem,
enviar_sticker, ...) diretamente, SEM passar os bytes da mídia pelo LLM —
o modelo só passa argumentos pequenos (texto + jid); o base64 fica no servidor.
"""

import logging

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from config import settings

logger = logging.getLogger("google_adk.agente.mcp_client")


async def chamar_mcp(tool: str, args: dict) -> None:
    """Invoca uma tool do MCP do bot. Levanta exceção se a tool retornar erro."""
    async with streamablehttp_client(settings.mcp_url) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            resultado = await session.call_tool(tool, args)
    if getattr(resultado, "isError", False):
        raise RuntimeError(f"MCP {tool} falhou: {resultado.content}")


async def chamar_mcp_texto(tool: str, args: dict) -> str:
    """Como `chamar_mcp`, mas retorna o texto concatenado do resultado.

    Usado por tools de LEITURA (ex.: listar_agendamentos), em que o conteúdo
    devolvido pela tool MCP importa para o modelo.
    """
    async with streamablehttp_client(settings.mcp_url) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            resultado = await session.call_tool(tool, args)
    if getattr(resultado, "isError", False):
        raise RuntimeError(f"MCP {tool} falhou: {resultado.content}")
    partes = [getattr(c, "text", "") for c in (resultado.content or [])]
    return "".join(partes)
