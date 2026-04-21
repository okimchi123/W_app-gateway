const fs = require('fs/promises');
const path = require('path');

const STORAGE_DIR = path.join(__dirname, '..', '..', 'storage');
const DEBOUNCE_MS = 2000;

// Map<customerId, { contacts: Map<jid, Contact>, synced: boolean, saveTimer: NodeJS.Timeout|null }>
const stores = new Map();

function getContactsPath(customerId) {
  return path.join(STORAGE_DIR, customerId, 'contacts.json');
}

function getStore(customerId) {
  let store = stores.get(customerId);
  if (!store) {
    store = { contacts: new Map(), synced: false, saveTimer: null };
    stores.set(customerId, store);
  }
  return store;
}

function slimContact(c) {
  const out = { id: c.id };
  if (c.name) out.name = c.name;
  if (c.notify) out.notify = c.notify;
  if (c.verifiedName) out.verifiedName = c.verifiedName;
  if (c.lid) out.lid = c.lid;
  return out;
}

// Contacts.update sends diffs — spread keeps prior non-empty fields when the
// incoming record omits them. slimContact strips falsy values, so "..."
// won't clobber a previously-saved name with undefined.
function mergeContact(existing, incoming) {
  return { ...(existing || {}), ...slimContact(incoming) };
}

function mergeBatch(store, contacts) {
  let changed = false;
  for (const c of contacts) {
    if (!c?.id) continue;
    const existing = store.contacts.get(c.id);
    store.contacts.set(c.id, mergeContact(existing, c));
    changed = true;
  }
  return changed;
}

function scheduleSave(customerId) {
  const store = getStore(customerId);
  if (store.saveTimer) return;
  store.saveTimer = setTimeout(async () => {
    store.saveTimer = null;
    const arr = Array.from(store.contacts.values());
    try {
      await fs.mkdir(path.dirname(getContactsPath(customerId)), { recursive: true });
      await fs.writeFile(getContactsPath(customerId), JSON.stringify(arr));
    } catch (err) {
      console.error(`[${customerId}] contactStore: failed to write contacts.json: ${err.message}`);
    }
  }, DEBOUNCE_MS);
}

async function loadContacts(customerId) {
  const store = getStore(customerId);
  try {
    const raw = await fs.readFile(getContactsPath(customerId), 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length > 0) {
      for (const c of arr) {
        if (c?.id) store.contacts.set(c.id, c);
      }
      store.synced = true;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[${customerId}] contactStore: failed to load contacts.json: ${err.message}`);
    }
  }
}

function markHistorySynced(customerId, contacts) {
  if (!contacts?.length) return;
  const store = getStore(customerId);
  const changed = mergeBatch(store, contacts);
  if (!changed) return;
  if (!store.synced) store.synced = true;
  scheduleSave(customerId);
}

function upsertContacts(customerId, contacts) {
  if (!contacts?.length) return;
  const store = getStore(customerId);
  const changed = mergeBatch(store, contacts);
  if (changed) scheduleSave(customerId);
}

// Returns true / false / null. null means "cache not hydrated yet" — caller
// should omit the field so downstream's missing=unsafe fail-safe engages.
function getSavedStatus(customerId, jid, jidAlt) {
  const store = stores.get(customerId);
  if (!store || !store.synced) return null;
  const candidates = [jid, jidAlt].filter(Boolean);
  for (const id of candidates) {
    const c = store.contacts.get(id);
    if (c?.name) return true;
  }
  return false;
}

async function clearContacts(customerId) {
  const store = stores.get(customerId);
  if (store?.saveTimer) {
    clearTimeout(store.saveTimer);
    store.saveTimer = null;
  }
  stores.delete(customerId);
  await fs.rm(getContactsPath(customerId), { force: true }).catch(() => {});
}

module.exports = {
  loadContacts,
  markHistorySynced,
  upsertContacts,
  getSavedStatus,
  clearContacts,
};
