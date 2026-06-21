const path = require('path');
const qrcode = require('qrcode');
const pino = require('pino');
const { handleMessage } = require('../handlers/messageHandler');
const { loadChats, recordHistorySyncMessages, clearChats } = require('./chatStore');
const {
  loadMessages,
  recordHistoryMessages,
  recordLiveMessages,
  clearMessages,
} = require('./messageStore');

const STORAGE_DIR = path.join(__dirname, '..', '..', 'storage');
const logger = pino({ level: 'warn' });

// In-memory store of active sessions
// Map<customerId, { socket, status, qr }>
const sessions = new Map();

let baileys = null;

async function loadBaileys() {
  if (!baileys) {
    baileys = await import('@whiskeysockets/baileys');
  }
  return baileys;
}

async function startSession(customerId) {
  if (sessions.has(customerId)) {
    const existing = sessions.get(customerId);
    if (existing.status === 'connected') {
      return { status: 'already_connected', phoneNumber: getConnectedPhoneNumber(existing.socket) };
    }
  }

  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion } = await loadBaileys();

  const authDir = path.join(STORAGE_DIR, customerId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  await loadChats(customerId);
  await loadMessages(customerId);

  const { version } = await fetchLatestWaWebVersion();
  console.log(`[${customerId}] Using WA web version: ${version}`);

  const socket = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger,
    version,
  });

  const session = { socket, status: 'connecting', qr: null };
  sessions.set(customerId, session);

  return new Promise((resolve) => {
    let resolved = false;

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('messaging-history.set', ({ messages }) => {
      recordHistorySyncMessages(customerId, messages || []);
      recordHistoryMessages(customerId, messages || []);
    });

    socket.ev.on('messages.upsert', (upsert) => {
      handleMessage(customerId, upsert, socket);
      recordLiveMessages(customerId, upsert.messages || []);
    });

    socket.ev.on('connection.update', async (update) => {
      console.log(`[${customerId}] connection.update:`, JSON.stringify(update, null, 2));
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrDataUrl = await qrcode.toDataURL(qr);
        session.qr = qrDataUrl;
        session.status = 'waiting_for_qr';

        if (!resolved) {
          resolved = true;
          resolve({ status: 'qr_generated', qr: qrDataUrl });
        }
      }

      if (connection === 'open') {
        session.status = 'connected';
        session.qr = null;
        console.log(`[${customerId}] Connected`);

        if (!resolved) {
          resolved = true;
          resolve({ status: 'connected' });
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        console.log(`[${customerId}] Disconnected (code: ${statusCode}, loggedOut: ${loggedOut})`);

        if (loggedOut) {
          sessions.delete(customerId);
          await clearChats(customerId);
          await clearMessages(customerId);
          const fs = require('fs/promises');
          await fs.rm(authDir, { recursive: true, force: true }).catch(() => {});
          session.status = 'logged_out';
        } else {
          session.status = 'disconnected';
          console.log(`[${customerId}] Disconnected, attempting reconnection...`);

          const MAX_RETRIES = 3;
          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            console.log(`[${customerId}] Reconnect attempt ${attempt}/${MAX_RETRIES}`);
            try {
              const result = await startSession(customerId);
              if (result.status === 'connected' || result.status === 'qr_generated' || result.status === 'already_connected') {
                console.log(`[${customerId}] Reconnected on attempt ${attempt}`);
                break;
              }
            } catch (err) {
              console.error(`[${customerId}] Reconnect attempt ${attempt} failed:`, err.message);
            }

            if (attempt < MAX_RETRIES) {
              await new Promise((r) => setTimeout(r, 3000 * attempt));
            } else {
              console.error(`[${customerId}] All ${MAX_RETRIES} reconnect attempts failed, staying disconnected`);
              // Ensure the session stays in the map with "disconnected" status
              const current = sessions.get(customerId);
              if (current) {
                current.status = 'disconnected';
              } else {
                sessions.set(customerId, { socket: null, status: 'disconnected', qr: null });
              }
            }
          }
        }

        if (!resolved) {
          resolved = true;
          resolve({ status: 'disconnected', loggedOut });
        }
      }
    });
  });
}

function getConnectedPhoneNumber(socket) {
  const id = socket?.user?.id;
  if (!id) return null;
  return id.split(/[:@]/)[0] || null;
}

function getSession(customerId) {
  return sessions.get(customerId) || null;
}

function getSessionStatus(customerId) {
  const session = sessions.get(customerId);
  if (!session) return { status: 'not_found' };
  const result = { status: session.status, qr: session.qr };
  if (session.status === 'connected') {
    result.phoneNumber = getConnectedPhoneNumber(session.socket);
  }
  return result;
}

async function deleteSession(customerId) {
  const session = sessions.get(customerId);
  if (!session) return { status: 'not_found' };

  try {
    await session.socket.logout();
  } catch {
    // socket may already be closed
    session.socket.end();
  }

  sessions.delete(customerId);
  await clearChats(customerId);
  await clearMessages(customerId);

  const fs = require('fs/promises');
  const authDir = path.join(STORAGE_DIR, customerId);
  await fs.rm(authDir, { recursive: true, force: true }).catch(() => {});

  return { status: 'deleted' };
}

async function restoreSessions() {
  const fs = require('fs');
  if (!fs.existsSync(STORAGE_DIR)) return;

  const customers = fs.readdirSync(STORAGE_DIR).filter((name) => {
    return fs.statSync(path.join(STORAGE_DIR, name)).isDirectory();
  });

  for (const customerId of customers) {
    console.log(`[${customerId}] Restoring session...`);
    startSession(customerId).catch((err) => {
      console.error(`[${customerId}] Restore failed:`, err.message);
    });
  }
}

module.exports = {
  sessions,
  startSession,
  getSession,
  getSessionStatus,
  deleteSession,
  restoreSessions,
};
