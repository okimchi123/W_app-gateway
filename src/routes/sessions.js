const { Router } = require('express');
const multer = require('multer');
const {
  startSession,
  getSession,
  getSessionStatus,
  deleteSession,
} = require('../sessions/sessionManager');
const {
  generateWAMessageFromContent,
  normalizeMessageContent,
  isJidGroup,
  generateMessageIDV2,
} = require('@whiskeysockets/baileys');
const { markOutgoing } = require('../utils/outgoingSourceTracker');
const { getMessages } = require('../sessions/messageStore');

function getUserJid(socket) {
  return socket?.authState?.creds?.me?.id || socket?.user?.id;
}

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

function getMediaKey(mimetype) {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  return 'document';
}

// POST /session/start/:customerId
router.post('/session/start/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const result = await startSession(customerId);
    res.json(result);
  } catch (err) {
    console.error(`[start] Error for ${req.params.customerId}:`, err.message);

    if (err.code === 'SESSION_START_TIMEOUT') {
      return res.status(504).json({
        error: 'WhatsApp did not respond in time; no QR was produced',
        code: 'SESSION_START_TIMEOUT',
      });
    }

    res.status(500).json({ error: 'Failed to start session' });
  }
});

// GET /session/status/:customerId
router.get('/session/status/:customerId', (req, res) => {
  try {
    const { customerId } = req.params;
    const result = getSessionStatus(customerId);
    res.json(result);
  } catch (err) {
    console.error(`[status] Error for ${req.params.customerId}:`, err.message);
    res.status(500).json({ error: 'Failed to get session status' });
  }
});

// GET /session/messages/:customerId?contact=<digits>&limit=<n>&type=person|group
router.get('/session/messages/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { contact, limit, type } = req.query;

    if (!contact) {
      return res.status(400).json({ error: 'Missing "contact" query param' });
    }

    const digits = String(contact).replace(/\D/g, '');
    const jid = type === 'group' ? `${digits}@g.us` : `${digits}@s.whatsapp.net`;

    let cap = parseInt(limit, 10);
    if (!Number.isFinite(cap) || cap <= 0) cap = 20;
    if (cap > 100) cap = 100;

    const messages = await getMessages(customerId, jid, cap);

    res.json({
      ok: true,
      customerId,
      contact: digits,
      count: messages.length,
      messages,
    });
  } catch (err) {
    console.error(`[messages] Error for ${req.params.customerId}:`, err.message);
    res.status(500).json({ error: 'Failed to read messages' });
  }
});

// POST /session/send/:customerId
router.post('/session/send/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { to, message, source } = req.body;

    if (!to || !message) {
      return res.status(400).json({ error: 'Missing "to" or "message" in body' });
    }

    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    const session = getSession(customerId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (session.status !== 'connected') {
      return res.status(400).json({ error: `Session not connected (status: ${session.status})` });
    }

    const sendOptions = {};
    if (source) {
      const messageId = generateMessageIDV2(getUserJid(session.socket));
      markOutgoing(messageId, source);
      sendOptions.messageId = messageId;
    }

    await session.socket.sendMessage(jid, { text: message }, sendOptions);
    res.json({ status: 'sent' });
  } catch (err) {
    console.error(`[send] Error for ${req.params.customerId}:`, err.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// POST /session/send-file/:customerId
router.post('/session/send-file/:customerId', upload.single('file'), async (req, res) => {
  try {
    const { customerId } = req.params;
    const { chatId, fileName, caption, source } = req.body;

    if (!chatId || !req.file) {
      return res.status(400).json({ error: 'Missing "chatId" or "file" in form data' });
    }

    const jid = chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`;

    const session = getSession(customerId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (session.status !== 'connected') {
      return res.status(400).json({ error: `Session not connected (status: ${session.status})` });
    }

    const mediaKey = getMediaKey(req.file.mimetype);
    const messagePayload = {
      [mediaKey]: req.file.buffer,
      mimetype: req.file.mimetype,
      caption: caption || undefined,
    };
    if (mediaKey === 'document') {
      messagePayload.fileName = fileName || req.file.originalname;
    }

    const sendOptions = {};
    if (source) {
      const messageId = generateMessageIDV2(getUserJid(session.socket));
      markOutgoing(messageId, source);
      sendOptions.messageId = messageId;
    }

    await session.socket.sendMessage(jid, messagePayload, sendOptions);

    res.json({ status: 'sent' });
  } catch (err) {
    console.error(`[send-file] Error for ${req.params.customerId}:`, err.message);
    res.status(500).json({ error: 'Failed to send file' });
  }
});

// POST /session/send-buttons/:customerId
router.post('/session/send-buttons/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { to, body, buttons, header, footer, source } = req.body;

    if (!to || !body || !buttons || !Array.isArray(buttons) || buttons.length === 0) {
      return res.status(400).json({ error: 'Missing "to", "body", or "buttons" in body' });
    }

    if (buttons.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 buttons allowed' });
    }

    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    const session = getSession(customerId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (session.status !== 'connected') {
      return res.status(400).json({ error: `Session not connected (status: ${session.status})` });
    }

    // Build native flow buttons
    const nativeButtons = buttons.map((btn) => ({
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({
        display_text: btn.buttonText,
        id: btn.buttonId,
      }),
    }));

    const content = {
      interactiveMessage: {
        nativeFlowMessage: { buttons: nativeButtons },
        body: { text: body },
        footer: footer ? { text: footer } : undefined,
        header: header ? { title: header } : undefined,
      },
    };

    const sock = session.socket;
    const userJid = sock.authState?.creds?.me?.id || sock.user?.id;
    const fullMsg = generateWAMessageFromContent(jid, content, {
      userJid,
      messageId: generateMessageIDV2(userJid),
    });

    const normalizedContent = normalizeMessageContent(fullMsg.message);
    const additionalNodes = [
      {
        tag: 'biz',
        attrs: {},
        content: [{
          tag: 'interactive',
          attrs: { type: 'native_flow', v: '1' },
          content: [{
            tag: 'native_flow',
            attrs: { v: '9', name: 'mixed' },
          }],
        }],
      },
    ];
    if (!isJidGroup(jid)) {
      additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
    }

    if (source) {
      markOutgoing(fullMsg.key.id, source);
    }

    await sock.relayMessage(jid, fullMsg.message, {
      messageId: fullMsg.key.id,
      additionalNodes,
    });
    res.json({ status: 'sent' });
  } catch (err) {
    console.error(`[send-buttons] Error for ${req.params.customerId}:`, err.message);
    res.status(500).json({ error: 'Failed to send buttons message' });
  }
});

// POST /session/send-list/:customerId
router.post('/session/send-list/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { to, body, buttonText, sections, header, footer, source } = req.body;

    if (!to || !body || !buttonText || !sections || !Array.isArray(sections) || sections.length === 0) {
      return res.status(400).json({ error: 'Missing "to", "body", "buttonText", or "sections" in body' });
    }

    if (sections.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 sections allowed' });
    }

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      if (!section || !section.title || !Array.isArray(section.rows) || section.rows.length === 0) {
        return res.status(400).json({ error: `Section ${i} missing "title" or non-empty "rows"` });
      }
      if (section.rows.length > 10) {
        return res.status(400).json({ error: `Section ${i} exceeds maximum 10 rows` });
      }
      for (let j = 0; j < section.rows.length; j++) {
        const row = section.rows[j];
        if (!row || !row.rowId || !row.title) {
          return res.status(400).json({ error: `Section ${i} row ${j} missing "rowId" or "title"` });
        }
      }
    }

    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    const session = getSession(customerId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (session.status !== 'connected') {
      return res.status(400).json({ error: `Session not connected (status: ${session.status})` });
    }

    const wireSections = sections.map((section) => ({
      title: section.title,
      rows: section.rows.map((row) => ({
        header: '',
        title: row.title,
        description: row.description || '',
        id: row.rowId,
      })),
    }));

    const nativeButtons = [
      {
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: buttonText,
          sections: wireSections,
        }),
      },
    ];

    const content = {
      interactiveMessage: {
        nativeFlowMessage: { buttons: nativeButtons },
        body: { text: body },
        footer: footer ? { text: footer } : undefined,
        header: header ? { title: header } : undefined,
      },
    };

    const sock = session.socket;
    const userJid = sock.authState?.creds?.me?.id || sock.user?.id;
    const fullMsg = generateWAMessageFromContent(jid, content, {
      userJid,
      messageId: generateMessageIDV2(userJid),
    });

    normalizeMessageContent(fullMsg.message);
    const additionalNodes = [
      {
        tag: 'biz',
        attrs: {},
        content: [{
          tag: 'interactive',
          attrs: { type: 'native_flow', v: '1' },
          content: [{
            tag: 'native_flow',
            attrs: { v: '9', name: 'mixed' },
          }],
        }],
      },
    ];
    if (!isJidGroup(jid)) {
      additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
    }

    if (source) {
      markOutgoing(fullMsg.key.id, source);
    }

    await sock.relayMessage(jid, fullMsg.message, {
      messageId: fullMsg.key.id,
      additionalNodes,
    });
    res.json({ status: 'sent' });
  } catch (err) {
    console.error(`[send-list] Error for ${req.params.customerId}:`, err.message);
    res.status(500).json({ error: 'Failed to send list message' });
  }
});

// DELETE /session/:customerId
router.delete('/session/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const result = await deleteSession(customerId);

    if (result.status === 'not_found') {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(`[delete] Error for ${req.params.customerId}:`, err.message);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

module.exports = router;
