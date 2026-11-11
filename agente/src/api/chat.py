import asyncio
import base64
import json
import logging
import random
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException
from google.genai import types

from repo import memoria_repo, pendencias_repo, rosto_repo
from shared import request_context
from shared.mcp_client import chamar_mcp
from shared.session_locks import lock_da_sessao
from client import roteador
from client.classificador import Classificacao, classificar_turno
from client.root_agent import runner
from client.session import APP_NAME, session_service
from config import settings
from schemas.chat import ChatRequest, ChatResponse

logger = logging.getLogger(__name__)
router = APIRouter()

# Mensagens amigáveis (na persona) para falhas de IA que NÃO são bug nosso:
# sem isso o usuário só veria o ❌ genérico do bot. Texto curto e informal.
_MSG_SEM_CREDITO = "estourou os tokens!!!! 😵‍💫"
_MSG_SOBRECARGA = "tô meio sobrecarregada agora 😮‍💨 tenta de novo daqui a pouco que eu te respondo 🥲"
_MSG_TOOL_INEXISTENTE = "não encontrei a ferramenta necessária para atender esse pedido. esclarece melhor o que tu quer ou cai fora! bjokas 💋"
# Falha transiente/desconhecida: marcamos a conversa PENDENTE e avisamos UMA vez
# que vamos re-tentar sozinhos (a rotina de retry cuida do resto).
_MSG_PENDENTE = "perai, rolou alguma coisa aqui no meu sistema, vou dar uma olhada aqui e já retorno :p"


def _mensagem_amigavel_para(exc: Exception) -> str | None:
    """Texto amigável se o erro for de capacidade/billing da IA; senão None.

    Esses casos não são bug do nosso lado (conta sem crédito, modelo
    sobrecarregado) — vale responder algo legível em vez de estourar 500.
    """
    msg = str(exc).lower()
    if "credits are depleted" in msg or "billing" in msg:
        return _MSG_SEM_CREDITO
    if "resource_exhausted" in msg or "unavailable" in msg or "overloaded" in msg or "429" in msg or "503" in msg:
        return _MSG_SOBRECARGA
    # O LLM às vezes alucina o nome de uma tool (ex.: "enviar_sticker_gerado" no
    # lugar de "gerar_e_enviar_sticker"). O ADK levanta ValueError e o turno
    # morre — melhor pedir pra repetir do que devolver ❌ mudo.
    if "not found" in msg and "tool" in msg:
        return _MSG_TOOL_INEXISTENTE
    return None


async def _reagir(req: ChatRequest, emoji: str) -> None:
    """Reage à mensagem-gatilho via MCP do bot (emoji "" remove a reação).

    As reações (⏳ "processando" / 💅 "pronto") só saem em turnos de AÇÃO — quem
    decide isso é o roteador (rota de ação), que vive aqui no agente; por isso a
    reação é emitida pelo agente, e NÃO mais pelo bot (que reagia a toda mensagem,
    inclusive conversa). Falha de reação nunca derruba o turno.
    """
    try:
        await chamar_mcp("reagir", {
            "jid": req.chatId,
            "msgKey": req.msgKey.model_dump(exclude_none=True),
            "emoji": emoji,
        })
    except Exception:  # noqa: BLE001
        logger.warning("Falha ao reagir %r em %s", emoji, req.chatId, exc_info=True)

def _montar_conteudo(
    req: ChatRequest,
    memoria_texto: str = "",
    rosto_texto: str = "",
    classif: Classificacao | None = None,
) -> types.Content:
    rem = req.remetente
    remetente_nome = (rem.nome if rem and rem.nome else "desconhecido")
    remetente_numero = (rem.numero if rem and rem.numero else "?")
    registrado = "sim" if (rem and rem.registrado) else "nao"
    eh_admin = "sim" if (rem and rem.ehAdmin) else "nao"

    data_hora_atual = datetime.now(ZoneInfo(settings.timezone)).isoformat()

    # Tempero de tom do turno: o classificador decide o TOM (serio/neutro/leve) e o
    # estilo é sorteado DENTRO do balde daquele tom — mantém a variedade, mas no
    # registro certo (não solta deboche/malícia numa conversa séria). Sem
    # classificação (fallback), usa o pool completo. A complexidade vira a
    # `dica_tamanho` abaixo.
    tom = classif.tom if classif else "neutro"
    balde = settings.estilos_por_tom.get(tom) or settings.estilos_resposta
    estilo_da_vez = random.choice(balde)
    dica_tamanho = classif.dica_tamanho() if classif else "médio"

    bloco_citacao = ""
    if req.citacao and req.citacao.texto:
        autor = req.citacao.autor or "?"
        bloco_citacao = (
            f"mensagem_citada_autor: {autor}\n"
            f"mensagem_citada_texto: {req.citacao.texto}\n"
        )

    bloco_memoria = ""
    if memoria_texto:
        bloco_memoria = f"\n[memória-do-usuário]\n{memoria_texto}\n"

    # Sinaliza explicitamente que há uma imagem editável no turno (anexada ou
    # citada). O modelo já a "vê" pela inline_data, mas o flag deixa a decisão
    # de usar as tools de edição menos ambígua. Só conta imagem (não áudio/vídeo).
    tem_imagem = bool(req.midia and (req.midia.mimetype or "").startswith("image/"))

    # Rostos conhecidos identificados na imagem do turno (memória visual). Só
    # aparece quando há match — uma linha curta, não cresce com a conversa.
    linha_rosto = f"pessoa_reconhecida: {rosto_texto}\n" if rosto_texto else ""

    contexto_sistema = (
        "[contexto-sistema]\n"
        f"usuario_jid: {req.chatId}\n"
        f"msg_key: {json.dumps(req.msgKey.model_dump(exclude_none=True), ensure_ascii=False)}\n"
        f"remetente_nome: {remetente_nome}\n"
        f"remetente_numero: {remetente_numero}\n"
        f"registrado: {registrado}\n"
        f"eh_admin: {eh_admin}\n"
        f"data_hora_atual: {data_hora_atual}\n"
        f"estilo_da_vez: {estilo_da_vez}\n"
        f"dica_tamanho: {dica_tamanho}\n"
        f"tem_imagem: {'sim' if tem_imagem else 'nao'}\n"
        f"{linha_rosto}"
        f"{bloco_citacao}"
        f"{bloco_memoria}"
        "\n"
        "[mensagem-usuario]\n"
        f"{req.mensagem}"
    )

    parts: list[types.Part] = [types.Part(text=contexto_sistema)]

    if req.midia:
        parts.append(
            types.Part(
                inline_data=types.Blob(
                    data=base64.b64decode(req.midia.base64),
                    mime_type=req.midia.mimetype,
                )
            )
        )

    return types.Content(role="user", parts=parts)


async def _garantir_sessao(chat_id: str) -> None:
    sessao = await session_service.get_session(
        app_name=APP_NAME, user_id=chat_id, session_id=chat_id
    )
    if sessao is None:
        await session_service.create_session(
            app_name=APP_NAME, user_id=chat_id, session_id=chat_id
        )


async def _recuperar_memorias(req: ChatRequest) -> str:
    """Top-K memórias relevantes da pessoa (só cadastrada) para a mensagem atual.

    Falha de memória nunca derruba o turno — devolve "" e segue.
    """
    rem = req.remetente
    if not (rem and rem.registrado and rem.numero):
        return ""
    try:
        if await memoria_repo.contar(rem.numero) == 0:
            return ""
        emb = await memoria_repo.gerar_embedding(req.mensagem)
        achados = await memoria_repo.top_k(rem.numero, emb, settings.memoria_top_k)
    except Exception:  # noqa: BLE001
        logger.exception("Falha ao recuperar memórias de %s", req.chatId)
        return ""
    return "\n".join(f"- ({a['categoria']}) {a['conteudo']}" for a in achados)


async def _reconhecer_rosto(req: ChatRequest) -> str:
    """Identifica rostos conhecidos na imagem do turno (memória visual).

    Espelha `_recuperar_memorias`: só roda com imagem, sai cedo se NÃO há nenhum
    rosto cadastrado (não carrega o modelo à toa) e nunca derruba o turno. NÃO é
    gated por `registrado` — qualquer um pode mandar foto de uma pessoa conhecida.
    Devolve algo como "João (5547...@...); Maria (5541...@...)" ou "".
    """
    if not (req.midia and (req.midia.mimetype or "").startswith("image/")):
        return ""
    try:
        if await rosto_repo.contar() == 0:
            return ""
        midia = {"base64": req.midia.base64, "mimetype": req.midia.mimetype}
        embs = await rosto_repo.gerar_embeddings_faciais(midia, settings.rosto_max_faces_por_turno)
        vistos: dict[str, str] = {}  # numero -> nome (dedup por pessoa)
        for emb in embs:
            achado = await rosto_repo.reconhecer(emb, settings.rosto_distancia_max)
            if achado and achado["numero"] not in vistos:
                vistos[achado["numero"]] = achado["nome"]
    except Exception:  # noqa: BLE001
        logger.exception("Falha no reconhecimento facial de %s", req.chatId)
        return ""
    return "; ".join(f"{nome} ({numero})" for numero, nome in vistos.items())


@router.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    rota: str | None = None
    try:
        # Serializa por chatId: uma requisição por sessão de cada vez.
        async with lock_da_sessao(req.chatId):
            await _garantir_sessao(req.chatId)

            # Memória, reconhecimento facial e classificação de tom/complexidade
            # são independentes: rodam em PARALELO (cada um trata o próprio erro).
            # O classificador entra aqui de propósito — sua latência fica "escondida"
            # atrás dos outros, que já precisam terminar antes de montar o prompt.
            memoria_texto, rosto_texto, classif = await asyncio.gather(
                _recuperar_memorias(req),
                _reconhecer_rosto(req),
                classificar_turno(req),
            )
            conteudo = _montar_conteudo(req, memoria_texto, rosto_texto, classif)

            texto_final: str | None = None
            tools_acionadas: list[str] = []

            # Identidade confiável do turno (trava as permissões de memória no
            # código, independente do que o LLM passar como argumento).
            rem = req.remetente
            tokens = request_context.definir(
                rem.numero if rem else None,
                bool(rem and rem.ehAdmin),
                bool(rem and rem.registrado),
            )
            # Imagem do turno disponível para as tools de edição (sem passar
            # base64 pelo LLM). Só imagem — áudio/vídeo o modelo consome via visão.
            midia_turno = None
            if req.midia and (req.midia.mimetype or "").startswith("image/"):
                midia_turno = {"base64": req.midia.base64, "mimetype": req.midia.mimetype}
            token_midia = request_context.definir_midia(midia_turno)

            # Contexto recente (mensagens anteriores ao gatilho). Guardado no
            # ContextVar para injeção EFÊMERA via before_model_callback — NÃO entra
            # em _montar_conteudo (a sessão do ADK tem que ficar limpa). Ver
            # client/contexto.py e [SEGURANÇA] no CLAUDE.md.
            token_ctx = request_context.definir_contexto(req.contexto)

            # Roteador determinístico v0: decide a rota pelos sinais do turno e
            # restringe as tools expostas ao LLM (o filtro roda no
            # before_model_callback). None = fallback (todas as tools).
            if settings.roteador_ativo:
                tem_imagem = bool(req.midia and (req.midia.mimetype or "").startswith("image/"))
                rota = roteador.decidir_rota(
                    req.mensagem,
                    tem_imagem,
                    bool(rem and rem.ehAdmin),
                    bool(rem and rem.registrado),
                )
            # Sufixo de instrução por rota (orientação específica; ou tudo no
            # fallback). Injetado no system_instruction pelo before_model_callback.
            instr_suf = roteador.instrucao_suplementar(req.mensagem, rota)
            token_rota = request_context.definir_rota(
                rota, roteador.tools_da_rota(rota), instr_suf
            )
            # Reação só em turno de AÇÃO (o usuário pediu pra FAZER algo): ⏳ ao
            # iniciar, 💅 ao concluir. Conversa normal NÃO ganha reação nenhuma.
            # Quem decide ação vs conversa é o roteador — por isso a reação sai
            # daqui, não do bot (que antes reagia a toda mensagem).
            eh_acao = settings.roteador_ativo and roteador.eh_rota_de_acao(rota)
            if eh_acao:
                await _reagir(req, "⏳")
            try:
                async for event in runner.run_async(
                    user_id=req.chatId,
                    session_id=req.chatId,
                    new_message=conteudo,
                ):
                    for chamada in event.get_function_calls() or []:
                        tools_acionadas.append(chamada.name)

                    if event.is_final_response() and event.content and event.content.parts:
                        for parte in event.content.parts:
                            if getattr(parte, "text", None):
                                texto_final = parte.text
                # Concluiu: 💅 se realmente agiu (chamou alguma tool). Se era rota
                # de ação mas o modelo não agiu, limpa o ⏳ pendente ("").
                if tools_acionadas:
                    await _reagir(req, "💅")
                elif eh_acao:
                    await _reagir(req, "")
            finally:
                request_context.limpar_rota(token_rota)
                request_context.limpar_contexto(token_ctx)
                request_context.limpar_midia(token_midia)
                request_context.limpar(tokens)

        return ChatResponse(texto=texto_final, tools_acionadas=tools_acionadas, rota=rota)

    except Exception as exc:
        logger.exception("Falha no /chat para %s", req.chatId)
        # Tool alucinada pelo LLM (nome inexistente) NÃO é transiente nem se
        # resolve re-tentando: pede pra repetir (comportamento atual), sem
        # virar pendente.
        msg = str(exc).lower()
        if "not found" in msg and "tool" in msg:
            return ChatResponse(texto=_MSG_TOOL_INEXISTENTE, tools_acionadas=[])
        # Todo o resto (sobrecarga 429/503/overload/resource_exhausted/unavailable,
        # billing/credits e desconhecido) vira PENDENTE: gravamos a conversa e uma
        # rotina re-tenta sozinha. Avisamos o "perai" só na 1ª vez (dedup por chat);
        # se já havia pendente, texto=None (o bot não reenvia nada).
        try:
            criou = await pendencias_repo.marcar_pendente(
                chat_id=req.chatId,
                msg_key=json.dumps(req.msgKey.model_dump(exclude_none=True), ensure_ascii=False),
                mensagem=req.mensagem,
                contexto=json.dumps([m.model_dump() for m in req.contexto], ensure_ascii=False),
                erro=repr(exc),
            )
        except Exception as exc_pend:  # noqa: BLE001
            # Nem a captura funcionou: degrada pro 500 clássico (bot reage ❌).
            logger.exception("Falha ao marcar pendência de %s", req.chatId)
            raise HTTPException(status_code=500, detail=str(exc)) from exc_pend
        return ChatResponse(texto=(_MSG_PENDENTE if criou else None), pendente=True)
