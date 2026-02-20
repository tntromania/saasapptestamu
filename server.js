require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const isWindows = process.platform === 'win32';
const YTDLP_PATH = isWindows ? path.join(__dirname, 'yt-dlp.exe') : '/usr/local/bin/yt-dlp';
const FFMPEG_PATH = isWindows ? path.join(__dirname, 'ffmpeg.exe') : '/usr/bin/ffmpeg';
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); 

// =======================================================
// AICI PUI NOUL PROXY REZIDENTIAL (IPRoyal, Smartproxy)
// =======================================================
const PROXY_URL = "http://core-residential.evomi.com:1000:banicualex6:MGqdTRZRtftV80I9MhSD_country-RO"; // EX: "http://user:parola@geo.iproyal.com:12345"
const proxyArg = PROXY_URL ? `--proxy "${PROXY_URL}"` : "";

// Folosim clientul "android" care fenteaza cel mai bine sistemul
const bypassArgs = `--force-ipv4 --extractor-args "youtube:player_client=android" --no-warnings`;

// --- LOGICA PENTRU TRANSCRIPT ---
const getTranscriptAndSummary = async (url) => {
    return new Promise((resolve) => {
        const command = `"${YTDLP_PATH}" ${proxyArg} ${bypassArgs} --write-auto-sub --skip-download --sub-lang en,ro --convert-subs vtt --output "${path.join(DOWNLOAD_DIR, 'temp_%(id)s')}" "${url}"`;
        
        exec(command, { maxBuffer: 1024 * 1024 * 10, timeout: 60000 }, async (error, stdout, stderr) => {
            const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith('temp_') && f.endsWith('.vtt'));
            let cleanText = "";
            
            if (files.length === 0) {
                resolve({ text: "Nu s-a găsit subtitrare." });
                return;
            } else {
                const vttPath = path.join(DOWNLOAD_DIR, files[0]);
                let content = fs.readFileSync(vttPath, 'utf8');
                content = content.replace(/WEBVTT/g, '').replace(/(\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3})/g, '').replace(/<[^>]*>/g, '');
                cleanText = [...new Set(content.split('\n').map(l => l.trim()).filter(l => l.length > 2))].join(' ');
                fs.unlinkSync(vttPath);
            }

            try {
                const completion = await openai.chat.completions.create({
                    messages: [{ role: "system", content: "Ești un asistent util." }, { role: "user", content: `Rezumă acest text, extrăgând 3 idei principale (fii scurt):\n\n${cleanText.substring(0, 4000)}` }],
                    model: "gpt-4o-mini", 
                });
                resolve({ text: completion.choices[0].message.content });
            } catch (e) {
                resolve({ text: "Eroare AI la rezumat." });
            }
        });
    });
};

// --- ENDPOINT PROCESARE VIDEO ---
app.post('/api/process-yt', async (req, res) => {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    // Fentam Shorts
    if (url.includes('/shorts/')) {
        url = url.replace('/shorts/', '/watch?v=').split('&')[0].split('?feature')[0];
    }
    
    console.log(`[START] Procesare pe domeniu: ${url}`);
    const videoId = Date.now();
    const outputPath = path.join(DOWNLOAD_DIR, `${videoId}.mp4`);

    try {
        const ffmpegArg = isWindows ? `--ffmpeg-location "${FFMPEG_PATH}"` : "";
        const command = `"${YTDLP_PATH}" ${proxyArg} ${ffmpegArg} ${bypassArgs} -f "b[ext=mp4]/best" -o "${outputPath}" --no-check-certificates --no-playlist "${url}"`;
        
        const aiData = await getTranscriptAndSummary(url);

        console.log(`[INFO] Se descarcă cu proxy rezidențial...`);
        
        exec(command, { maxBuffer: 1024 * 1024 * 10, timeout: 180000 }, async (error, stdout, stderr) => {
            if (error) {
                console.error(`[EROARE] Youtube a blocat conexiunea. Baga proxy rezidential!`);
                return res.status(500).json({ error: "Conexiune refuzată de YouTube. Este necesar un Proxy Rezidențial valid." });
            }
            
            console.log(`[SUCCES] Video descărcat perfect!`);
            res.json({
                status: 'ok',
                downloadUrl: `/download/${videoId}.mp4`,
                aiSummary: aiData.text
            });
        });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/download/:filename', (req, res) => {
    const file = path.join(DOWNLOAD_DIR, req.params.filename);
    res.download(file, (err) => {
        if (!err) {
            setTimeout(() => { if (fs.existsSync(file)) fs.unlinkSync(file); }, 60000);
        }
    });
});

app.listen(PORT, () => {
    console.log(`🚀 VIRALIO rulează oficial.`);
});