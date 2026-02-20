# Folosim o versiune moderna de Node.js si Debian
FROM node:22-bookworm

# Instalam dependentele: FFmpeg, Python, Curl si Unzip
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip wget curl unzip

# Descarcam binarul STANDALONE yt-dlp_linux
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -O /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

# INSTALAM DENO (SECRETUL PENTRU A TRECE DE BOTGUARD IN 2026)
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"

# Setam folderul de lucru
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]