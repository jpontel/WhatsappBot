import base64
import io
import json
import re
import threading
import time
import wave

import httpx
from google import genai
from google.genai import types

from repo import memoria_repo, rosto_repo
from shared import log_buffer, request_context
from shared.mcp_client import chamar_mcp, chamar_mcp_texto
from config import settings


# --- Rate limit de GERAÇÃO de imagens por usuário ----------------------------
# Cada chamada à API de imagem do Gemini custa; este teto evita que um usuário
# empilhe gerações num curto intervalo (abuso/custo). Janela DESLIZANTE em
# memória: guarda os timestamps (monotônicos) das gerações de cada número e
# poda os que já saíram da janela. Reiniciar o processo zera a contagem — ok
# para um limitador de custo. Vale só para GERAÇÃO/EDIÇÃO com IA; busca de
# imagem na web e áudio (TTS) NÃO passam por aqui. OBS: o contador é POR
# PROCESSO — com vários workers uvicorn, o teto vale por worker.
_geracao_lock = threading.Lock()
_geracao_hist: dict[str, list[float]] = {}

# Mesmo esquema para a GERAÇÃO de música (Lyria). Contador SEPARADO do de imagem:
# os baldes (`_hist`) e os tetos (`settings`) são independentes, então gerar
# música não consome o saldo de imagem e vice-versa.
_musica_lock = threading.Lock()
_musica_hist: dict[str, list[float]] = {}


def _checar_limite(
    hist: dict[str, list[float]],
    lock: threading.Lock,
    teto: int,
    janela: int,
    rotulo: str,
) -> str | None:
    """Teto por usuário em janela DESLIZANTE, genérico (imagem/música/etc.).

    Lê o solicitante da identidade CONFIÁVEL do turno (`request_context`, não de
    argumento do LLM). Se ainda há saldo na janela, REGISTRA esta chamada e
    devolve None (pode prosseguir). Se já estourou `teto` dentro de `janela`
    segundos, devolve a mensagem de erro (sem registrar) — o chamador aborta
    ANTES de tocar na API. `rotulo` é o substantivo no plural da mensagem
    (ex.: "imagens", "músicas").
    """
    numero, _eh_admin, _registrado = request_context.atual()
    chave = (numero or "").split("@", 1)[0].strip() or "?"
    agora = time.monotonic()
    with lock:
        recentes = [t for t in hist.get(chave, []) if agora - t < janela]
        if len(recentes) >= teto:
            hist[chave] = recentes  # persiste a poda mesmo ao recusar
            espera = int(janela - (agora - recentes[0])) + 1 if recentes else janela
            return (
                f"Limite de {teto} {rotulo} a cada {janela // 60} min atingido — "
                f"espera ~{espera}s e tenta de novo."
            )
        recentes.append(agora)
        hist[chave] = recentes
        return None


def _checar_limite_geracao() -> str | None:
    """Aplica o teto de gerações de IMAGEM do usuário (ver `_checar_limite`)."""
    return _checar_limite(
        _geracao_hist,
        _geracao_lock,
        settings.imagem_rate_max,
        settings.imagem_rate_janela_seg,
        "imagens",
    )


def _checar_limite_musica() -> str | None:
    """Aplica o teto de gerações de MÚSICA do usuário (ver `_checar_limite`)."""
    return _checar_limite(
        _musica_hist,
        _musica_lock,
        settings.musica_rate_max,
        settings.musica_rate_janela_seg,
        "músicas",
    )


async def gerar_imagem(prompt: str) -> dict:
    """Gera uma imagem a partir de um prompt em texto usando o Gemini.

    Args:
        prompt: descrição em texto da imagem desejada (em português).

    Returns:
        Dicionário com `base64` (str, imagem PNG em base64) e `mimetype` (str, ex: 'image/png').
        Em caso de bloqueio do filtro de segurança, retorna `{"erro": "..."}`.
    """
    limite = _checar_limite_geracao()
    if limite:
        return {"erro": limite}

    client = genai.Client(api_key=settings.gemini_api_key)

    response = await client.aio.models.generate_content(
        model=settings.gemini_image_model,
        contents=f"Gere uma imagem sobre: {prompt}",
        config=types.GenerateContentConfig(
            image_config=types.ImageConfig(image_size="512px", aspect_ratio="1:1"),
        ),
    )

    parts = (response.candidates[0].content.parts or []) if response.candidates else []
    image_part = next((p for p in parts if getattr(p, "inline_data", None)), None)

    if image_part is None:
        text_part = next((p for p in parts if getattr(p, "text", None)), None)
        motivo = text_part.text if text_part else "filtro de segurança bloqueou a geração."
        return {"erro": f"Falha ao gerar imagem: {motivo}"}

    raw = image_part.inline_data.data
    b64 = raw if isinstance(raw, str) else base64.b64encode(raw).decode("utf-8")

    return {
        "base64": b64,
        "mimetype": image_part.inline_data.mime_type or "image/png",
    }


async def editar_imagem(prompt: str, imagem: dict) -> dict:
    """Edita uma imagem EXISTENTE conforme `prompt`, usando o Gemini.

    Diferente de `gerar_imagem` (texto → imagem), aqui a imagem original entra
    JUNTO do texto (imagem + texto → imagem editada). É o modelo de imagem
    decidindo a alteração pedida (mudar cabelo/rosto/fundo/estilo etc.).

    Args:
        prompt: a alteração desejada, em texto (pt-BR).
        imagem: a imagem que chegou no turno — {"base64": str, "mimetype": str}.

    Returns:
        {"base64", "mimetype"} com a imagem editada, ou {"erro": "..."} se o
        filtro de segurança bloquear (comum em troca de rosto de pessoa real).
    """
    limite = _checar_limite_geracao()
    if limite:
        return {"erro": limite}

    client = genai.Client(api_key=settings.gemini_api_key)
    raw = base64.b64decode(imagem["base64"])

    # Capamos só a RESOLUÇÃO (image_size="512px", tier mais barato) para conter
    # custo — SEM aspect_ratio, para o modelo preservar o enquadramento original
    # da foto (forçar 1:1 distorceria). 512px basta para o WhatsApp.
    response = await client.aio.models.generate_content(
        model=settings.gemini_image_model,
        contents=[
            types.Part(inline_data=types.Blob(data=raw, mime_type=imagem.get("mimetype") or "image/jpeg")),
            types.Part(text=f"Edite esta imagem conforme o pedido (mantenha o resto fiel ao original): {prompt}"),
        ],
        config=types.GenerateContentConfig(
            image_config=types.ImageConfig(image_size="512px"),
        ),
    )

    parts = (response.candidates[0].content.parts or []) if response.candidates else []
    image_part = next((p for p in parts if getattr(p, "inline_data", None)), None)

    if image_part is None:
        text_part = next((p for p in parts if getattr(p, "text", None)), None)
        motivo = text_part.text if text_part else "filtro de segurança bloqueou a edição."
        return {"erro": f"Falha ao editar imagem: {motivo}"}

    out = image_part.inline_data.data
    b64 = out if isinstance(out, str) else base64.b64encode(out).decode("utf-8")

    return {
        "base64": b64,
        "mimetype": image_part.inline_data.mime_type or "image/png",
    }


async def gerar_imagem_com_referencias(prompt: str, imagens: list[dict]) -> dict:
    """Gera uma imagem NOVA a partir de uma ou mais imagens de REFERÊNCIA + texto.

    Generaliza `editar_imagem` para N imagens: o modelo de imagem do Gemini
    aceita várias entradas e compõe uma cena nova a partir delas (ex.: juntar os
    rostos de pessoas cadastradas). Capamos só a resolução (image_size="512px")
    para conter custo, sem aspect_ratio (deixa o modelo escolher o enquadramento).

    Args:
        prompt: a cena/pedido em texto (pt-BR).
        imagens: lista de {"base64", "mimetype"} — as referências.

    Returns:
        {"base64", "mimetype"} com a imagem gerada, ou {"erro": "..."} se o filtro
        de segurança bloquear (comum com rosto de pessoa real).
    """
    if not imagens:
        return {"erro": "Sem imagens de referência para gerar."}
    limite = _checar_limite_geracao()
    if limite:
        return {"erro": limite}
    client = genai.Client(api_key=settings.gemini_api_key)

    partes: list[types.Part] = [
        types.Part(
            inline_data=types.Blob(
                data=base64.b64decode(img["base64"]),
                mime_type=img.get("mimetype") or "image/jpeg",
            )
        )
        for img in imagens
    ]
    partes.append(
        types.Part(
            text=(
                "Gere uma imagem NOVA usando as pessoas/elementos das imagens acima "
                "como referência (preserve os rostos o máximo possível). "
                f"Pedido: {prompt}"
            )
        )
    )

    response = await client.aio.models.generate_content(
        model=settings.gemini_image_model,
        contents=partes,
        config=types.GenerateContentConfig(
            image_config=types.ImageConfig(image_size="512px"),
        ),
    )

    parts = (response.candidates[0].content.parts or []) if response.candidates else []
    image_part = next((p for p in parts if getattr(p, "inline_data", None)), None)

    if image_part is None:
        text_part = next((p for p in parts if getattr(p, "text", None)), None)
        motivo = text_part.text if text_part else "filtro de segurança bloqueou a geração."
        return {"erro": f"Falha ao gerar imagem: {motivo}"}

    out = image_part.inline_data.data
    b64 = out if isinstance(out, str) else base64.b64encode(out).decode("utf-8")

    return {
        "base64": b64,
        "mimetype": image_part.inline_data.mime_type or "image/png",
    }


def _pcm_para_wav(pcm: bytes, sample_rate: int) -> bytes:
    """Embrulha PCM bruto (16-bit, mono) num container WAV.

    O TTS do Gemini devolve PCM cru; o WAV dá um arquivo autodescrito que o bot
    (ffmpeg) transcodifica para a nota de voz. Usa só a stdlib (sem ffmpeg aqui).
    """
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)  # 16-bit
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return buf.getvalue()


def _taxa_do_mime(mime: str | None) -> int:
    """Extrai o sample rate do mime do TTS (ex.: 'audio/L16;rate=24000'). 24000 default."""
    m = re.search(r"rate=(\d+)", mime or "")
    return int(m.group(1)) if m else 24000


async def gerar_audio(texto: str, voz: str = "") -> dict:
    """Gera fala (TTS) a partir de texto usando o Gemini.

    Args:
        texto: o que deve ser falado (já na persona).
        voz: voz prebuilt do Gemini (vazio = default de `settings.gemini_tts_voz`).

    Returns:
        `{"base64": <wav>, "mimetype": "audio/wav"}` ou `{"erro": "..."}`.
    """
    client = genai.Client(api_key=settings.gemini_api_key)

    # Enquadra como narração: o modelo TTS, com texto curto/ambíguo, às vezes
    # tenta "responder" em vez de só ler e devolve 400. A instrução abaixo deixa
    # claro que ele deve apenas falar o transcript, sem comentar nem responder.
    # Direção de atuação: o TTS controla a entrega só por linguagem natural, então
    # descrevemos o tom aqui (debochado/irônico/arrogante) sem mexer no transcript.
    # Reforçamos que isso é instrução de COMO falar — não deve ser lida em voz alta
    # nem alterar/adicionar palavras ao texto.
    contents = (
        "Leia em voz alta, em português, exatamente o texto a seguir, "
        "sem responder, comentar nem adicionar nada. Use um tom debochado, "
        "irônico e arrogante, como quem zomba com superioridade: entonação "
        "sarcástica, levemente arrastada e displicente, sem exagerar a ponto "
        "de ficar ininteligível. Estas instruções de tom são apenas direção de "
        "atuação: não as leia em voz alta nem mude as palavras do texto:\n\n"
        f"{texto}"
    )

    try:
        response = await client.aio.models.generate_content(
            model=settings.gemini_tts_model,
            contents=contents,
            config=types.GenerateContentConfig(
                response_modalities=["AUDIO"],
                speech_config=types.SpeechConfig(
                    voice_config=types.VoiceConfig(
                        prebuilt_voice_config=types.PrebuiltVoiceConfig(
                            voice_name=voz or settings.gemini_tts_voz,
                        ),
                    ),
                ),
            ),
        )
    except Exception as exc:  # noqa: BLE001 - quota/erro de API: degrada p/ texto
        return {"erro": f"Falha ao gerar áudio: {exc}"}

    # Extração defensiva: o TTS às vezes devolve um candidato sem `content`
    # (texto muito curto/ambíguo), o que crasharia o acesso direto a `.parts`.
    cand = response.candidates[0] if response.candidates else None
    content = getattr(cand, "content", None) if cand else None
    parts = list(getattr(content, "parts", None) or [])
    audio_part = next((p for p in parts if getattr(p, "inline_data", None)), None)

    if audio_part is None:
        text_part = next((p for p in parts if getattr(p, "text", None)), None)
        motivo = text_part.text if text_part else "filtro de segurança bloqueou a geração."
        return {"erro": f"Falha ao gerar áudio: {motivo}"}

    raw = audio_part.inline_data.data
    pcm = base64.b64decode(raw) if isinstance(raw, str) else raw
    wav = _pcm_para_wav(pcm, _taxa_do_mime(audio_part.inline_data.mime_type))

    return {
        "base64": base64.b64encode(wav).decode("utf-8"),
        "mimetype": "audio/wav",
    }


async def gerar_musica(prompt: str) -> dict:
    """Gera uma música (clipe de ~30s) a partir de um prompt usando o Lyria 3.

    Diferente do TTS (`gerar_audio`, que LÊ um texto), aqui o modelo COMPÕE uma
    faixa musical. Usa o `lyria-3-clip-preview` (sempre ~30s) pela Interactions API
    do genai. O gate de uso é checado ANTES de tocar na API (anti-abuso/custo).

    Args:
        prompt: descrição da música — estilo/clima/instrumentos e, se for cantada,
            sobre o que cantar (de preferência em português).

    Returns:
        `{"base64": <mp3>, "mimetype": "audio/mpeg"}` ou `{"erro": "..."}` (limite
        de uso atingido, cota/erro da API, ou resposta sem áudio).
    """
    limite = _checar_limite_musica()
    if limite:
        return {"erro": limite}

    client = genai.Client(api_key=settings.gemini_api_key)

    # Interactions API (genai >= 2.x): o schema novo ("steps") é o default. O
    # `output_audio` é o atalho para o último bloco de áudio gerado — `data` em
    # base64 (MP3 do Lyria) e `mime_type`. (No genai 1.x esse caminho dava HTTP 400:
    # schema legacy desligado em mai/2026 — por isso o ADK foi para 2.x.)
    try:
        interaction = await client.aio.interactions.create(
            model=settings.gemini_music_model,
            input=prompt,
        )
    except Exception as exc:  # noqa: BLE001 - cota/erro de API: degrada p/ texto
        return {"erro": f"Falha ao gerar música: {exc}"}

    audio = interaction.output_audio
    if audio is None or not audio.data:
        return {"erro": "Falha ao gerar música: a API não devolveu áudio."}

    return {"base64": audio.data, "mimetype": audio.mime_type or "audio/mpeg"}


async def buscar_web(query: str) -> dict:
    """Pesquisa na internet (Tavily) para responder com informação atual/factual.

    Use quando a pergunta depender de fatos recentes, notícias, cotações, dados que
    mudam, ou qualquer coisa que você não saiba com certeza.

    Args:
        query: o termo de busca, em linguagem natural (de preferência em português).

    Returns:
        Dicionário com `resumo` (str, resposta sintetizada) e `resultados`
        (lista de {`titulo`, `url`, `trecho`}). Em caso de falha: `{"erro": "..."}`.
    """
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                settings.tavily_search_url,
                json={
                    "api_key": settings.tavily_api_key,
                    "query": query,
                    "search_depth": "basic",
                    "max_results": 5,
                    "include_answer": True,
                },
            )
            resp.raise_for_status()
            dados = resp.json()
    except Exception as exc:  # noqa: BLE001 - devolve erro pro modelo, não derruba o turno
        return {"erro": f"Falha na busca web: {exc}"}

    resultados = [
        {
            "titulo": r.get("title", ""),
            "url": r.get("url", ""),
            "trecho": r.get("content", ""),
        }
        for r in dados.get("results", [])
    ]
    return {"resumo": dados.get("answer") or "", "resultados": resultados}


def _autores_resumidos(autores: list, limite: int = 3) -> str:
    """Junta os nomes dos autores; acima de `limite`, corta e acrescenta 'et al.'."""
    nomes = [a.get("name", "") for a in autores if a.get("name")]
    if not nomes:
        return ""
    if len(nomes) > limite:
        return ", ".join(nomes[:limite]) + " et al."
    return ", ".join(nomes)


async def buscar_artigos(query: str) -> dict:
    """Busca artigos científicos no Semantic Scholar (rápido, com resumo TLDR).

    Use SEMPRE que a pergunta pedir embasamento científico/acadêmico ("o que a
    ciência diz sobre...", "tem estudo sobre...", "qual a evidência de..."). É a
    opção PADRÃO para artigos: ranqueia por relevância e traz um resumo de uma
    frase (`tldr`) pronto para citar. Para levantamentos amplos/profundos ou com
    filtros (ano, open-access), use `deepsearch_artigos`.

    Args:
        query: o tema/pergunta de busca, em linguagem natural.

    Returns:
        Dicionário com `artigos` (lista de {`titulo`, `ano`, `autores`, `tldr`,
        `citacoes`, `venue`, `url`, `pdf_aberto`}). Em caso de falha: `{"erro": "..."}`.
    """
    headers = {}
    if settings.semantic_scholar_api_key:
        headers["x-api-key"] = settings.semantic_scholar_api_key
    try:
        async with httpx.AsyncClient(timeout=30, headers=headers) as client:
            resp = await client.get(
                settings.semantic_scholar_api_url,
                params={
                    "query": query,
                    "limit": 5,
                    "fields": "title,abstract,year,authors,url,citationCount,tldr,openAccessPdf,venue",
                },
            )
            resp.raise_for_status()
            dados = resp.json()
    except Exception as exc:  # noqa: BLE001 - devolve erro pro modelo, não derruba o turno
        return {"erro": f"Falha na busca de artigos: {exc}"}

    artigos = []
    for p in dados.get("data", []):
        tldr = (p.get("tldr") or {}).get("text") or ""
        pdf = (p.get("openAccessPdf") or {}).get("url") or ""
        artigos.append({
            "titulo": p.get("title", ""),
            "ano": p.get("year"),
            "autores": _autores_resumidos(p.get("authors") or []),
            "tldr": tldr,
            "citacoes": p.get("citationCount"),
            "venue": p.get("venue", ""),
            "url": p.get("url", ""),
            "pdf_aberto": pdf,
        })
    if not artigos:
        return {"erro": "Nenhum artigo encontrado para essa busca."}
    return {"artigos": artigos}


def _remontar_abstract(inverted_index: dict, max_chars: int = 300) -> str:
    """Reconstrói o abstract do OpenAlex (vem como índice invertido palavra→posições)."""
    if not inverted_index:
        return ""
    posicoes: list[tuple[int, str]] = []
    for palavra, indices in inverted_index.items():
        for i in indices:
            posicoes.append((i, palavra))
    texto = " ".join(palavra for _, palavra in sorted(posicoes))
    return texto[:max_chars].rstrip() + "…" if len(texto) > max_chars else texto


async def deepsearch_artigos(
    query: str, desde_ano: int | None = None, apenas_open_access: bool = False
) -> dict:
    """Varredura PROFUNDA de artigos científicos no OpenAlex (ampla, com filtros).

    Use quando o `buscar_artigos` vier fraco/vazio, OU quando pedirem um
    levantamento amplo/aprofundado/recente sobre um assunto. Cobre ~240M de
    trabalhos e ordena por número de citações. Permite filtrar por ano e por
    acesso aberto.

    Args:
        query: o tema de busca, em linguagem natural.
        desde_ano: se informado, traz só artigos publicados a partir desse ano.
        apenas_open_access: se True, traz só artigos de acesso aberto (com PDF livre).

    Returns:
        Dicionário com `artigos` (lista de {`titulo`, `ano`, `autores`, `resumo`,
        `citacoes`, `venue`, `url`, `open_access`}). Em caso de falha: `{"erro": "..."}`.
    """
    params = {
        "search": query,
        "per_page": 10,
        "sort": "cited_by_count:desc",
        "mailto": settings.openalex_mailto,
    }
    filtros = []
    if desde_ano:
        filtros.append(f"publication_year:>{desde_ano - 1}")
    if apenas_open_access:
        filtros.append("is_oa:true")
    if filtros:
        params["filter"] = ",".join(filtros)

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(settings.openalex_api_url, params=params)
            resp.raise_for_status()
            dados = resp.json()
    except Exception as exc:  # noqa: BLE001 - devolve erro pro modelo, não derruba o turno
        return {"erro": f"Falha no deepsearch de artigos: {exc}"}

    artigos = []
    for w in dados.get("results", []):
        autores = [
            {"name": (a.get("author") or {}).get("display_name", "")}
            for a in w.get("authorships", [])
        ]
        loc = (w.get("primary_location") or {}).get("source") or {}
        artigos.append({
            "titulo": w.get("title", ""),
            "ano": w.get("publication_year"),
            "autores": _autores_resumidos(autores),
            "resumo": _remontar_abstract(w.get("abstract_inverted_index") or {}),
            "citacoes": w.get("cited_by_count"),
            "venue": loc.get("display_name", ""),
            "url": w.get("doi") or w.get("id", ""),
            "open_access": (w.get("open_access") or {}).get("is_oa", False),
        })
    if not artigos:
        return {"erro": "Nenhum artigo encontrado para essa busca."}
    return {"artigos": artigos}


async def buscar_imagem(query: str) -> dict:
    """Procura uma imagem existente na web (Tavily) e a devolve pronta para envio.

    Diferente de `gerar_imagem` (que cria uma imagem nova com IA), esta acha uma
    imagem real já existente na internet. Depois de chamar, use `enviar_imagem`
    com o `base64` retornado para entregar no WhatsApp.

    Args:
        query: descrição do que procurar (ex.: "gato siamês filhote").

    Returns:
        Dicionário com `base64`, `mimetype`, `url` e `titulo` (mesmo formato de
        `gerar_imagem`). Em caso de falha: `{"erro": "..."}`.
    """
    # User-Agent de navegador: muitos sites respondem 403 a clientes sem UA.
    headers = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"}
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True, headers=headers) as client:
            resp = await client.post(
                settings.tavily_search_url,
                json={
                    "api_key": settings.tavily_api_key,
                    "query": query,
                    "search_depth": "basic",
                    "max_results": 5,
                    "include_images": True,
                    "include_image_descriptions": True,
                },
            )
            resp.raise_for_status()
            imagens = resp.json().get("images") or []
            if not imagens:
                return {"erro": "Nenhuma imagem encontrada para essa busca."}

            # Tenta cada candidata (Tavily devolve URL str ou {url, description});
            # pula as que falham (403/404/timeout) até baixar uma de verdade.
            ultimo_erro = "sem candidatas"
            for cand in imagens[:5]:
                img_url = cand.get("url") if isinstance(cand, dict) else cand
                descricao = cand.get("description", "") if isinstance(cand, dict) else ""
                if not img_url:
                    continue
                try:
                    img_resp = await client.get(img_url)
                    img_resp.raise_for_status()
                except Exception as exc:  # noqa: BLE001 - tenta a próxima candidata
                    ultimo_erro = str(exc)
                    continue
                mimetype = img_resp.headers.get("content-type", "image/jpeg").split(";")[0]
                if not mimetype.startswith("image/"):
                    ultimo_erro = f"conteúdo não é imagem ({mimetype})"
                    continue
                return {
                    "base64": base64.b64encode(img_resp.content).decode("utf-8"),
                    "mimetype": mimetype,
                    "url": img_url,
                    "titulo": descricao,
                }
            return {"erro": f"Não consegui baixar nenhuma imagem: {ultimo_erro}"}
    except Exception as exc:  # noqa: BLE001
        return {"erro": f"Falha na busca de imagem: {exc}"}


# --- Tools de ENTREGA (expostas ao modelo) -----------------------------------
# Importante: estas tools recebem argumentos PEQUENOS (texto + jid) e fazem a
# busca/geração + o envio via MCP no próprio servidor. O base64 da imagem NUNCA
# volta para o modelo (evita o modelo ter que re-emitir ~100KB de base64, que
# trava/estoura). `gerar_imagem`/`buscar_imagem` acima são helpers internos.


async def _entregar(produtor, mcp_tool: str, jid: str, legenda: str = "") -> dict:
    """Gera/busca a imagem (via `produtor`) e entrega no WhatsApp via MCP."""
    img = await produtor
    if "erro" in img:
        return img
    try:
        args = {"jid": jid, "mediaBase64": img["base64"]}
        if mcp_tool == "enviar_imagem":
            args["legenda"] = legenda or img.get("titulo") or ""
        await chamar_mcp(mcp_tool, args)
    except Exception as exc:  # noqa: BLE001
        return {"erro": f"Falha ao enviar via MCP ({mcp_tool}): {exc}"}
    return {"status": "ok", "url": img.get("url")}


async def gerar_e_enviar_imagem(prompt: str, jid: str) -> dict:
    """CRIA uma imagem com IA e a ENVIA no WhatsApp (uma etapa só).

    Use quando o usuário pedir para criar/desenhar/gerar uma imagem. Passe
    `jid` = `usuario_jid` do contexto. Não retorna a imagem (já é enviada).
    """
    return await _entregar(gerar_imagem(prompt), "enviar_imagem", jid)


async def buscar_e_enviar_imagem(query: str, jid: str) -> dict:
    """PROCURA uma imagem real na web e a ENVIA no WhatsApp (uma etapa só).

    Use quando pedirem "acha/procura uma foto/imagem de...". Passe `jid` =
    `usuario_jid` do contexto. Não retorna a imagem (já é enviada).
    """
    return await _entregar(buscar_imagem(query), "enviar_imagem", jid)


async def gerar_e_enviar_sticker(prompt: str, jid: str) -> dict:
    """CRIA uma imagem com IA e a envia como FIGURINHA (sticker) no WhatsApp.

    Use quando pedirem um sticker/figurinha de algo a ser criado. Passe `jid` =
    `usuario_jid` do contexto.
    """
    return await _entregar(gerar_imagem(prompt), "enviar_sticker", jid)


async def enviar_sticker_gerado(prompt: str, jid: str) -> dict:
    """Alias de `gerar_e_enviar_sticker` (o modelo às vezes chama por este nome).

    CRIA uma imagem com IA e a envia como FIGURINHA (sticker) no WhatsApp.
    Passe `jid` = `usuario_jid` do contexto.
    """
    return await gerar_e_enviar_sticker(prompt, jid)


async def buscar_e_enviar_sticker(query: str, jid: str) -> dict:
    """PROCURA uma imagem na web e a envia como FIGURINHA (sticker) no WhatsApp.

    Use quando pedirem um sticker/figurinha de algo que existe (foto real).
    Passe `jid` = `usuario_jid` do contexto.
    """
    return await _entregar(buscar_imagem(query), "enviar_sticker", jid)


async def editar_e_enviar_imagem(prompt: str, jid: str) -> dict:
    """EDITA a imagem que o usuário ENVIOU ou CITOU e envia o resultado no WhatsApp.

    Use quando HOUVER uma imagem no turno e o pedido for ALTERÁ-LA: mudar
    cabelo, rosto, roupa, cor, fundo, estilo (cartoon/anime), remover/adicionar
    algo etc. `prompt` = a alteração desejada em texto; `jid` = `usuario_jid`.
    Os bytes da imagem original vêm do contexto do turno (não passe base64).
    Não retorna a imagem (já é enviada) — depois confirme em UMA frase curta.
    """
    midia = request_context.midia_atual()
    if not midia:
        return {"erro": "Não recebi imagem neste turno — peça para a pessoa enviar ou citar uma foto."}
    return await _entregar(editar_imagem(prompt, midia), "enviar_imagem", jid)


async def editar_e_enviar_sticker(prompt: str, jid: str) -> dict:
    """EDITA a imagem enviada/citada e envia o resultado como FIGURINHA (sticker).

    Igual a `editar_e_enviar_imagem`, mas entrega como figurinha. Use quando
    pedirem a imagem editada em formato de sticker. `prompt` = a alteração;
    `jid` = `usuario_jid`. Os bytes vêm do contexto do turno (não passe base64).
    """
    midia = request_context.midia_atual()
    if not midia:
        return {"erro": "Não recebi imagem neste turno — peça para a pessoa enviar ou citar uma foto."}
    return await _entregar(editar_imagem(prompt, midia), "enviar_sticker", jid)


async def gerar_e_enviar_audio(texto: str, jid: str, voz: str = "") -> dict:
    """GERA fala (TTS) a partir do texto e a ENVIA como NOTA DE VOZ no WhatsApp.

    Use quando o usuário pedir resposta em áudio ("responde em áudio", "lê isso",
    "manda um áudio") e, a seu critério de persona, em respostas curtas/leves em
    que falar fica mais divertido. `texto` = a fala já na sua persona; `jid` =
    `usuario_jid` do contexto. Não retorna o áudio (já é enviado) — depois confirme
    em UMA frase curta, sem repetir o conteúdo em texto.
    """
    return await _entregar(gerar_audio(texto, voz), "enviar_audio", jid)


async def gerar_e_enviar_musica(prompt: str, jid: str) -> dict:
    """CRIA uma MÚSICA com IA (Lyria, clipe de ~30s) e a ENVIA no WhatsApp.

    Use quando pedirem para CANTAR ou fazer/compor uma música ("canta...", "faz
    uma música sobre...", "cria uma música"). `prompt` = a descrição da música
    (estilo/clima/instrumentos e, se cantada, sobre o que cantar) já na sua
    persona; `jid` = `usuario_jid` do contexto. Não retorna o áudio (já é enviado
    como nota de voz) — depois deixe a RESPOSTA FINAL VAZIA. Em caso de limite de
    uso ou falha, devolve `{"erro": ...}`.
    """
    return await _entregar(gerar_musica(prompt), "enviar_audio", jid)


async def gerar_e_enviar_semaninha(usuario_lastfm: str, jid: str) -> dict:
    """GERA a colagem da semana (Last.fm) de um usuário e a ENVIA no WhatsApp.

    Use quando pedirem a "semaninha", a "colagem da semana" ou os "mais ouvidos"
    de alguém no Last.fm ("faz a semaninha do fulano", "manda a colagem da semana
    do beltrano"). `usuario_lastfm` = o nome de usuário no Last.fm (peça se não
    souber); `jid` = `usuario_jid` do contexto. Não retorna a imagem (já é enviada)
    — depois confirme em UMA frase curta.

    Returns:
        `{"status": "ok"}` em sucesso (a imagem já foi enviada) ou `{"erro": "..."}`.
    """
    try:
        await chamar_mcp("gerar_e_enviar_semaninha", {"usuario": usuario_lastfm, "jid": jid})
    except Exception as exc:  # noqa: BLE001 - devolve erro pro modelo, não derruba o turno
        return {"erro": f"Falha ao gerar a semaninha: {exc}"}
    return {"status": "ok"}


async def converter_em_sticker(jid: str) -> dict:
    """Transforma a imagem ENVIADA/CITADA no turno em FIGURINHA, SEM alterá-la.

    Use quando pedirem para virar sticker a foto deste turno exatamente como ela
    é ("faz figurinha disso", "transforma em sticker", "vira figurinha"). Para
    ALTERAR a imagem e já entregar como figurinha, use `editar_e_enviar_sticker`.
    `jid` = `usuario_jid` do contexto. Os bytes vêm do contexto do turno (não passe
    base64). Não retorna a figurinha (já é enviada) — depois confirme em UMA frase.

    Returns:
        `{"status": "ok"}` em sucesso ou `{"erro": "..."}`.
    """
    midia = request_context.midia_atual()
    if not midia:
        return {"erro": "Não recebi imagem neste turno — peça pra enviar ou citar uma foto."}
    try:
        await chamar_mcp("enviar_sticker", {"jid": jid, "mediaBase64": midia["base64"]})
    except Exception as exc:  # noqa: BLE001
        return {"erro": f"Falha ao converter em figurinha: {exc}"}
    return {"status": "ok"}


# --- Memória de longo prazo por usuário --------------------------------------
# Guarda/recupera trechos relevantes por pessoa (`numero`). A recuperação para
# o contexto é automática (bloco [memória-do-usuário]); estas tools são para
# GRAVAR e GERENCIAR. A PERMISSÃO é travada no código (não só na instrução):
# o `_alvo_memoria` resolve o número-alvo a partir da identidade CONFIÁVEL do
# turno (request_context), ignorando tentativa do LLM de mirar outra pessoa.


def _alvo_memoria(numero_pedido: str) -> tuple[str | None, str | None]:
    """Resolve o número-alvo aplicando a permissão. Retorna (numero, erro).

    Admin → qualquer número; não-admin → só o próprio (recusa se pedir outro);
    não-cadastrado → sem memória.
    """
    proprio, eh_admin, registrado = request_context.atual()
    if not registrado or not proprio:
        return None, "Memória só funciona para pessoas cadastradas."
    pedido = (numero_pedido or "").strip()
    if eh_admin:
        return (pedido or proprio), None
    if pedido and pedido != proprio:
        return None, "Você só pode acessar a sua própria memória."
    return proprio, None


async def salvar_memoria(numero: str, categoria: str, conteudo: str) -> dict:
    """Guarda um fato relevante sobre uma pessoa na memória de longo prazo.

    Use quando captar algo que valha lembrar no futuro: datas importantes,
    trabalho, relações, preferências/características estáveis. NÃO guarde
    trivialidades nem coisas efêmeras. Só para pessoas cadastradas.

    Args:
        numero: identificador da pessoa dona da memória (use `remetente_numero`;
            o admin pode informar o número de outra pessoa).
        categoria: rótulo curto (ex.: "trabalho", "data", "familia", "preferencia").
        conteudo: o fato em uma frase objetiva (ex.: "Faz aniversário em 12/03").

    Returns:
        `{"status": "ok"}`, `{"status": "duplicada", ...}` ou `{"erro": "..."}`.
    """
    alvo, erro = _alvo_memoria(numero)
    if erro:
        return {"erro": erro}
    try:
        emb = await memoria_repo.gerar_embedding(conteudo)
        return await memoria_repo.salvar(alvo, categoria, conteudo, emb)
    except Exception as exc:  # noqa: BLE001
        return {"erro": f"Falha ao salvar memória: {exc}"}


async def listar_memorias(numero: str) -> dict:
    """Lista o que está guardado na memória de uma pessoa.

    Use para "o que você sabe sobre mim?". Mostra o `id` (necessário p/ esquecer).

    Returns:
        `{"memorias": [{id, categoria, conteudo, created_at}]}` ou `{"erro": "..."}`.
    """
    alvo, erro = _alvo_memoria(numero)
    if erro:
        return {"erro": erro}
    try:
        memorias = await memoria_repo.listar(alvo)
    except Exception as exc:  # noqa: BLE001
        return {"erro": f"Falha ao listar memórias: {exc}"}
    if not memorias:
        return {"memorias": [], "aviso": "Nenhuma memória guardada para essa pessoa."}
    return {"memorias": memorias}


async def esquecer_memoria(numero: str, id: int) -> dict:
    """Apaga uma memória pelo `id` (obtido via `listar_memorias`).

    Returns:
        `{"status": "ok"}` ou `{"erro": "..."}`.
    """
    alvo, erro = _alvo_memoria(numero)
    if erro:
        return {"erro": erro}
    try:
        ok = await memoria_repo.esquecer(alvo, id)
    except Exception as exc:  # noqa: BLE001
        return {"erro": f"Falha ao esquecer memória: {exc}"}
    return {"status": "ok"} if ok else {"erro": "Memória não encontrada para essa pessoa."}


# --- Memória visual (reconhecimento facial) ----------------------------------
# Vincula o ROSTO da foto a uma pessoa cadastrada, num espaço vetorial PRÓPRIO
# (ver rosto_repo) — separado da memória de texto. O reconhecimento na chegada
# de imagens é AUTOMÁTICO (campo `pessoa_reconhecida` no [contexto-sistema], ver
# api/chat.py); estas tools são só para CADASTRAR/APAGAR rostos. Restrito ao
# ADMIN (coerente com o /cadastrar do bot), travado no código via request_context.


def _so_admin() -> str | None:
    """Erro se quem fala não é o admin; None se for (gate de cadastro de rosto)."""
    _proprio, eh_admin, _registrado = request_context.atual()
    if not eh_admin:
        return "Só o admin pode cadastrar rostos."
    return None


async def registrar_rosto(numero: str, nome: str) -> dict:
    """Cadastra o ROSTO da foto do turno e o vincula a uma pessoa (memória visual).

    Use quando o ADMIN mandar uma foto e disser de quem é o rosto ("cadastra o
    rosto do João", "esse é o João"). Descubra o `numero` da pessoa com
    `buscar_contato(nome)` ANTES (ela precisa estar cadastrada via `/cadastrar`).
    A foto vem do contexto do turno — NÃO passe base64.

    Args:
        numero: JID/numero da pessoa cadastrada (vindo do `buscar_contato`).
        nome: nome da pessoa (exibido no reconhecimento automático).

    Returns:
        `{"status": "ok"}`, `{"status": "duplicada"}` ou `{"erro": "..."}`.
    """
    erro = _so_admin()
    if erro:
        return {"erro": erro}
    if not (numero or "").strip():
        return {"erro": "Preciso do número da pessoa — use buscar_contato antes."}
    midia = request_context.midia_atual()
    if not midia:
        return {"erro": "Não recebi foto neste turno — peça para enviar ou citar a foto do rosto."}
    try:
        embs = await rosto_repo.gerar_embeddings_faciais(midia, 1)
        if not embs:
            return {"erro": "Não achei um rosto nítido na foto — manda uma foto mais clara do rosto."}
        alvo = numero.strip()
        resultado = await rosto_repo.salvar_rosto(alvo, nome, embs[0])
        # Guarda também a FOTO (não só o vetor): é ela que alimenta a geração de
        # imagem com pessoas cadastradas. Uma por pessoa (a última substitui).
        await rosto_repo.salvar_foto_rosto(alvo, nome, midia)
        return resultado
    except Exception as exc:  # noqa: BLE001
        return {"erro": f"Falha ao cadastrar rosto: {exc}"}


async def esquecer_rosto(numero: str) -> dict:
    """Apaga os rostos cadastrados de uma pessoa (corrigir/recadastrar).

    Use quando o ADMIN pedir para esquecer o rosto de alguém. Descubra o `numero`
    com `buscar_contato(nome)` se não souber.

    Returns:
        `{"status": "ok", "removidos": N}` ou `{"erro": "..."}`.
    """
    erro = _so_admin()
    if erro:
        return {"erro": erro}
    if not (numero or "").strip():
        return {"erro": "Preciso do número da pessoa — use buscar_contato antes."}
    try:
        n = await rosto_repo.esquecer_rosto(numero.strip())
    except Exception as exc:  # noqa: BLE001
        return {"erro": f"Falha ao esquecer rosto: {exc}"}
    return {"status": "ok", "removidos": n} if n else {"erro": "Essa pessoa não tem rosto cadastrado."}


async def gerar_e_enviar_imagem_com_pessoas(prompt: str, numeros: list[str], jid: str) -> dict:
    """CRIA uma imagem com pessoas CADASTRADAS (usa a foto do rosto delas) e ENVIA.

    Use para "faça/cria uma imagem com o X e a Y" — compor pessoas cadastradas
    numa cena nova. Descubra o `numero` de CADA pessoa com `buscar_contato(nome)`
    ANTES e passe a lista em `numeros`. `prompt` = a cena desejada (pt-BR);
    `jid` = `usuario_jid`. Não retorna a imagem (já é enviada) — depois confirme
    em UMA frase curta.

    Só funciona para quem tem ROSTO cadastrado COM FOTO. Se faltar a foto de
    alguém, o retorno diz quem — peça para cadastrar o rosto dessa pessoa.

    Returns:
        `{"status": "ok"}` ou `{"erro": "..."}` (sem foto / bloqueio do filtro).
    """
    _proprio, _eh_admin, registrado = request_context.atual()
    if not registrado:
        return {"erro": "Esse recurso é só para pessoas cadastradas."}
    nums = [n.strip() for n in (numeros or []) if (n or "").strip()]
    if not nums:
        return {"erro": "Preciso do número de pelo menos uma pessoa — use buscar_contato antes."}
    nums = nums[: settings.rosto_gen_max_pessoas]
    try:
        fotos = await rosto_repo.fotos_de(nums)
    except Exception as exc:  # noqa: BLE001
        return {"erro": f"Falha ao recuperar as fotos: {exc}"}
    if not fotos:
        return {"erro": "Nenhuma dessas pessoas tem rosto cadastrado com foto — cadastre o rosto (com a foto) primeiro."}
    # Compara por parte-de-usuário: o LLM pode passar o número com ou sem o
    # sufixo @s.whatsapp.net (foi o que quebrava entre grupos).
    achados = {rosto_repo.normalizar_numero(f["numero"]) for f in fotos}
    faltando = [n for n in nums if rosto_repo.normalizar_numero(n) not in achados]
    if faltando:
        return {"erro": f"Sem foto cadastrada para: {', '.join(faltando)}. Cadastre o rosto dessas pessoas (com foto) antes."}
    return await _entregar(gerar_imagem_com_referencias(prompt, fotos), "enviar_imagem", jid)


async def buscar_contato(nome: str) -> dict:
    """Procura um contato CADASTRADO pelo nome para descobrir o JID dele.

    Use ANTES de agendar um lembrete dirigido a OUTRA pessoa ("lembre o João de...",
    "manda 'parabéns' pra Maria dia tal"). Com o `jid` retornado, chame
    `agendar_alerta(jid=<jid do contato>, ...)`.

    Args:
        nome: nome (ou parte) da pessoa, como o usuário falou.

    Returns:
        `{"contatos": [{"nome", "jid"}]}`. Lista vazia => não cadastrado;
        vários itens => peça ao usuário para desambiguar.
    """
    try:
        bruto = await chamar_mcp_texto("buscar_pessoa", {"nome": nome})
        contatos = json.loads(bruto) if bruto else []
    except Exception as exc:  # noqa: BLE001
        return {"erro": f"Falha ao buscar contato: {exc}"}
    if not contatos:
        return {"contatos": [], "aviso": f"Nenhum contato chamado '{nome}' está cadastrado."}
    return {"contatos": contatos}


async def cadastrar_pessoa(nome: str, numero: str) -> dict:
    """Cadastra/registra uma pessoa pelo NÚMERO (identidade), restrito ao ADMIN.

    Use quando o ADMIN pedir para cadastrar/registrar alguém informando o número
    ("cadastra o Andrei, +55 41 99186-2566", "registra esse número como Maria").
    O bot normaliza o número (JID canônico) e grava. NÃO confunda com cadastro de
    ROSTO (foto + "esse é o fulano"): aquilo é `registrar_rosto`.

    Args:
        nome: o nome da pessoa, como o admin falou.
        numero: o número informado pelo admin (qualquer formato — o bot normaliza).

    Returns:
        `{"status": "ok", "nome": ...}` em sucesso ou `{"erro": "..."}`.
    """
    _proprio, eh_admin, _reg = request_context.atual()
    if not eh_admin:
        return {"erro": "Só o admin pode cadastrar pessoas."}
    if not (nome or "").strip():
        return {"erro": "Preciso do nome da pessoa pra cadastrar."}
    if not (numero or "").strip():
        return {"erro": "Preciso do número da pessoa pra cadastrar."}
    try:
        await chamar_mcp("cadastrar_pessoa", {"nome": nome, "numero": numero})
    except Exception as exc:  # noqa: BLE001 - devolve erro pro modelo, não derruba o turno
        return {"erro": f"Falha ao cadastrar pessoa: {exc}"}
    return {"status": "ok", "nome": nome}


async def listar_participantes(jid: str) -> dict:
    """Lista os participantes (só nomes) de um GRUPO do WhatsApp.

    Use quando pedirem "quem está no grupo?", "quem tá aqui?", etc. Passe
    `jid` = `usuario_jid` do contexto (precisa ser um grupo). Cada item traz
    `cadastrado`: os cadastrados vêm com o nome real; os demais com número ou
    "(desconhecido)" — para esses, não exponha número cru, agrupe como "alguns
    que não conheço".

    Returns:
        `{"participantes": [{"nome", "cadastrado"}]}` ou `{"erro": "..."}`.
    """
    try:
        bruto = await chamar_mcp_texto("listar_participantes_grupo", {"jid": jid})
        participantes = json.loads(bruto) if bruto else []
    except Exception as exc:  # noqa: BLE001
        return {"erro": f"Falha ao listar participantes: {exc}"}
    if not participantes:
        return {"participantes": [], "aviso": "Nenhum participante encontrado (ou não é um grupo)."}
    return {"participantes": participantes}


# --- Lembretes agendados (cron) ----------------------------------------------
# O agente interpreta a linguagem natural e monta a estrutura; o bot persiste,
# agenda e dispara (via node-cron). O lembrete é enviado para `jid` — por padrão
# o chat de origem, mas pode ser o JID de um contato (ver buscar_contato).
#
# PERMISSÃO travada no código (não só na instrução): a identidade de quem pede
# vem do `request_context` (vinda do request HTTP, CONFIÁVEL), não dos argumentos
# que o LLM passa. O bot enforce: admin mexe em qualquer lembrete; os demais só
# nos que eles mesmos criaram.


def _identidade_agendamento() -> tuple[str | None, bool, str | None]:
    """Resolve quem está pedindo, a partir da identidade confiável do turno.

    Retorna `(solicitante, eh_admin, erro)`. Recusa não cadastrado (sem número).
    """
    proprio, eh_admin, registrado = request_context.atual()
    if not registrado or not proprio:
        return None, False, "Lembretes só funcionam para pessoas cadastradas."
    return proprio, eh_admin, None


async def agendar_alerta(
    jid: str,
    mensagem: str,
    tipo: str,
    cron_expression: str = "",
    run_at: str = "",
    timezone: str = "America/Sao_Paulo",
    urgente: bool = False,
) -> dict:
    """Agenda um lembrete para ser enviado ao chat de origem num horário futuro.

    Passe `jid` = `usuario_jid` do contexto (é o destino: grupo ou privado).
    Calcule os horários a partir de `data_hora_atual` do contexto. Quem fica
    "admin" do lembrete (e poderá cancelá-lo/editá-lo) é definido pela identidade
    confiável do turno — você não precisa (nem deve) passar isso.

    Args:
        jid: JID do chat que receberá o lembrete (= usuario_jid).
        mensagem: o texto do lembrete (já na sua persona, ex.: "⏰ Lembrete: ...").
        tipo: "once" (uma vez) ou "recorrente" (repete).
        cron_expression: expressão cron (obrigatória se tipo="recorrente"). Ex.:
            "0 8 * * *" (todo dia 8h), "0 9 * * 1" (toda segunda 9h).
        run_at: data/hora ISO 8601 com offset (obrigatória se tipo="once"). Ex.:
            "2026-06-04T14:00:00-03:00".
        timezone: fuso (default "America/Sao_Paulo").
        urgente: se True, o lembrete (só para tipo="once") fica reenviando a cada
            3min até o solicitante responder no chat. Use quando o usuário pedir
            algo como "urgente", "não me deixa esquecer", "insiste comigo".

    Returns:
        `{"status": "ok"}` em sucesso ou `{"erro": "..."}`.
    """
    solicitante, _eh_admin, erro = _identidade_agendamento()
    if erro:
        return {"erro": erro}
    try:
        await chamar_mcp("agendar_mensagem", {
            "jid": jid,
            "mensagem": mensagem,
            "tipo": tipo,
            "cron_expression": cron_expression,
            "run_at": run_at,
            "timezone": timezone,
            "urgente": urgente,
            "solicitante": solicitante,
        })
    except Exception as exc:  # noqa: BLE001 - devolve erro pro modelo, não derruba o turno
        return {"erro": f"Falha ao agendar lembrete: {exc}"}
    return {"status": "ok"}


async def listar_alertas(jid: str) -> dict:
    """Lista os lembretes agendados ativos do chat. Passe `jid` = `usuario_jid`.

    O admin vê todos os lembretes do chat; os demais veem só os próprios.

    Returns:
        `{"alertas": [{id, mensagem, tipo, cron_expression, run_at}]}` ou `{"erro": "..."}`.
    """
    solicitante, eh_admin, erro = _identidade_agendamento()
    if erro:
        return {"erro": erro}
    try:
        bruto = await chamar_mcp_texto("listar_agendamentos", {
            "jid": jid,
            "solicitante": solicitante,
            "eh_admin": eh_admin,
        })
        alertas = json.loads(bruto) if bruto else []
    except Exception as exc:  # noqa: BLE001
        return {"erro": f"Falha ao listar lembretes: {exc}"}
    if not alertas:
        return {"alertas": [], "aviso": "Nenhum lembrete agendado."}
    return {"alertas": alertas}


async def cancelar_alerta(jid: str, id: int) -> dict:
    """Cancela um lembrete agendado pelo id (obtido via `listar_alertas`).

    Passe `jid` = `usuario_jid` do contexto. Só dá certo se o lembrete for de
    quem está pedindo (ou se for o admin) — caso contrário o bot recusa.

    Returns:
        `{"status": "ok"}` em sucesso ou `{"erro": "..."}`.
    """
    solicitante, eh_admin, erro = _identidade_agendamento()
    if erro:
        return {"erro": erro}
    try:
        await chamar_mcp("cancelar_agendamento", {
            "jid": jid,
            "id": id,
            "solicitante": solicitante,
            "eh_admin": eh_admin,
        })
    except Exception as exc:  # noqa: BLE001
        return {"erro": f"Falha ao cancelar lembrete: {exc}"}
    return {"status": "ok"}


async def editar_alerta(
    jid: str,
    id: int,
    mensagem: str = "",
    run_at: str = "",
    cron_expression: str = "",
    urgente: bool | None = None,
) -> dict:
    """Edita um lembrete PENDENTE pelo id (obtido via `listar_alertas`).

    Passe `jid` = `usuario_jid` do contexto. Informe APENAS os campos que mudam
    (deixe os outros vazios). Use `run_at` para lembrete "once" e `cron_expression`
    para "recorrente". Só dá certo se o lembrete for de quem está pedindo (ou se
    for o admin) — caso contrário o bot recusa.

    Args:
        jid: JID do chat admin do lembrete (= usuario_jid).
        id: id do lembrete a editar.
        mensagem: novo texto (vazio = não muda).
        run_at: novo horário ISO 8601 com offset, só p/ "once" (vazio = não muda).
        cron_expression: nova expressão cron, só p/ "recorrente" (vazio = não muda).
        urgente: liga/desliga urgência; None = não muda.

    Returns:
        `{"status": "ok"}` em sucesso ou `{"erro": "..."}`.
    """
    solicitante, eh_admin, erro = _identidade_agendamento()
    if erro:
        return {"erro": erro}
    payload: dict = {
        "jid": jid,
        "id": id,
        "solicitante": solicitante,
        "eh_admin": eh_admin,
    }
    # Só manda o que mudou — assim o bot não sobrescreve campos com vazio.
    if mensagem:
        payload["mensagem"] = mensagem
    if run_at:
        payload["run_at"] = run_at
    if cron_expression:
        payload["cron_expression"] = cron_expression
    if urgente is not None:
        payload["urgente"] = urgente
    try:
        await chamar_mcp("editar_agendamento", payload)
    except Exception as exc:  # noqa: BLE001
        return {"erro": f"Falha ao editar lembrete: {exc}"}
    return {"status": "ok"}


async def inspecionar_logs(
    nivel: str = "WARNING",
    comp: str = "",
    limite: int = 20,
    resumo: bool = False,
) -> dict:
    """Lê os logs recentes do AGENTE para investigar o estado/erros do sistema.

    Restrito ao ADMIN. Use quando o admin pedir para você olhar seus próprios logs
    ou investigar por que algo falhou ("por que a figurinha não enviou?", "deu erro
    em quê?", "como você tá?"). Os logs vêm estruturados, com segredos/números
    redigidos e truncados — resuma o que achar em vez de despejar tudo.

    Args:
        nivel: nível MÍNIMO ("DEBUG"|"INFO"|"WARNING"|"ERROR"). Default WARNING.
        comp: filtra pelo componente (substring do nome do logger, ex.: "chat",
            "roteador", "classificador"). Vazio = todos.
        limite: nº máximo de registros (teto no settings).
        resumo: se True, devolve só a CONTAGEM por tipo (nível+componente) — ótimo
            para um panorama rápido com pouquíssimo token.

    Returns:
        `{"svc": "agente", "total": N, "logs": [...]}` ou, em modo resumo,
        `{"svc": "agente", "total": N, "resumo": {...}}`. `{"erro": ...}` se não-admin.
    """
    _proprio, eh_admin, _reg = request_context.atual()
    if not eh_admin:
        return {"erro": "Só o admin pode inspecionar os logs."}
    return log_buffer.recuperar(
        nivel=nivel, comp=(comp or None), limite=limite, resumo=resumo
    )
