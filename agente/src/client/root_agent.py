from google.adk.agents import LlmAgent
from google.adk.runners import Runner
from google.genai import types
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams
from google.adk.tools.mcp_tool.mcp_toolset import MCPToolset

from client.contexto import injetar_contexto
from client.fallback_model import FallbackGemini
from client.historico import limitar_historico
from client.instruction import INSTRUCTION, NOME_BOT
from client.roteador import filtrar_tools, injetar_instrucao
from client.session import APP_NAME, session_service
from tools.tools import (
    agendar_alerta,
    buscar_artigos,
    buscar_contato,
    buscar_e_enviar_imagem,
    buscar_e_enviar_sticker,
    buscar_web,
    cadastrar_pessoa,
    cancelar_alerta,
    converter_em_sticker,
    deepsearch_artigos,
    editar_alerta,
    editar_e_enviar_imagem,
    editar_e_enviar_sticker,
    enviar_sticker_gerado,
    esquecer_memoria,
    esquecer_rosto,
    gerar_e_enviar_audio,
    gerar_e_enviar_imagem,
    gerar_e_enviar_imagem_com_pessoas,
    gerar_e_enviar_musica,
    gerar_e_enviar_semaninha,
    gerar_e_enviar_sticker,
    inspecionar_logs,
    listar_alertas,
    listar_memorias,
    listar_participantes,
    registrar_rosto,
    salvar_memoria,
)
from config import settings

# Tools MCP de agendamento NÃO são expostas cruas ao LLM: elas têm wrappers
# Python (agendar/listar/cancelar/editar_alerta) que injetam a identidade
# CONFIÁVEL do turno e o bot enforce a permissão. Se o LLM enxergasse as tools
# cruas, poderia chamá-las direto e furar o controle. Este filtro força o uso
# dos wrappers.
_MCP_TOOLS_OCULTAS = {
    "agendar_mensagem",
    "listar_agendamentos",
    "cancelar_agendamento",
    "editar_agendamento",
    # Cadastro e semaninha têm wrappers Python (gate de admin / montagem de args);
    # esconder as MCP cruas força o LLM a usar os wrappers.
    "cadastrar_pessoa",
    "gerar_e_enviar_semaninha",
}


def _expor_tool_mcp(tool, readonly_context=None) -> bool:  # noqa: ANN001 - ToolPredicate
    return tool.name not in _MCP_TOOLS_OCULTAS


mcp_toolset = MCPToolset(
    connection_params=StreamableHTTPConnectionParams(url=settings.mcp_url),
    tool_filter=_expor_tool_mcp,
)

# Modelo com fallback automático em 429/503 (high demand / cota).
modelo = FallbackGemini(
    model=settings.gemini_model,
    fallback_models=settings.gemini_fallback_models,
)

# Amostragem mais "solta" — combate respostas com o mesmo tom/bordões. Vale
# também no fallback (a config flui para o llm_request). OBS: os modelos
# gemini-3 preview NÃO aceitam frequency/presence_penalty ("Penalty is not
# enabled for this model"), então a variedade vem de temperature/top_p + da
# rotação de `estilo_da_vez` + da diretriz anti-repetição na instrução.
config_geracao = types.GenerateContentConfig(
    temperature=settings.gemini_temperature,
    top_p=settings.gemini_top_p,
)


def _antes_do_modelo(callback_context, llm_request):  # noqa: ANN001 - assinatura ADK
    """Encadeia os before_model_callbacks do turno, na ordem:

    1. `limitar_historico` — corta a janela de histórico enviada ao modelo;
    2. `filtrar_tools` — restringe as ferramentas à rota decidida (roteador v0);
    3. `injetar_instrucao` — concatena a orientação da rota no system_instruction;
    4. `injetar_contexto` — insere o bloco [contexto-recente] (efêmero) antes do
       gatilho. DEPOIS do corte de histórico para não ser descartado por ele.

    Todos mutam o `llm_request` e retornam None (não substituem a resposta).
    """
    limitar_historico(callback_context, llm_request)
    filtrar_tools(callback_context, llm_request)
    injetar_instrucao(callback_context, llm_request)
    injetar_contexto(callback_context, llm_request)
    return None


root_agent = LlmAgent(
    name=NOME_BOT.lower(),
    model=modelo,
    instruction=INSTRUCTION,
    generate_content_config=config_geracao,
    # Corta o histórico replayado (historico.py) E restringe as tools à rota
    # decidida pelo roteador determinístico v0 (roteador.py). Ver _antes_do_modelo.
    before_model_callback=_antes_do_modelo,
    tools=[
        mcp_toolset,
        buscar_web,
        buscar_artigos,
        deepsearch_artigos,
        gerar_e_enviar_imagem,
        gerar_e_enviar_imagem_com_pessoas,
        buscar_e_enviar_imagem,
        gerar_e_enviar_sticker,
        enviar_sticker_gerado,
        buscar_e_enviar_sticker,
        editar_e_enviar_imagem,
        editar_e_enviar_sticker,
        gerar_e_enviar_audio,
        gerar_e_enviar_musica,
        gerar_e_enviar_semaninha,
        converter_em_sticker,
        agendar_alerta,
        listar_alertas,
        cancelar_alerta,
        editar_alerta,
        buscar_contato,
        cadastrar_pessoa,
        listar_participantes,
        inspecionar_logs,
        salvar_memoria,
        listar_memorias,
        esquecer_memoria,
        registrar_rosto,
        esquecer_rosto,
    ],
)

runner = Runner(
    agent=root_agent,
    app_name=APP_NAME,
    session_service=session_service,
)
