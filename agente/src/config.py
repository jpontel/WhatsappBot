import os

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    gemini_api_key: str
    gemini_model: str = "gemini-3-flash-preview"
    gemini_image_model: str = "gemini-3.1-flash-image-preview"
    # Síntese de fala (TTS). O modelo devolve PCM 16-bit/24kHz mono; a `voz` é
    # uma das vozes prebuilt do Gemini (ex.: Kore, Puck, Aoede, Charon).
    gemini_tts_model: str = "gemini-2.5-flash-preview-tts"
    gemini_tts_voz: str = "Kore"
    # Geração de MÚSICA (Lyria 3). O `clip` gera clipes de ~30s (versão limitada);
    # o `pro` faria músicas longas (não usado, mais caro). Devolve MP3 base64.
    gemini_music_model: str = "lyria-3-clip-preview"
    # Modelos de fallback (em ordem) quando o primário falha com 429/503. Caímos
    # pro flash-lite (mais barato) só como rede de segurança. OBS: os modelos
    # gemini-2.5 foram descontinuados para contas novas (404 "no longer available
    # to new users"); usar geração 3.x. gemini-3.5-flash-lite confirmado 200.
    gemini_fallback_models: list[str] = ["gemini-3.5-flash"]

    # Amostragem da geração de texto — combate a repetição de tom/bordões.
    # Mais alta = mais variedade (e mais risco de incoerência). Tunável.
    # OBS: penalty (frequency/presence) NÃO é suportado pelos modelos gemini-3
    # preview ("Penalty is not enabled for this model"), por isso não usamos.
    gemini_temperature: float = 1.15
    gemini_top_p: float = 0.95

    # "Temperos" de tom sorteados por turno (um por mensagem) — variam o registro
    # da resposta sem depender do modelo se auto-aleatorizar. Tunável.
    estilos_resposta: list[str] = [
        "deboche seco e curto",
        "ironia blasé/preguiçosa",
        "sarcasmo afiado e afrontoso",
        "empolgação debochada",
        "fingindo paciência com a pergunta",
        "deboche carinhoso",
        "frieza cortante",
        "malícia de duplo sentido",
        "provocação travessa/flerte zoeiro",
    ]

    # --- Classificador de tom/complexidade (sensor por LLM leve) ----------------
    # Um classificador barato lê a mensagem + contexto curto e devolve {tom,
    # complexidade}. O `tom` escolhe o BALDE de estilos (gate) e a `complexidade`
    # vira uma dica de tamanho. Mantém a VARIEDADE (ainda sorteia dentro do balde),
    # mas no registro certo. Ver docs/PLANO-classificador-tom-complexidade.md.
    classificador_ativo: bool = True
    # Modelo do classificador: o mais barato/rápido (tarefa trivial). Separado do
    # modelo da resposta de propósito.
    gemini_model_classificador: str = "gemini-3.5-flash-lite"
    # Teto de mensagens de contexto enviadas AO classificador (bem menor que o da
    # resposta — tom/complexidade se definem pelo turno atual + vizinhança imediata).
    classificador_contexto_max: int = 3
    # Timeout da chamada do classificador; ao estourar, cai no fallback (neutro).
    classificador_timeout_seg: float = 5.0

    # Baldes de estilo por tom (gate). SÃO APENAS os 9 `estilos_resposta` atuais
    # reparticionados — nenhum estilo novo. O balde `serio` usa os MENOS agressivos
    # como stopgap (não há registro sério no pool; melhoria futura é só preencher
    # este balde com estilos sóbrios, sem mexer no mecanismo).
    estilos_por_tom: dict[str, list[str]] = {
        "leve": [
            "deboche seco e curto",
            "sarcasmo afiado e afrontoso",
            "empolgação debochada",
            "frieza cortante",
            "malícia de duplo sentido",
            "provocação travessa/flerte zoeiro",
        ],
        "neutro": [
            "ironia blasé/preguiçosa",
            "deboche carinhoso",
        ],
        "serio": [
            "deboche carinhoso",
            "fingindo paciência com a pergunta",
        ],
    }

    tavily_api_key: str
    tavily_search_url: str = "https://api.tavily.com/search"

    # Recuperação de artigos científicos.
    # Semantic Scholar: a key é OPCIONAL (vazia = pool público); só melhora o rate limit.
    semantic_scholar_api_key: str = ""
    semantic_scholar_api_url: str = "https://api.semanticscholar.org/graph/v1/paper/search"
    # OpenAlex: não exige key, só um e-mail no "polite pool" (parâmetro mailto).
    openalex_api_url: str = "https://api.openalex.org/works"
    openalex_mailto: str = "jose.pontel@waproject.com.br"

    mcp_url: str = "http://localhost:3001/mcp"

    # Janela de histórico enviada ao modelo por turno. O ADK, por padrão,
    # replaya a SESSÃO INTEIRA (todos os eventos desde sempre) a cada /chat —
    # isso infla custo/latência e faz o modelo imitar chamadas de tool antigas
    # (inclusive erradas). Cortamos para as últimas N entradas via
    # before_model_callback (não apaga nada do banco; só limita o que vai pro
    # LLM). ~40 entradas ≈ 10 trocas recentes (msg + tool calls + resposta).
    historico_max_itens: int = 40

    # Teto por QUANTIDADE do buffer de contexto recente injetado por turno
    # (últimas mensagens do chat ANTES do gatilho). O bot já capa o payload, mas
    # aqui é um clamp DEFENSIVO no lado do agente — satisfaz [SEGURANÇA] regra 3:
    # tudo que entra no prompt e pode crescer precisa de limite numérico. O
    # acréscimo é FIXO por-turno e NÃO-cumulativo (é efêmero, não entra na sessão
    # do ADK). Ver client/contexto.py.
    contexto_max_itens: int = 10

    # Roteador determinístico (v0 — "porta de rota"): antes de chamar o modelo,
    # classifica a intenção da mensagem por regras (sinais já disponíveis: mídia,
    # verbos-gatilho, identidade) e RESTRINGE as ferramentas expostas ao LLM ao
    # subconjunto daquela rota — encolhendo o schema de tools por turno (menos
    # tokens) e tornando a decisão auditável. Quando nenhuma regra casa, NÃO
    # filtra (fallback: todas as tools, igual ao comportamento antigo). É um
    # kill switch: `false` desliga o roteador e volta ao LLM completo sempre.
    # Ver client/roteador.py. NUNCA bloqueia — só atalha.
    roteador_ativo: bool = True

    # Fuso usado para interpretar "agora" (lembretes/agendamentos) e injetar a
    # data/hora atual no contexto do modelo.
    timezone: str = "America/Sao_Paulo"

    # Memória de longo prazo (vetorial, sqlite-vec).
    embedding_model: str = "gemini-embedding-001"
    embedding_dim: int = 768
    memoria_top_k: int = 5
    memoria_distancia_max: float = 1.0   # acima disso, irrelevante p/ injetar
    memoria_distancia_dedup: float = 0.15  # abaixo disso, considera duplicata
    memoria_max_por_pessoa: int = 200

    # Memória visual (reconhecimento facial, sqlite-vec — espaço SEPARADO do
    # texto: modelo dedicado de face-recognition, NÃO o gemini-embedding-001).
    rosto_model: str = "buffalo_l"          # pacote InsightFace (buffalo_s = + leve)
    rosto_embedding_dim: int = 512          # ArcFace
    # Limiar de distância L2 (sobre embeddings normalizados, ≈ cosseno) para
    # considerar "mesma pessoa". CALIBRAR empiricamente com fotos reais —
    # acima disso, NÃO é match (segue desconhecido).
    rosto_distancia_max: float = 0.9
    rosto_distancia_dedup: float = 0.2      # abaixo disso, foto ~idêntica (não duplica)
    rosto_max_faces_por_turno: int = 3      # teto de rostos reconhecidos por imagem
    rosto_max_por_pessoa: int = 5           # teto de vetores (ângulos) por pessoa
    rosto_gen_max_pessoas: int = 4          # teto de pessoas/refs por geração de imagem

    # Rate limit de GERAÇÃO de imagens por usuário (anti-abuso/custo), em janela
    # DESLIZANTE (mesma mecânica da música — `_checar_limite_geracao`). Conta só
    # geração/edição com IA (Gemini); busca de imagem na web e áudio (TTS) não
    # entram. Cada imagem ~512px custa ≈ US$0,045. Tunável.
    imagem_rate_max: int = 10               # máx. de imagens na janela
    imagem_rate_janela_seg: int = 300       # janela em segundos (5 min)

    # Rate limit de GERAÇÃO de música (Lyria) por usuário — contador INDEPENDENTE
    # do de imagem (gerar música não consome o teto de imagem e vice-versa). Mesma
    # mecânica de janela deslizante. Ver `_checar_limite_musica`.
    musica_rate_max: int = 5                # máx. de músicas na janela
    musica_rate_janela_seg: int = 300       # janela em segundos (5 min)

    # Auto-recuperação de turnos do /chat que falharam de forma transiente. A
    # conversa vira PENDENTE no banco e uma rotina re-tenta de tempos em tempos.
    pendencia_intervalo_seg: int = 600      # intervalo entre varreduras da rotina (10 min)
    pendencia_max_tentativas: int = 3       # após isso, desiste e avisa o admin
    pendencia_contexto_max: int = 10        # teto de mensagens de contexto reinjetadas no retry
    pendencia_lote_max: int = 50            # máx. de pendências processadas por varredura
    admin_jid: str = ""                     # JID/numero do admin p/ avisos (ex.: desistência) — lido de ADMIN_JID

    host: str = "0.0.0.0"
    port: int = 8000

    database_url: str = "sqlite+aiosqlite:///./agente.db"


settings = Settings()

# O cliente google-genai usado pelo LlmAgent do ADK lê a chave do ambiente do
# processo (GOOGLE_API_KEY). O pydantic-settings carrega o .env apenas para este
# objeto `settings`, sem popular o os.environ — então exportamos aqui para que a
# chamada principal do LLM enxergue a chave. Não sobrescreve se já estiver definida
# no ambiente (ex.: deploy que injeta a variável direto).
os.environ.setdefault("GOOGLE_API_KEY", settings.gemini_api_key)
