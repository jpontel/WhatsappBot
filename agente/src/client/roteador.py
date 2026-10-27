"""Roteador determinístico de intenção — "porta de rota" (v0).

Plano MP-1 (ver artifact de arquitetura): hoje quem decide o que fazer é o
próprio LLM, raciocinando sobre TODO o cardápio de ~24 ferramentas a cada turno
— não-determinístico e caro em tokens (o schema de todas as tools vai no prompt
sempre). Este módulo introduz um porteiro ANTES do modelo que, por regras sobre
sinais já disponíveis (mídia no turno, verbos-gatilho, identidade), classifica a
mensagem numa ROTA e restringe as ferramentas expostas ao LLM ao subconjunto
daquela rota. Resultado: schema de tools menor por turno (menos tokens) e decisão
auditável.

Princípios (v0):
- **Nunca bloqueia, só atalha.** Quando nenhuma regra casa, `decidir_rota`
  devolve None → `tools_da_rota` devolve None → o filtro NÃO roda e o LLM recebe
  TODAS as tools (comportamento antigo, rede de segurança).
- **Interface plugável.** O filtro vive atrás do before_model_callback; trocar as
  regras por um classificador (v1 embeddings / v2 Jev) não muda o resto.
- **Dano só quando o turno precisaria de uma tool de OUTRA rota** — para mensagem
  conversa/tópico (sem tool), restringir é inócuo: o modelo responde em texto.
- **Identidade vem do request (confiável), nunca do texto** — rota `rosto` exige
  admin; `memoria` exige cadastrado.

Impacto em tokens (verificação obrigatória — CLAUDE.md [SEGURANÇA]): este módulo
NÃO adiciona nada ao prompt; apenas REMOVE declarações de tool nas rotas que
casam (redução por-turno, sem acúmulo). A rota escolhida volta no ChatResponse
(telemetria), fora do prompt.
"""

import logging
import re
import unicodedata

from google.genai import types

from client.instruction import (
    FRAGMENTO_BETTDOPO,
    FRAGMENTO_LOTE,
    INSTRUCAO_POR_ROTA,
    INSTRUCAO_SEM_ROTA,
)
from shared import request_context

logger = logging.getLogger(__name__)

# --- Nomes de ferramentas (como aparecem nas function_declarations) -----------
# Python tools = nome da função. MCP tools (do bot) = nome registrado no servidor
# MCP. Tool cross-cutting mantida em TODA rota restrita (a persona reage):
_BASE = frozenset({"reagir"})

# Subconjuntos por rota. União com _BASE é feita em `tools_da_rota`.
_TOOLS_POR_ROTA: dict[str, frozenset[str]] = {
    "geracao_visual": frozenset({
        "gerar_e_enviar_imagem", "gerar_e_enviar_imagem_com_pessoas",
        "buscar_e_enviar_imagem", "gerar_e_enviar_sticker",
        "enviar_sticker_gerado", "buscar_e_enviar_sticker",
        "editar_e_enviar_imagem", "editar_e_enviar_sticker", "buscar_contato",
    }),
    "edicao_visual": frozenset({
        "editar_e_enviar_imagem", "editar_e_enviar_sticker",
        "gerar_e_enviar_imagem", "gerar_e_enviar_sticker",
    }),
    "audio": frozenset({"gerar_e_enviar_audio"}),
    "musica": frozenset({"gerar_e_enviar_musica"}),
    "lembrete": frozenset({
        "agendar_alerta", "listar_alertas", "cancelar_alerta",
        "editar_alerta", "buscar_contato",
    }),
    "memoria": frozenset({
        "salvar_memoria", "listar_memorias", "esquecer_memoria", "buscar_contato",
    }),
    "rosto": frozenset({"registrar_rosto", "esquecer_rosto", "buscar_contato"}),
    "busca": frozenset({"buscar_web", "buscar_artigos", "deepsearch_artigos"}),
    # Imagem no turno sem outra intenção: o modelo só "olha" e comenta — nenhuma
    # tool além da base. Maior economia de schema.
    "visao": frozenset(),
}


def _norm(texto: str) -> str:
    """Minúsculas + sem acento, para casar 'música'/'musica' etc."""
    s = unicodedata.normalize("NFD", (texto or "").lower())
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


# --- Regras (regex sobre o texto normalizado) ---------------------------------
_RE_GER_VERBO = re.compile(r"\b(desenh\w*|gera\w*|cria\w*|faz|faca|fazer|monta\w*|ilustra\w*|gostaria de ver)\b")
_RE_GER_NOUN = re.compile(r"\b(imagem|imagens|figurinha\w*|sticker\w*|foto|fotos|desenho|logo|logotipo|arte|wallpaper|papel de parede|meme\w*|retrato|poster)\b")
_RE_EDIT = re.compile(r"\b(edita\w*|muda\w*|troca\w*|altera\w*|remov\w*|tira\w*|coloca\w*|adiciona\w*|deixa|transform\w*|melhora\w*|conserta\w*|recorta\w*|corta\w*|apaga\w*|pinta\w*)\b")
# "cantar" é o verbo canônico de pedir música ("canta uma música sobre...") —
# por si só já basta para a rota de música, sem precisar de substantivo musical.
_RE_MUSICA = re.compile(r"\b(compoe\w*|compor|cant[ae]\w*|cantar|jingle|instrumental|musiquinha|trilha sonora)\b")
_RE_MUSICA_NOUN = re.compile(r"\b(musica|cancao|beat|rap|funk|samba|sertanejo)\b")
_RE_AUDIO = re.compile(
    r"\b("
    r"fala isso|falar isso|le isso|leia isso|narra\w*|nota de voz"
    # "quero/queria/manda/faz/gera/grava (um) audio" — intenção explícita de TTS.
    r"|(quero|queria|manda|me manda|faz|faca|fazer|gera\w*|cria\w*|grava\w*)\s+(um\s+)?audio"
    # "audio do/da/de X", "audio falando/dizendo", "audio disso".
    r"|audio\s+(d[oae]|disso|falando|dizendo)"
    r"|em audio|por audio|me responde por audio"
    r")\b"
)
_RE_LEMBRETE = re.compile(r"\b(me lembr\w*|lembr[ae] de|me avis\w*|agend\w*|todo dia|toda\s+(segunda|terca|quarta|quinta|sexta|sabado|domingo|semana|hora|noite|manha)|amanha|depois de amanha|daqui a|as \d{1,2}(h|:| horas?| da)|cron)\b")
_RE_MEMORIA = re.compile(r"\b(anota\w*|anote|lembra que eu|guarda que|memoriz\w*|salva que|registra que|nao esquec\w* que|grava que)\b")
_RE_ROSTO_PESSOA = re.compile(r"\b(esse|essa|este|esta)\s+(e|eh)\s+[oa]\b")
_RE_ROSTO_KW = re.compile(r"\b(cadastr\w*\s+(o|a|esse|essa|rosto)|rosto d|reconhec\w*)\b")
_RE_BUSCA = re.compile(r"\b(pesquis\w*|procur\w*|busca na web|busca no|o que e|o que foi|quem e|quem foi|noticia\w*|preco de|cotacao|quanto custa|artigo\w*|paper\w*|estudo\w* sobre|cientific\w*)\b|https?://")
# Gatilho da regra condicional "bettdopo"/trovão — vale em QUALQUER rota (não é
# uma rota, é um fragmento extra de instrução injetado quando a msg menciona isso).
_RE_BETTDOPO = re.compile(r"\b(bettdopo|bet do po|trov\w*)\b")


def decidir_rota(
    mensagem: str,
    tem_imagem: bool,
    eh_admin: bool,
    registrado: bool,
) -> str | None:
    """Classifica a intenção por regras. Primeira que casa vence; None = fallback.

    Ordem importa: do sinal mais específico ao mais genérico.
    """
    m = _norm(mensagem)

    # 1) Cadastro de rosto — só admin, com imagem e marcador explícito.
    if tem_imagem and eh_admin and (_RE_ROSTO_PESSOA.search(m) or _RE_ROSTO_KW.search(m)):
        return "rosto"

    # 2) Edição da imagem do turno (imagem presente + verbo de edição).
    if tem_imagem and _RE_EDIT.search(m):
        return "edicao_visual"

    # 3) Geração visual (verbo de "fazer" + substantivo de imagem/figurinha).
    if _RE_GER_VERBO.search(m) and _RE_GER_NOUN.search(m):
        return "geracao_visual"

    # 4) Música (intenção explícita de compor, OU verbo de fazer + nome musical).
    if _RE_MUSICA.search(m) or (_RE_GER_VERBO.search(m) and _RE_MUSICA_NOUN.search(m)):
        return "musica"

    # 5) Áudio / nota de voz (intenção explícita).
    if _RE_AUDIO.search(m):
        return "audio"

    # 6) Lembrete / agendamento (marcador temporal ou verbo de lembrar).
    if _RE_LEMBRETE.search(m):
        return "lembrete"

    # 7) Memória (só faz sentido para pessoa cadastrada).
    if registrado and _RE_MEMORIA.search(m):
        return "memoria"

    # 8) Busca factual / científica / URL.
    if _RE_BUSCA.search(m):
        return "busca"

    # 9) Imagem no turno sem outra intenção: só olhar/comentar.
    if tem_imagem:
        return "visao"

    # 10) Nada casou → fallback (sem filtro: LLM recebe todas as tools).
    return None


def tools_da_rota(rota: str | None) -> frozenset[str] | None:
    """Conjunto de tools permitidas na rota (∪ base), ou None = sem filtro."""
    if rota is None:
        return None
    return _TOOLS_POR_ROTA.get(rota, frozenset()) | _BASE


def filtrar_tools(callback_context, llm_request) -> None:  # noqa: ANN001 - assinatura ADK
    """before_model_callback: restringe as function_declarations do turno à rota.

    Lê `request_context.tools_permitidas_atual()`. None → não filtra (fallback).
    Reconstrói `llm_request.config.tools` com um Tool novo contendo só as
    declarações permitidas (não muta os objetos do ADK, que podem ser
    reaproveitados). Tools não-função (ex.: google_search) passam intactas.
    `tools_dict` fica como está: se por acaso o modelo chamar algo, ainda executa.
    """
    permitidas = request_context.tools_permitidas_atual()
    if not permitidas:  # None ou vazio-sem-filtro → fallback
        return None

    config = getattr(llm_request, "config", None)
    tools = getattr(config, "tools", None) if config else None
    if not tools:
        return None

    novas = []
    total = mantidas_total = 0
    for tool in tools:
        fds = getattr(tool, "function_declarations", None)
        if not fds:
            novas.append(tool)  # tool não-função: preserva
            continue
        total += len(fds)
        mantidas = [fd for fd in fds if getattr(fd, "name", None) in permitidas]
        if mantidas:
            mantidas_total += len(mantidas)
            novas.append(types.Tool(function_declarations=mantidas))
        # senão: descarta o Tool inteiro (nenhuma declaração permitida)

    config.tools = novas
    logger.info(
        "Roteador: rota=%s — tools %d→%d",
        request_context.rota_atual(), total, mantidas_total,
    )
    return None


def instrucao_suplementar(mensagem: str, rota: str | None) -> str:
    """Monta o SUFIXO de system_instruction do turno (orientação específica).

    Espelha a decisão de rota: na rota conhecida injeta SÓ a orientação daquela
    rota (menor que o manual monolítico); no fallback (rota=None) injeta TODA a
    orientação de tools — porque ali o LLM recebe TODAS as tools e precisa saber
    usá-las (rede de segurança: nunca pior que o comportamento antigo).

    É acréscimo FIXO por-turno (não acumula com a conversa) — ver [SEGURANÇA].
    """
    if rota is not None and rota in INSTRUCAO_POR_ROTA:
        base = INSTRUCAO_POR_ROTA[rota]
    else:
        # Fallback: LLM vê todas as tools → precisa de toda a orientação + o
        # bloco de "tools sem rota".
        base = "\n".join(INSTRUCAO_POR_ROTA.values()) + "\n" + INSTRUCAO_SEM_ROTA

    # Fragmentos condicionais — valem em QUALQUER rota (inclusive fallback).
    m = _norm(mensagem)
    if _RE_BETTDOPO.search(m):
        base += FRAGMENTO_BETTDOPO
    # "[lote ...]" é marcador do próprio sistema, não texto do usuário; casar no
    # original (sem normalizar), case-insensitive, só no começo da mensagem.
    if (mensagem or "").lower().startswith("[lote"):
        base += FRAGMENTO_LOTE

    return base


def injetar_instrucao(callback_context, llm_request) -> None:  # noqa: ANN001 - assinatura ADK
    """before_model_callback: concatena o sufixo da rota no system_instruction.

    Roda SEMPRE (inclusive no fallback) — por isso é um callback separado de
    `filtrar_tools`, que faz early-return quando não há filtro de tools. Lê o
    sufixo de `request_context.instrucao_suplementar_atual()`.

    `llm_request.config.system_instruction` pode vir como `str` OU como
    `types.Content`/lista de `Part` — normalizamos para texto e reescrevemos como
    str (defensivo, no padrão do `filtrar_tools`).
    """
    suf = request_context.instrucao_suplementar_atual()
    if not suf:
        return None

    config = getattr(llm_request, "config", None)
    if not config:
        return None

    base = getattr(config, "system_instruction", None)
    base_texto = _system_instruction_para_texto(base)

    config.system_instruction = (base_texto + "\n\n" + suf) if base_texto else suf
    logger.info(
        "Roteador: rota=%s — instrução +%d chars",
        request_context.rota_atual(), len(suf),
    )
    return None


def _system_instruction_para_texto(valor) -> str:  # noqa: ANN001 - str | Content | Part | list
    """Normaliza o system_instruction (str/Content/Part/lista) para texto puro."""
    if not valor:
        return ""
    if isinstance(valor, str):
        return valor
    # Content/Part: extrai .parts[*].text. Lista: concatena cada item recursivamente.
    partes = getattr(valor, "parts", None)
    if partes is not None:
        return "".join(getattr(p, "text", "") or "" for p in partes)
    if isinstance(valor, (list, tuple)):
        return "".join(_system_instruction_para_texto(v) for v in valor)
    # Part solto (tem .text direto) ou fallback: usa .text se existir, senão str().
    texto = getattr(valor, "text", None)
    return texto if texto else str(valor)
