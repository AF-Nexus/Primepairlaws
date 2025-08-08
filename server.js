// server.js - Backend Server with Real Baileys
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('baileys');
const P = require('pino');

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
        const { version, isLatest } = await fetchLatestBaileysVersion();
        
        console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);
        
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: P({ level: 'silent' }),
            browser: ['EF-PRIME-MD', 'Chrome', '1.0.0'],
            generateHighQualityLinkPreview: true
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

            console.log('Connection update:', { connection, sessionId });

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('Connection closed:', {
                    shouldReconnect,
                    statusCode: lastDisconnect?.error?.output?.statusCode,
                    reason: lastDisconnect?.error?.output?.payload?.message
                });
                
                if (!shouldReconnect) {
                    activeSessions.delete(sessionId);
                    // Clean up session directory
                    if (fs.existsSync(sessionDir)) {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    }
                }
            } else if (connection === 'open') {
                console.log(`Session ${sessionId} connected successfully`);
                session.paired = true;
                
                // Upload credentials to Pastebin
                try {
                    const credsPath = path.join(sessionDir, 'creds.json');
                    if (fs.existsSync(credsPath)) {
                        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                        
                        const pasteId = await uploadToPartebin(creds);
                        const efSessionId = `EF-PRIME-MD_${pasteId}`;
                        
                        // Send session ID to user's WhatsApp
                        await sendSessionToWhatsApp(sock, phoneNumber, efSessionId);
                        
                        console.log(`Session ID sent to ${phoneNumber}: ${efSessionId}`);
                        
                        // Clean up after a delay
                        setTimeout(() => {
                            try {
                                sock.end();
                                activeSessions.delete(sessionId);
                                if (fs.existsSync(sessionDir)) {
                                    fs.rmSync(sessionDir, { recursive: true, force: true });
                                }
                            } catch (cleanupError) {
                                console.error('Cleanup error:', cleanupError);
                            }
                        }, 5000);
                    } else {
                        console.error('Credentials file not found');
                    }
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
            console.log(`Requesting pairing code for: ${cleanNumber}`);
            
            const code = await sock.requestPairingCode(cleanNumber);
            const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
            
            console.log(`Pairing code generated: ${formattedCode}`);
            
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
            error: 'Failed to generate session: ' + error.message
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
        } else if (response.data.startsWith('Bad API request')) {
            throw new Error('Pastebin API error: ' + response.data);
        } else {
            // If it's just a paste ID
            return response.data;
        }
    } catch (error) {
        console.error('Pastebin upload error:', error);
        throw new Error('Failed to upload to Pastebin: ' + error.message);
    }
}

// Send session ID to WhatsApp
async function sendSessionToWhatsApp(sock, phoneNumber, sessionId) {
    try {
        const cleanNumber = phoneNumber.replace(/\D/g, '');
        const jid = cleanNumber + '@s.whatsapp.net';
        
        console.log(`Attempting to send message to: ${jid}`);
        
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
        
        console.log(`Session ID sent successfully to ${phoneNumber}`);
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
                console.log(`Cleaning up expired session: ${sessionId}`);
                session.sock.end();
                if (fs.existsSync(session.sessionDir)) {
                    fs.rmSync(session.sessionDir, { recursive: true, force: true });
                }
                activeSessions.delete(sessionId);
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
    
    console.log('Server started successfully!');
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

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = app;    const cleanup = () => {
        if (bot) {
            bot.end();
            bot.ev.removeAllListeners();
        }
        if (fs.existsSync(sessionPath)) {
            fs.rm(sessionPath, { recursive: true, force: true }, (err) => {
                if (err) console.error(`Failed to delete temp session folder ${sessionPath}:`, err);
            });
        }
    };

    try {
        socket.emit('status', { message: 'Initializing Bot Instance...' });

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const level = pino({ level: 'silent' });
        const { version } = await fetchLatestBaileysVersion();

        // --- THIS IS THE KEY: We are using the exact, robust configuration from your bot ---
        bot = makeWASocket({
            logger: level,
            printQRInTerminal: false,
            browser: Browsers.windows('Chrome'),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, level),
            },
            version,
            // These settings from your bot are crucial for stability
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 10 },
            appStateMacVerification: { patch: true, snapshot: true },
        });

        if (!bot.authState.creds.registered) {
            socket.emit('status', { message: 'Requesting Pairing Code...' });
            await new Promise(resolve => setTimeout(resolve, 1500)); // Small delay for stability

            const code = await bot.requestPairingCode(phoneNumber);
            const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
            socket.emit('pairing-code', { code: formattedCode });
        }

        bot.ev.on('creds.update', saveCreds);

        // We use the full connection logic from your bot for reliability
        bot.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                socket.emit('status', { message: 'Connection Successful! Uploading session and sending ID...' });

                const credsData = fs.readFileSync(path.join(sessionPath, 'creds.json'), 'utf-8');

                try {
                    const pasteUrl = await pastebin.createPaste({
                        text: credsData,
                        title: `EF-PRIME-MD Session - ${phoneNumber}`,
                        format: "json",
                        privacy: 1,
                        expiration: 'N'
                    });

                    const pasteId = path.basename(new URL(pasteUrl).pathname);

                    if (!pasteId) throw new Error('Could not generate Paste ID.');
                    
                    const efSessionId = `EF-PRIME-MD_${pasteId}`;
                    const userJid = `${phoneNumber}@s.whatsapp.net`;
                    
                    // --- SENDING TWO MESSAGES AS REQUESTED ---
                    // Message 1: The Session ID itself for easy copying
                    await bot.sendMessage(userJid, { text: efSessionId });
                    
                    // Message 2: The instructional message
                    const instructions = `🤖 *EF-PRIME-MD Session Generated* 🤖\n\n✅ *Session ID Sent Above*\n\n1. Long-press the message above to copy your session ID.\n2. Use it in your bot's configuration.\n3. Keep this ID completely private!\n\nThank you for using our service! 🚀`;
                    await bot.sendMessage(userJid, { text: instructions });

                    socket.emit('success', { message: 'Session ID has been sent to your WhatsApp!' });
                } catch (e) {
                    console.error("Pastebin or Send Message Error:", e);
                    socket.emit('error', { message: `API Error: ${e.message}` });
                } finally {
                    cleanup();
                }

            } else if (connection === 'close') {
                const reasonCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
                const reason = DisconnectReason[reasonCode] || 'Unknown';
                const errorMessage = `Connection Failed. Please refresh and try again. (Reason: ${reason})`;
                
                socket.emit('error', { message: errorMessage });
                cleanup();
            }
        });

    } catch (error) {
        console.error(`Error during pairing for socket ${socket.id}:`, error);
        socket.emit('error', { message: 'An internal server error occurred. Please refresh and try again.' });
        cleanup();
    }
}

io.on('connection', (socket) => {
    console.log(`[Socket.IO] New connection: ${socket.id}`);
    
    socket.on('get-pairing-code', (data) => {
        const { phoneNumber } = data;
        if (!phoneNumber || !/^\d+$/.test(phoneNumber)) {
            return socket.emit('error', { message: 'Invalid phone number format.' });
        }
        handlePairingRequest(socket, phoneNumber);
    });

    socket.on('disconnect', () => {
        console.log(`[Socket.IO] Disconnected: ${socket.id}`);
        const sessionPath = path.join(TEMP_SESSIONS_DIR, `session-${socket.id}`);
        if (fs.existsSync(sessionPath)) {
            fs.rm(sessionPath, { recursive: true, force: true }, () => {});
        }
    });
});

server.listen(PORT, () => {
    console.log(`Pairing server running on http://localhost:${PORT}`);
});

process.on('uncaughtException', (err) => {
    console.error('An uncaught exception occurred:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('An unhandled promise rejection occurred:', reason);
});    const cleanup = () => {
        if (bot) {
            bot.end();
            bot.ev.removeAllListeners();
        }
        if (fs.existsSync(sessionPath)) {
            fs.rm(sessionPath, { recursive: true, force: true }, (err) => {
                if (err) console.error(`Failed to delete temp session folder ${sessionPath}:`, err);
            });
        }
    };

    try {
        socket.emit('status', { message: 'Initializing Bot Instance...' });

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const level = pino({ level: 'silent' });
        const { version } = await fetchLatestBaileysVersion();

        // --- THIS IS THE KEY: We are using the exact, robust configuration from your bot ---
        bot = makeWASocket({
            logger: level,
            printQRInTerminal: false,
            browser: Browsers.windows('Chrome'),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, level),
            },
            version,
            // These settings from your bot are crucial for stability
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 10 },
            appStateMacVerification: { patch: true, snapshot: true },
        });

        if (!bot.authState.creds.registered) {
            socket.emit('status', { message: 'Requesting Pairing Code...' });
            await new Promise(resolve => setTimeout(resolve, 1500)); // Small delay for stability

            const code = await bot.requestPairingCode(phoneNumber);
            const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
            socket.emit('pairing-code', { code: formattedCode });
        }

        bot.ev.on('creds.update', saveCreds);

        // We use the full connection logic from your bot for reliability
        bot.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                socket.emit('status', { message: 'Connection Successful! Uploading session and sending ID...' });

                const credsData = fs.readFileSync(path.join(sessionPath, 'creds.json'), 'utf-8');

                try {
                    const pasteUrl = await pastebin.createPaste({
                        text: credsData,
                        title: `EF-PRIME-MD Session - ${phoneNumber}`,
                        format: "json",
                        privacy: 1,
                        expiration: 'N'
                    });

                    const pasteId = path.basename(new URL(pasteUrl).pathname);

                    if (!pasteId) throw new Error('Could not generate Paste ID.');
                    
                    const efSessionId = `EF-PRIME-MD_${pasteId}`;
                    const userJid = `${phoneNumber}@s.whatsapp.net`;
                    
                    // --- SENDING TWO MESSAGES AS REQUESTED ---
                    // Message 1: The Session ID itself for easy copying
                    await bot.sendMessage(userJid, { text: efSessionId });
                    
                    // Message 2: The instructional message
                    const instructions = `🤖 *EF-PRIME-MD Session Generated* 🤖\n\n✅ *Session ID Sent Above*\n\n1. Long-press the message above to copy your session ID.\n2. Use it in your bot's configuration.\n3. Keep this ID completely private!\n\nThank you for using our service! 🚀`;
                    await bot.sendMessage(userJid, { text: instructions });

                    socket.emit('success', { message: 'Session ID has been sent to your WhatsApp!' });
                } catch (e) {
                     console.error("Pastebin or Send Message Error:", e);
                     socket.emit('error', { message: `API Error: ${e.message}` });
                } finally {
                    cleanup();
                }

            } else if (connection === 'close') {
                const reasonCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
                const reason = DisconnectReason[reasonCode] || 'Unknown';
                const errorMessage = `Connection Failed. Please refresh and try again. (Reason: ${reason})`;
                
                socket.emit('error', { message: errorMessage });
                cleanup();
            }
        });

    } catch (error) {
        console.error(`Error during pairing for socket ${socket.id}:`, error);
        socket.emit('error', { message: 'An internal server error occurred. Please refresh and try again.' });
        cleanup();
    }
}

io.on('connection', (socket) => {
    console.log(`[Socket.IO] New connection: ${socket.id}`);
    
    socket.on('get-pairing-code', (data) => {
        const { phoneNumber } = data;
        if (!phoneNumber || !/^\d+$/.test(phoneNumber)) {
            return socket.emit('error', { message: 'Invalid phone number format.' });
        }
        handlePairingRequest(socket, phoneNumber);
    });

    socket.on('disconnect', () => {
        console.log(`[Socket.IO] Disconnected: ${socket.id}`);
        const sessionPath = path.join(TEMP_SESSIONS_DIR, `session-${socket.id}`);
        if (fs.existsSync(sessionPath)) {
            fs.rm(sessionPath, { recursive: true, force: true }, () => {});
        }
    });
});

server.listen(PORT, () => {
    console.log(`Pairing server running on http://localhost:${PORT}`);
});

process.on('uncaughtException', (err) => {
    console.error('An uncaught exception occurred:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('An unhandled promise rejection occurred:', reason);
});            fs.mkdirSync(sessionDir, { recursive: true });
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
