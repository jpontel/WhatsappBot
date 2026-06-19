"""Testes das tools de áudio (TTS) no lado do agente.

O Gemini e o MCP do bot são mockados; validamos o contrato:
- `gerar_audio` embrulha o PCM num WAV válido;
- `enviar_audio_gerado` chama o MCP `enviar_audio` com o base64 certo;
- erros viram dict (não levantam).
"""

import base64
import io
import wave

import tools.tools as tools


# --- _pcm_para_wav / _taxa_do_mime -------------------------------------------

def test_pcm_para_wav_gera_header_valido():
    pcm = b"\x00\x01" * 1000  # 1000 amostras 16-bit
    wav = tools._pcm_para_wav(pcm, 24000)

    # consegue reabrir como WAV e os parâmetros batem
    with wave.open(io.BytesIO(wav), "rb") as r:
        assert r.getnchannels() == 1
        assert r.getsampwidth() == 2
        assert r.getframerate() == 24000
        assert r.readframes(r.getnframes()) == pcm


def test_taxa_do_mime():
    assert tools._taxa_do_mime("audio/L16;rate=24000") == 24000
    assert tools._taxa_do_mime("audio/L16;codec=pcm;rate=16000") == 16000
    assert tools._taxa_do_mime(None) == 24000
    assert tools._taxa_do_mime("audio/wav") == 24000


# --- gerar_audio -------------------------------------------------------------

class _FakeInline:
    def __init__(self, data, mime):
        self.data = data
        self.mime_type = mime


class _FakePart:
    def __init__(self, inline_data=None, text=None):
        self.inline_data = inline_data
        self.text = text


class _FakeContent:
    def __init__(self, parts):
        self.parts = parts


class _FakeCandidate:
    def __init__(self, parts):
        self.content = _FakeContent(parts)


class _FakeResponse:
    def __init__(self, parts):
        self.candidates = [_FakeCandidate(parts)]


def _patch_genai(monkeypatch, parts):
    """Faz genai.Client(...).aio.models.generate_content devolver `parts`."""
    async def fake_generate(**kwargs):
        return _FakeResponse(parts)

    class _Models:
        generate_content = staticmethod(fake_generate)

    class _Aio:
        models = _Models()

    class _Client:
        def __init__(self, *a, **k):
            self.aio = _Aio()

    monkeypatch.setattr(tools.genai, "Client", _Client)


async def test_gerar_audio_embrulha_em_wav(monkeypatch):
    pcm = b"\x10\x20" * 500
    parts = [_FakePart(inline_data=_FakeInline(pcm, "audio/L16;rate=24000"))]
    _patch_genai(monkeypatch, parts)

    res = await tools.gerar_audio("bom dia")

    assert res["mimetype"] == "audio/wav"
    wav = base64.b64decode(res["base64"])
    with wave.open(io.BytesIO(wav), "rb") as r:
        assert r.getframerate() == 24000
        assert r.readframes(r.getnframes()) == pcm


async def test_gerar_audio_sem_inline_vira_erro(monkeypatch):
    parts = [_FakePart(text="bloqueado pelo filtro")]
    _patch_genai(monkeypatch, parts)

    res = await tools.gerar_audio("oi")

    assert "erro" in res
    assert "bloqueado" in res["erro"]


async def test_gerar_audio_excecao_da_api_vira_erro(monkeypatch):
    """Quota/erro de API (ex.: 429) degrada p/ erro-dict, não levanta."""
    async def fake_generate(**kwargs):
        raise RuntimeError("429 RESOURCE_EXHAUSTED")

    class _Models:
        generate_content = staticmethod(fake_generate)

    class _Aio:
        models = _Models()

    class _Client:
        def __init__(self, *a, **k):
            self.aio = _Aio()

    monkeypatch.setattr(tools.genai, "Client", _Client)

    res = await tools.gerar_audio("oi pessoal")

    assert "erro" in res
    assert "429" in res["erro"]


# --- enviar_audio_gerado -----------------------------------------------------

async def test_enviar_audio_gerado_chama_mcp(monkeypatch):
    chamadas = []

    async def fake_mcp(tool, args):
        chamadas.append((tool, args))

    async def fake_gerar(texto, voz=""):
        return {"base64": "QUJD", "mimetype": "audio/wav"}

    monkeypatch.setattr(tools, "chamar_mcp", fake_mcp)
    monkeypatch.setattr(tools, "gerar_audio", fake_gerar)

    res = await tools.enviar_audio_gerado("oi pessoal", "5547@s.whatsapp.net")

    assert res["status"] == "ok"
    tool, args = chamadas[0]
    assert tool == "enviar_audio"
    assert args == {"jid": "5547@s.whatsapp.net", "mediaBase64": "QUJD"}


async def test_enviar_audio_gerado_propaga_erro(monkeypatch):
    async def fake_gerar(texto, voz=""):
        return {"erro": "Falha ao gerar áudio: x"}

    monkeypatch.setattr(tools, "gerar_audio", fake_gerar)

    res = await tools.enviar_audio_gerado("oi", "5547@s.whatsapp.net")

    assert "erro" in res
