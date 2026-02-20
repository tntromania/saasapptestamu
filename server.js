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

app.use(cors());
app.use(express.json());
// Serveste tot ce este in folderul public pe noul tau domeniu
app.use(express.static(path.join(__dirname, 'public'))); 

// Proxy-ul WebShare
const PROXY_URL = "http://jidqrlsg:8acghm3viqfp@64.137.96.74:6641/"; 
const proxyArg = `--proxy "${PROXY_URL}"`;
const bypassArgs = `--force-ipv4 --extractor-args "youtube:player_client=android" --no-warnings`;

// --- LOGICA PENTRU TRANSCRIPT ---
const getTranscriptAndSummary = async (url) => {
    return new Promise((resolve) => {
        const command = `"${YTDLP_PATH}" ${proxyArg} ${bypassArgs} --write-auto-sub --skip-download --sub-lang en,ro --convert-subs vtt --output "${path.join(DOWNLOAD_DIR, 'temp_%(id)s')}" "${url}"`;
        
        exec(command, { maxBuffer: 1024 * 1024 * 10, timeout: 60000 }, async (error, stdout, stderr) => {
            const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith('temp_') && f.endsWith('.vtt'));
            let cleanText = "";
            if (files.length === 0) {
                resolve({ text: "Nu s-a găsit subtitrare. Probabil YouTube a restricționat proxy-ul." });
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
                    messages: [{ role: "system", content: "Ești un asistent util." }, { role: "user", content: `Rezumă textul acesta în română, scurt:\n\n${cleanText.substring(0, 4000)}` }],
                    model: "gpt-4o-mini", 
                });
                resolve({ text: completion.choices[0].message.content });
            } catch (e) {
                resolve({ text: "Eroare AI la generarea rezumatului." });
            }
        });
    });
};

// =================================================================
// 🚨 SCHEMA SUPREMA: DACA PICA YT-DLP, FOLOSIM API PUBLIC (Cobalt)
// =================================================================
const downloadViaBypassAPI = async (videoUrl, outputPath) => {
    console.log(`[SCHEMA] Proxy-ul a fost blocat. Inițiere Bypass API de rezervă...`);
    try {
        const res = await fetch("https://api.cobalt.tools/api/json", {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Origin": "https://cobalt.tools",
                "Referer": "https://cobalt.tools/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            },
            body: JSON.stringify({ url: videoUrl, vQuality: "1080", disableMetadata: true })
        });
        
        const data = await res.json();
        
        if (data && data.url) {
            return new Promise((resolve, reject) => {
                const curlCmd = `curl -L -o "${outputPath}" "${data.url}"`;
                exec(curlCmd, { timeout: 120000 }, (err) => {
                    if (err) reject(err);
                    else resolve(true);
                });
            });
        } else {
            throw new Error("Bypass-ul a eșuat. Serverul API nu a returnat link-ul.");
        }
    } catch (error) {
        throw error;
    }
};

// --- ENDPOINT PROCESARE VIDEO ---
app.post('/api/process-yt', async (req, res) => {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

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

        console.log(`[INFO] Încercare descărcare video cu yt-dlp...`);
        
        exec(command, { maxBuffer: 1024 * 1024 * 10, timeout: 120000 }, async (error, stdout, stderr) => {
            if (error) {
                console.error(`[BLOCAT] yt-dlp a eșuat. YouTube a refuzat conexiunea. Activăm Bypass-ul!`);
                try {
                    await downloadViaBypassAPI(url, outputPath);
                    console.log(`[SUCCES] Video a fost descărcat cu forța prin Bypass!`);
                    
                    return res.json({
                        status: 'ok',
                        downloadUrl: `/download/${videoId}.mp4`,
                        aiSummary: aiData.text
                    });
                } catch (bypassErr) {
                    console.error("Și Bypass-ul a eșuat:", bypassErr.message);
                    return res.status(500).json({ error: "Eroare: Atât proxy-ul, cât și bypass-ul au picat. Încearcă alt proxy." });
                }
            } else {
                console.log(`[SUCCES] Video descărcat normal cu yt-dlp!`);
                res.json({
                    status: 'ok',
                    downloadUrl: `/download/${videoId}.mp4`,
                    aiSummary: aiData.text
                });
            }
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
    console.log(`🚀 VIRALIO rulează pe domeniu`);
});