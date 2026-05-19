# WClixAPI - Custom WhatsApp Gateway API Reference

> This replaces Green API. Use this reference when building or updating Supabase edge functions.

**Base URL:** `https://wa.clixwapp.online`

**Auth:** All `/api/*` endpoints require header: `x-api-key: <your-api-key>`

---

## Endpoints

### 1. Start Session (Get QR Code)

```
POST /api/session/start/:customerId
```

**Response (first time - needs QR scan):**
```json
{
  "status": "qr_generated",
  "qr": "data:image/png;base64,..."
}
```

**Response (already connected):**
```json
{
  "status": "already_connected",
  "phoneNumber": "639516185785"
}
```

Possible response statuses from this endpoint: `qr_generated`, `connected`, `already_connected`, `disconnected`.

---

### 2. Check Session Status

```
GET /api/session/status/:customerId
```

**Response (connected):**
```json
{
  "status": "connected",
  "qr": null,
  "phoneNumber": "639516185785"
}
```

**Response (waiting for QR scan):**
```json
{
  "status": "waiting_for_qr",
  "qr": "data:image/png;base64,..."
}
```

Possible statuses: `connected`, `connecting`, `waiting_for_qr`, `disconnected`, `logged_out`, `not_found`.

> `phoneNumber` is only present when `status === "connected"`. It is the phone number of the WhatsApp account paired to this session, in plain digits (no `+`, no `@s.whatsapp.net`).

---

### 3. Send Text Message

```
POST /api/session/send/:customerId
Content-Type: application/json
```

**Body:**
```json
{
  "to": "63XXXXXXXXXX",
  "message": "Hello from our SaaS!",
  "source": "bot-reply"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string | Yes | Phone number (no `@s.whatsapp.net` needed — gateway adds it) |
| `message` | string | Yes | Message text |
| `source` | string | No | Free-form tag echoed back on the matching outgoing webhook payload as `source`. Useful for attributing the outgoing message to a specific bot, flow, or human operator. |

**Response:**
```json
{
  "status": "sent"
}
```

> When `source` is provided, the gateway generates a deterministic message ID, sends with it, and later when the outgoing message is echoed back via webhook, the same `source` value is attached. If `source` is omitted, the outgoing webhook payload simply has no `source` field.

---

### 4. Send Image / Video / Document

```
POST /api/session/send-file/:customerId
Content-Type: multipart/form-data
```

**Form fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chatId` | string | Yes | Phone number (e.g. `63XXXXXXXXXX`) |
| `file` | file | Yes | The image / video / document to send (max 64 MB) |
| `fileName` | string | No | Custom file name (used only for documents) |
| `caption` | string | No | Caption text (images and videos) |
| `source` | string | No | Free-form tag echoed back on the matching outgoing webhook payload |

The gateway picks the WhatsApp media type automatically from the uploaded file's MIME type:
- `image/*` → image
- `video/*` → video
- everything else → document

**Response:**
```json
{
  "status": "sent"
}
```

---

### 5. Send Interactive Buttons

```
POST /api/session/send-buttons/:customerId
Content-Type: application/json
```

**Body:**
```json
{
  "to": "63XXXXXXXXXX",
  "body": "Please choose an option:",
  "header": "Welcome",
  "footer": "Tap a button to reply",
  "buttons": [
    { "buttonId": "1", "buttonText": "Option A" },
    { "buttonId": "2", "buttonText": "Option B" },
    { "buttonId": "3", "buttonText": "Option C" }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string | Yes | Phone number |
| `body` | string | Yes | Message text |
| `buttons` | array | Yes | 1-10 button objects |
| `header` | string | No | Title text above body |
| `footer` | string | No | Footer text below buttons |
| `source` | string | No | Free-form tag echoed back on the matching outgoing webhook payload |

Each button: `{ "buttonId": "unique-id", "buttonText": "Label (max 25 chars)" }`

**Response:**
```json
{
  "status": "sent"
}
```

> Note: Maximum 10 buttons per message. Uses native flow format via `relayMessage`.

---

### 6. Delete/Disconnect Session

```
DELETE /api/session/:customerId
```

**Response:**
```json
{
  "success": true
}
```

---

### 7. Health Check (no auth needed)

```
GET /health
```

**Response:**
```json
{
  "status": "ok"
}
```

---

## Message Webhook

The gateway forwards **both incoming and outgoing** messages to `MAIN_SAAS_WEBHOOK_URL` via POST. One retry is attempted on failure (2-second delay).

### Private text message
```json
{
  "customerId": "customer1",
  "type": "incoming",
  "chatType": "private",
  "from": "639516185785",
  "pushName": "John Doe",
  "message": "Hi there!",
  "messageType": "text",
  "timestamp": 1709812345
}
```

### Private image message
```json
{
  "customerId": "customer1",
  "type": "incoming",
  "chatType": "private",
  "from": "639516185785",
  "pushName": "John Doe",
  "message": "check this out",
  "messageType": "image",
  "timestamp": 1709812345,
  "image": {
    "base64": "/9j/4AAQSkZJRg...",
    "mimetype": "image/jpeg",
    "caption": "check this out"
  }
}
```

### Private video message
```json
{
  "customerId": "customer1",
  "type": "incoming",
  "chatType": "private",
  "from": "639516185785",
  "pushName": "John Doe",
  "message": "look at this clip",
  "messageType": "video",
  "timestamp": 1709812345,
  "media": {
    "base64": "AAAAIGZ0eXBpc29t...",
    "mimetype": "video/mp4",
    "caption": "look at this clip",
    "fileName": null
  }
}
```

### Private document message
```json
{
  "customerId": "customer1",
  "type": "incoming",
  "chatType": "private",
  "from": "639516185785",
  "pushName": "John Doe",
  "message": "",
  "messageType": "document",
  "timestamp": 1709812345,
  "media": {
    "base64": "JVBERi0xLjQKJ...",
    "mimetype": "application/pdf",
    "caption": null,
    "fileName": "invoice.pdf"
  }
}
```

### Group message
```json
{
  "customerId": "customer1",
  "type": "incoming",
  "chatType": "group",
  "from": "120363044555888777",
  "participant": "639516185785",
  "pushName": "John Doe",
  "message": "hello everyone",
  "messageType": "text",
  "timestamp": 1709812345
}
```

### Outgoing message (with `source`)
```json
{
  "customerId": "customer1",
  "type": "outgoing",
  "chatType": "private",
  "from": "639516185785",
  "pushName": null,
  "message": "Thanks for reaching out!",
  "messageType": "text",
  "timestamp": 1709812350,
  "source": "bot-reply"
}
```

`source` is only present on outgoing payloads, and only when the original send-API call provided a `source` value.

### Incoming private message with `hasChatHistory` (opt-in customers only)
```json
{
  "customerId": "260222c1-9b83-4206-bb90-7445907fb582",
  "type": "incoming",
  "chatType": "private",
  "from": "639516185785",
  "pushName": "John Doe",
  "message": "hi again",
  "messageType": "text",
  "timestamp": 1709812345,
  "hasChatHistory": true
}
```

### Media download failure
If the gateway fails to download an inbound image, video, or document, it still forwards the payload but with the media object set to `null` and an explicit error flag. Treat these as "the message arrived but the media wasn't retrievable."

```json
{
  "customerId": "customer1",
  "type": "incoming",
  "chatType": "private",
  "from": "639516185785",
  "pushName": "John Doe",
  "message": "",
  "messageType": "video",
  "timestamp": 1709812345,
  "media": null,
  "mediaError": "Failed to download video"
}
```
Same shape for images: `"image": null, "imageError": "Failed to download image"`.

### Webhook Fields

| Field | Type | Description |
|-------|------|-------------|
| `customerId` | string | The session/customer ID |
| `type` | string | `"incoming"` or `"outgoing"` |
| `chatType` | string | `"private"` or `"group"` |
| `from` | string \| null | Phone number (private) or group ID (group chat). `null` if the gateway could not resolve a JID. |
| `participant` | string\|undefined | Only in group messages — phone number of the sender, or `null` if unresolved |
| `pushName` | string\|null | Sender's WhatsApp display name (typically `null` on outgoing) |
| `message` | string | Message text, button display text, or media caption. Empty string when the inbound message has no text (e.g., a document upload with no caption). |
| `messageType` | string | `"text"`, `"image"`, `"video"`, or `"document"` |
| `timestamp` | number | Unix seconds (WhatsApp's `messageTimestamp`) |
| `image` | object\|null\|undefined | Present when `messageType` is `"image"`. `null` if the download failed. |
| `image.base64` | string | Base64-encoded image data (not saved to disk) |
| `image.mimetype` | string | e.g. `"image/jpeg"`, `"image/png"` |
| `image.caption` | string\|null | Image caption if provided |
| `imageError` | string\|undefined | Present and human-readable only when an image download failed |
| `media` | object\|null\|undefined | Present when `messageType` is `"video"` or `"document"`. `null` if the download failed. |
| `media.base64` | string | Base64-encoded video/document data (not saved to disk) |
| `media.mimetype` | string | e.g. `"video/mp4"`, `"application/pdf"`, `"application/octet-stream"` |
| `media.caption` | string\|null | Caption (videos may have one, documents typically don't) |
| `media.fileName` | string\|null | Original file name (documents only; `null` for videos) |
| `mediaError` | string\|undefined | Present and human-readable only when a video/document download failed |
| `source` | string\|undefined | Outgoing payloads only — the `source` value passed when sending. Absent if not provided. |
| `hasChatHistory` | boolean\|undefined | Opt-in feature: only emitted for incoming private messages, only for customers enabled in the gateway's cutoff config, and only after WhatsApp's history sync has completed. `true` if this sender has at least one message with the account dated before the customer's configured cutoff date; `false` otherwise. **Missing field = "unknown / not enabled / not yet synced"** — treat as fail-safe (don't act on it). |

> `from` is a clean phone number (e.g. `639516185785`), not a JID. The gateway resolves LIDs to phone numbers automatically.
> Button/interactive replies are forwarded as regular text messages with the button's display text in `message`.
> Images, videos, and documents are sent as base64 in the payload — nothing is stored on disk.
> Field absence carries meaning: missing `hasChatHistory` ≠ `false`, and missing `source` ≠ empty. Downstream consumers should treat missing fields as "no information available" rather than as a specific value.

---

## Migration from Green API

| Green API | WClixAPI (ours) |
|-----------|-----------------|
| `POST /waInstance.../sendMessage` | `POST /api/session/send/:customerId` |
| `POST /waInstance.../SendFileByUpload` | `POST /api/session/send-file/:customerId` |
| `POST /waInstance.../getQRCode` | `POST /api/session/start/:customerId` |
| `GET /waInstance.../getStateInstance` | `GET /api/session/status/:customerId` |
| `POST /waInstance.../logout` | `DELETE /api/session/:customerId` |
| Webhook: `stateInstanceChanged` | `GET /api/session/status/:customerId` (poll) |
| Webhook: `incomingMessageReceived` | Our gateway POSTs to `MAIN_SAAS_WEBHOOK_URL` (type: `incoming`) |
| Webhook: `outgoingMessageStatus` | Our gateway POSTs to `MAIN_SAAS_WEBHOOK_URL` (type: `outgoing`) |

### Key differences from Green API:
1. **No instance creation** — just call `/api/session/start/:customerId` with any customer ID
2. **Single API key** for all sessions (not per-instance like Green API)
3. **QR code returned as base64 PNG** directly in the response (no separate getQRCode call)
4. **Phone number format** — send `to` as plain number (`63XXXXXXXXXX`), no need for `@c.us` suffix
5. **Webhook payload** — includes `chatType`, `messageType` (`text` / `image` / `video` / `document`), `from` as a clean phone number, `image` for photos, `media` for video/document, optional `source` on outgoing, and optional `hasChatHistory` on opt-in incoming
6. **Clean phone numbers** — `from` is always a phone number (e.g. `639516185785`), not a JID or LID. Group messages include `participant` for the sender's number.

---

## Example: Supabase Edge Function - Send Message

```typescript
const res = await fetch(
  `https://wa.clixwapp.online/api/session/send/${customerId}`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": Deno.env.get("WA_GATEWAY_API_KEY")!,
    },
    body: JSON.stringify({ to: phoneNumber, message: text }),
  }
);
const data = await res.json();
```

## Example: Supabase Edge Function - Start Session

```typescript
const res = await fetch(
  `https://wa.clixwapp.online/api/session/start/${customerId}`,
  {
    method: "POST",
    headers: {
      "x-api-key": Deno.env.get("WA_GATEWAY_API_KEY")!,
    },
  }
);
const data = await res.json();
// data.qr = "data:image/png;base64,..." (display this in your frontend)
```

## Example: Supabase Edge Function - Receive Messages

```typescript
// This edge function URL goes in the gateway's MAIN_SAAS_WEBHOOK_URL env var
const payload = await req.json();
// payload = {
//   customerId, type, chatType, from, pushName, message,
//   messageType, timestamp,
//   participant?,                   // group only
//   image? | imageError?,            // messageType === "image"
//   media? | mediaError?,            // messageType === "video" | "document"
//   source?,                         // outgoing only
//   hasChatHistory?,                 // incoming + private + opt-in customer + after history sync
// }

if (payload.type === "incoming") {
  // payload.from = phone number (e.g. "639516185785")
  // payload.chatType = "private" or "group"
  // payload.participant = sender's phone (only in group chats)

  if (payload.messageType === "image" && payload.image) {
    // payload.image.base64 / mimetype / caption
  }

  if (payload.messageType === "video" && payload.media) {
    // payload.media.base64 / mimetype / caption / fileName (null for videos)
  }

  if (payload.messageType === "document" && payload.media) {
    // payload.media.base64 / mimetype / fileName / caption (often null)
  }

  if (payload.imageError || payload.mediaError) {
    // gateway forwarded the message but failed to download the media
  }

  if ("hasChatHistory" in payload) {
    // Only present for opt-in customers, only after the history sync has populated.
    // true = sender chatted with this account before the configured cutoff date.
    // Missing the field entirely = treat as "unknown" / fail-safe.
  }
}

if (payload.type === "outgoing" && payload.source) {
  // payload.source = the value passed when this outgoing message was sent via /api/session/send*
  // Use this to attribute the echo back to the bot/flow that triggered it.
}
```
