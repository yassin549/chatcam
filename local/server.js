const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const wrtc = require('wrtc');

const PORT = parseInt(process.env.PORT || '8080', 10);
// Hardcoded RTSP URL (credentials included). Change if needed.
const RTSP_URL = 'rtsp://pyuser:yacine03041973@192.168.1.70:554/cam/realmonitor?channel=1&subtype=0';

const WIDTH = parseInt(process.env.WIDTH || '1280', 10);
const HEIGHT = parseInt(process.env.HEIGHT || '720', 10);
const FPS = parseInt(process.env.FPS || '30', 10);
const FRAME_SIZE = Math.floor(WIDTH * HEIGHT * 3 / 2); // yuv420p

const videoSource = new wrtc.nonstandard.RTCVideoSource();
const videoTrack = videoSource.createTrack();

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
});
