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

// Must stay below nginx's proxy_read_timeout (60s) so the client gets a real
// error from us instead of a 504 from nginx.
const START_TIMEOUT_MS = Number(process.env.SESSION_START_TIMEOUT_MS) || 45000;
const VERSION_FETCH_TIMEOUT_MS = Number(process.env.WA_VERSION_FETCH_TIMEOUT_MS) || 10000;

// In-memory store of active sessions
// Map<customerId, { socket, status, qr }>
const sessions = new Map();

// In-flight startSession promises, keyed by customerId. Without this, every
// retry of a hanging /session/start spawns another Baileys socket for the same
// customer; the old ones are never closed and keep connecting to WhatsApp.
const pendingStarts = new Map();

// Customers with a background reconnect loop already running, so overlapping
// 'close' events don't each spawn their own retry chain.
const reconnecting = new Set();

let baileys = null;

async function loadBaileys() {
  if (!baileys) {
    baileys = await import('@whiskeysockets/baileys');
  }
  return baileys;
}

function closeSocket(socket) {
  if (!socket) return;
  try {
    socket.end(undefined);
  } catch {
    // socket may already be torn down
  }
}

// fetchLatestWaWebVersion() hits https://web.whatsapp.com/sw.js with no timeout
// of its own. If WhatsApp stalls that request, startSession never even reaches
// socket creation. Bound it and fall back to the version bundled with Baileys.
async function resolveWaVersion(customerId) {
  const { fetchLatestWaWebVersion } = await loadBaileys();
  try {
    const { version, isLatest, error } = await fetchLatestWaWebVersion({
      signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS),
    });
    if (error) {
      console.warn(`[${customerId}] WA version lookup fell back to bundled version:`, error.message || error);
    }
    return { version, isLatest };
  } catch (err) {
    console.warn(`[${customerId}] WA version lookup failed (${err.message}); using bundled version`);
    return { version: null, isLatest: false };
  }
}

// Public entry point: collapses concurrent/retried starts for the same customer
// onto a single attempt instead of opening a socket per request.
async function startSession(customerId) {
  const inFlight = pendingStarts.get(customerId);
  if (inFlight) return inFlight;

  const attempt = startSessionInner(customerId).finally(() => {
    pendingStarts.delete(customerId);
  });

  pendingStarts.set(customerId, attempt);
  return attempt;
}

async function startSessionInner(customerId) {
  if (sessions.has(customerId)) {
    const existing = sessions.get(customerId);
    if (existing.status === 'connected') {
      return { status: 'already_connected', phoneNumber: getConnectedPhoneNumber(existing.socket) };
    }
    // Replacing a non-connected session: close the previous socket first so it
    // stops its own reconnect attempts against WhatsApp.
    closeSocket(existing.socket);
  }

  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = await loadBaileys();

  const authDir = path.join(STORAGE_DIR, customerId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  await loadChats(customerId);
  await loadMessages(customerId);

  const { version } = await resolveWaVersion(customerId);
  console.log(`[${customerId}] Using WA web version: ${version || 'bundled default'}`);

  const socketConfig = {
    auth: state,
    printQRInTerminal: false,
    logger,
  };
  // makeWASocket spreads config over its defaults, so an explicit `undefined`
  // would clobber the bundled version rather than fall back to it.
  if (version) socketConfig.version = version;

  const socket = makeWASocket(socketConfig);

  const session = { socket, status: 'connecting', qr: null };
  sessions.set(customerId, session);

  return new Promise((resolve, reject) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;

      console.error(
        `[${customerId}] No qr/connection.update from Baileys within ${START_TIMEOUT_MS}ms; aborting start`
      );

      closeSocket(socket);
      const current = sessions.get(customerId);
      if (current === session) {
        session.socket = null;
        session.qr = null;
        session.status = 'disconnected';
      }

      const err = new Error(`Timed out after ${START_TIMEOUT_MS}ms waiting for WhatsApp to respond`);
      err.code = 'SESSION_START_TIMEOUT';
      reject(err);
    }, START_TIMEOUT_MS);

    const settle = (value) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(value);
    };

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

        settle({ status: 'qr_generated', qr: qrDataUrl });
      }

      if (connection === 'open') {
        session.status = 'connected';
        session.qr = null;
        console.log(`[${customerId}] Connected`);

        settle({ status: 'connected' });
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
          settle({ status: 'disconnected', loggedOut });
          return;
        }

        session.status = 'disconnected';

        // Answer the caller now. Reconnection runs in the background — holding
        // the HTTP request open across 3 retries plus backoff is what pushed
        // /session/start past nginx's 60s timeout.
        settle({ status: 'disconnected', loggedOut });
        scheduleReconnect(customerId, statusCode).catch((err) => {
          console.error(`[${customerId}] Reconnect loop crashed:`, err.message);
        });
      }
    });
  });
}

// WhatsApp answers 405 when it is refusing connections from this IP, usually
// because it has seen too many attempts. Retrying that every 3s is what turned
// one blocked IP into 4.1M rejected handshakes and an OOM loop, so back off in
// minutes instead. 515 is the opposite case: it is a normal step in the pairing
// handshake and the client is *expected* to reconnect straight away.
const BLOCKED_STATUS_CODES = new Set([403, 405, 429]);
const BLOCKED_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 45 * 60_000];

function reconnectDelayMs(statusCode, attempt) {
  if (statusCode === 515) return 1000;
  if (BLOCKED_STATUS_CODES.has(statusCode)) {
    return BLOCKED_BACKOFF_MS[attempt - 1] ?? BLOCKED_BACKOFF_MS.at(-1);
  }
  return 3000 * attempt;
}

async function scheduleReconnect(customerId, statusCode) {
  if (reconnecting.has(customerId)) return;
  reconnecting.add(customerId);

  const MAX_RETRIES = 3;
  try {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const delay = reconnectDelayMs(statusCode, attempt);
      if (delay >= 60_000) {
        console.log(`[${customerId}] code ${statusCode}: backing off ${Math.round(delay / 60000)}min before attempt ${attempt}`);
      }
      await new Promise((r) => setTimeout(r, delay));

      console.log(`[${customerId}] Reconnect attempt ${attempt}/${MAX_RETRIES}`);
      try {
        const result = await startSession(customerId);
        if (
          result.status === 'connected' ||
          result.status === 'qr_generated' ||
          result.status === 'already_connected'
        ) {
          console.log(`[${customerId}] Reconnected on attempt ${attempt}`);
          return;
        }
      } catch (err) {
        console.error(`[${customerId}] Reconnect attempt ${attempt} failed:`, err.message);
      }
    }

    console.error(`[${customerId}] All ${MAX_RETRIES} reconnect attempts failed, staying disconnected`);
    const current = sessions.get(customerId);
    if (current) {
      current.status = 'disconnected';
    } else {
      sessions.set(customerId, { socket: null, status: 'disconnected', qr: null });
    }
  } finally {
    reconnecting.delete(customerId);
  }
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

  // Staggered: restoring every customer at once means N simultaneous
  // connections to WhatsApp from one IP, which is a good way to get throttled.
  const RESTORE_STAGGER_MS = Number(process.env.SESSION_RESTORE_STAGGER_MS) || 2000;

  for (const customerId of customers) {
    console.log(`[${customerId}] Restoring session...`);
    try {
      await startSession(customerId);
    } catch (err) {
      console.error(`[${customerId}] Restore failed:`, err.message);
    }
    await new Promise((r) => setTimeout(r, RESTORE_STAGGER_MS));
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
