require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const wrtc = require('wrtc');

const PORT = parseInt(process.env.PORT || '8080', 10);
const RTSP_URL = process.env.RTSP_URL || '';
const ANALYZER_CONTROL_URL = process.env.ANALYZER_CONTROL_URL || '';
const ANALYZER_CONTROL_TOKEN = process.env.ANALYZER_CONTROL_TOKEN || '';
const ANALYZER_PING_MS = Math.max(5000, parseInt(process.env.ANALYZER_PING_MS || '15000', 10));
const ANALYZER_PING_TIMEOUT_MS = Math.max(2000, parseInt(process.env.ANALYZER_PING_TIMEOUT_MS || '8000', 10));
const ANALYZER_PUBLIC_CHECK_MS = Math.max(5000, parseInt(process.env.ANALYZER_PUBLIC_CHECK_MS || '15000', 10));
const ANALYZER_PUBLIC_CHECK_TIMEOUT_MS = Math.max(1000, parseInt(process.env.ANALYZER_PUBLIC_CHECK_TIMEOUT_MS || '4000', 10));
const PUBLIC_WEBRTC_URL = process.env.PUBLIC_WEBRTC_URL || '';
const ANALYZER_CONTROL_LOG = (process.env.ANALYZER_CONTROL_LOG || 'true').toLowerCase() === 'true';

if (typeof fetch !== 'function') {
  console.error('Global fetch is not available. Use Node 18+ or add a fetch polyfill.');
  process.exit(1);
}

if (!RTSP_URL) {
  console.error('RTSP_URL is required.');
  process.exit(1);
}

const WIDTH = parseInt(process.env.WIDTH || '1280', 10);
const HEIGHT = parseInt(process.env.HEIGHT || '720', 10);
const FPS = parseInt(process.env.FPS || '30', 10);
const FRAME_SIZE = Math.floor(WIDTH * HEIGHT * 3 / 2); // yuv420p

const videoSource = new wrtc.nonstandard.RTCVideoSource();
const videoTrack = videoSource.createTrack();

let analyzerPingTimer = null;
let analyzerStopInFlight = false;
let publicCheckTimer = null;
let publicCheckInFlight = false;
let lastPublicReachable = null;

function buildAnalyzerControlUrl(pathname) {
  if (!ANALYZER_CONTROL_URL) return '';
  let url;
  try {
    url = new URL(ANALYZER_CONTROL_URL);
  } catch {
    console.warn('ANALYZER_CONTROL_URL is invalid.');
    return '';
  }
  url.pathname = pathname;
  url.search = '';
  return url.toString();
}

async function sendAnalyzerControl(pathname, payload) {
  if (!ANALYZER_CONTROL_URL) return;
  const url = buildAnalyzerControlUrl(pathname);
  if (!url) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANALYZER_PING_TIMEOUT_MS);
  const headers = { 'Content-Type': 'application/json' };
  if (ANALYZER_CONTROL_TOKEN) {
    headers.Authorization = `Bearer ${ANALYZER_CONTROL_TOKEN}`;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
      signal: controller.signal
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`Analyzer control ${pathname} failed:`, res.status, body);
      return;
    }
    if (ANALYZER_CONTROL_LOG) {
      console.log(`Analyzer control ${pathname} ok (${res.status}).`);
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      console.warn('Analyzer control request timed out.');
    } else {
      console.warn('Analyzer control request failed:', err.message || err);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function getControlPayload() {
  if (PUBLIC_WEBRTC_URL) {
    return { webrtcUrl: PUBLIC_WEBRTC_URL };
  }
  return null;
}

function startAnalyzerHeartbeat() {
  if (!ANALYZER_CONTROL_URL) {
    console.warn('ANALYZER_CONTROL_URL not set; analyzer control is disabled.');
    return;
  }
  if (analyzerPingTimer) {
    return;
  }
  const payload = getControlPayload();
  if (ANALYZER_CONTROL_LOG) {
    console.log('Sending analyzer /control/start', payload || {});
  }
  sendAnalyzerControl('/control/start', payload);
  analyzerPingTimer = setInterval(() => {
    sendAnalyzerControl('/control/ping', payload);
  }, ANALYZER_PING_MS);
}

async function stopAnalyzerHeartbeat() {
  if (analyzerStopInFlight) return;
  if (!analyzerPingTimer && lastPublicReachable === false) {
    return;
  }
  analyzerStopInFlight = true;
  if (analyzerPingTimer) {
    clearInterval(analyzerPingTimer);
    analyzerPingTimer = null;
  }
  const payload = getControlPayload();
  await sendAnalyzerControl('/control/stop', payload);
  analyzerStopInFlight = false;
}

function buildPublicCheckUrl() {
  if (!PUBLIC_WEBRTC_URL) return '';
  let url;
  try {
    url = new URL(PUBLIC_WEBRTC_URL);
  } catch {
    console.warn('PUBLIC_WEBRTC_URL is invalid.');
    return '';
  }
  url.pathname = '/client.html';
  url.search = '';
  return url.toString();
}

async function isPublicWebrtcReachable() {
  const checkUrl = buildPublicCheckUrl();
  if (!checkUrl) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANALYZER_PUBLIC_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(checkUrl, { method: 'GET', signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function updateAnalyzerForReachability() {
  if (!ANALYZER_CONTROL_URL) return;
  if (!PUBLIC_WEBRTC_URL) {
    startAnalyzerHeartbeat();
    return;
  }
  if (publicCheckInFlight) return;
  publicCheckInFlight = true;
  try {
    const reachable = await isPublicWebrtcReachable();
    const prev = lastPublicReachable;
    lastPublicReachable = reachable;
    if (prev === null) {
      if (reachable) {
        console.log('Public WebRTC URL reachable; starting analyzer.');
        startAnalyzerHeartbeat();
      } else {
        console.warn('Public WebRTC URL unreachable; analyzer waiting for availability.');
        await stopAnalyzerHeartbeat();
      }
      return;
    }
    if (reachable && !prev) {
      console.log('Public WebRTC URL reachable; resuming analyzer.');
      startAnalyzerHeartbeat();
    } else if (!reachable && prev) {
      console.warn('Public WebRTC URL unreachable; stopping analyzer.');
      await stopAnalyzerHeartbeat();
    }
  } finally {
    publicCheckInFlight = false;
  }
}

function startAnalyzerControlSupervisor() {
  if (!ANALYZER_CONTROL_URL) {
    console.warn('ANALYZER_CONTROL_URL not set; analyzer control is disabled.');
    return;
  }
  if (!PUBLIC_WEBRTC_URL) {
    startAnalyzerHeartbeat();
    return;
  }
  updateAnalyzerForReachability().catch((err) => {
    console.warn('Public WebRTC check failed:', err.message || err);
  });
  publicCheckTimer = setInterval(() => {
    updateAnalyzerForReachability().catch((err) => {
      console.warn('Public WebRTC check failed:', err.message || err);
    });
  }, ANALYZER_PUBLIC_CHECK_MS);
}

function startFfmpeg() {
  const args = [
    '-rtsp_transport', 'tcp',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-analyzeduration', '0',
    '-probesize', '32',
    '-i', RTSP_URL,
    '-an',
    '-vf', `scale=${WIDTH}:${HEIGHT}`,
    '-r', String(FPS),
    '-c:v', 'rawvideo',
    '-pix_fmt', 'yuv420p',
    '-f', 'rawvideo',
    'pipe:1'
  ];

  console.log('Starting FFmpeg:', `ffmpeg ${args.join(' ')}`);
  const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'inherit'] });

  let leftover = Buffer.alloc(0);
  ffmpeg.stdout.on('data', (chunk) => {
    const data = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
    let offset = 0;

    while (offset + FRAME_SIZE <= data.length) {
      // Copy into a tight buffer so wrtc sees the exact frame byteLength.
      const frame = Buffer.from(data.subarray(offset, offset + FRAME_SIZE));
      videoSource.onFrame({ width: WIDTH, height: HEIGHT, data: frame });
      offset += FRAME_SIZE;
    }

    leftover = data.subarray(offset);
  });

  ffmpeg.on('close', (code, signal) => {
    console.error(`FFmpeg exited (code=${code}, signal=${signal}). Restarting in 2s...`);
    setTimeout(startFfmpeg, 2000);
  });

  ffmpeg.on('error', (err) => {
    console.error('FFmpeg spawn error:', err);
  });
}

startFfmpeg();

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/client.html') {
    const filePath = path.join(__dirname, 'client.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Failed to load client.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const pc = new wrtc.RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  // Attach the track to a MediaStream so the browser gets a stream in ontrack.
  const mediaStream = new wrtc.MediaStream();
  mediaStream.addTrack(videoTrack);
  pc.addTrack(videoTrack, mediaStream);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }));
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === 'failed' || state === 'disconnected' || state === 'closed') {
      pc.close();
    }
  };

  ws.on('message', async (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch {
      return;
    }

    if (data.type === 'offer') {
      await pc.setRemoteDescription(new wrtc.RTCSessionDescription({
        type: 'offer',
        sdp: data.sdp
      }));

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription.sdp }));
    } else if (data.type === 'candidate' && data.candidate) {
      try {
        await pc.addIceCandidate(new wrtc.RTCIceCandidate(data.candidate));
      } catch (err) {
        console.warn('ICE candidate error:', err.message);
      }
    }
  });

  ws.on('close', () => pc.close());
  ws.on('error', () => pc.close());
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  startAnalyzerControlSupervisor();
});

async function shutdown(signal) {
  await stopAnalyzerHeartbeat();
  process.exit(0);
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch(() => process.exit(1));
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch(() => process.exit(1));
});
