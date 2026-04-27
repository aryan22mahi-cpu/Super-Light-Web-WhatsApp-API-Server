require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
/**
 * WhatsApp Service
 * Handles Baileys WhatsApp connection logic
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    fetchLatestWaWebVersion,
    makeCacheableSignalKeyStore,
    isJidBroadcast,
    Browsers,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const https = require('https');
const Session = require('../models/Session');
const ActivityLog = require('../models/ActivityLog');

// Logger configuration
const defaultLogLevel = process.env.NODE_ENV === 'production' ? 'silent' : 'warn';
const logger = pino({ level: process.env.LOG_LEVEL || defaultLogLevel });

// Active socket connections (in-memory)
const activeSockets = new Map();
const retryCounters = new Map();

// Auth directory
const AUTH_DIR = path.join(__dirname, '../../auth_info_baileys');

function ensureAuthDir() {
    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    }
}

async function callClaude(userMessage) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1024,
            system: "You are DailyDesk, a helpful WhatsApp assistant. You are concise, friendly, and reply in the same language the user writes in. Keep responses short and to the point — this is WhatsApp, not email.",
            messages: [{ role: "user", content: userMessage }]
        });
        const options = {
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(payload)
            }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    resolve(result.content[0].text);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function connect(sessionId, onUpdate, onMessage) {
    if (!require('../utils/validation').isValidId(sessionId)) {
        throw new Error('Invalid session ID');
    }

    ensureAuthDir();

    const sessionDir = path.join(AUTH_DIR, sessionId);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    Session.updateStatus(sessionId, 'CONNECTING', 'Initializing...');
    if (onUpdate) onUpdate(sessionId, 'CONNECTING', 'Initializing...', null);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    let version;
    try {
        const waVersion = await fetchLatestWaWebVersion({});
        version = waVersion.version;
        console.log(`[${sessionId}] Using WA Web version: ${version.join('.')}`);
    } catch (e) {
        const baileysVersion = await fetchLatestBaileysVersion();
        version = baileysVersion.version;
        console.log(`[${sessionId}] Using Baileys version: ${version.join('.')} (fallback)`);
    }

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        printQRInTerminal: false,
        logger,
        browser: Browsers.ubuntu('Chrome'),
        generateHighQualityLinkPreview: false,
        shouldIgnoreJid: (jid) => isJidBroadcast(jid),
        qrTimeout: 40000,
        markOnlineOnConnect: true,
        syncFullHistory: false,
        retryRequestDelayMs: 500,
        maxMsgRetryCount: 3,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        defaultQueryTimeoutMs: undefined,
        getMessage: async () => ({ conversation: 'hello' })
    });

    activeSockets.set(sessionId, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            Session.updateStatus(sessionId, 'GENERATING_QR', 'Scan QR code');
            if (onUpdate) onUpdate(sessionId, 'GENERATING_QR', 'Scan QR code', qr);
        }

        if (connection === 'connecting') {
            Session.updateStatus(sessionId, 'CONNECTING', 'Connecting...');
            if (onUpdate) onUpdate(sessionId, 'CONNECTING', 'Connecting...', null);
        }

        if (connection === 'open') {
            console.log(`[${sessionId}] Connected!`);
            retryCounters.delete(sessionId);
            const name = sock.user?.name || 'Unknown';
            Session.updateStatus(sessionId, 'CONNECTED', `Connected as ${name}`);
            if (onUpdate) onUpdate(sessionId, 'CONNECTED', `Connected as ${name}`, null);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = lastDisconnect?.error?.output?.payload?.message || 'Connection closed';

            console.log(`[${sessionId}] Disconnected: ${statusCode} - ${reason}`);
            Session.updateStatus(sessionId, 'DISCONNECTED', reason);
            if (onUpdate) onUpdate(sessionId, 'DISCONNECTED', reason, null);

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 401 && statusCode !== 403;

            if (shouldReconnect) {
                const retryCount = (retryCounters.get(sessionId) || 0) + 1;
                retryCounters.set(sessionId, retryCount);

                if (retryCount <= 5) {
                    console.log(`[${sessionId}] Reconnecting... (attempt ${retryCount})`);
                    setTimeout(() => connect(sessionId, onUpdate, onMessage), 5000);
                } else {
                    console.log(`[${sessionId}] Max retries reached`);
                    retryCounters.delete(sessionId);
                }
            } else {
                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    console.log(`[${sessionId}] Logged out, cleaning session data`);
                    if (fs.existsSync(sessionDir)) {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    }
                }
            }

            activeSockets.delete(sessionId);
        }
    });

    // Handle incoming messages - call Claude and reply
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && msg.message) {
            if (onMessage) onMessage(sessionId, msg);

            const userText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            if (!userText) return;

            console.log(`[${sessionId}] Received: ${userText}`);

            try {
                const reply = await callClaude(userText);
                await sock.sendMessage(msg.key.remoteJid, { text: reply });
                console.log(`[${sessionId}] Replied: ${reply.substring(0, 50)}`);
            } catch (e) {
                console.error(`[${sessionId}] Claude error: ${e.message}`);
            }
        }
    });

    return sock;
}

function disconnect(sessionId) {
    const sock = activeSockets.get(sessionId);
    if (sock) {
        sock.end();
        activeSockets.delete(sessionId);
    }
    retryCounters.delete(sessionId);
}

function getSocket(sessionId) {
    return activeSockets.get(sessionId) || null;
}

function isConnected(sessionId) {
    const sock = activeSockets.get(sessionId);
    return sock?.user != null;
}

function deleteSessionData(sessionId) {
    if (!require('../utils/validation').isValidId(sessionId)) {
        return;
    }

    disconnect(sessionId);

    const sessionDir = path.join(AUTH_DIR, sessionId);
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    Session.delete(sessionId);
}

function getActiveSessions() {
    return activeSockets;
}

module.exports = {
    connect,
    disconnect,
    getSocket,
    isConnected,
    deleteSessionData,
    getActiveSessions,
    AUTH_DIR
};
