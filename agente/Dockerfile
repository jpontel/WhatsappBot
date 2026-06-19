# Agente ADK (FastAPI + Google ADK) — servido por uvicorn na 8000
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src

WORKDIR /app

# Libs de sistema:
#  - build-essential: o insightface compila uma extensão na instalação.
#  - libgomp1: runtime do onnxruntime (OpenMP).
#  - libglib2.0-0: runtime do opencv (mesmo headless, alguns módulos linkam glib).
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libgomp1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Poetry para resolver as dependências a partir do pyproject/lock
RUN pip install --no-cache-dir "poetry==2.4.1"

# Instala só as dependências primeiro (melhor cache); o pacote em si roda via PYTHONPATH.
# `poetry lock` regenera o lock no build (as deps de visão são adicionadas sem
# precisar resolver a árvore localmente) — depois instala só o grupo main.
COPY pyproject.toml poetry.lock README.md ./
RUN poetry config virtualenvs.create false \
    && poetry lock \
    && poetry install --no-root --only main

# Pré-baixa o modelo InsightFace (buffalo_l) para dentro da imagem: o cache fica
# em /root/.insightface/models e o 1º reconhecimento em produção não faz fetch.
RUN python -c "from insightface.app import FaceAnalysis; FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider']).prepare(ctx_id=0, det_size=(640, 640))"

# Código da aplicação
COPY src ./src

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
