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
        "editar_e_enviar_imagem", "editar_e_enviar_sticker",
        "gerar_e_enviar_semaninha", "converter_em_sticker",
    }),
    "edicao_visual": frozenset({
        "editar_e_enviar_imagem", "editar_e_enviar_sticker",
        "gerar_e_enviar_imagem", "gerar_e_enviar_sticker",
        "converter_em_sticker",
        # Precisa estar aqui (não só em "geracao_visual") pro caso de "adiciona o
        # Fulano cadastrado NESSA foto" — tem_imagem=true + verbo de edição cai
        # aqui, e sem a tool o LLM usava editar_e_enviar_imagem (só texto, sem
        # referência de rosto) e inventava rostos genéricos pra quem foi citado.
        "gerar_e_enviar_imagem_com_pessoas",
    }),
    "cadastro": frozenset({"cadastrar_pessoa", "buscar_contato"}),
    "audio": frozenset({"gerar_e_enviar_audio"}),
    "musica": frozenset({"gerar_e_enviar_musica"}),
    "lembrete": frozenset({
        "agendar_alerta", "listar_alertas", "cancelar_alerta",
        "editar_alerta", "buscar_contato",
    }),
    "memoria": frozenset({
        "salvar_memoria", "listar_memorias", "esquecer_memoria", "buscar_contato",
    }),
    # Apple Notes (via ponte MCP no Mac) — SÓ admin. Nomes em KEBAB-CASE (o ADK não
    # renomeia tools MCP). MANTER em sincronia com _NOTES_TOOLS_EXPOSTAS em
    # root_agent.py (drift → tool some na rota ou vaza no fallback).
    "notas": frozenset({
        "create-note", "search-notes", "get-note-content",
        "append-to-note", "list-folders",
    }),
    "rosto": frozenset({"registrar_rosto", "esquecer_rosto", "buscar_contato"}),
    "busca": frozenset({"buscar_web", "buscar_artigos", "deepsearch_artigos"}),
    # Imagem no turno sem outra intenção: o modelo só "olha" e comenta — nenhuma
    # tool além da base. Maior economia de schema.
    "visao": frozenset(),
    # Guia de uso ("como você funciona"): é só EXPLICAR capacidades, não executar
    # nada → nenhuma tool. O catálogo vem no fragmento INSTRUCAO_POR_ROTA["ajuda"].
    "ajuda": frozenset(),
}


def _norm(texto: str) -> str:
    """Minúsculas + sem acento, para casar 'música'/'musica' etc."""
    s = unicodedata.normalize("NFD", (texto or "").lower())
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


# --- Regras (regex sobre o texto normalizado) ---------------------------------
_RE_GER_VERBO = re.compile(r"\b(desenh\w*|gera\w*|cria\w*|faz|faca|fazer|monta\w*|ilustra\w*|gostaria de ver)\b")
_RE_GER_NOUN = re.compile(r"\b(imagem|imagens|figurinha\w*|sticker\w*|foto|fotos|desenho|logo|logotipo|arte|wallpaper|papel de parede|meme\w*|retrato|poster)\b")
_RE_EDIT = re.compile(r"\b(edita\w*|muda\w*|troca\w*|altera\w*|remov\w*|tira\w*|coloca\w*|adiciona\w*|deixa|transform\w*|melhora\w*|conserta\w*|recorta\w*|corta\w*|apaga\w*|pinta\w*|aumenta\w*|diminui\w*|reduz\w*|amplia\w*|encolhe\w*)\b")
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
# "Você lembra de mim?" / "você lembra de quando..." — pergunta sobre a MEMÓRIA
# do bot (recall), não pedido de lembrete; mas casa em `lembr[ae] de` de
# _RE_LEMBRETE. Sem essa exclusão, mesma classe de bug do rosto/cadastro: rota
# "lembrete" não tem nenhuma tool pra responder sobre lembrança, só agendar.
_RE_LEMBRETE_RECALL = re.compile(r"\b(voce|vc|tu)\s+lembr\w*\s+de\b")
_RE_MEMORIA = re.compile(r"\b(anota\w*|anote|lembra que eu|guarda que|memoriz\w*|salva que|registra que|nao esquec\w* que|grava que)\b")
# Menção EXPLÍCITA à palavra "memória" (sem acento após _norm) combinada com um
# verbo de registro genérico ("cadastra", "registra", "anota", "guarda", "salva").
# Cobre o caso em que o usuário usa o MESMO verbo de _RE_CADASTRO pra pedir
# salvamento de memória (ex.: "cadastre na memória as informações de fulano...")
# — sem isso, _RE_CADASTRO (checado ANTES na ordem de decidir_rota) rouba a rota
# pra "cadastro", que não expõe `salvar_memoria`, e o LLM aluciona uma tool.
_RE_MEMORIA_EXPLICITA = re.compile(
    r"\b(cadastr|registr|anot|guard|salv|grav)\w*\s+(na|nas|numa)?\s*memoria\b"
)
# Apple Notes (rota "notas") — exige menção EXPLÍCITA ao substantivo "nota(s)" ou
# "apple notes". Isso desambigua da memória vetorial (_RE_MEMORIA casa "anota que
# eu gosto..." → memoria) e do cadastro (_RE_CADASTRO casa "registra o fulano" →
# cadastro). A rota é gateada a admin (ver decidir_rota) e posicionada ANTES de
# cadastro/memória — mas o gate só funciona se o regex casar a frase; por isso ele
# cobre "registra/anota NA nota", "cria uma nota", "minhas notas", etc.
_RE_NOTAS = re.compile(
    r"\bapple notes\b"
    r"|\b(anot|registr|salv|guard|escrev|cri|adicion|busc|abr|le|ler|consult|procur|ach)\w*"
    r"\s+(a|o|na|no|numa|num|uma|um|essa|esse|aquela|aquele|minha|meu|nas|nos|minhas)?\s*notas?\b"
    r"|\b(na|nas|numa|minha|minhas)\s+notas?\b"
    r"|\bo que (tem|ta|esta|diz|tinha|havia) (na|em|dentro da|nas) notas?\b"
)
_RE_ROSTO_PESSOA = re.compile(r"\b(esse|essa|este|esta)\s+(e|eh)\s+[oa]\b")
_RE_ROSTO_KW = re.compile(r"\b(cadastr\w*\s+(o|a|esse|essa|rosto)|rosto d|reconhec\w*)\b")
# Qualquer menção a "rosto" SEM imagem no turno (ex.: "tem o rosto cadastrado de
# X?") — usado só pra EXCLUIR a rota de cadastro de pessoa (1.1) abaixo: essa
# rota só serve pra `cadastrar_pessoa` por número, não tem nenhuma tool pra
# responder sobre rosto, e "cadastrado"/"registrado" bate em _RE_CADASTRO por
# acidente. Sem a exclusão, vira o mesmo bug do _RE_MEMORIA_EXPLICITA: rota
# errada, sem tool, LLM aluciona. Cai no fallback (rota=None), que já lida bem
# com a pergunta (responde em texto, sem tool).
_RE_ROSTO_MENCAO = re.compile(r"\brosto\w*\b")
# Cadastro de pessoa pelo número (sem imagem): "cadastra o fulano <número>",
# "registra esse número como Maria". Só admin (checado em decidir_rota).
_RE_CADASTRO = re.compile(r"\b(cadastr\w*|registr\w*)\b")
_RE_BUSCA = re.compile(r"\b(pesquis\w*|procur\w*|busca na web|busca no|o que e|o que foi|quem e|quem foi|noticia\w*|preco de|cotacao|quanto custa|artigo\w*|paper\w*|estudo\w* sobre|cientific\w*)\b|https?://")
# Gatilho da regra condicional "bettdopo"/trovão — vale em QUALQUER rota (não é
# uma rota, é um fragmento extra de instrução injetado quando a msg menciona isso).
_RE_BETTDOPO = re.compile(r"\b(bettdopo|bet do po|trov\w*)\b")

# Vocabulário de REAÇÃO PURA (risada, interjeição, elogio, confirmação) +
# palavras NEUTRAS de preenchimento (artigos/conectivos comuns em reações
# curtas, ex.: "que foto linda"). Usado por `_eh_reacao_pura` para decidir se
# uma mensagem-com-imagem que não bateu em NENHUMA regra de rota é só um
# comentário (rota "visao", 0 tools) ou um possível pedido de ação que
# nenhuma regra específica reconheceu (cai no fallback `None`, todas as
# tools). Critério: TODO token da mensagem precisa estar num dos dois
# conjuntos, E pelo menos 1 token precisa ser reação de verdade — senão
# "poe oculos nele"/"manda ver" (sem verbo conhecido, mas pedido de ação
# real) cairiam aqui só por acaso não baterem em nenhuma regra anterior.
# Fullmatch por TOKEN (não .search): uma palavra de elogio dentro de uma
# frase maior ("ficou bom demais, mas diminui o brilho") não pode sequestrar
# a classificação — mesma classe de bug de regex "roubando rota" já vista
# nesta sessão (memoria/cadastro, rosto/cadastro, lembrete/recall).
_PALAVRAS_REACAO = frozenset({
    "kk", "rs", "haha", "rindo", "chorando", "nossa", "uau", "caramba",
    "eita", "aff", "affs", "lindo", "linda", "incrivel", "demais", "top",
    "show", "massa", "maravilhoso", "maravilhosa", "perfeito", "perfeita",
    "sim", "nao", "ok", "blz", "valeu", "vlw", "obrigado", "obrigada",
})
_PALAVRAS_NEUTRAS = frozenset({
    "que", "isso", "essa", "esse", "foto", "imagem", "ficou", "ficaram",
    "ta", "tao", "muito", "bem", "mto", "mt", "pra", "de", "a", "o", "la", "ai",
})
# Mensagem vazia (foto sem legenda) ou só risada/pontuação — caso de maior
# volume real (reação a foto enviada pelo próprio bot).
_RE_SO_RISADA_OU_VAZIO = re.compile(r"^[\s.,!?~\-]*(k+|rs+|haha+\w*|rindo|chorando)?[\s.,!?~\-]*$")


def _eh_reacao_pura(m: str) -> bool:
    """True se a mensagem (já normalizada) é só comentário/reação — sem
    pedido de ação. Ver vocabulário acima para o critério exato."""
    if _RE_SO_RISADA_OU_VAZIO.fullmatch(m):
        return True
    palavras = re.findall(r"\w+", m)
    if not palavras:
        return False
    vocabulario = _PALAVRAS_REACAO | _PALAVRAS_NEUTRAS
    return all(p in vocabulario for p in palavras) and any(p in _PALAVRAS_REACAO for p in palavras)

# Meta-pergunta sobre o FUNCIONAMENTO do bot → rota "ajuda" (guia de uso). Cobre o
# geral ("como você funciona", "o que você faz", "quais seus comandos") e o
# específico/cherry-pick ("você sabe salvar meu rosto?", "você consegue criar
# imagem?"). O caso específico exige um verbo de capacidade depois de "sabe/
# consegue/pode", para NÃO confundir com perguntas comuns ("você sabe que horas são").
_RE_AJUDA = re.compile(
    r"como (voce|vc|tu) (funciona|usa|uso)"
    r"|como funciona (voce|vc|o bot|a lulad\w*|isso|voce ai)"
    r"|o que (voce|vc|tu) (faz|sabe fazer|consegue fazer|pode fazer|faz aqui|faz de)"
    r"|pra que (voce|vc|tu) serve|serve pra que"
    r"|quais( sao)? (as |os |suas |seus )?(funcoe\w*|funcionalidade\w*|ferramenta\w*|capacidade\w*|comando\w*)"
    r"|(seus|teus) comandos|lista de (comando\w*|funcoe\w*|funcionalidade\w*)"
    r"|me ajuda a (usar|te usar)|como (te usar|usar voce|usar vc)|manual de uso"
    r"|(voce|vc|tu) (sabe|consegue|conseguem|pode) "
    r"(fazer|criar|gerar|gera|salvar|salva|cadastrar|cadastra|mandar|manda|enviar|envia"
    r"|editar|edita|baixar|baixa|tocar|toca|cantar|canta|compor|desenhar|desenha|buscar"
    r"|busca|pesquisar|lembrar|lembra|agendar|agenda|reconhecer|transformar|converter|responder)"
    r"|(voce|vc|tu) tem como "
)


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

    # 0) Guia de uso — meta-pergunta sobre o funcionamento do bot. Vem ANTES das
    # rotas de ação para que "você sabe criar imagem?" seja EXPLICAÇÃO (ajuda), não
    # execução (geracao_visual). Só explica, não dispara tool.
    if _RE_AJUDA.search(m):
        return "ajuda"

    # 0.5) Apple Notes — SÓ admin (dado pessoal do dono do Mac). ANTES de cadastro
    # (1.1, `registr\w*`) e memória (7, `anota\w*`) para não ser sequestrada por
    # "registra/anota na nota...". Exige menção explícita a "nota(s)"/"apple notes".
    if eh_admin and _RE_NOTAS.search(m):
        return "notas"

    # 0.6) Menção EXPLÍCITA a "memória" + verbo de registro — ANTES de cadastro
    # (1.1), senão "cadastre na memória..." cai em "cadastro" (sem `salvar_memoria`
    # no cardápio) e o LLM aluciona uma tool inexistente. Só para cadastrado.
    if registrado and _RE_MEMORIA_EXPLICITA.search(m):
        return "memoria"

    # 1) Cadastro de rosto — só admin, com imagem e marcador explícito.
    if tem_imagem and eh_admin and (_RE_ROSTO_PESSOA.search(m) or _RE_ROSTO_KW.search(m)):
        return "rosto"

    # 1.1) Cadastro de pessoa pelo número — só admin, SEM imagem (com imagem, o
    # "cadastra" cai na regra de rosto acima). Verbo de cadastrar/registrar.
    # Exclui menção a "rosto" (ver _RE_ROSTO_MENCAO) — sem isso rouba perguntas
    # tipo "tem o rosto cadastrado de X?" pra uma rota sem tool nenhuma pra isso.
    if eh_admin and (not tem_imagem) and _RE_CADASTRO.search(m) and not _RE_ROSTO_MENCAO.search(m):
        return "cadastro"

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
    # Exclui "você lembra de..." (pergunta sobre recall, não pedido de lembrete).
    if _RE_LEMBRETE.search(m) and not _RE_LEMBRETE_RECALL.search(m):
        return "lembrete"

    # 7) Memória (só faz sentido para pessoa cadastrada).
    if registrado and _RE_MEMORIA.search(m):
        return "memoria"

    # 8) Busca factual / científica / URL.
    if _RE_BUSCA.search(m):
        return "busca"

    # 9) Imagem no turno sem outra intenção RECONHECIDA. "visao" (0 tools) só
    # quando a mensagem parece mesmo um comentário/reação pura — senão cai no
    # fallback (10), que dá TODAS as tools. Sem essa distinção, qualquer verbo
    # de edição não previsto (ex.: "aumenta", que faltava até esse fix) caía
    # com 0 tools disponíveis e o LLM alucinava uma função inexistente em vez
    # de ter a chance de usar a tool real.
    if tem_imagem:
        return "visao" if _eh_reacao_pura(m) else None

    # 10) Nada casou → fallback (sem filtro: LLM recebe todas as tools).
    return None


def deve_forcar_salvamento(mensagem: str) -> bool:
    """True se o turno deve FORÇAR a chamada de `salvar_memoria` (tool_config
    ANY) — gatilho da rota "memoria" (`_RE_MEMORIA` ou `_RE_MEMORIA_EXPLICITA`)
    com conteúdo substancial sobrando após o trecho-gatilho (≥3 palavras), para
    não forçar em falsos-positivos triviais (ex.: "não esquece que hoje é
    sexta" sozinho). Opera sobre a mensagem NORMALIZADA de ponta a ponta (match
    e fatiamento), evitando o bug de índice de misturar normalizada com original.
    """
    m = _norm(mensagem)
    match = _RE_MEMORIA.search(m) or _RE_MEMORIA_EXPLICITA.search(m)
    if not match:
        return False
    resto = m[match.end():].split()
    return len(resto) >= 3


def _turno_ja_executou_tool(llm_request) -> bool:  # noqa: ANN001 - assinatura ADK
    """True se algum Part de algum Content do turno já tem function_response —
    ou seja, é a 2ª (ou posterior) chamada ao modelo dentro do MESMO turno
    (depois que uma tool já executou). `function_response` é o atributo real
    do `types.Part` (snake_case); `functionResponse` é só o alias de
    serialização JSON e NUNCA existe como atributo de instância Python.
    """
    for content in (getattr(llm_request, "contents", None) or []):
        for part in (getattr(content, "parts", None) or []):
            if getattr(part, "function_response", None):
                return True
    return False


def forcar_salvamento(callback_context, llm_request) -> None:  # noqa: ANN001 - assinatura ADK
    """before_model_callback: na 1ª chamada do turno, se o gatilho de força
    estiver ativo (`request_context.forcar_salvamento_memoria_atual()`), obriga
    o modelo a chamar `salvar_memoria` via `tool_config` (function calling mode
    ANY, restrito a essa tool). NÃO força na 2ª chamada do turno (depois que a
    tool já executou) — senão o modelo tentaria chamar de novo em vez de
    responder em texto, travando a confirmação final ao usuário.
    """
    if not request_context.forcar_salvamento_memoria_atual():
        return None
    if _turno_ja_executou_tool(llm_request):
        return None

    config = getattr(llm_request, "config", None)
    if not config:
        return None

    config.tool_config = types.ToolConfig(
        function_calling_config=types.FunctionCallingConfig(
            mode=types.FunctionCallingConfigMode.ANY,
            allowed_function_names=["salvar_memoria"],
        )
    )
    logger.info("Roteador: forçando chamada de salvar_memoria (tool_config=ANY)")
    return None


def tools_da_rota(rota: str | None) -> frozenset[str] | None:
    """Conjunto de tools permitidas na rota (∪ base), ou None = sem filtro."""
    if rota is None:
        return None
    return _TOOLS_POR_ROTA.get(rota, frozenset()) | _BASE


def eh_rota_de_acao(rota: str | None) -> bool:
    """True se a rota implica EXECUTAR algo (gera/envia mídia, agenda, memoriza,
    reconhece rosto, busca...) — i.e., o usuário PEDIU algo para o bot FAZER.
    `None` (conversa/fallback), `visao` (só olhar/comentar uma imagem) e `ajuda`
    (só explicar o funcionamento) NÃO são ação. Usado para decidir se o turno merece
    reação (⏳/💅) no WhatsApp: conversa normal não ganha reação nenhuma.
    """
    return bool(rota) and rota not in {"visao", "ajuda"}


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
