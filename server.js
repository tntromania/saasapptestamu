require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
// --- PACHETE NOI ---
const mongoose = require('mongoose');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const isWindows = process.platform === 'win32';
const YTDLP_PATH = isWindows ? path.join(__dirname, 'yt-dlp.exe') : '/usr/local/bin/yt-dlp';
const FFMPEG_PATH = isWindows ? path.join(__dirname, 'ffmpeg.exe') : '/usr/bin/ffmpeg';
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
    credits: { type: Number, default: 3 }, // Dam 3 credite gratis la inregistrare
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

// ==========================================
// PROXY-UL TAU EVOMI
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
        
        console.log("👉 Încerc verificare token cu Client ID:", process.env.GOOGLE_CLIENT_ID);
        
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        
        // Cautam utilizatorul in DB, daca nu e, il cream
        let user = await User.findOne({ googleId: payload.sub });
        if (!user) {
            console.log("Creăm utilizator nou:", payload.email);
            user = new User({
                googleId: payload.sub,
                email: payload.email,
                name: payload.name,
                picture: payload.picture,
                credits: 3 // 3 credite la înregistrare
            });
            await user.save();
        }

        // Generam un Token de sesiune pentru site
        const sessionToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        
        res.json({ token: sessionToken, user: { name: user.name, picture: user.picture, credits: user.credits } });
    } catch (error) {
        // AICI E MAGIA: Afișăm eroarea exactă trimisă de Google!
        console.error("❌ EROARE CRITICĂ GOOGLE LOGIN:", error.message);
        res.status(400).json({ error: "Eroare Google: " + error.message });
    }
});

// 2. Endpoint Verificare Profil (ca sa stie frontend-ul cate credite ai cand dai refresh)
app.get('/api/auth/me', authenticate, async (req, res) => {
    const user = await User.findById(req.userId);
    res.json({ user: { name: user.name, picture: user.picture, credits: user.credits } });
});

// 3. Logica de YT (Optimizata)
const getTranscriptAndTranslation = async (url) => {
    return new Promise((resolve) => {
        const command = `"${YTDLP_PATH}" ${proxyArg} ${bypassArgs} --write-auto-sub --skip-download --sub-lang en,ro --convert-subs vtt --output "${path.join(DOWNLOAD_DIR, 'temp_%(id)s')}" "${url}"`;
        exec(command, { maxBuffer: 1024 * 1024 * 10, timeout: 60000 }, async (err) => {
            const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith('temp_') && f.endsWith('.vtt'));
            let originalText = "";
            if (files.length === 0) return resolve({ original: "Nu s-a găsit subtitrare.", translated: "Nu există text de tradus." });
            
            const vttPath = path.join(DOWNLOAD_DIR, files[0]);
            let content = fs.readFileSync(vttPath, 'utf8');
            content = content.replace(/WEBVTT/g, '').replace(/(\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3})/g, '').replace(/<[^>]*>/g, '');
            originalText = [...new Set(content.split('\n').map(l => l.trim()).filter(l => l.length > 2))].join(' ');
            fs.unlinkSync(vttPath);

            try {
                const completion = await openai.chat.completions.create({
                    messages: [
                        { role: "system", content: "Ești un traducător profesionist. Tradu textul pe care îl primești în limba română, păstrând pe cât posibil formatul și sensul. Nu oferi explicații, returnează doar traducerea textului si tot odata cand apare music, scoate-l și lasă-mi, te rog, doar textul în sine, fără: Tip: subtitrări Limba: en aliniere: început poziție: 0%" },
                        { role: "user", content: textToTranslate }
                    ],
                    model: "gpt-4o-mini", 
                });
                resolve({ original: originalText, translated: completion.choices[0].message.content });
            } catch (e) {
                resolve({ original: originalText, translated: "Eroare AI la traducere." });
            }
        });
    });
};

// 4. Endpoint Procesare Video (PROTEJAT DE AUTENTIFICARE!)
app.post('/api/process-yt', authenticate, async (req, res) => {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL lipsă' });

    // VERIFICARE CREDITE!
    const user = await User.findById(req.userId);
    if (user.credits <= 0) {
        return res.status(403).json({ error: "Nu mai ai credite! Cumpără un pachet pentru a continua." });
    }

    if (url.includes('/shorts/')) url = url.replace('/shorts/', '/watch?v=').split('&')[0].split('?feature')[0];
    
    const videoId = Date.now();
    const outputPath = path.join(DOWNLOAD_DIR, `${videoId}.mp4`);

    try {
        const ffmpegArg = isWindows ? `--ffmpeg-location "${FFMPEG_PATH}"` : "";
        const command = `"${YTDLP_PATH}" ${proxyArg} ${ffmpegArg} ${bypassArgs} -f "b[ext=mp4]/best" -o "${outputPath}" --no-check-certificates --no-playlist "${url}"`;
        
        const aiData = await getTranscriptAndTranslation(url);

        exec(command, { maxBuffer: 1024 * 1024 * 10, timeout: 180000 }, async (error, stdout, stderr) => {
            if (error) return res.status(500).json({ error: "Eroare la descărcare. Serverul YouTube a refuzat conexiunea." });
            
            // DACA A FOST SUCCES, SCADEM UN CREDIT!
            user.credits -= 1;
            await user.save();

            res.json({
                status: 'ok',
                downloadUrl: `/download/${videoId}.mp4`,
                originalText: aiData.original,
                translatedText: aiData.translated,
                creditsLeft: user.credits // Trimitem creditele ramase in frontend
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