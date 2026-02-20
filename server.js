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

// DATELE TALE EXACTE PENTRU EVOMI (PROXY REZIDENTIAL):
const PROXY_URL = `http://banicualex6:MGqdTRZRtftV80I9MhSD@core-residential.evomi.com:1000`;
const proxyArg = `--proxy "${PROXY_URL}"`;
const bypassArgs = `--force-ipv4 --extractor-args "youtube:player_client=android" --no-warnings`;

// --- LOGICA PENTRU TRANSCRIPT SI TRADUCERE ---
const getTranscriptAndTranslation = async (url) => {
    return new Promise((resolve) => {
        const command = `"${YTDLP_PATH}" ${proxyArg} ${bypassArgs} --write-auto-sub --skip-download --sub-lang en,ro --convert-subs vtt --output "${path.join(DOWNLOAD_DIR, 'temp_%(id)s')}" "${url}"`;
        
        exec(command, { maxBuffer: 1024 * 1024 * 10, timeout: 60000 }, async (error, stdout, stderr) => {
            const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith('temp_') && f.endsWith('.vtt'));
            let originalText = "";
            
            if (files.length === 0) {
                resolve({ original: "Nu s-a găsit subtitrare.", translated: "Nu există text de tradus." });
                return;
            } else {
                const vttPath = path.join(DOWNLOAD_DIR, files[0]);
                let content = fs.readFileSync(vttPath, 'utf8');
                content = content.replace(/WEBVTT/g, '').replace(/(\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3})/g, '').replace(/<[^>]*>/g, '');
                originalText = [...new Set(content.split('\n').map(l => l.trim()).filter(l => l.length > 2))].join(' ');
                fs.unlinkSync(vttPath);
            }

            // Limităm la ~10000 caractere (cam 15 minute de video) să nu crape API-ul
            let textToTranslate = originalText.substring(0, 10000);

            try {
                const completion = await openai.chat.completions.create({
                    messages: [
                        { role: "system", content: "Ești un traducător profesionist. Tradu textul pe care îl primești în limba română, păstrând pe cât posibil formatul și sensul. Nu oferi explicații, returnează doar traducerea textului si tot odata cand apare music, scoate-l și lasă-mi, te rog, doar textul în sine, fără: Tip: subtitrări Limba: en aliniere: început poziție: 0%" },
                        { role: "user", content: textToTranslate }
                    ],
                    model: "gpt-4o-mini", 
                });
                
                resolve({ 
                    original: originalText, 
                    translated: completion.choices[0].message.content 
                });
            } catch (e) {
                resolve({ 
                    original: originalText, 
                    translated: "Eroare AI la traducere: " + e.message 
                });
            }
        });
    });
};

// --- ENDPOINT PROCESARE VIDEO ---
app.post('/api/process-yt', async (req, res) => {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    if (url.includes('/shorts/')) {
        url = url.replace('/shorts/', '/watch?v=').split('&')[0].split('?feature')[0];
    }
    
    console.log(`[START] Procesare domeniu: ${url}`);
    
    const videoId = Date.now();
    const outputPath = path.join(DOWNLOAD_DIR, `${videoId}.mp4`);

    try {
        const ffmpegArg = isWindows ? `--ffmpeg-location "${FFMPEG_PATH}"` : "";
        const command = `"${YTDLP_PATH}" ${proxyArg} ${ffmpegArg} ${bypassArgs} -f "b[ext=mp4]/best" -o "${outputPath}" --no-check-certificates --no-playlist "${url}"`;
        
        // Preluam originalul si tradusul simultan
        const aiData = await getTranscriptAndTranslation(url);

        console.log(`[INFO] Se descarcă MP4 cu IP rezidențial Evomi...`);
        
        exec(command, { maxBuffer: 1024 * 1024 * 10, timeout: 180000 }, async (error, stdout, stderr) => {
            if (error) {
                console.error(`[EROARE] Detalii eroare:`, stderr);
                return res.status(500).json({ error: "Eroare la descărcare. Serverul YouTube a refuzat conexiunea (posibil din cauza proxy-ului)." });
            }
            
            console.log(`[SUCCES] Video descărcat perfect!`);
            res.json({
                status: 'ok',
                downloadUrl: `/download/${videoId}.mp4`,
                originalText: aiData.original,
                translatedText: aiData.translated
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
    console.log(`🚀 VIRALIO rulează cu Evomi Proxy & Traducător.`);
});