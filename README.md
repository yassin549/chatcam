# chatcam

Minimal RTSP -> WebRTC viewer using Node.js, FFmpeg, and WebSockets.

This project pulls video from an RTSP camera with FFmpeg, feeds raw frames into `wrtc`, and serves a simple WebRTC viewer over HTTP + WebSocket signaling.

## Quick Summary
- `server.js` runs an HTTP server, WebSocket signaling, and FFmpeg -> WebRTC pipeline.
- `client.html` connects via WebRTC and plays the video.
- FFmpeg decodes RTSP to raw `yuv420p` frames.
- `wrtc` encodes to a WebRTC-friendly codec (VP8/H264 depending on build).

## Requirements
- Node.js **18.x** (recommended for `wrtc` prebuilt binaries).
- FFmpeg in PATH.
- An RTSP camera feed.

## Files
- `server.js`: WebRTC signaling + media pipeline.
- `client.html`: minimal browser viewer.
- `package.json`: dependencies and scripts.

## Install (Windows)
1) Install Node 18 via nvm-windows:
```powershell
winget install -e --id CoreyButler.NVMforWindows --source winget
nvm install 18.20.5
nvm use 18.20.5
node -v
```

2) Install FFmpeg:
```powershell
winget install -e --id Gyan.FFmpeg --source winget
```
Open a new PowerShell and verify:
```powershell
ffmpeg -version
```

3) Install dependencies:
```powershell
npm install ws
npm install -D node-pre-gyp
npm install wrtc
```

Optional cleanup after install:
```powershell
npm rm node-pre-gyp --save-dev
```

## Configure RTSP
Set the RTSP URL via environment variable before starting the server:
```powershell
$env:RTSP_URL="rtsp://username:password@host:port/path"
```

## Run
```powershell
node server.js
```
Open in your browser:
```text
http://localhost:8080
```

## Ngrok (public HTTPS access)
```powershell
ngrok http 8080
```
Open the HTTPS forwarding URL shown by ngrok.

## Environment Variables
- `RTSP_URL` (required, e.g. `rtsp://user:pass@host:554/stream`)
- `PORT` (default `8080`)
- `WIDTH` (default `1280`)
- `HEIGHT` (default `720`)
- `FPS` (default `30`)

Example:
```powershell
$env:PORT="8080"
$env:WIDTH="1280"
$env:HEIGHT="720"
$env:FPS="30"
node server.js
```

## How It Works
1) **FFmpeg** connects to RTSP and decodes frames to raw `yuv420p`.
2) The Node process reads `stdout` and slices it into fixed-size frames.
3) Each frame is pushed into `RTCVideoSource` from `wrtc`.
4) The browser creates an offer and sends it over WebSocket.
5) The server responds with an answer and ICE candidates.
6) The browser receives a track and attaches it to a `<video>` element.

## Analyzer (Render)
The Render analyzer lives in `chatAI/`. It connects to the WebRTC stream, samples ~1 fps, captions frames with `Xenova/vit-gpt2-image-captioning`, stores new events in Postgres, and sends Telegram notifications.

### Run (local or Render)
```powershell
cd chatAI
npm run analyze
```

### Required env vars
- `DATABASE_URL` (Postgres connection string)
- `TELEGRAM_BOT_TOKEN` (Telegram bot token)

### Optional env vars
- `WEBRTC_URL` (default: `http://localhost:8080`, must be a full `http(s)` or `ws(s)` URL)
- `ANALYZE_FPS` (default: `1`)
- `MODEL_ID` (default: `Xenova/vit-gpt2-image-captioning`)
- `MODEL_DTYPE` (default: `fp32`)
- `MAX_NEW_TOKENS` (default: `96`)
- `JPEG_QUALITY` (default: `70`)
- `MIN_EVENT_SECONDS` (default: `5`)
- `ANALYZER_PORT` (health server port, default: `8090` when `PORT` is not set)
- `TELEGRAM_WEBHOOK_URL` (enables webhook mode, must be full `https` base URL; path comes from `TELEGRAM_WEBHOOK_PATH`)
- `TELEGRAM_WEBHOOK_PATH` (default: `/telegram`)
- `TELEGRAM_WEBHOOK_SECRET` (optional secret token validation)

### Telegram
- Send at least one message to the bot so `getUpdates` can resolve your chat id.
## Troubleshooting
### WebRTC viewer stuck on "Connecting..."
- Ensure the server logs show FFmpeg is producing frames (look for `frame=` output).
- Open browser DevTools and check console for WebRTC/ICE errors.
- Confirm the WebSocket connection is established (`/ws`).

### FFmpeg 401 Unauthorized
- Wrong username/password or RTSP permissions.
- Verify with:
```powershell
ffmpeg -rtsp_transport tcp -i "rtsp://user:pass@host:554/stream" -t 5 -f null -
```

### EPERM errors on Windows
- Avoid running the project from a OneDrive-synced folder.
- Use a local path like `C:\dev\chatcam`.

## Notes on Latency
- This is already low-latency: TCP RTSP + `-fflags nobuffer` + small `-probesize`.
- If you need even lower latency, consider tuning FPS or resolution.

## Security Notes
- Do not commit secrets to a public repo.
- If you used ngrok authtokens in a shared session, rotate them.
