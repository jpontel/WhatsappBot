"""Testes do salvamento forçado (tool_config=ANY restrito a salvar_memoria).

Cobre:
- `deve_forcar_salvamento`: gatilho da rota "memoria" + guard de conteúdo
  mínimo (≥3 palavras após o verbo-gatilho), fatiando a mensagem NORMALIZADA
  de ponta a ponta.
- `forcar_salvamento` (before_model_callback): só seta tool_config=ANY na 1ª
  chamada do turno — usando `google.genai.types.Part`/`Content` DE VERDADE
  (não um dublê com atributo solto), para não escapar de uma regressão no
  nome do atributo (`function_response`, snake_case).
- `decidir_rota`: menção explícita a "memória" + verbo de registro (ex.:
  "cadastre na memória...") tem que ganhar da rota "cadastro" — regressão real
  observada em produção: `_RE_CADASTRO` casava "cadastre" antes de chegar na
  checagem de memória, a rota "cadastro" não expõe `salvar_memoria`, e o LLM
  acabava alucinando uma tool inexistente (`adicionar_memoria`).
"""

from google.adk.models import LlmRequest
from google.genai import types

import client.roteador as roteador
import shared.request_context as rc


def test_deve_forcar_com_conteudo_substancial():
    assert roteador.deve_forcar_salvamento("guarda que a Aline nasceu em março") is True


def test_deve_forcar_com_acento_e_maiuscula():
    assert roteador.deve_forcar_salvamento("ANOTA que o Andrei adora Legião Urbana") is True


def test_nao_forca_sem_conteudo_substancial():
    # só o verbo-gatilho, sem fato nenhum depois.
    assert roteador.deve_forcar_salvamento("anota que") is False


def test_nao_forca_mensagem_sem_gatilho():
    assert roteador.deve_forcar_salvamento("oi, como você está?") is False


def test_cadastre_na_memoria_prioriza_rota_memoria_sobre_cadastro():
    # Regressão real: "cadastre" casa com _RE_CADASTRO, mas a frase explicitamente
    # pede salvar NA MEMÓRIA — tem que ganhar da rota "cadastro".
    msg = "cadastre na memoria as informações para cada pessoa cadastrada: 1. edimilson: tem um gato chamado Zuko"
    rota = roteador.decidir_rota(msg, tem_imagem=False, eh_admin=True, registrado=True)
    assert rota == "memoria"
    assert "salvar_memoria" in roteador.tools_da_rota(rota)


def test_cadastro_de_pessoa_nova_continua_rota_cadastro():
    # Sem menção a "memória", o verbo de cadastro continua roteando normal.
    msg = "cadastra o fulano com o numero 5541999999999"
    rota = roteador.decidir_rota(msg, tem_imagem=False, eh_admin=True, registrado=True)
    assert rota == "cadastro"


def test_deve_forcar_com_mencao_explicita_a_memoria():
    msg = "cadastre na memoria as informações: ele tem um gato chamado Zuko e adora cobol"
    assert roteador.deve_forcar_salvamento(msg) is True


def test_pergunta_sobre_rosto_sem_imagem_nao_cai_em_cadastro():
    # Regressão real: "cadastrado" casa com _RE_CADASTRO, mas a pergunta é sobre
    # ROSTO (sem tool nenhuma pra responder) — tem que cair no fallback, não
    # na rota "cadastro" (só tem cadastrar_pessoa/buscar_contato).
    rota = roteador.decidir_rota(
        "tem o rosto cadastrado de todos esses?", tem_imagem=False, eh_admin=True, registrado=True
    )
    assert rota is None


def test_cadastro_de_rosto_com_imagem_continua_rota_rosto():
    # Com imagem, a regra de rosto (1) já intercepta ANTES da de cadastro — não
    # pode regredir por causa da exclusão acima.
    rota = roteador.decidir_rota(
        "cadastra o rosto do joao", tem_imagem=True, eh_admin=True, registrado=True
    )
    assert rota == "rosto"


def test_pergunta_se_bot_lembra_nao_cai_em_lembrete():
    # Risco estrutural idêntico ao do rosto: "lembra de" casa em _RE_LEMBRETE,
    # mas "você lembra de mim?" é pergunta sobre RECALL, não pedido de lembrete
    # (rota "lembrete" só tem agendar/listar/cancelar/editar_alerta).
    rota = roteador.decidir_rota(
        "voce lembra de mim?", tem_imagem=False, eh_admin=False, registrado=True
    )
    assert rota is None


def test_pedido_de_lembrete_legitimo_continua_funcionando():
    rota = roteador.decidir_rota(
        "me lembra de tomar remedio as 8h", tem_imagem=False, eh_admin=False, registrado=True
    )
    assert rota == "lembrete"


def test_forca_com_frase_trivial_mas_com_3_palavras(monkeypatch):
    # Guard é só "3+ palavras depois", não qualidade do conteúdo — risco
    # residual aceito e documentado no plano.
    assert roteador.deve_forcar_salvamento("nao esquece que hoje e sexta") is True


def _llm_request(tools_names=("salvar_memoria",), function_response=False) -> LlmRequest:
    fds = [types.FunctionDeclaration(name=n) for n in tools_names]
    config = types.GenerateContentConfig(tools=[types.Tool(function_declarations=fds)])
    parts = [types.Part(text="oi")]
    if function_response:
        parts.append(
            types.Part(function_response=types.FunctionResponse(name="salvar_memoria", response={"status": "ok"}))
        )
    content = types.Content(role="user", parts=parts)
    return LlmRequest(model="x", contents=[content], config=config)


def test_forca_na_1a_chamada_do_turno():
    req = _llm_request()
    tokens = rc.definir_rota("memoria", frozenset({"salvar_memoria"}), "", True)
    try:
        roteador.forcar_salvamento(None, req)
        assert req.config.tool_config is not None
        assert req.config.tool_config.function_calling_config.mode == types.FunctionCallingConfigMode.ANY
        assert req.config.tool_config.function_calling_config.allowed_function_names == ["salvar_memoria"]
    finally:
        rc.limpar_rota(tokens)


def test_nao_forca_na_2a_chamada_do_turno_apos_tool_response():
    req = _llm_request(function_response=True)
    tokens = rc.definir_rota("memoria", frozenset({"salvar_memoria"}), "", True)
    try:
        roteador.forcar_salvamento(None, req)
        assert req.config.tool_config is None
    finally:
        rc.limpar_rota(tokens)


def test_nao_forca_quando_gatilho_desligado():
    req = _llm_request()
    tokens = rc.definir_rota("memoria", frozenset({"salvar_memoria"}), "", False)
    try:
        roteador.forcar_salvamento(None, req)
        assert req.config.tool_config is None
    finally:
        rc.limpar_rota(tokens)


def test_turno_ja_executou_tool_le_atributo_snake_case():
    req = _llm_request(function_response=True)
    assert roteador._turno_ja_executou_tool(req) is True


def test_turno_nao_executou_tool_sem_function_response():
    req = _llm_request(function_response=False)
    assert roteador._turno_ja_executou_tool(req) is False
