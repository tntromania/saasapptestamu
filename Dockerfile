# Folosim o versiune stabila de Node.js
FROM node:18-bullseye

# Instalam update-uri, ffmpeg, python (necesar pentru yt-dlp)
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip wget

# Descarcam cea mai recenta versiune de yt-dlp pentru Linux direct de pe GitHub
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

# Setam folderul de lucru pe VPS
WORKDIR /app

# Copiem doar pachetele necesare
COPY package*.json ./

# Instalam dependentele Node.js
RUN npm install

# Copiem restul proiectului (HTML, JS, etc)
COPY . .

# Expunem portul
EXPOSE 3000

# Comanda de pornire a serverului
CMD ["node", "server.js"]