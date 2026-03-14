const http = require('http');
const WebSocket = require('ws');
const wrtc = require('wrtc');
const { Pool } = require('pg');
const jpeg = require('jpeg-js');

const TELEGRAM_BOT_TOKEN = '8715068728:AAEEcvxrXlhHC2WBQd62OrYgqU3G_mM8zn0';

const PORT = parseInt(process.env.PORT || '8080', 10);
const WEBRTC_BASE_URL = process.env.WEBRTC_URL || 'https://deafly-kinaesthetic-sadye.ngrok-free.dev';
const ANALYZE_FPS = Math.max(0.1, parseFloat(process.env.ANALYZE_FPS || '1'));
const MODEL_ID = process.env.MODEL_ID || 'onnx-community/Florence-2-base';
const MODEL_DTYPE = process.env.MODEL_DTYPE || 'fp32';
const CAPTION_TASK = process.env.CAPTION_TASK || '<MORE_DETAILED_CAPTION>';
const MAX_NEW_TOKENS = parseInt(process.env.MAX_NEW_TOKENS || '96', 10);
const JPEG_QUALITY = Math.min(95, Math.max(40, parseInt(process.env.JPEG_QUALITY || '70', 10)));
const MIN_EVENT_SECONDS = Math.max(0, parseFloat(process.env.MIN_EVENT_SECONDS || '5'));

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
let cachedChatId = null;
let updateOffset = 0;
let lastChatIdCheck = 0;
let lastCaptionNorm = '';
let lastEventAt = 0;

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

async function fetchChatId() {
  if (cachedChatId) return cachedChatId;
  const now = Date.now();
  if (now - lastChatIdCheck < 3000) return null;
  lastChatIdCheck = now;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${updateOffset}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn('Telegram getUpdates failed:', res.status);
    return null;
  }
  const data = await res.json();
  if (!data.ok) {
    console.warn('Telegram getUpdates error:', data);
    return null;
  }
  if (Array.isArray(data.result) && data.result.length > 0) {
    for (const update of data.result) {
      updateOffset = Math.max(updateOffset, (update.update_id || 0) + 1);
      const msg = update.message || update.channel_post || update.edited_message || update.edited_channel_post;
      if (msg && msg.chat && typeof msg.chat.id === 'number') {
        cachedChatId = msg.chat.id;
        console.log('Resolved Telegram chat id:', cachedChatId);
        return cachedChatId;
      }
    }
  }
  return null;
}

async function sendTelegramMessage(text) {
  const chatId = await fetchChatId();
  if (!chatId) {
    console.warn('Telegram chat id not available yet. Send a message to the bot.');
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn('Telegram sendMessage failed:', res.status, body);
  }
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
  const transformers = await import('@huggingface/transformers');
  const { Florence2ForConditionalGeneration, AutoProcessor: HFProcessor, RawImage: HFImage } = transformers;
  RawImage = HFImage;
  processor = await HFProcessor.from_pretrained(MODEL_ID);
  model = await Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, { dtype: MODEL_DTYPE });
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

async function handleEvent(caption, jpegBuffer) {
  await pool.query('INSERT INTO events (caption, image) VALUES ($1, $2)', [caption, jpegBuffer]);
  await sendTelegramMessage(caption);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startAnalyzer() {
  await initDb();
  await initModel();
  setInterval(() => {
    fetchChatId().catch((err) => console.warn('Telegram chat id lookup failed:', err));
  }, 5000);

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
