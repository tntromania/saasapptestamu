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

// Setari automate pentru VPS (Linux) sau PC (Windows)
const isWindows = process.platform === 'win32';
const YTDLP_PATH = isWindows ? path.join(__dirname, 'yt-dlp.exe') : '/usr/local/bin/yt-dlp';
const FFMPEG_PATH = isWindows ? path.join(__dirname, 'ffmpeg.exe') : '/usr/bin/ffmpeg';
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); 

// Daca pui cookies.txt le va folosi automat, dar functioneaza si fara!
const cookiesPath = path.join(__dirname, 'cookies.txt');
const cookiesArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : "";

// --- LOGICA PENTRU TRANSCRIPT ---
const getTranscriptAndSummary = async (url) => {
    return new Promise((resolve) => {
        // Folosim clientul "android" care are cele mai mici sanse de blocare pe VPS
        const command = `"${YTDLP_PATH}" ${cookiesArg} --write-auto-sub --skip-download --sub-lang en,ro --convert-subs vtt --extractor-args "youtube:player_client=android" --output "${path.join(DOWNLOAD_DIR, 'temp_%(id)s')}" "${url}"`;
        
        exec(command, async (error, stdout, stderr) => {
            const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith('temp_') && f.endsWith('.vtt'));
            
            let cleanText = "";
            if (files.length === 0) {
                // Dacă nu există subtitrare, NU stăm să așteptăm DUMP-JSON (care dă timeout). Trecem mai departe rapid.
                resolve({ text: "Nu s-a găsit subtitrare oficială pentru acest videoclip." });
                return;
            } else {
                const vttPath = path.join(DOWNLOAD_DIR, files[0]);
                let content = fs.readFileSync(vttPath, 'utf8');
                content = content.replace(/WEBVTT/g, '').replace(/(\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3})/g, '').replace(/<[^>]*>/g, '');
                cleanText = [...new Set(content.split('\n').map(l => l.trim()).filter(l => l.length > 2))].join(' ');
                fs.unlinkSync(vttPath);
            }

            try {
                // Generam rezumatul super rapid cu GPT
                const completion = await openai.chat.completions.create({
                    messages: [
                        { role: "system", content: "Ești un asistent util care extrage ideile principale." },
                        { role: "user", content: `Te rog tradu și rezumă textul acesta în română, în 2-3 idei principale (fii concis):\n\n${cleanText.substring(0, 4000)}` }
                    ],
                    model: "gpt-4o-mini", // Model super rapid
                });
                resolve({ text: completion.choices[0].message.content });
            } catch (e) {
                resolve({ text: "Eroare la procesarea textului cu AI." });
            }
        });
    });
};


// --- ENDPOINT PROCESARE VIDEO ---
app.post('/api/process-yt', async (req, res) => {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    // Fentam protectia pentru Shorts transformand linkul in Video Normal
    if (url.includes('/shorts/')) {
        url = url.replace('/shorts/', '/watch?v=').split('&')[0].split('?feature')[0];
    }
    
    console.log(`[START] Procesare pe VPS: ${url}`);
    const videoId = Date.now();
    const outputPath = path.join(DOWNLOAD_DIR, `${videoId}.mp4`);

    try {
        const ffmpegArg = isWindows ? `--ffmpeg-location "${FFMPEG_PATH}"` : "";
        
        // Comanda optimizata pt viteza si bypass:
        // Setam calitatea la maxim 1080p, folosim "android", si scurtam formatul pt a evita merge-ul greoi de ffmpeg daca nu e nevoie
        const command = `"${YTDLP_PATH}" ${ffmpegArg} ${cookiesArg} -f "b[ext=mp4]/best" -o "${outputPath}" --extractor-args "youtube:player_client=android" --no-check-certificates --no-playlist "${url}"`;
        
        // Preluam textul (Dureaza ~3 secunde)
        const aiData = await getTranscriptAndSummary(url);

        // NU MAI GENERAM AUDIO AICI! Asta dadea Timeout-ul ("read tcp4"). Ne concentram pe Download si Text.
        
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error("Eroare yt-dlp pe VPS:", stderr);
                return res.status(500).json({ error: `Eroare descărcare. Serverul YouTube a refuzat conexiunea.` });
            }
            
            res.json({
                status: 'ok',
                downloadUrl: `/download/${videoId}.mp4`,
                audioUrl: null, // Am scos audio-ul ca sa mearga instant
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
    console.log(`🚀 VIRALIO (Versiunea Optimizată) rulează pe http://localhost:${PORT}`);
});