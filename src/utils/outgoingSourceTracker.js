const TTL_MS = 5 * 60 * 1000;

const entries = new Map();

function markOutgoing(messageId, source) {
  if (!messageId || !source) return;
  entries.set(messageId, { source, expiresAt: Date.now() + TTL_MS });
}

function consumeSource(messageId) {
  if (!messageId) return null;
  const entry = entries.get(messageId);
  if (!entry) return null;
  entries.delete(messageId);
  if (entry.expiresAt < Date.now()) return null;
  return entry.source;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of entries) {
    if (entry.expiresAt < now) entries.delete(id);
  }
}, 60 * 1000).unref();

module.exports = { markOutgoing, consumeSource };
