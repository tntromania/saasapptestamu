require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const mongoose = require('mongoose');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// 100% SETARI PENTRU VPS COOLIFY (Fara Windows)
const YTDLP_PATH = '/usr/local/bin/yt-dlp';
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); 

// ==========================================
// BAZA DE DATE (MONGODB) & SCHEMA USER
// ==========================================
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Conectat la MongoDB!'))
    .catch(err => console.error('❌ Eroare MongoDB:', err));

const UserSchema = new mongoose.Schema({
    googleId: String,
    email: String,
    name: String,
    picture: String,
    credits: { type: Number, default: 3 },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

// ==========================================
// PROXY EVOMI & BYPASS
// ==========================================
const PROXY_URL = `http://banicualex6:MGqdTRZRtftV80I9MhSD@core-residential.evomi.com:1000`;
const proxyArg = `--proxy "${PROXY_URL}"`;
const bypassArgs = `--force-ipv4 --extractor-args "youtube:player_client=android" --no-warnings`;

// ==========================================
// MIDDLEWARE AUTENTIFICARE
// ==========================================
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Trebuie să fii logat!" });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (e) {
        return res.status(401).json({ error: "Sesiune expirată. Te rog loghează-te din nou." });
    }
};

// ==========================================
// RUTELE DE API
// ==========================================

// 1. Endpoint Login Google
app.post('/api/auth/google', async (req, res) => {
    try {
        const { credential } = req.body;
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        
        let user = await User.findOne({ googleId: payload.sub });
        if (!user) {
            console.log("Creăm utilizator nou:", payload.email);
            user = new User({
                googleId: payload.sub,
                email: payload.email,
                name: payload.name,
                picture: payload.picture,
                credits: 3
            });
            await user.save();
        }

        const sessionToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.json({ token: sessionToken, user: { name: user.name, picture: user.picture, credits: user.credits } });
    } catch (error) {
        console.error("❌ EROARE GOOGLE LOGIN:", error.message);
        res.status(400).json({ error: "Eroare Google: " + error.message });
    }
});

// 2. Verificare Profil
app.get('/api/auth/me', authenticate, async (req, res) => {
    const user = await User.findById(req.userId);
    res.json({ user: { name: user.name, picture: user.picture, credits: user.credits } });
});

// 3. Logica de YT (Curatare mizerii subtitrare)
const getTranscriptAndTranslation = async (url) => {
    return new Promise((resolve) => {
        const command = `"${YTDLP_PATH}" ${proxyArg} ${bypassArgs} --write-auto-sub --skip-download --sub-lang en,ro --convert-subs vtt --output "${path.join(DOWNLOAD_DIR, 'temp_%(id)s')}" "${url}"`;
        
        exec(command, { maxBuffer: 1024 * 1024 * 10, timeout: 60000 }, async (err) => {
            const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith('temp_') && f.endsWith('.vtt'));
            let originalText = "";
            
            if (files.length === 0) {
                return resolve({ original: "Nu s-a găsit subtitrare.", translated: "Nu există text de tradus." });
            }
            
            const vttPath = path.join(DOWNLOAD_DIR, files[0]);
            let content = fs.readFileSync(vttPath, 'utf8');
            
            // CURATARE GUNOAIE DIN VTT (Magic Regex)
            content = content
                .replace(/WEBVTT/gi, '')
                .replace(/Kind:[^\n]+/gi, '')
                .replace(/Language:[^\n]+/gi, '')
                .replace(/align:[^\n]+/gi, '')
                .replace(/position:[^\n]+/gi, '')
                .replace(/(\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}.*)/g, '')
                .replace(/<[^>]*>/g, '') // scoate tag-urile HTML
                .replace(/\[Music\]/gi, '') // Scoate parantezele cu muzica
                .replace(/\[Muzică\]/gi, '');

            // Eliminam liniile goale ramase si unim textul
            originalText = [...new Set(content.split('\n').map(l => l.trim()).filter(l => l.length > 2))].join(' ');
            fs.unlinkSync(vttPath);

            // Definim textul limitat pentru GPT (Asta lipsea si dadea eroare!)
            const textToTranslate = originalText.substring(0, 10000);

            try {
                const completion = await openai.chat.completions.create({
                    messages: [
                        { role: "system", content: "Ești un traducător profesionist. Tradu textul pe care îl primești în limba română, păstrând pe cât posibil formatul și sensul. Returnează DOAR traducerea textului, fără absolut nicio altă explicație." },
                        { role: "user", content: textToTranslate }
                    ],
                    model: "gpt-4o-mini", 
                });
                resolve({ original: originalText, translated: completion.choices[0].message.content });
            } catch (e) {
                console.error("Eroare OpenAI:", e.message);
                resolve({ original: originalText, translated: "Eroare AI la traducere: " + e.message });
            }
        });
    });
};

// 4. Endpoint Procesare Video
app.post('/api/process-yt', authenticate, async (req, res) => {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    const user = await User.findById(req.userId);
    if (user.credits <= 0) {
        return res.status(403).json({ error: "Nu mai ai credite! Cumpără un pachet pentru a continua." });
    }

    if (url.includes('/shorts/')) url = url.replace('/shorts/', '/watch?v=').split('&')[0].split('?feature')[0];
    
    const videoId = Date.now();
    const outputPath = path.join(DOWNLOAD_DIR, `${videoId}.mp4`);

    try {
        // Am scos ffmpegArg pt ca suntem 100% pe VPS Linux
        const command = `"${YTDLP_PATH}" ${proxyArg} ${bypassArgs} -f "b[ext=mp4]/best" -o "${outputPath}" --no-check-certificates --no-playlist "${url}"`;
        
        const aiData = await getTranscriptAndTranslation(url);

        exec(command, { maxBuffer: 1024 * 1024 * 10, timeout: 180000 }, async (error, stdout, stderr) => {
            if (error) {
                console.error("Eroare YTDLP:", stderr);
                return res.status(500).json({ error: "Eroare la descărcare. Serverul YouTube a refuzat conexiunea." });
            }
            
            user.credits -= 1;
            await user.save();

            res.json({
                status: 'ok',
                downloadUrl: `/download/${videoId}.mp4`,
                originalText: aiData.original,
                translatedText: aiData.translated,
                creditsLeft: user.credits 
            });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/download/:filename', (req, res) => {
    const file = path.join(DOWNLOAD_DIR, req.params.filename);
    res.download(file, (err) => {
        if (!err) setTimeout(() => { if (fs.existsSync(file)) fs.unlinkSync(file); }, 60000);
    });
});

app.listen(PORT, () => console.log(`🚀 VIRALIO SaaS rulează. Așteptăm banii.`));