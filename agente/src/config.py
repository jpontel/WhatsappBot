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
    # Modelos de fallback (em ordem) quando o primário falha com 429/503. NÃO
    # incluir gemini-3-flash-preview: ele é +67% input / +20% output que o
    # gemini-2.5-flash primário — escalar pra ele no overload encarecia em
    # silêncio. Caímos pro flash-lite (mais barato) só como rede de segurança.
    gemini_fallback_models: list[str] = ["gemini-2.5-flash-lite"]

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

    # Teto DIÁRIO de GERAÇÃO de imagens por usuário (anti-abuso/custo): cada
    # usuário pode gerar no máximo `imagem_max_por_dia` imagens por DIA-CALENDÁRIO
    # (reseta à meia-noite no fuso de `timezone`). O ADMIN (ver `ADMIN_JID`) é
    # ISENTO — gera quantas quiser. Conta só geração/edição com IA (Gemini); busca
    # de imagem na web e áudio (TTS) não entram. Cada imagem ~512px custa ≈ US$0,045
    # (747 tokens de saída a US$60/1M) — 10/dia ≈ US$0,45/dia por usuário no teto.
    # Ver `_checar_limite_geracao`.
    imagem_max_por_dia: int = 10            # máx. de gerações por dia (não-admin)

    # Rate limit de GERAÇÃO de música (Lyria) por usuário — contador INDEPENDENTE
    # do de imagem (gerar música não consome o teto de imagem e vice-versa). Mesma
    # mecânica de janela deslizante. Ver `_checar_limite_musica`.
    musica_rate_max: int = 5                # máx. de músicas na janela
    musica_rate_janela_seg: int = 300       # janela em segundos (5 min)

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
