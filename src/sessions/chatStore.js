const fs = require('fs/promises');
const path = require('path');

// Per-customer cutoff for hasChatHistory. Add a customer here to enable the feature for them.
// Value is a UNIX timestamp (seconds). Customer must re-pair after a date change so chats.json rebuilds.
const CHAT_HISTORY_CUTOFFS = {
  // Eliron
  '260222c1-9b83-4206-bb90-7445907fb582': Math.floor(new Date('2026-05-19T00:00:00+03:00').getTime() / 1000),
  // Limor
  '4b0e1f37-d55b-41d1-8a33-4f4e6b70781f': Math.floor(new Date('2026-05-15T00:00:00+03:00').getTime() / 1000),
};

const STORAGE_DIR = path.join(__dirname, '..', '..', 'storage');
const DEBOUNCE_MS = 2000;

// Map<customerId, { jids: Set<string>, synced: boolean, saveTimer: NodeJS.Timeout|null }>
const stores = new Map();

function getChatsPath(customerId) {
  return path.join(STORAGE_DIR, customerId, 'chats.json');
}

function getStore(customerId) {
  let store = stores.get(customerId);
  if (!store) {
    store = { jids: new Set(), synced: false, saveTimer: null };
    stores.set(customerId, store);
  }
  return store;
}

function scheduleSave(customerId) {
  const store = getStore(customerId);
  if (store.saveTimer) return;
  store.saveTimer = setTimeout(async () => {
    store.saveTimer = null;
    const arr = Array.from(store.jids);
    try {
      await fs.mkdir(path.dirname(getChatsPath(customerId)), { recursive: true });
      await fs.writeFile(getChatsPath(customerId), JSON.stringify(arr));
    } catch (err) {
      console.error(`[${customerId}] chatStore: failed to write chats.json: ${err.message}`);
    }
  }, DEBOUNCE_MS);
}

async function loadChats(customerId) {
  const store = getStore(customerId);
  try {
    const raw = await fs.readFile(getChatsPath(customerId), 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length > 0) {
      let added = 0;
      for (const entry of arr) {
        if (typeof entry === 'string' && entry.length > 0) {
          store.jids.add(entry);
          added++;
        }
      }
      if (added > 0) store.synced = true;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[${customerId}] chatStore: failed to load chats.json: ${err.message}`);
    }
  }
}

function isCutoffEnabled(customerId) {
  return Object.prototype.hasOwnProperty.call(CHAT_HISTORY_CUTOFFS, customerId);
}

function recordHistorySyncMessages(customerId, messages) {
  const cutoff = CHAT_HISTORY_CUTOFFS[customerId];
  if (!cutoff) return;
  if (!messages?.length) return;
  const store = getStore(customerId);
  let changed = false;
  for (const msg of messages) {
    const jid = msg?.key?.remoteJid;
    if (!jid) continue;
    const ts = Number(msg.messageTimestamp);
    if (!Number.isFinite(ts) || ts <= 0 || ts >= cutoff) continue;
    if (store.jids.has(jid)) continue;
    store.jids.add(jid);
    changed = true;
  }
  if (!changed) return;
  if (!store.synced) store.synced = true;
  scheduleSave(customerId);
}

function isChatsSynced(customerId) {
  return stores.get(customerId)?.synced === true;
}

function hasPreCutoffChat(customerId, jid, jidAlt) {
  const store = stores.get(customerId);
  if (!store) return false;
  const candidates = [jid, jidAlt].filter(Boolean);
  for (const id of candidates) {
    if (store.jids.has(id)) return true;
  }
  return false;
}

async function clearChats(customerId) {
  const store = stores.get(customerId);
  if (store?.saveTimer) {
    clearTimeout(store.saveTimer);
    store.saveTimer = null;
  }
  stores.delete(customerId);
  await fs.rm(getChatsPath(customerId), { force: true }).catch(() => {});
}

module.exports = {
  loadChats,
  recordHistorySyncMessages,
  isCutoffEnabled,
  isChatsSynced,
  hasPreCutoffChat,
  clearChats,
};
