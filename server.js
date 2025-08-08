// server.js - Backend Server
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

const PASTEBIN_API_KEY = 'EMWTMkQAVfJa9kM-MRUrxd5Oku1U7pgL';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const activeSessions = new Map();

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/generate-session', async (req, res) => {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
        return res.status(400).json({ success: false, error: 'Phone number is required' });
    }

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const sessionDir = path.join(__dirname, 'sessions', sessionId);

    try {
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['EF-PRIME-MD', 'Chrome', '1.0.0']
        });

        activeSessions.set(sessionId, { sock, phoneNumber, sessionDir, paired: false, saveCreds });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            const session = activeSessions.get(sessionId);
            
            if (!session) return;

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (!shouldReconnect) {
                    activeSessions.delete(sessionId);
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
            } else if (connection === 'open') {
                console.log(`Session ${sessionId} connected successfully`);
                session.paired = true;
                
                try {
                    const credsPath = path.join(sessionDir, 'creds.json');
                    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                    
                    const pasteId = await uploadToPastebin(creds);
                    const efSessionId = `EF-PRIME-MD_${pasteId}`;
                    
                    await sendSessionToWhatsApp(sock, phoneNumber, efSessionId);
                    
                    setTimeout(() => {
                        sock.end();
                        activeSessions.delete(sessionId);
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    }, 5000);
                    
                } catch (error) {
                    console.error('Error uploading/sending credentials:', error);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        if (!sock.authState.creds.registered) {
            const cleanNumber = phoneNumber.replace(/\D/g, '');
            const code = await sock.requestPairingCode(cleanNumber);
            const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
            
            res.json({ success: true, sessionId, pairingCode: formattedCode });
        } else {
            res.status(400).json({ success: false, error: 'Number already registered' });
        }

    } catch (error) {
        console.error('Error generating session:', error);
        
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        activeSessions.delete(sessionId);
        
        res.status(500).json({ success: false, error: 'Failed to generate session' });
    }
});

app.get('/api/session-status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);
    
    if (!session) {
        return res.json({ status: 'not_found' });
    }
    
    res.json({ status: session.paired ? 'paired' : 'waiting' });
});

async function uploadToPastebin(credentials) {
    const postData = new URLSearchParams({
        api_dev_key: PASTEBIN_API_KEY,
        api_option: 'paste',
        api_paste_code: JSON.stringify(credentials, null, 2),
        api_paste_name: 'EF-PRIME-MD Session Credentials',
        api_paste_expire_date: 'N',
        api_paste_private: 1,
        api_paste_format: 'json'
    });

    try {
        const response = await axios.post('https://pastebin.com/api/api_post.php', postData, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        if (response.data.startsWith('https://pastebin.com/')) {
            return response.data.split('/').pop();
        } else {
            throw new Error(response.data);
        }
    } catch (error) {
        console.error('Pastebin upload error:', error);
        throw error;
    }
}

// --- KEY CHANGE IS HERE ---
async function sendSessionToWhatsApp(sock, phoneNumber, sessionId) {
    try {
        const jid = phoneNumber.replace(/\D/g, '') + '@s.whatsapp.net';
        
        // **MESSAGE 1: The Session ID by itself for easy copying**
        await sock.sendMessage(jid, { 
            text: sessionId 
        });

        // **MESSAGE 2: The instructional message**
        const instructionsMessage = `🤖 *EF-PRIME-MD Session Generated* 🤖

📱 *Instructions:*
1. Long-press the message above to copy your session ID.
2. Use it in your bot's \`.env\` file.
3. Keep this ID secure and private.

⚠️ *Important:*
- Do not share this session ID with anyone.
- Save it in a secure location.

🔐 *Generated on:* ${new Date().toLocaleString()}

Thank you for using EF-PRIME-MD! 🚀`;

        await sock.sendMessage(jid, { 
            text: instructionsMessage 
        });
        
        console.log(`Session ID sent to ${phoneNumber}`);
        return true;
    } catch (error) {
        console.error('Error sending session to WhatsApp:', error);
        return false;
    }
}

setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of activeSessions.entries()) {
        const sessionAge = now - parseInt(sessionId.split('_')[1]);
        
        if (sessionAge > 10 * 60 * 1000) {
            try {
                session.sock.end();
                if (fs.existsSync(session.sessionDir)) {
                    fs.rmSync(session.sessionDir, { recursive: true, force: true });
                }
                activeSessions.delete(sessionId);
                console.log(`Cleaned up expired session: ${sessionId}`);
            } catch (error) {
                console.error('Error cleaning up session:', error);
            }
        }
    }
}, 60000);

app.listen(PORT, () => {
    console.log(`EF-PRIME-MD Session Generator running on port ${PORT}`);
    
    const sessionsDir = path.join(__dirname, 'sessions');
    if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
    }
});

process.on('SIGINT', () => {
    console.log('Shutting down server...');
    
    for (const [sessionId, session] of activeSessions.entries()) {
        try {
            session.sock.end();
            if (fs.existsSync(session.sessionDir)) {
                fs.rmSync(session.sessionDir, { recursive: true, force: true });
            }
        } catch (error) {
            console.error('Error during shutdown:', error);
        }
    }
    
    process.exit(0);
});

module.exports = app;
