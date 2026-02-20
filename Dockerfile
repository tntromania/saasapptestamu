# 1. Folosim o versiune moderna de Node.js si Debian (Bookworm)
FROM node:22-bookworm

# 2. Instalam update-urile, FFmpeg si Python
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip wget curl

# 3. Descarcam binarul STANDALONE yt-dlp_linux (fara erori de Python!)
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -O /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

# 4. Setam folderul de lucru in container
WORKDIR /app

# 5. Copiem fisierele de configurare si instalam pachetele NPM
COPY package*.json ./
RUN npm install

# 6. Copiem tot restul codului tau (server.js, public, etc.)
COPY . .

# 7. Expunem portul 3000
EXPOSE 3000

# 8. Pornim serverul
CMD ["node", "server.js"]