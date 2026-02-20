require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const PORT = 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// Pe Linux, ele vor fi instalate global in sistem
const YTDLP_PATH = 'yt-dlp';
const FFMPEG_PATH = 'ffmpeg';
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

app.use(cors());
app.use(express.json());
// Asta spune serverului să caute fișierele HTML direct în folderul "public"
app.use(express.static(path.join(__dirname, 'public'))); 

// --- LOGICA PENTRU TRANSCRIPT ---
const getTranscriptAndSummary = async (url) => {
    return new Promise((resolve) => {
        const command = `"${YTDLP_PATH}" --write-auto-sub --skip-download --sub-lang en,ro --convert-subs vtt --output "${path.join(DOWNLOAD_DIR, 'temp_%(id)s')}" "${url}"`;
        
        exec(command, async (error, stdout) => {
            const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith('temp_') && f.endsWith('.vtt'));
            
            if (files.length === 0) {
                const descCommand = `"${YTDLP_PATH}" --get-description "${url}"`;
                exec(descCommand, (err, descOut) => resolve({ text: descOut || "Nu s-a găsit subtitrare. Folosim descrierea." }));
                return;
            }

            const vttPath = path.join(DOWNLOAD_DIR, files[0]);
            let content = fs.readFileSync(vttPath, 'utf8');
            content = content.replace(/WEBVTT/g, '').replace(/(\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3})/g, '').replace(/<[^>]*>/g, '');
            const cleanText = [...new Set(content.split('\n').map(l => l.trim()).filter(l => l.length > 2))].join(' ');
            fs.unlinkSync(vttPath);

            try {
                const completion = await openai.chat.completions.create({
                    messages: [
                        { role: "system", content: "Ești un asistent util." },
                        { role: "user", content: `Tradu și rezumă textul acesta în română:\n\n${cleanText.substring(0, 5000)}` }
                    ],
                    model: "gpt-4o-mini",
                });
                resolve({ text: completion.choices[0].message.content });
            } catch (e) {
                resolve({ text: "Eroare GPT: " + e.message });
            }
        });
    });
};

// --- LOGICA PENTRU AUDIO ---
const generateAudio = async (text, id) => {
    try {
        const mp3 = await openai.audio.speech.create({
            model: "tts-1-hd",
            voice: "alloy",
            input: text.substring(0, 4000),
        });
        const buffer = Buffer.from(await mp3.arrayBuffer());
        const audioPath = path.join(DOWNLOAD_DIR, `${id}.mp3`);
        fs.writeFileSync(audioPath, buffer);
        return audioPath;
    } catch (error) {
        console.error("Eroare Audio:", error.message);
        return null;
    }
};

// --- ENDPOINT PROCESARE VIDEO ---
app.post('/api/process-yt', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    console.log(`[START] Procesare: ${url}`);
    const videoId = Date.now();
    const outputPath = path.join(DOWNLOAD_DIR, `${videoId}.mp4`);

    try {
        const command = `"${YTDLP_PATH}" --ffmpeg-location "${FFMPEG_PATH}" -f "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" -o "${outputPath}" --no-check-certificates --no-playlist "${url}"`;
        
        const aiData = await getTranscriptAndSummary(url);
        
        let audioUrl = null;
        if (aiData.text && !aiData.text.startsWith('Eroare')) {
            await generateAudio(aiData.text, videoId);
            audioUrl = `/download/${videoId}.mp3`;
        }

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error("Eroare descarcare:", stderr);
                return res.status(500).json({ error: "Nu am putut descărca video-ul." });
            }
            
            res.json({
                status: 'ok',
                downloadUrl: `/download/${videoId}.mp4`,
                audioUrl: audioUrl,
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
    console.log(`🚀 VIRALIO ruleaza pe http://localhost:${PORT}`);
});