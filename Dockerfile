# Usa a versão LTS do Node
FROM node:20-slim

# Instala dependências de sistema para o 'canvas' e outras libs de mídia
RUN apt-get update && apt-get install -y \
    python3 \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Cria o diretório de trabalho
WORKDIR /app

# Copia só o package.json (o package-lock.json é legado da era pré-pnpm e está
# dessincronizado — deixar o npm resolver a árvore evita "Invalid Version" no dedup)
COPY package.json ./

# Instala as dependências (incluindo devDependencies para rodar o tsx)
RUN npm install

# Copia o restante dos arquivos do projeto
COPY . .

# Porta do servidor MCP (StreamableHTTP) consumido pelo agente
EXPOSE 3001

# Comando para rodar o bot em PRODUÇÃO (sem watch).
#
# Por que NÃO usar "npm run start" (tsx watch):
#   - "tsx watch" é um file-watcher de desenvolvimento; ele roda o app num processo FILHO
#     e fica observando o disco. No recreate do container, o Docker manda SIGTERM ao PID 1;
#     o watcher não repassa esse sinal de forma limpa ao Node filho, que morre abruptamente
#     no meio de um avanço de chave/ratchet do Baileys -> sessão fica "stale" -> 401 loggedOut.
#
# Por que "node --import tsx/esm" e não "npm run start:prod":
#   - Aqui o Node é o PID 1, então o SIGTERM do Docker chega DIRETO ao nosso handler de
#     desligamento gracioso em src/index.ts (sem hop pelo npm nem por um processo filho do tsx).
#   - tsx entra só como loader de TypeScript no mesmo processo (não cria subprocesso).
# (o script "start:prod" no package.json existe para o mesmo fim em execução manual/local.)
CMD ["node", "--import", "tsx/esm", "src/index.ts"]