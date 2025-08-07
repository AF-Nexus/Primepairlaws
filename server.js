const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const PastebinAPI = require('pastebin-js');

// It's highly recommended to move this to a .env file for security
const PASTEBIN_API_KEY = 'EMWTMkQAVfJa9kM-MRUrxd5Oku1U7pgL'; 
const pastebin = new PastebinAPI(PASTEBIN_API_KEY);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const TEMP_SESSIONS_DIR = path.join(__dirname, 'temp-sessions');

app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync(TEMP_SESSIONS_DIR)) {
    fs.mkdirSync(TEMP_SESSIONS_DIR);
}

// This function encapsulates the entire pairing logic for one user
async function handlePairingRequest(socket, phoneNumber) {
    const sessionPath = path.join(TEMP_SESSIONS_DIR, `session-${socket.id}`);
    let bot = null;

    const cleanup = async () => {
        if (bot) {
            await bot.end();
            bot.ev.removeAllListeners();
        }
        if (fs.existsSync(sessionPath)) {
            fs.rm(sessionPath, { recursive: true, force: true }, (err) => {
                if (err) console.error(`Failed to delete temp session folder ${sessionPath}:`, err);
            });
        }
    };

    try {
        socket.emit('status', { message: 'Initializing Pairing Process...' });
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const level = pino({ level: 'silent' });

        bot = makeWASocket({
            logger: level,
            printQRInTerminal: false,
            browser: Browsers.windows('Chrome'), // Mimics your bot's browser
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, level),
            },
            version: (await require('@whiskeysockets/baileys').fetchLatestBaileysVersion()).version,
        });

        // This is the key part: we check if the temporary session is registered
        if (!bot.authState.creds.registered) {
            socket.emit('status', { message: 'Requesting Pairing Code from WhatsApp...' });
            // Add a small delay to ensure the socket is ready
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            const code = await bot.requestPairingCode(phoneNumber);
            socket.emit('pairing-code', { code: code?.match(/.{1,4}/g)?.join('-') || code });
        }

        bot.ev.on('creds.update', saveCreds);

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

                    if (pasteId) {
                        const sessionIdValue = `EF-PRIME-MD_${pasteId}`;
                        const userJid = `${phoneNumber}@s.whatsapp.net`;
                        const messageText = `✅ *Your EF-PRIME-MD Session ID* ✅\n\nCongratulations! Your bot is linked.\n\nCopy this Session ID and paste it into the \`.env\` file of your bot:\n\n\`\`\`${sessionIdValue}\`\`\`\n\n*Warning: Do not share this Session ID with anyone.*`;
                        
                        await bot.sendMessage(userJid, { text: messageText });
                        socket.emit('success', { message: 'Session ID has been sent to your WhatsApp!' });
                    } else {
                        throw new Error('Paste ID could not be generated.');
                    }
                } catch (e) {
                     console.error("Pastebin or Send Message Error:", e);
                     socket.emit('error', { message: `API Error: ${e.message}` });
                } finally {
                    await cleanup();
                }

            } else if (connection === 'close') {
                const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                if (reason !== DisconnectReason.loggedOut && reason !== DisconnectReason.connectionReplaced) {
                     socket.emit('error', { message: `Connection Failed. Please try again. (Reason: ${DisconnectReason[reason] || 'Unknown'})` });
                }
                await cleanup();
            }
        });

    } catch (error) {
        console.error(`Error during pairing for socket ${socket.id}:`, error);
        socket.emit('error', { message: 'An internal server error occurred. Please refresh and try again.' });
        await cleanup();
    }
}

io.on('connection', (socket) => {
    console.log(`[Socket.IO] New connection: ${socket.id}`);
    
    socket.on('get-pairing-code', (data) => {
        const { phoneNumber } = data;
        if (!phoneNumber || !/^\d+$/.test(phoneNumber)) {
            return socket.emit('error', { message: 'Invalid phone number format.' });
        }
        // Start the dedicated pairing handler for this user
        handlePairingRequest(socket, phoneNumber);
    });

    socket.on('disconnect', () => {
        console.log(`[Socket.IO] Disconnected: ${socket.id}`);
        // Clean up any lingering session folder if the user disconnects abruptly
        const sessionPath = path.join(TEMP_SESSIONS_DIR, `session-${socket.id}`);
        if (fs.existsSync(sessionPath)) {
            fs.rm(sessionPath, { recursive: true, force: true }, () => {});
        }
    });
});

server.listen(PORT, () => {
    console.log(`Pairing server running on http://localhost:${PORT}`);
});
