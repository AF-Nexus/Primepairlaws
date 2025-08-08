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

// Your Pastebin API Key (hidden from frontend)
const PASTEBIN_API_KEY = 'EMWTMkQAVfJa9kM-MRUrxd5Oku1U7pgL';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Store active sessions
const activeSessions = new Map();

// Serve the HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Generate session endpoint
app.post('/api/generate-session', async (req, res) => {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
        return res.status(400).json({ success: false, error: 'Phone number is required' });
    }

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const sessionDir = path.join(__dirname, 'sessions', sessionId);

    try {
        // Create session directory
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

        // Store session info
        activeSessions.set(sessionId, {
            sock,
            phoneNumber,
            sessionDir,
            paired: false,
            saveCreds
        });

        // Handle connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            const session = activeSessions.get(sessionId);
            
            if (!session) return;

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (!shouldReconnect) {
                    activeSessions.delete(sessionId);
                    // Clean up session directory
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
            } else if (connection === 'open') {
                console.log(`Session ${sessionId} connected successfully`);
                session.paired = true;
                
                // Upload credentials to Pastebin
                try {
                    const credsPath = path.join(sessionDir, 'creds.json');
                    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                    
                    const pasteId = await uploadToPartebin(creds);
                    const efSessionId = `EF-PRIME-MD_${pasteId}`;
                    
                    // Send session ID to user's WhatsApp
                    await sendSessionToWhatsApp(sock, phoneNumber, efSessionId);
                    
                    // Clean up
                    setTimeout(() => {
                        sock.end();
                        activeSessions.delete(sessionId);
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    }, 5000);
                    
                } catch (error) {
                    console.error('Error uploading credentials:', error);
                }
            }
        });

        // Handle credentials update
        sock.ev.on('creds.update', saveCreds);

        // Request pairing code
        if (!sock.authState.creds.registered) {
            const cleanNumber = phoneNumber.replace(/\D/g, '');
            const code = await sock.requestPairingCode(cleanNumber);
            const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
            
            res.json({
                success: true,
                sessionId,
                pairingCode: formattedCode
            });
        } else {
            res.status(400).json({
                success: false,
                error: 'Number already registered'
            });
        }

    } catch (error) {
        console.error('Error generating session:', error);
        
        // Clean up on error
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        activeSessions.delete(sessionId);
        
        res.status(500).json({
            success: false,
            error: 'Failed to generate session'
        });
    }
});

// Check session status
app.get('/api/session-status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);
    
    if (!session) {
        return res.json({ status: 'not_found' });
    }
    
    res.json({
        status: session.paired ? 'paired' : 'waiting'
    });
});

// Upload credentials to Pastebin
async function uploadToPartebin(credentials) {
    const postData = new URLSearchParams({
        api_dev_key: PASTEBIN_API_KEY,
        api_option: 'paste',
        api_paste_code: JSON.stringify(credentials, null, 2),
        api_paste_name: 'EF-PRIME-MD Session Credentials',
        api_paste_expire_date: 'N',
        api_paste_private: 1, // Private paste
        api_paste_format: 'json'
    });

    try {
        const response = await axios.post('https://pastebin.com/api/api_post.php', postData, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
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

// Send session ID to WhatsApp
async function sendSessionToWhatsApp(sock, phoneNumber, sessionId) {
    try {
        const jid = phoneNumber.replace(/\D/g, '') + '@s.whatsapp.net';
        
        const message = `🤖 *EF-PRIME-MD Session Generated* 🤖

✅ *Your Session ID:*
\`${sessionId}\`

📱 *Instructions:*
1. Copy the session ID above
2. Use it in your bot deployment
3. Keep this ID secure and private

⚠️ *Important:*
- Do not share this session ID with anyone
- This message will be the only time you receive it
- Save it in a secure location

🔐 *Generated on:* ${new Date().toLocaleString()}

Thank you for using EF-PRIME-MD! 🚀`;

        await sock.sendMessage(jid, { 
            text: message 
        });
        
        console.log(`Session ID sent to ${phoneNumber}`);
        return true;
    } catch (error) {
        console.error('Error sending session to WhatsApp:', error);
        return false;
    }
}

// Clean up old sessions periodically
setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of activeSessions.entries()) {
        const sessionAge = now - parseInt(sessionId.split('_')[1]);
        
        // Remove sessions older than 10 minutes
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
}, 60000); // Check every minute

app.listen(PORT, () => {
    console.log(`EF-PRIME-MD Session Generator running on port ${PORT}`);
    
    // Create sessions directory if it doesn't exist
    const sessionsDir = path.join(__dirname, 'sessions');
    if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
    }
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down server...');
    
    // Close all active sessions
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
