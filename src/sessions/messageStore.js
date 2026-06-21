const fs = require('fs/promises');
const path = require('path');

// Only these customers capture message content. Others no-op.
// Capturing for everyone would persist message bodies + rewrite a file every 2s
// for every bot on the shared gateway — a disk/IO and privacy change for all tenants.
const MESSAGE_CAPTURE_CUSTOMERS = new Set([
  'ronit-id',
  'clix-news',
]);

const STORAGE_DIR = path.join(__dirname, '..', '..', 'storage');
const DEBOUNCE_MS = 2000;
const MAX_PER_JID = 50;

// Map<customerId, { byJid: Map<jid, Array<{direction,text,timestamp}>>, loaded: boolean, saveTimer: NodeJS.Timeout|null }>
const stores = new Map();

function getMessagesPath(customerId) {
  return path.join(STORAGE_DIR, customerId, 'messages.json');
}

function getStore(customerId) {
  let store = stores.get(customerId);
  if (!store) {
    store = { byJid: new Map(), loaded: false, saveTimer: null };
    stores.set(customerId, store);
  }
  return store;
}

// Canonical storage key — mirrors messageHandler.js resolvePhoneNumber so that
// captured messages and endpoint lookups share one key. Group chats keep the raw
// group JID; private/@lid chats normalize to <digits>@s.whatsapp.net.
function storageKeyFor(msg) {
  const remoteJid = msg?.key?.remoteJid;
  if (!remoteJid) return null;

  if (remoteJid.endsWith('@g.us')) return remoteJid;

  if (remoteJid.endsWith('@s.whatsapp.net')) {
    return `${remoteJid.replace(/@.+$/, '')}@s.whatsapp.net`;
  }

  if (remoteJid.endsWith('@lid')) {
    const altJid = msg.key.remoteJidAlt;
    if (altJid && altJid.endsWith('@s.whatsapp.net')) {
      return `${altJid.replace(/@.+$/, '')}@s.whatsapp.net`;
    }
  }

  return null;
}

// Text precedence mirrors messageHandler.js; media caption folds in as the text.
function extractContent(msg) {
  const m = msg?.message;
  if (!m) return '';
  return m.conversation
    || m.extendedTextMessage?.text
    || m.buttonsResponseMessage?.selectedDisplayText
    || m.listResponseMessage?.title
    || m.templateButtonReplyMessage?.selectedDisplayText
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || m.documentMessage?.caption
    || '';
}

function scheduleSave(customerId) {
  const store = getStore(customerId);
  if (store.saveTimer) return;
  store.saveTimer = setTimeout(async () => {
    store.saveTimer = null;
    const obj = {};
    for (const [jid, arr] of store.byJid) {
      obj[jid] = arr;
    }
    try {
      await fs.mkdir(path.dirname(getMessagesPath(customerId)), { recursive: true });
      await fs.writeFile(getMessagesPath(customerId), JSON.stringify(obj));
    } catch (err) {
      console.error(`[${customerId}] messageStore: failed to write messages.json: ${err.message}`);
    }
  }, DEBOUNCE_MS);
}

async function loadMessages(customerId) {
  const store = getStore(customerId);
  try {
    const raw = await fs.readFile(getMessagesPath(customerId), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      for (const [jid, arr] of Object.entries(obj)) {
        if (Array.isArray(arr)) store.byJid.set(jid, arr);
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[${customerId}] messageStore: failed to load messages.json: ${err.message}`);
    }
  }
  store.loaded = true;
}

function insertMessage(store, jid, record) {
  let arr = store.byJid.get(jid);
  if (!arr) {
    arr = [];
    store.byJid.set(jid, arr);
  }

  // Best-effort dedup (no message id in the stored shape).
  const dup = arr.some((e) =>
    e.timestamp === record.timestamp
    && e.direction === record.direction
    && e.text === record.text);
  if (dup) return false;

  arr.push(record);
  if (arr.length > MAX_PER_JID) {
    arr.sort((a, b) => a.timestamp - b.timestamp);
    store.byJid.set(jid, arr.slice(-MAX_PER_JID));
  }
  return true;
}

function recordMessages(customerId, messages) {
  if (!MESSAGE_CAPTURE_CUSTOMERS.has(customerId)) return;
  if (!messages?.length) return;
  const store = getStore(customerId);
  let changed = false;

  for (const msg of messages) {
    const jid = storageKeyFor(msg);
    if (!jid) continue;
    const timestamp = Number(msg.messageTimestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
    const record = {
      direction: msg.key?.fromMe ? 'outbound' : 'inbound',
      text: extractContent(msg),
      timestamp,
    };
    if (insertMessage(store, jid, record)) changed = true;
  }

  if (changed) scheduleSave(customerId);
}

function recordHistoryMessages(customerId, messages) {
  recordMessages(customerId, messages);
}

function recordLiveMessages(customerId, messages) {
  recordMessages(customerId, messages);
}

async function getMessages(customerId, jid, limit) {
  let arr;
  const store = stores.get(customerId);
  if (store?.loaded) {
    arr = store.byJid.get(jid);
  } else {
    try {
      const raw = await fs.readFile(getMessagesPath(customerId), 'utf8');
      const obj = JSON.parse(raw);
      arr = obj?.[jid];
    } catch {
      arr = null;
    }
  }

  if (!Array.isArray(arr) || arr.length === 0) return [];

  return arr
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

async function clearMessages(customerId) {
  const store = stores.get(customerId);
  if (store?.saveTimer) {
    clearTimeout(store.saveTimer);
    store.saveTimer = null;
  }
  stores.delete(customerId);
  await fs.rm(getMessagesPath(customerId), { force: true }).catch(() => {});
}

module.exports = {
  loadMessages,
  recordHistoryMessages,
  recordLiveMessages,
  getMessages,
  clearMessages,
};
