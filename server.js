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

// SETARI AUTOMATE PC / VPS
const isWindows = process.platform === 'win32';
const YTDLP_PATH = isWindows ? path.join(__dirname, 'yt-dlp.exe') : '/usr/local/bin/yt-dlp';
const FFMPEG_PATH = isWindows ? path.join(__dirname, 'ffmpeg.exe') : '/usr/bin/ffmpeg';
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); 

// Daca exista cookies.txt, il bagam in ecuatie
const cookiesPath = path.join(__dirname, 'cookies.txt');
const cookiesArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : "";

// ==========================================
// ARMA SECRETA ANTI-VPS BLOCK
// 1. --force-ipv4 -> Evita ban-urile IPV6 ale datacenterelor
// 2. --extractor-args "youtube:player_client=ios,tv" -> Fenteaza BotGuard
// 3. --no-warnings -> Ascunde mesajele inutile
// ==========================================
const bypassArgs = `--force-ipv4 --extractor-args "youtube:player_client=ios,tv" --no-warnings`;


// --- LOGICA PENTRU TRANSCRIPT ---
const getTranscriptAndSummary = async (url) => {
    return new Promise((resolve) => {
        const command = `"${YTDLP_PATH}" ${cookiesArg} ${bypassArgs} --write-auto-sub --skip-download --sub-lang en,ro --convert-subs vtt --output "${path.join(DOWNLOAD_DIR, 'temp_%(id)s')}" "${url}"`;
        
        // AM ADAUGAT maxBuffer: Opreste Node.js din a bloca procesul daca yt-dlp e "prea vorbaret"
        exec(command, { maxBuffer: 1024 * 1024 * 10 }, async (error, stdout, stderr) => {
            const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith('temp_') && f.endsWith('.vtt'));
            
            let cleanText = "";
            if (files.length === 0) {
                resolve({ text: "Nu s-a găsit subtitrare pentru acest videoclip." });
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
                    messages: [
                        { role: "system", content: "Ești un asistent util." },
                        { role: "user", content: `Tradu și rezumă textul acesta în română, în 2-3 idei principale:\n\n${cleanText.substring(0, 4000)}` }
                    ],
                    model: "gpt-4o-mini", 
                });
                resolve({ text: completion.choices[0].message.content });
            } catch (e) {
                resolve({ text: "Eroare AI: Nu s-a putut traduce textul." });
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
    
    console.log(`[START] Procesare pe VPS: ${url}`);
    const videoId = Date.now();
    const outputPath = path.join(DOWNLOAD_DIR, `${videoId}.mp4`);

    try {
        const ffmpegArg = isWindows ? `--ffmpeg-location "${FFMPEG_PATH}"` : "";
        
        // Comanda MEGA-OPTIMIZATA de download
        const command = `"${YTDLP_PATH}" ${ffmpegArg} ${cookiesArg} ${bypassArgs} -f "b[ext=mp4]/best" -o "${outputPath}" --no-check-certificates --no-playlist "${url}"`;
        
        const aiData = await getTranscriptAndSummary(url);

        console.log(`[INFO] Descarcare video in curs...`);
        // AM ADAUGAT maxBuffer si aici!
        exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                console.error("Eroare VPS:", stderr || error.message);
                // Trimitem eroarea exact in browser ca sa stii daca te-a blocat
                return res.status(500).json({ error: "YouTube a blocat conexiunea. Încearcă alt video sau actualizează cookies." });
            }
            
            res.json({
                status: 'ok',
                downloadUrl: `/download/${videoId}.mp4`,
                audioUrl: null, // Dezactivat momentan ca sa ruleze brici
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
    console.log(`🚀 VIRALIO (SaaS) rulează pe http://localhost:${PORT}`);
});