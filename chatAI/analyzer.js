const http = require('http');
const dns = require('dns');
const WebSocket = require('ws');
const wrtc = require('wrtc');
const { Pool } = require('pg');
const jpeg = require('jpeg-js');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_POLL_MS = Math.max(1000, parseInt(process.env.TELEGRAM_POLL_MS || '1500', 10));
const TELEGRAM_LONG_POLL_SECONDS = Math.max(0, parseInt(process.env.TELEGRAM_LONG_POLL_SECONDS || '25', 10));
const TELEGRAM_FETCH_TIMEOUT_MS = Math.max(5000, parseInt(process.env.TELEGRAM_FETCH_TIMEOUT_MS || '35000', 10));
const TELEGRAM_CLEAR_WEBHOOK = (process.env.TELEGRAM_CLEAR_WEBHOOK || 'true').toLowerCase() === 'true';
const TELEGRAM_DEBUG = (process.env.TELEGRAM_DEBUG || '').toLowerCase() === 'true';

const HEALTH_PORT = parseInt(process.env.ANALYZER_PORT || process.env.PORT || '8090', 10);
const WEBRTC_BASE_URL = process.env.WEBRTC_URL || 'http://localhost:8080';
const WEBRTC_RECONNECT_MIN_MS = Math.max(1000, parseInt(process.env.WEBRTC_RECONNECT_MIN_MS || '2000', 10));
const WEBRTC_RECONNECT_MAX_MS = Math.max(WEBRTC_RECONNECT_MIN_MS, parseInt(process.env.WEBRTC_RECONNECT_MAX_MS || '60000', 10));
const WEBRTC_SUSPEND_AFTER_MS = Math.max(0, parseInt(process.env.WEBRTC_SUSPEND_AFTER_MS || '300000', 10));
const WEBRTC_SUSPEND_CHECK_MS = Math.max(5000, parseInt(process.env.WEBRTC_SUSPEND_CHECK_MS || '30000', 10));
const WEBRTC_MODEL_ON_CONNECT = (process.env.WEBRTC_MODEL_ON_CONNECT || 'true').toLowerCase() === 'true';
const ANALYZE_FPS = Math.max(0.1, parseFloat(process.env.ANALYZE_FPS || '1'));
const MODEL_ID = process.env.MODEL_ID || 'Xenova/vit-gpt2-image-captioning';
const MODEL_DTYPE = process.env.MODEL_DTYPE || 'fp32';
const CAPTION_TASK = process.env.CAPTION_TASK || '<MORE_DETAILED_CAPTION>';
const MAX_NEW_TOKENS = parseInt(process.env.MAX_NEW_TOKENS || '96', 10);
const JPEG_QUALITY = Math.min(95, Math.max(40, parseInt(process.env.JPEG_QUALITY || '70', 10)));
const MIN_EVENT_SECONDS = Math.max(0, parseFloat(process.env.MIN_EVENT_SECONDS || '5'));

const CHAT_HISTORY_LIMIT = Math.max(2, parseInt(process.env.CHAT_HISTORY_LIMIT || '8', 10));
const CHAT_EVENT_LIMIT = Math.max(1, parseInt(process.env.CHAT_EVENT_LIMIT || '20', 10));
const CHAT_EVENT_LIMIT_MAX = Math.max(CHAT_EVENT_LIMIT, parseInt(process.env.CHAT_EVENT_LIMIT_MAX || '100', 10));
const CHAT_EVENT_WINDOW_HOURS = Math.max(1, parseFloat(process.env.CHAT_EVENT_WINDOW_HOURS || '24'));

const LLM_BACKEND = (process.env.LLM_BACKEND || 'disabled').toLowerCase();
const LLM_ROUTER_ENABLED = (process.env.LLM_ROUTER_ENABLED || 'true').toLowerCase() === 'true';
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

if ((process.env.DNS_IPV4_FIRST || 'true').toLowerCase() === 'true') {
  try {
    if (typeof dns.setDefaultResultOrder === 'function') {
      dns.setDefaultResultOrder('ipv4first');
    }
  } catch (err) {
    console.warn('DNS result order not set:', err.message || err);
  }
}

if (!process.env.WEBRTC_URL) {
  console.warn('WEBRTC_URL not set; defaulting to http://localhost:8080');
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

let captioner;
let RawImage;
let modelReady = false;
let modelLoading = false;
let updateOffset = 0;
let pollInFlight = false;
let lastCaptionNorm = '';
let lastEventAt = 0;

const knownChatIds = new Set();
const chatHistory = new Map();

const SYSTEM_PROMPT = [
  'You are ChatCam, a camera event manager.',
  'Answer questions using ONLY the event context provided.',
  'If the context is empty or insufficient, say so and ask a clarifying question.',
  'If asked whether something happened, answer yes or no based on events and cite event ids and timestamps.',
  'If asked for a summary, provide a concise summary and highlight notable events.',
  'If asked to explain an event, explain based on the caption and context only.',
  'Do not invent events or details that are not in the context.'
].join(' ');

const ROUTER_PROMPT = [
  'You are a routing assistant for a camera events Telegram bot.',
  'Return ONLY a JSON object with this schema:',
  '{"action":"answer|send_photo|db_stats","event_id":number|null,"window_hours":number|null,"limit":number|null,"query":string|null}.',
  'Use action="send_photo" if the user asks to send/show/share a photo, picture, image, or snapshot.',
  'Use action="db_stats" if the user asks whether the database is empty, how many events exist, or when the last event happened.',
  'Use action="answer" for all other questions.',
  'If the user refers to a specific event id (like "event #42"), set event_id.',
  'If the user asks for a time range, set window_hours (e.g. "last 2 hours" => 2, "today" => 24).',
  'If the user asks for N events, set limit.',
  'If the user asks about specific content or objects, set query to a short literal search phrase (e.g. "garage", "person at door").',
  'If no query is needed, set query to null.',
  'Return JSON only with double quotes.'
].join(' ');

function normalizeCaption(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s.,!?]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildWebSocketUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch (err) {
    throw new Error(`WEBRTC_URL must be a valid URL (got "${baseUrl}").`);
  }
  const protocol = url.protocol;
  if (protocol === 'https:' || protocol === 'wss:') {
    url.protocol = 'wss:';
  } else if (protocol === 'http:' || protocol === 'ws:') {
    url.protocol = 'ws:';
  } else {
    throw new Error(`WEBRTC_URL must use http/https/ws/wss (got "${protocol}").`);
  }
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

function safeParseJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return null;
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTelegram(url, options = {}, timeoutMs = TELEGRAM_FETCH_TIMEOUT_MS) {
  return await fetchWithTimeout(url, options, timeoutMs);
}

function getLlmUnavailableMessage() {
  return 'LLM is down right now, so we are unable to answer. We will message you when the service gets back up again.';
}

function truncateTelegramText(text) {
  if (text.length <= 3900) return text;
  return `${text.slice(0, 3900)}...`;
}

function truncateTelegramCaption(text) {
  if (!text) return '';
  if (text.length <= 1000) return text;
  return `${text.slice(0, 1000)}...`;
}

function clampEventLimit(value) {
  if (!Number.isFinite(value)) return CHAT_EVENT_LIMIT;
  return Math.min(CHAT_EVENT_LIMIT_MAX, Math.max(1, Math.floor(value)));
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

async function searchEvents(query, windowHours, limit) {
  if (!query) return getRecentEvents(windowHours, limit);
  const like = `%${query}%`;
  const res = await pool.query(
    'SELECT id, created_at, caption FROM events WHERE created_at >= NOW() - ($1 * INTERVAL \'1 hour\') AND caption ILIKE $2 ORDER BY created_at DESC LIMIT $3',
    [windowHours, like, limit]
  );
  return res.rows;
}

async function getEventById(id) {
  const res = await pool.query('SELECT id, created_at, caption FROM events WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function getEventByIdWithImage(id) {
  const res = await pool.query('SELECT id, created_at, caption, image FROM events WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function getLatestEventWithImage() {
  const res = await pool.query('SELECT id, created_at, caption, image FROM events ORDER BY created_at DESC LIMIT 1');
  return res.rows[0] || null;
}

async function getEventStats() {
  const res = await pool.query('SELECT COUNT(*)::int AS count, MAX(created_at) AS latest FROM events');
  return res.rows[0] || { count: 0, latest: null };
}

async function clearTelegramWebhook() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CLEAR_WEBHOOK) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`;
    const res = await fetchTelegram(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('Telegram deleteWebhook failed:', res.status, body);
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
  return getLlmUnavailableMessage();
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
    try {
      const res = await fetchTelegram(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const respBody = await res.text().catch(() => '');
        console.warn('Telegram sendMessage failed:', res.status, respBody);
      }
    } catch (err) {
      const cause = err && err.cause ? err.cause : null;
      const extra = cause && cause.code ? ` code=${cause.code}` : '';
      if (err && err.name === 'AbortError') {
        console.warn(`Telegram sendMessage timeout:${extra}`);
      } else {
        console.warn(`Telegram sendMessage fetch failed:${extra}`, err.message || err);
      }
    }
  }
}

async function sendTelegramPhoto(imageBuffer, options = {}) {
  if (!TELEGRAM_BOT_TOKEN) return;
  if (!imageBuffer) {
    await sendTelegramMessage('No image available to send.', options);
    return;
  }
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

  const caption = truncateTelegramCaption(options.caption || '');
  for (const chatId of targetIds) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
      form.append('caption', caption);
    }
    if (options.replyToMessageId) {
      form.append('reply_to_message_id', String(options.replyToMessageId));
    }
    try {
      const blob = new Blob([imageBuffer], { type: 'image/jpeg' });
      form.append('photo', blob, 'event.jpg');
      const res = await fetchTelegram(url, { method: 'POST', body: form });
      if (!res.ok) {
        const respBody = await res.text().catch(() => '');
        console.warn('Telegram sendPhoto failed:', res.status, respBody);
      }
    } catch (err) {
      const cause = err && err.cause ? err.cause : null;
      const extra = cause && cause.code ? ` code=${cause.code}` : '';
      if (err && err.name === 'AbortError') {
        console.warn(`Telegram sendPhoto timeout:${extra}`);
      } else {
        console.warn(`Telegram sendPhoto fetch failed:${extra}`, err.message || err);
      }
    }
  }
}

async function answerChatQuestion(chatId, text, overrides = {}) {
  if (!isLlmConfigured()) {
    return getLlmConfigMessage();
  }

  const eventId = Number.isFinite(overrides.eventId) ? overrides.eventId : null;
  const windowHours = Number.isFinite(overrides.windowHours) ? overrides.windowHours : CHAT_EVENT_WINDOW_HOURS;
  const limit = clampEventLimit(Number.isFinite(overrides.limit) ? overrides.limit : CHAT_EVENT_LIMIT);
  const query = typeof overrides.query === 'string' && overrides.query.trim() ? overrides.query.trim() : null;

  let events = [];
  let note = '';

  if (eventId) {
    const event = await getEventById(eventId);
    if (event) {
      events = [event];
    } else {
      note = `No event found for id ${eventId}.`;
    }
  } else if (query) {
    events = await searchEvents(query, windowHours, limit);
    if (!events.length) {
      note = `No events matched query "${query}".`;
    }
  } else {
    events = await getRecentEvents(windowHours, limit);
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

function normalizeRoute(route) {
  if (!route || typeof route !== 'object') return null;
  const action = typeof route.action === 'string' ? route.action.toLowerCase() : '';
  if (!['answer', 'send_photo', 'db_stats'].includes(action)) return null;
  const eventIdRaw = route.event_id === null || route.event_id === undefined ? null : Number(route.event_id);
  const windowHoursRaw = route.window_hours === null || route.window_hours === undefined ? null : Number(route.window_hours);
  const limitRaw = route.limit === null || route.limit === undefined ? null : Number(route.limit);
  const queryRaw = typeof route.query === 'string' ? route.query.trim() : null;
  return {
    action,
    eventId: Number.isFinite(eventIdRaw) ? Math.floor(eventIdRaw) : null,
    windowHours: Number.isFinite(windowHoursRaw) ? Math.max(0.1, windowHoursRaw) : null,
    limit: Number.isFinite(limitRaw) ? clampEventLimit(limitRaw) : null,
    query: queryRaw ? queryRaw : null
  };
}

async function routeUserRequest(text) {
  if (!LLM_ROUTER_ENABLED || !isLlmConfigured()) {
    return null;
  }
  try {
    const messages = [
      { role: 'system', content: ROUTER_PROMPT },
      { role: 'user', content: text }
    ];
    const raw = await callLlm(messages);
    const parsed = safeParseJson(raw);
    const normalized = normalizeRoute(parsed);
    if (!normalized) {
      if (TELEGRAM_DEBUG) {
        console.warn('Router parse failed:', raw);
      }
      return null;
    }
    if (TELEGRAM_DEBUG) {
      console.log('Router decision:', normalized);
    }
    return normalized;
  } catch (err) {
    console.warn('Router error:', err.message || err);
    return null;
  }
}

async function handlePhotoRequest(chatId, text, messageId, overrides = {}) {
  const eventId = Number.isFinite(overrides.eventId) ? overrides.eventId : null;
  const event = eventId ? await getEventByIdWithImage(eventId) : await getLatestEventWithImage();
  if (!event) {
    const message = eventId
      ? `No event found for id ${eventId}.`
      : 'No events recorded yet, so there is no photo to send.';
    await sendTelegramMessage(message, { chatId, replyToMessageId: messageId });
    return;
  }
  const ts = new Date(event.created_at).toISOString();
  const caption = `Event #${event.id} at ${ts}\n${event.caption}`;
  await sendTelegramPhoto(event.image, { chatId, replyToMessageId: messageId, caption });
}

async function handleDatabaseStatusRequest(chatId, messageId) {
  const stats = await getEventStats();
  if (!stats || !stats.count) {
    await sendTelegramMessage('Yes. The database has no events yet.', { chatId, replyToMessageId: messageId });
    return;
  }
  const ts = stats.latest ? new Date(stats.latest).toISOString() : 'unknown time';
  await sendTelegramMessage(
    `No. The database has ${stats.count} event(s). Latest event at ${ts}.`,
    { chatId, replyToMessageId: messageId }
  );
}

async function handleTelegramText(chatId, text, messageId) {
  const trimmed = (text || '').trim();
  if (!trimmed) return;
  knownChatIds.add(String(chatId));

  if (trimmed === '/start' || trimmed === '/help') {
    const help = [
      'ChatCam is online. Ask in plain language about camera events or photos.',
      'Examples:',
      '- "summary of the last 2 hours"',
      '- "did someone enter the garage today?"',
      '- "explain event #42"',
      '- "send the last photo"',
      '- "is the database empty?"'
    ].join('\n');
    await sendTelegramMessage(help, { chatId, replyToMessageId: messageId });
    return;
  }

  if (!isLlmConfigured() || !LLM_ROUTER_ENABLED) {
    await sendTelegramMessage(getLlmUnavailableMessage(), { chatId, replyToMessageId: messageId });
    return;
  }

  try {
    const route = await routeUserRequest(trimmed);
    if (!route) {
      const reply = await answerChatQuestion(chatId, trimmed, {});
      await sendTelegramMessage(reply, { chatId, replyToMessageId: messageId });
      return;
    }
    if (route.action === 'send_photo') {
      await handlePhotoRequest(chatId, trimmed, messageId, route);
      return;
    }
    if (route.action === 'db_stats') {
      await handleDatabaseStatusRequest(chatId, messageId);
      return;
    }
    const reply = await answerChatQuestion(chatId, trimmed, {
      eventId: route.eventId,
      windowHours: route.windowHours,
      limit: route.limit,
      query: route.query
    });
    await sendTelegramMessage(reply, { chatId, replyToMessageId: messageId });
  } catch (err) {
    console.warn('Telegram handler error:', err.message || err);
    await sendTelegramMessage(getLlmUnavailableMessage(), {
      chatId,
      replyToMessageId: messageId
    });
  }
}

async function pollTelegramUpdates() {
  if (!TELEGRAM_BOT_TOKEN || pollInFlight) return;
  pollInFlight = true;
  try {
    const params = new URLSearchParams({
      offset: String(updateOffset),
      timeout: String(TELEGRAM_LONG_POLL_SECONDS),
      allowed_updates: JSON.stringify(['message', 'edited_message', 'channel_post', 'edited_channel_post'])
    });
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?${params.toString()}`;
    const res = await fetchTelegram(url, {}, TELEGRAM_FETCH_TIMEOUT_MS + (TELEGRAM_LONG_POLL_SECONDS * 1000));
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('Telegram getUpdates failed:', res.status, body);
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
    const cause = err && err.cause ? err.cause : null;
    const extra = cause && cause.code ? ` code=${cause.code}` : '';
    if (err && err.name === 'AbortError') {
      console.warn(`Telegram polling timeout:${extra}`);
    } else {
      console.warn(`Telegram polling error:${extra}`, err.message || err);
    }
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
  console.log('Telegram polling started.');
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

async function ensureModelLoaded() {
  if (modelReady || modelLoading) return;
  modelLoading = true;
  try {
    await initModel();
  } finally {
    modelLoading = false;
  }
}

async function initModel() {
  console.log('Loading vision model...');
  const transformers = await import('@huggingface/transformers');
  const { pipeline, RawImage: HFImage } = transformers;
  RawImage = HFImage;
  captioner = await pipeline('image-to-text', MODEL_ID);
  modelReady = true;
  console.log('Vision model ready.');
}

async function generateCaption(image) {
  const output = await captioner(image, { max_new_tokens: MAX_NEW_TOKENS });
  const result = Array.isArray(output) ? output[0] : output;
  const text = result && (result.generated_text || result.text) ? (result.generated_text || result.text) : '';
  return String(text || '').trim();
}

async function startAnalyzer() {
  await initDb();
  startTelegramPolling();
  if (!WEBRTC_MODEL_ON_CONNECT) {
    initModel().catch((err) => {
      console.error('Vision model failed to load:', err);
    });
  }

  let wsUrl;
  try {
    wsUrl = buildWebSocketUrl(WEBRTC_BASE_URL);
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
  console.log('Connecting to WebRTC signaling:', wsUrl);

  let lastFrameAt = 0;
  let processing = false;
  let reconnectDelay = WEBRTC_RECONNECT_MIN_MS;
  let offlineSince = null;
  let reconnectTimer = null;
  let suspendedLogged = false;

  const resetReconnect = () => {
    reconnectDelay = WEBRTC_RECONNECT_MIN_MS;
    offlineSince = null;
    suspendedLogged = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = (reason) => {
    const now = Date.now();
    if (!offlineSince) offlineSince = now;
    const offlineFor = now - offlineSince;
    let delay = reconnectDelay;
    if (WEBRTC_SUSPEND_AFTER_MS > 0 && offlineFor >= WEBRTC_SUSPEND_AFTER_MS) {
      delay = Math.max(delay, WEBRTC_SUSPEND_CHECK_MS);
      if (!suspendedLogged) {
        console.log(`WebRTC offline for ${Math.round(offlineFor / 1000)}s; suspending reconnect attempts.`);
        suspendedLogged = true;
      }
    } else if (suspendedLogged) {
      suspendedLogged = false;
    }
    if (TELEGRAM_DEBUG) {
      console.log(`Scheduling WebRTC reconnect in ${Math.round(delay / 1000)}s (${reason}).`);
    }
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
    reconnectDelay = Math.min(WEBRTC_RECONNECT_MAX_MS, Math.floor(reconnectDelay * 1.6));
  };

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
        if (!modelReady) {
          if (WEBRTC_MODEL_ON_CONNECT) {
            ensureModelLoaded().catch((err) => console.error('Vision model failed to load:', err));
          }
          return;
        }
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
      resetReconnect();
      if (WEBRTC_MODEL_ON_CONNECT) {
        ensureModelLoaded().catch((err) => console.error('Vision model failed to load:', err));
      }
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
      scheduleReconnect('close');
    });

    ws.on('error', (err) => {
      console.warn('WebSocket error:', err.message);
      cleanup();
      scheduleReconnect('error');
    });

    ws.on('unexpected-response', (req, res) => {
      console.warn('WebSocket unexpected response:', res.statusCode);
      cleanup();
      scheduleReconnect(`http_${res.statusCode}`);
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
}).listen(HEALTH_PORT, () => {
  console.log(`Analyzer health server on :${HEALTH_PORT}`);
});

startAnalyzer().catch((err) => {
  console.error('Analyzer failed to start:', err);
  process.exit(1);
});

