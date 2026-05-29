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

# Copia apenas os arquivos de dependências primeiro (otimiza o cache do Docker)
COPY package*.json ./

# Instala as dependências (incluindo devDependencies para rodar o tsx)
RUN npm install

# Copia o restante dos arquivos do projeto
COPY . .

# Expõe a porta (caso seu express use a 3000, por exemplo)
EXPOSE 3000

# Comando para rodar o bot
CMD ["npm", "run", "start"]