const axios = require('axios');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

const MEDIA_TYPES = {
  imageMessage: 'image',
  videoMessage: 'video',
  documentMessage: 'document',
};

function resolvePhoneNumber(msg) {
  const remoteJid = msg.key.remoteJid;

  // If it's already a phone number JID, just extract the number
  if (remoteJid?.endsWith('@s.whatsapp.net')) {
    return remoteJid.replace(/@.+$/, '');
  }

  // If it's a LID, check the alternative JID for the phone number
  if (remoteJid?.endsWith('@lid')) {
    const altJid = msg.key.remoteJidAlt;
    if (altJid && altJid.endsWith('@s.whatsapp.net')) {
      return altJid.replace(/@.+$/, '');
    }
  }

  // Fallback: return whatever we have, stripped of domain
  return remoteJid?.replace(/@.+$/, '') || null;
}

async function forwardToWebhook(payload) {
  const url = process.env.MAIN_SAAS_WEBHOOK_URL;
  if (!url) {
    console.error('[webhook] MAIN_SAAS_WEBHOOK_URL is not set, skipping');
    return;
  }

  try {
    await axios.post(url, payload, { timeout: 10000 });
  } catch (err) {
    console.error(`[webhook] First attempt failed: ${err.message}. Retrying...`);
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await axios.post(url, payload, { timeout: 10000 });
    } catch (retryErr) {
      console.error(`[webhook] Retry failed: ${retryErr.message}`);
    }
  }
}

async function handleMessage(customerId, { messages, type }, socket) {
  if (type !== 'notify') return;

  for (const msg of messages) {
    // DEBUG: log raw message structure for button/interactive replies
    if (msg.message && !msg.message.conversation && !msg.message.extendedTextMessage) {
      console.log(`[${customerId}] DEBUG raw message keys:`, Object.keys(msg.message));
      console.log(`[${customerId}] DEBUG raw message:`, JSON.stringify(msg.message, null, 2));
    }

    // DEBUG: log JID resolution
    console.log(`[${customerId}] DEBUG remoteJid: ${msg.key.remoteJid}, remoteJidAlt: ${msg.key.remoteJidAlt || 'none'}`);

    // Detect media type (image, video, or document)
    let mediaMsg = null;
    let messageType = 'text';
    for (const [key, type] of Object.entries(MEDIA_TYPES)) {
      if (msg.message?.[key]) {
        mediaMsg = msg.message[key];
        messageType = type;
        break;
      }
    }

    const text = msg.message?.conversation
      || msg.message?.extendedTextMessage?.text
      || msg.message?.buttonsResponseMessage?.selectedDisplayText
      || msg.message?.listResponseMessage?.title
      || msg.message?.templateButtonReplyMessage?.selectedDisplayText
      || msg.message?.nativeFlowResponseMessage?.params
      || msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.params
      || mediaMsg?.caption
      || null;

    // Skip messages with no text and no media
    if (!text && !mediaMsg) continue;

    const direction = msg.key.fromMe ? 'outgoing' : 'incoming';

    const isGroup = msg.key.remoteJid?.endsWith('@g.us') || false;

    const payload = {
      customerId,
      type: direction,
      chatType: isGroup ? 'group' : 'private',
      from: resolvePhoneNumber(msg),
      ...(isGroup && { participant: msg.key.participant?.replace(/@.+$/, '') || null }),
      pushName: msg.pushName || null,
      message: text || '',
      messageType,
      timestamp: msg.messageTimestamp,
    };

    // Download image and attach as base64 (no disk storage)
    if (messageType === 'image') {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
          logger: undefined,
          reuploadRequest: socket.updateMediaMessage,
        });
        payload.image = {
          base64: buffer.toString('base64'),
          mimetype: mediaMsg.mimetype || 'image/jpeg',
          caption: mediaMsg.caption || null,
        };
      } catch (err) {
        console.error(`[${customerId}] Failed to download image: ${err.message}`);
        payload.image = null;
        payload.imageError = 'Failed to download image';
      }
    }

    // Download video/document and attach as base64
    if (messageType === 'video' || messageType === 'document') {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
          logger: undefined,
          reuploadRequest: socket.updateMediaMessage,
        });
        payload.media = {
          base64: buffer.toString('base64'),
          mimetype: mediaMsg.mimetype || 'application/octet-stream',
          caption: mediaMsg.caption || null,
          fileName: mediaMsg.fileName || null,
        };
      } catch (err) {
        console.error(`[${customerId}] Failed to download ${messageType}: ${err.message}`);
        payload.media = null;
        payload.mediaError = `Failed to download ${messageType}`;
      }
    }

    console.log(`[${customerId}] ${direction} ${direction === 'incoming' ? 'from' : 'to'} ${payload.from} [${payload.messageType}]`);
    forwardToWebhook(payload);
  }
}

module.exports = { handleMessage };
