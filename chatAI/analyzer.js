const http = require('http');
const WebSocket = require('ws');
const wrtc = require('wrtc');
const { Pool } = require('pg');
const jpeg = require('jpeg-js');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_POLL_MS = Math.max(1000, parseInt(process.env.TELEGRAM_POLL_MS || '1500', 10));
const TELEGRAM_CLEAR_WEBHOOK = (process.env.TELEGRAM_CLEAR_WEBHOOK || 'true').toLowerCase() === 'true';
const TELEGRAM_DEBUG = (process.env.TELEGRAM_DEBUG || '').toLowerCase() === 'true';

const PORT = parseInt(process.env.PORT || '8080', 10);
const WEBRTC_BASE_URL = process.env.WEBRTC_URL || 'https://deafly-kinaesthetic-sadye.ngrok-free.dev';
const ANALYZE_FPS = Math.max(0.1, parseFloat(process.env.ANALYZE_FPS || '1'));
const MODEL_ID = process.env.MODEL_ID || 'onnx-community/Florence-2-base';
const MODEL_DTYPE = process.env.MODEL_DTYPE || 'fp32';
const CAPTION_TASK = process.env.CAPTION_TASK || '<MORE_DETAILED_CAPTION>';
const MAX_NEW_TOKENS = parseInt(process.env.MAX_NEW_TOKENS || '96', 10);
const JPEG_QUALITY = Math.min(95, Math.max(40, parseInt(process.env.JPEG_QUALITY || '70', 10)));
const MIN_EVENT_SECONDS = Math.max(0, parseFloat(process.env.MIN_EVENT_SECONDS || '5'));

const CHAT_HISTORY_LIMIT = Math.max(2, parseInt(process.env.CHAT_HISTORY_LIMIT || '8', 10));
const CHAT_EVENT_LIMIT = Math.max(1, parseInt(process.env.CHAT_EVENT_LIMIT || '20', 10));
const CHAT_EVENT_WINDOW_HOURS = Math.max(1, parseFloat(process.env.CHAT_EVENT_WINDOW_HOURS || '24'));

const LLM_BACKEND = (process.env.LLM_BACKEND || 'disabled').toLowerCase();
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_GROQ_MODEL = 'llama-3.1-8b-instant';
const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL
  || (LLM_BACKEND === 'gemini' ? DEFAULT_GEMINI_MODEL : (GROQ_API_KEY ? DEFAULT_GROQ_MODEL : DEFAULT_OPENAI_MODEL));
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || GROQ_API_KEY || '';
const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';
const DEFAULT_GROQ_BASE = 'https://api.groq.com/openai/v1';
const LLM_BASE_URL = process.env.LLM_BASE_URL
  || process.env.OPENAI_BASE_URL
  || process.env.GROQ_BASE_URL
  || (GROQ_API_KEY ? DEFAULT_GROQ_BASE : DEFAULT_OPENAI_BASE);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.LLM_API_KEY || '';
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const LLM_TEMPERATURE = Math.min(1, Math.max(0, parseFloat(process.env.LLM_TEMPERATURE || '0.2')));
const LLM_MAX_TOKENS = Math.max(64, parseInt(process.env.LLM_MAX_TOKENS || '400', 10));
const LLM_TIMEOUT_MS = Math.max(5000, parseInt(process.env.LLM_TIMEOUT_MS || '30000', 10));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

let model;
let processor;
let RawImage;
let modelReady = false;
let updateOffset = 0;
let pollInFlight = false;
let lastCaptionNorm = '';
let lastEventAt = 0;

const knownChatIds = new Set();
const chatHistory = new Map();

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'so', 'to', 'of', 'in', 'on', 'at',
  'for', 'with', 'without', 'about', 'from', 'into', 'over', 'after', 'before', 'is',
  'are', 'was', 'were', 'be', 'been', 'being', 'it', 'this', 'that', 'these', 'those',
  'what', 'when', 'where', 'who', 'why', 'how', 'did', 'does', 'do', 'has', 'have', 'had',
  'any', 'some', 'someone', 'something', 'anything', 'there', 'please', 'show', 'tell',
  'me', 'my', 'we', 'us', 'you', 'your', 'i'
]);

const SYSTEM_PROMPT = [
  'You are ChatCam, a camera event manager.',
  'Answer questions using ONLY the event context provided.',
  'If the context is empty or insufficient, say so and ask a clarifying question.',
  'If asked whether something happened, answer yes or no based on events and cite event ids and timestamps.',
  'If asked for a summary, provide a concise summary and highlight notable events.',
  'If asked to explain an event, explain based on the caption and context only.',
  'Do not invent events or details that are not in the context.'
].join(' ');

function normalizeCaption(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s.,!?]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildWebSocketUrl(baseUrl) {
  const url = new URL(baseUrl);
  const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.protocol = wsProtocol;
  url.pathname = '/ws';
  url.search = '';
  return url.toString();
}

function addChatHistory(chatId, role, content) {
  const key = String(chatId);
  const history = chatHistory.get(key) || [];
  history.push({ role, content });
  while (history.length > CHAT_HISTORY_LIMIT * 2) {
    history.shift();
  }
  chatHistory.set(key, history);
}

function getChatHistory(chatId) {
  const history = chatHistory.get(String(chatId)) || [];
  return history.slice(-CHAT_HISTORY_LIMIT * 2);
}

function parseTimeWindowHours(text) {
  const match = text.toLowerCase().match(/(?:last|past)\s+(\d+(?:\.\d+)?)\s*(minute|minutes|hour|hours|day|days)/);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2];
  if (unit.startsWith('minute')) return value / 60;
  if (unit.startsWith('hour')) return value;
  if (unit.startsWith('day')) return value * 24;
  return null;
}

function extractEventId(text) {
  const match = text.match(/(?:event\s*#?|#)(\d{1,9})/i);
  if (!match) return null;
  const id = parseInt(match[1], 10);
  return Number.isFinite(id) ? id : null;
}

function isSummaryRequest(text) {
  return /\bsummary\b|\bsummarize\b|\brecap\b|\boverview\b|what\s+happened/i.test(text);
}

function extractSearchTokens(text) {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const tokens = cleaned.split(/\s+/).filter((token) => token && !STOPWORDS.has(token));
  return tokens.slice(0, 8);
}

function truncateTelegramText(text) {
  if (text.length <= 3900) return text;
  return `${text.slice(0, 3900)}...`;
}

function buildEventContext(events, windowHours, note) {
  const lines = [];
  lines.push(`Event context window: last ${windowHours} hour(s).`);
  if (note) lines.push(`Note: ${note}`);
  if (!events.length) {
    lines.push('No events found in this window.');
    return lines.join('\n');
  }
  lines.push('Events (newest first):');
  for (const event of events) {
    const ts = new Date(event.created_at).toISOString();
    lines.push(`- [id=${event.id} | ${ts}] ${event.caption}`);
  }
  return lines.join('\n');
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      caption TEXT NOT NULL,
      image BYTEA NOT NULL
    );
  `);
}

async function getRecentEvents(windowHours, limit) {
  const res = await pool.query(
    'SELECT id, created_at, caption FROM events WHERE created_at >= NOW() - ($1 * INTERVAL \'1 hour\') ORDER BY created_at DESC LIMIT $2',
    [windowHours, limit]
  );
  return res.rows;
}

async function searchEvents(tokens, windowHours, limit) {
  if (!tokens.length) return getRecentEvents(windowHours, limit);
  const params = [windowHours];
  const conditions = [];
  for (const token of tokens) {
    params.push(`%${token}%`);
    conditions.push(`caption ILIKE $${params.length}`);
  }
  params.push(limit);
  const where = conditions.length ? `AND (${conditions.join(' OR ')})` : '';
  const sql = `SELECT id, created_at, caption FROM events WHERE created_at >= NOW() - ($1 * INTERVAL '1 hour') ${where} ORDER BY created_at DESC LIMIT $${params.length}`;
  const res = await pool.query(sql, params);
  return res.rows;
}

async function getEventById(id) {
  const res = await pool.query('SELECT id, created_at, caption FROM events WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function clearTelegramWebhook() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CLEAR_WEBHOOK) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn('Telegram deleteWebhook failed:', res.status);
      return;
    }
    if (TELEGRAM_DEBUG) {
      console.log('Telegram webhook cleared.');
    }
  } catch (err) {
    console.warn('Telegram deleteWebhook error:', err.message || err);
  }
}

function isLlmConfigured() {
  if (LLM_BACKEND === 'disabled') return false;
  if (LLM_BACKEND === 'openai_compat') {
    return Boolean(LLM_API_KEY && LLM_BASE_URL);
  }
  if (LLM_BACKEND === 'gemini') {
    return Boolean(GEMINI_API_KEY);
  }
  return false;
}

function getLlmConfigMessage() {
  if (LLM_BACKEND === 'gemini') {
    return [
      'LLM is not configured. Set these environment variables on Render:',
      '- LLM_BACKEND=gemini',
      '- GEMINI_API_KEY=your_api_key',
      `- LLM_MODEL=${DEFAULT_GEMINI_MODEL} (or another Gemini model)`
    ].join('\n');
  }

  return [
    'LLM is not configured. Set these environment variables on Render:',
    '- LLM_BACKEND=openai_compat',
    '- LLM_API_KEY=your_api_key (or GROQ_API_KEY)',
    `- LLM_MODEL=${DEFAULT_OPENAI_MODEL} (or ${DEFAULT_GROQ_MODEL} on Groq)`,
    `- LLM_BASE_URL=${DEFAULT_OPENAI_BASE} (or ${DEFAULT_GROQ_BASE} for Groq)`
  ].join('\n');
}

async function callOpenAiCompat(messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const url = `${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_API_KEY}`
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: LLM_TEMPERATURE,
        max_tokens: LLM_MAX_TOKENS,
        messages
      }),
      signal: controller.signal
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const errorMessage = data && data.error ? JSON.stringify(data.error) : res.statusText;
      throw new Error(`LLM request failed: ${res.status} ${errorMessage}`);
    }
    const choice = data && data.choices ? data.choices[0] : null;
    const message = choice && choice.message ? choice.message : null;
    let content = '';
    if (message && typeof message.content === 'string') {
      content = message.content;
    } else if (message && Array.isArray(message.content)) {
      content = message.content.map((part) => (part && part.text ? part.text : '')).join('');
    } else if (choice && typeof choice.text === 'string') {
      content = choice.text;
    }
    return String(content || '').trim();
  } finally {
    clearTimeout(timeout);
  }
}

function buildGeminiSystemInstruction(messages) {
  const systemText = messages
    .filter((msg) => msg && msg.role === 'system' && msg.content)
    .map((msg) => String(msg.content))
    .join('\n\n')
    .trim();
  if (!systemText) return null;
  return { parts: [{ text: systemText }] };
}

function buildGeminiContents(messages) {
  const contents = [];
  for (const msg of messages) {
    if (!msg || !msg.content || msg.role === 'system') continue;
    const role = msg.role === 'assistant' ? 'model' : 'user';
    contents.push({ role, parts: [{ text: String(msg.content) }] });
  }
  return contents;
}

async function callGemini(messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const base = GEMINI_BASE_URL.replace(/\/$/, '');
    const url = `${base}/models/${encodeURIComponent(LLM_MODEL)}:generateContent`;
    const systemInstruction = buildGeminiSystemInstruction(messages);
    const contents = buildGeminiContents(messages);
    const body = {
      contents,
      generationConfig: {
        temperature: LLM_TEMPERATURE,
        maxOutputTokens: LLM_MAX_TOKENS
      }
    };
    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const errorMessage = data && data.error ? JSON.stringify(data.error) : res.statusText;
      throw new Error(`Gemini request failed: ${res.status} ${errorMessage}`);
    }
    const candidate = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
    const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
      ? candidate.content.parts
      : [];
    const text = parts.map((part) => part && part.text ? part.text : '').join('').trim();
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function callLlm(messages) {
  if (LLM_BACKEND === 'openai_compat') {
    return callOpenAiCompat(messages);
  }
  if (LLM_BACKEND === 'gemini') {
    return callGemini(messages);
  }
  throw new Error(`Unsupported LLM_BACKEND: ${LLM_BACKEND}`);
}

async function handleEvent(caption, jpegBuffer) {
  await pool.query('INSERT INTO events (caption, image) VALUES ($1, $2)', [caption, jpegBuffer]);
  await sendTelegramMessage(caption);
}

async function sendTelegramMessage(text, options = {}) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const payloadText = truncateTelegramText(text);
  const targetIds = [];
  if (options.chatId) {
    targetIds.push(String(options.chatId));
  } else if (TELEGRAM_CHAT_ID) {
    targetIds.push(String(TELEGRAM_CHAT_ID));
  } else {
    targetIds.push(...Array.from(knownChatIds));
  }
  if (!targetIds.length) {
    console.warn('No Telegram chat id available. Send a message to the bot first.');
    return;
  }

  for (const chatId of targetIds) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = {
      chat_id: chatId,
      text: payloadText,
      disable_web_page_preview: true
    };
    if (options.replyToMessageId) {
      body.reply_to_message_id = options.replyToMessageId;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const respBody = await res.text().catch(() => '');
      console.warn('Telegram sendMessage failed:', res.status, respBody);
    }
  }
}

async function answerChatQuestion(chatId, text) {
  if (!isLlmConfigured()) {
    return getLlmConfigMessage();
  }

  const eventId = extractEventId(text);
  const windowOverride = parseTimeWindowHours(text);
  const windowHours = windowOverride || CHAT_EVENT_WINDOW_HOURS;

  let events = [];
  let note = '';

  if (eventId) {
    const event = await getEventById(eventId);
    if (event) {
      events = [event];
    } else {
      note = `No event found for id ${eventId}.`;
    }
  } else if (isSummaryRequest(text)) {
    events = await getRecentEvents(windowHours, CHAT_EVENT_LIMIT);
  } else {
    const tokens = extractSearchTokens(text);
    events = await searchEvents(tokens, windowHours, CHAT_EVENT_LIMIT);
    if (!events.length) {
      note = 'No direct keyword matches. Using most recent events.';
      events = await getRecentEvents(windowHours, CHAT_EVENT_LIMIT);
    }
  }

  const context = buildEventContext(events, windowHours, note);
  const history = getChatHistory(chatId);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: context },
    ...history,
    { role: 'user', content: text }
  ];

  const reply = await callLlm(messages);
  addChatHistory(chatId, 'user', text);
  addChatHistory(chatId, 'assistant', reply);
  return reply || 'I could not generate a response.';
}

async function handleTelegramText(chatId, text, messageId) {
  const trimmed = (text || '').trim();
  if (!trimmed) return;
  knownChatIds.add(String(chatId));

  if (trimmed === '/start' || trimmed === '/help') {
    const help = [
      'ChatCam is online. You can ask about camera events.',
      'Examples:',
      '- "summary of the last 2 hours"',
      '- "did someone enter the garage today?"',
      '- "explain event #42"'
    ].join('\n');
    await sendTelegramMessage(help, { chatId, replyToMessageId: messageId });
    return;
  }

  const reply = await answerChatQuestion(chatId, trimmed);
  await sendTelegramMessage(reply, { chatId, replyToMessageId: messageId });
}

async function pollTelegramUpdates() {
  if (!TELEGRAM_BOT_TOKEN || pollInFlight) return;
  pollInFlight = true;
  try {
    const params = new URLSearchParams({
      offset: String(updateOffset),
      timeout: '0',
      allowed_updates: JSON.stringify(['message', 'edited_message', 'channel_post', 'edited_channel_post'])
    });
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn('Telegram getUpdates failed:', res.status);
      return;
    }
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result)) {
      console.warn('Telegram getUpdates error:', data);
      return;
    }
    if (TELEGRAM_DEBUG && data.result.length) {
      console.log(`Telegram updates received: ${data.result.length}`);
    }

    for (const update of data.result) {
      updateOffset = Math.max(updateOffset, (update.update_id || 0) + 1);
      const msg = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
      if (!msg || !msg.chat) continue;
      const chatId = msg.chat.id;
      if (typeof msg.text === 'string') {
        await handleTelegramText(chatId, msg.text, msg.message_id);
      }
    }
  } catch (err) {
    console.warn('Telegram polling error:', err.message || err);
  } finally {
    pollInFlight = false;
  }
}

function startTelegramPolling() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('TELEGRAM_BOT_TOKEN is not set. Telegram bot is disabled.');
    return;
  }
  clearTelegramWebhook().catch((err) => console.warn('Telegram deleteWebhook failed:', err));
  setInterval(() => {
    pollTelegramUpdates().catch((err) => console.warn('Telegram polling failed:', err));
  }, TELEGRAM_POLL_MS);
  pollTelegramUpdates().catch((err) => console.warn('Telegram polling failed:', err));
}

function clampByte(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

function i420ToRgb(i420, width, height) {
  const frameSize = width * height;
  const chromaSize = frameSize >> 2;
  const yPlane = i420.subarray(0, frameSize);
  const uPlane = i420.subarray(frameSize, frameSize + chromaSize);
  const vPlane = i420.subarray(frameSize + chromaSize, frameSize + chromaSize + chromaSize);

  const rgb = new Uint8ClampedArray(width * height * 3);
  let outIndex = 0;

  for (let y = 0; y < height; y++) {
    const yRow = y * width;
    const uvRow = (y >> 1) * (width >> 1);
    for (let x = 0; x < width; x++) {
      const yVal = yPlane[yRow + x];
      const uvIndex = uvRow + (x >> 1);
      const uVal = uPlane[uvIndex];
      const vVal = vPlane[uvIndex];

      const c = yVal - 16;
      const d = uVal - 128;
      const e = vVal - 128;

      const r = clampByte((298 * c + 409 * e + 128) >> 8);
      const g = clampByte((298 * c - 100 * d - 208 * e + 128) >> 8);
      const b = clampByte((298 * c + 516 * d + 128) >> 8);

      rgb[outIndex++] = r;
      rgb[outIndex++] = g;
      rgb[outIndex++] = b;
    }
  }

  return rgb;
}

function rgbToJpeg(rgb, width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i];
    rgba[j + 1] = rgb[i + 1];
    rgba[j + 2] = rgb[i + 2];
    rgba[j + 3] = 0xff;
  }
  const rawImageData = { data: rgba, width, height };
  const jpegData = jpeg.encode(rawImageData, JPEG_QUALITY);
  return jpegData.data;
}

async function initModel() {
  console.log('Loading vision model...');
  const transformers = await import('@huggingface/transformers');
  const { Florence2ForConditionalGeneration, AutoProcessor: HFProcessor, RawImage: HFImage } = transformers;
  RawImage = HFImage;
  processor = await HFProcessor.from_pretrained(MODEL_ID);
  model = await Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, { dtype: MODEL_DTYPE });
  modelReady = true;
  console.log('Vision model ready.');
}

async function generateCaption(image) {
  const prompts = processor.construct_prompts(CAPTION_TASK);
  const inputs = await processor(image, prompts);
  const generatedIds = await model.generate({
    ...inputs,
    max_new_tokens: MAX_NEW_TOKENS
  });
  const generatedText = processor.batch_decode(generatedIds, { skip_special_tokens: false })[0];
  const result = processor.post_process_generation(generatedText, CAPTION_TASK, image.size);
  if (typeof result === 'string') return result.trim();
  if (result && typeof result === 'object' && result[CAPTION_TASK]) {
    const value = result[CAPTION_TASK];
    if (Array.isArray(value)) return value.join(' ').trim();
    return String(value).trim();
  }
  return generatedText.trim();
}

async function startAnalyzer() {
  await initDb();
  startTelegramPolling();
  initModel().catch((err) => {
    console.error('Vision model failed to load:', err);
  });

  const wsUrl = buildWebSocketUrl(WEBRTC_BASE_URL);
  console.log('Connecting to WebRTC signaling:', wsUrl);

  let lastFrameAt = 0;
  let processing = false;

  const connect = () => {
    const ws = new WebSocket(wsUrl);
    const pc = new wrtc.RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    pc.addTransceiver('video', { direction: 'recvonly' });

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        try { ws.close(); } catch {}
      }
    };

    const pendingCandidates = [];

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const payload = JSON.stringify({ type: 'candidate', candidate: event.candidate });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      } else {
        pendingCandidates.push(payload);
      }
    };

    pc.ontrack = (event) => {
      const track = event.track;
      const sink = new wrtc.nonstandard.RTCVideoSink(track);

      sink.onframe = async ({ frame }) => {
        const now = Date.now();
        const minInterval = 1000 / ANALYZE_FPS;
        if (processing || now - lastFrameAt < minInterval) return;
        if (!modelReady) return;
        processing = true;
        lastFrameAt = now;

        try {
          const { width, height, data } = frame;
          if (width % 2 !== 0 || height % 2 !== 0) {
            console.warn(`Skipping frame with odd dimensions ${width}x${height}`);
            return;
          }

          const rgb = i420ToRgb(data, width, height);
          const image = new RawImage(rgb, width, height, 3);
          const caption = await generateCaption(image);
          const normalized = normalizeCaption(caption);
          if (!normalized) return;

          const nowSec = Date.now() / 1000;
          const isNew = normalized !== lastCaptionNorm;
          const isAfterMinGap = (nowSec - lastEventAt) >= MIN_EVENT_SECONDS;

          if (isNew && isAfterMinGap) {
            lastCaptionNorm = normalized;
            lastEventAt = nowSec;
            const jpegBuffer = rgbToJpeg(rgb, width, height);
            await handleEvent(caption, jpegBuffer);
            console.log('Event stored:', caption);
          }
        } catch (err) {
          console.warn('Frame processing error:', err);
        } finally {
          processing = false;
        }
      };

      track.onended = () => sink.stop();
    };

    ws.on('message', async (message) => {
      let data;
      try {
        data = JSON.parse(message.toString());
      } catch {
        return;
      }

      if (data.type === 'answer') {
        await pc.setRemoteDescription(new wrtc.RTCSessionDescription({
          type: 'answer',
          sdp: data.sdp
        }));
      } else if (data.type === 'candidate' && data.candidate) {
        try {
          await pc.addIceCandidate(new wrtc.RTCIceCandidate(data.candidate));
        } catch (err) {
          console.warn('ICE candidate error:', err.message);
        }
      }
    });

    ws.on('open', async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp }));
      while (pendingCandidates.length > 0) {
        ws.send(pendingCandidates.shift());
      }
    });

    const cleanup = () => {
      try { ws.close(); } catch {}
      try { pc.close(); } catch {}
    };

    ws.on('close', () => {
      cleanup();
      setTimeout(connect, 2000);
    });

    ws.on('error', (err) => {
      console.warn('WebSocket error:', err.message);
      cleanup();
    });
  };

  connect();
}

http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end('not found');
}).listen(PORT, () => {
  console.log(`Analyzer health server on :${PORT}`);
});

startAnalyzer().catch((err) => {
  console.error('Analyzer failed to start:', err);
  process.exit(1);
});
