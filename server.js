const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const PastebinAPI = require('pastebin-js');

// --- Your Pastebin API Key ---
// It's highly recommended to move this to a .env file for security
// process.env.PASTEBIN_API_KEY
const PASTEBIN_API_KEY = 'EMWTMkQAVfJa9kM-MRUrxd5Oku1U7pgL'; 
const pastebin = new PastebinAPI(PASTEBIN_API_KEY);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const TEMP_SESSIONS_DIR = path.join(__dirname, 'temp-sessions');

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Create temp sessions directory if it doesn't exist
if (!fs.existsSync(TEMP_SESSIONS_DIR)) {
    fs.mkdirSync(TEMP_SESSIONS_DIR);
}

io.on('connection', (socket) => {
    console.log(`[Socket.IO] New connection: ${socket.id}`);
    
    socket.on('get-pairing-code', async (data) => {
        const { phoneNumber } = data;
        const sessionId = `session-${socket.id}`;
        const sessionPath = path.join(TEMP_SESSIONS_DIR, sessionId);
        let bot = null; 

        const cleanup = () => {
            if (bot) {
                bot.end();
                bot.ev.removeAllListeners();
            }
             if (fs.existsSync(sessionPath)) {
                fs.rm(sessionPath, { recursive: true, force: true }, (err) => {
                    if (err) console.error(`Failed to delete session folder ${sessionPath}:`, err);
                });
            }
        };

        try {
            if (!phoneNumber || !/^\d+$/.test(phoneNumber)) {
                return socket.emit('error', { message: 'Invalid phone number format.' });
            }

            socket.emit('status', { message: 'Initializing Baileys...' });
            
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            
            bot = makeWASocket({
                logger: pino({ level: 'silent' }),
                printQRInTerminal: false,
                browser: ["EF-PRIME-MD", "Safari", "1.0.0"],
                auth: state
            });

            if (!bot.authState.creds.registered) {
                socket.emit('status', { message: 'Requesting pairing code...' });
                setTimeout(async () => {
                    try {
                        const code = await bot.requestPairingCode(phoneNumber);
                        socket.emit('pairing-code', { code: code?.match(/.{1,4}/g)?.join('-') || code });
                    } catch(e) {
                        socket.emit('error', { message: 'Failed to request pairing code. Please check the number and try again.' });
                        cleanup();
                    }
                }, 3000); 
            }

            bot.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;
                if (connection === 'open') {
                    socket.emit('status', { message: 'Connection successful! Generating & sending Session ID...' });
                    
                    const credsData = fs.readFileSync(path.join(sessionPath, 'creds.json'), 'utf-8');
                    
                    try {
                        // *** NEW LOGIC: USE PASTEBIN-JS TO UPLOAD CREDS ***
                        const pasteUrl = await pastebin.createPaste({
                            text: credsData,
                            title: `EF-PRIME-MD Session - ${phoneNumber}`,
                            format: "json",
                            privacy: 1, // 0=public, 1=unlisted, 2=private
                            expiration: 'N' // N=Never, 10M, 1H, 1D, etc.
                        });

                        // The URL from pastebin.createPaste is the full URL. We need to extract the ID.
                        const pasteId = path.basename(new URL(pasteUrl).pathname);

                        if (pasteId) {
                            const sessionIdValue = `EF-PRIME-MD_${pasteId}`;
                            
                            const userJid = `${phoneNumber}@s.whatsapp.net`;
                            const messageText = `✅ *Your EF-PRIME-MD Session ID* ✅\n\nCongratulations! Your bot is linked.\n\nCopy the following Session ID and paste it into the \`.env\` file of your bot:\n\n\`\`\`${sessionIdValue}\`\`\`\n\n*Warning: Do not share this Session ID with anyone, as it grants full access to your WhatsApp account.*`;
                            
                            await bot.sendMessage(userJid, { text: messageText });
                            
                            socket.emit('success', { message: 'Session ID has been sent to your WhatsApp number!' });

                        } else {
                            socket.emit('error', { message: 'Could not generate Session ID. Please try again.' });
                        }
                    } catch (e) {
                         console.error("Pastebin API Error:", e);
                         socket.emit('error', { message: `Pastebin API error: ${e.message}` });
                    } finally {
                        cleanup();
                    }

                } else if (connection === 'close') {
                    const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                    if (reason !== DisconnectReason.loggedOut) {
                         socket.emit('error', { message: `Connection closed. Reason: ${DisconnectReason[reason] || 'Unknown'}` });
                    }
                    cleanup();
                }
            });

            bot.ev.on('creds.update', saveCreds);
            
        } catch (error) {
            console.error(error);
            socket.emit('error', { message: 'An internal server error occurred.' });
            cleanup();
        }
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