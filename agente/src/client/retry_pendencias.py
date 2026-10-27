"""Rotina de auto-recuperação de turnos do /chat que falharam.

Quando o /chat erra de forma (provavelmente) transiente, a conversa é marcada
PENDENTE no banco (`repo/pendencias_repo`). Esta rotina roda em background: a
cada `pendencia_intervalo_seg` ela varre as pendentes, re-roda o LLM com o
contexto do momento, responde o usuário ("desculpa a demora...") e apaga a
pendência resolvida. Após `pendencia_max_tentativas` falhas, desiste e avisa o
admin no privado.

[SEGURANÇA] — impacto em tokens: cada retry é UMA chamada de LLM, igual a um
turno de /chat. O volume é limitado por `pendencia_lote_max` pendências por
ciclo e por `pendencia_max_tentativas` por linha; o contexto reinjetado é capado
em `pendencia_contexto_max` e vive só no canal EFÊMERO (ContextVar) — não entra
na sessão do ADK, não acumula entre turnos.

Limitação do v1: a identidade original do turno (admin/registrado/número) e a
MÍDIA enviada NÃO são restauradas no retry — o contexto que persistimos é só o
texto das últimas mensagens. O retry foca o caso comum (erro transiente numa
conversa de texto); pedidos que dependiam da imagem anexada ou de permissão de
admin podem não se recuperar perfeitamente, mas nunca quebram o loop.
"""

import asyncio
import json
import logging

from google.genai import types

from client import roteador
from client.root_agent import runner
from config import settings
from repo import pendencias_repo
from schemas.chat import MensagemContexto
from shared import request_context
from shared.mcp_client import chamar_mcp
from shared.session_locks import lock_da_sessao

logger = logging.getLogger(__name__)

# Enquadramento injetado na mensagem re-enviada ao modelo: deixa explícito que é
# uma RETOMADA (o modelo não respondeu antes, agora o problema foi resolvido) —
# a persona reconhece a demora de leve, sem repetir a pergunta do usuário.
_ENQUADRAMENTO_RETOMADA = (
    "[sistema: retomada após falha técnica — você NÃO respondeu a mensagem "
    "abaixo antes; agora o problema foi resolvido. Responda retomando o assunto "
    "com um reconhecimento leve da demora (ex.: 'desculpa a demora'), SEM "
    "repetir a pergunta dele.]\n\n[mensagem-usuario]\n"
)


async def loop_retry() -> None:
    """Loop infinito da rotina. Dorme ANTES do 1º ciclo (não roda no boot) e
    nunca morre: qualquer exceção de um ciclo é logada e o loop segue.
    """
    while True:
        await asyncio.sleep(settings.pendencia_intervalo_seg)
        try:
            await _rodar_ciclo()
        except Exception:  # noqa: BLE001 - o loop jamais pode morrer
            logger.exception("Falha no ciclo de retry de pendências")


async def _rodar_ciclo() -> None:
    """Uma varredura: processa as pendentes em SÉRIE (uma por vez)."""
    pendentes = await pendencias_repo.listar_pendentes(settings.pendencia_lote_max)
    for p in pendentes:
        try:
            await _processar(p)
        except Exception:  # noqa: BLE001 - um item com erro não aborta o ciclo
            logger.exception("Falha ao processar pendência %s", p.get("id"))


async def _processar(p: dict) -> None:
    """Re-tenta uma única pendência (já sob tratamento de erro do ciclo)."""
    # Já estourou o teto de tentativas: nada a fazer (marcar_desistido já tratou).
    if p["tentativas"] >= settings.pendencia_max_tentativas:
        return None

    async with lock_da_sessao(p["chat_id"]):
        # Re-checa sob o lock: um /chat ao vivo pode ter resolvido essa conversa
        # entre a listagem e agora (DELETE). Se não é mais pendente, pula.
        if not await pendencias_repo.tem_pendente(p["chat_id"]):
            return None

        texto_final = await _rerodar_llm(p)

        if texto_final:
            # LLM OK: tenta entregar a resposta ao usuário via MCP do bot.
            try:
                await chamar_mcp(
                    "enviar_texto",
                    {"jid": p["chat_id"], "texto": texto_final},
                )
            except Exception:  # noqa: BLE001 - bot/MCP fora: NÃO conta tentativa
                logger.warning(
                    "Retry: LLM respondeu mas o envio falhou para %s (re-tenta no próximo ciclo)",
                    p["chat_id"],
                    exc_info=True,
                )
                return None
            # Entregue: resolve (DELETE).
            await pendencias_repo.resolver(p["id"])
            return None

        # LLM falhou (exceção no run ou texto vazio): conta a tentativa.
        await _registrar_falha(p)
        return None


async def _rerodar_llm(p: dict) -> str | None:
    """Re-roda o runner para a pendência, espelhando o loop do /chat.

    Reconstrói o contexto efêmero (últimas mensagens) e a rota/instrução de
    FALLBACK (todas as tools + manual completo), roda o runner e devolve o texto
    final. Devolve None se o run levantar exceção ou não produzir texto. Os
    ContextVars são sempre limpos no finally.
    """
    # Contexto recente persistido na pendência (lista de dicts) → objetos
    # MensagemContexto, capado nos últimos N (teto por quantidade — [SEGURANÇA]).
    try:
        itens_raw = json.loads(p["contexto"] or "[]")
    except (ValueError, TypeError):
        itens_raw = []
    itens = [MensagemContexto(**d) for d in itens_raw][-settings.pendencia_contexto_max:]
    tok_ctx = request_context.definir_contexto(itens)

    # Rota de fallback: no retry damos TODAS as tools + o manual completo (rota
    # None) — não re-decidimos a rota original (YAGNI: o run original falhou antes
    # de completar; o fallback é a rede de segurança).
    tok_rota = request_context.definir_rota(
        None,
        roteador.tools_da_rota(None),
        roteador.instrucao_suplementar(p["mensagem_usuario"], None),
    )

    texto = _ENQUADRAMENTO_RETOMADA + (p["mensagem_usuario"] or "")
    conteudo = types.Content(role="user", parts=[types.Part(text=texto)])

    texto_final: str | None = None
    try:
        async for event in runner.run_async(
            user_id=p["chat_id"],
            session_id=p["chat_id"],
            new_message=conteudo,
        ):
            if event.is_final_response() and event.content and event.content.parts:
                for parte in event.content.parts:
                    if getattr(parte, "text", None):
                        texto_final = parte.text
    except Exception:  # noqa: BLE001 - run falhou: trata como tentativa gasta
        logger.warning("Retry: run_async falhou para %s", p["chat_id"], exc_info=True)
        texto_final = None
    finally:
        request_context.limpar_rota(tok_rota)
        request_context.limpar_contexto(tok_ctx)

    return texto_final


async def _registrar_falha(p: dict) -> None:
    """Conta uma tentativa falha; ao bater o teto, desiste e avisa o admin."""
    n = await pendencias_repo.registrar_tentativa(p["id"])
    if n < settings.pendencia_max_tentativas:
        return None

    await pendencias_repo.marcar_desistido(p["id"])
    await _avisar_admin(p, n)
    return None


async def _avisar_admin(p: dict, n: int) -> None:
    """Avisa o admin no privado que desistimos de uma conversa. Best-effort."""
    if not settings.admin_jid:
        return None
    aj = settings.admin_jid if "@" in settings.admin_jid else settings.admin_jid + "@s.whatsapp.net"
    try:
        await chamar_mcp(
            "enviar_texto",
            {
                "jid": aj,
                "texto": (
                    f"⚠️ desisti de responder a conversa {p['chat_id']} após {n} "
                    f"tentativas. Último erro: {p.get('erro', '')[:200]}"
                ),
            },
        )
    except Exception:  # noqa: BLE001 - aviso ao admin nunca derruba o ciclo
        logger.warning("Retry: falha ao avisar o admin sobre %s", p["chat_id"], exc_info=True)
    return None
