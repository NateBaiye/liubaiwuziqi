# Gomoku Online (Room Code + Video Call)

This project is a browser-based Gomoku game for two players with:
- Room-code matchmaking
- Real-time board sync
- Built-in peer-to-peer video call (WebRTC)

## Tech
- Node.js
- Express
- Socket.IO
- WebRTC (browser APIs)

## Run locally
1. Install dependencies:
   ```bash
   cd backend
   npm install
   ```
2. Start server:
   ```bash
   cd backend
   npm start
   ```
3. Open in browser:
   - `http://localhost:3000`

### Set a private site password (recommended)
The site is password-protected. You must set a password before starting:

```bash
cd backend
SITE_PASSWORD="your-strong-password" npm start
```

### Optional TURN config for better video reliability
To improve call success across strict networks, configure TURN on the server:

```bash
cd backend
TURN_URLS="turn:your-turn-host:3478,turn:your-turn-host:443?transport=tcp" \
TURN_USERNAME="your-turn-username" \
TURN_CREDENTIAL="your-turn-password" \
SITE_PASSWORD="your-strong-password" \
npm start
```

## How to play
1. Player A clicks `Create Room` and shares the room code.
2. Player B enters the code and clicks `Join Room`.
3. Click `Start Camera` on both sides to enable video.
4. Play moves on the board when it is your turn.
5. Click `Reset Game` to start a new round.

## Deploy for playing from different countries
To play over the internet, deploy this app to a public server (Render, Railway, Fly.io, VPS, etc.).

Important notes:
- For a single Render service, you can deploy the repo root directly. The root [package.json](/Users/akashibaba/Desktop/Gomoku/package.json) starts [backend/server.js](/Users/akashibaba/Desktop/Gomoku/backend/server.js), and the backend serves [public/index.html](/Users/akashibaba/Desktop/Gomoku/public/index.html).
- A ready-to-use Render blueprint is included in [render.yaml](/Users/akashibaba/Desktop/Gomoku/render.yaml).
- The deploy root for the Node service should be the `backend` folder, because that is where `package.json` and `server.js` live.
- WebRTC camera/mic generally requires HTTPS on public domains.
- STUN servers are included for NAT traversal.
- Some networks still block direct peer-to-peer traffic; if that happens, add a TURN server for relay.
- For split deployment, set `FRONTEND_ORIGIN` on the backend to your frontend URL, for example `https://your-frontend.example.com`.
- For split deployment, set `SERVE_STATIC_FRONTEND=false` on the backend.
- For split deployment, edit [public/config.js](/Users/akashibaba/Desktop/Gomoku/public/config.js) and set `window.APP_CONFIG.API_BASE_URL` to your backend URL.
- For better restart resilience on Render, set `REDIS_URL` so room codes and game state survive service restarts and spin-downs.

## Better video reliability
For more reliable global video calls, configure TURN on the backend:

```bash
cd backend
TURN_URLS="turn:your-turn-host:3478,turn:your-turn-host:443?transport=tcp" \
TURN_USERNAME="your-turn-username" \
TURN_CREDENTIAL="your-turn-password" \
FRONTEND_ORIGIN="https://your-frontend.example.com" \
SITE_PASSWORD="your-strong-password" \
NODE_ENV=production \
SERVE_STATIC_FRONTEND=false \
npm start
```

Recommended TURN options:
- Use both UDP and TCP TURN URLs if your provider supports them.
- Include a `:443?transport=tcp` TURN URL for restrictive networks.
- Use a real TURN provider (Coturn, Twilio Network Traversal, Metered, Xirsys) instead of STUN-only.

## Better room reliability on Render
Without persistence, room codes and active games live only in server memory. That means a free Render restart or spin-down can wipe them.

This project now supports Redis-backed room persistence:

```bash
REDIS_URL="redis://..." \
ROOM_TTL_SECONDS=86400 \
SITE_PASSWORD="your-strong-password" \
NODE_ENV=production \
npm start
```

Notes:
- `REDIS_URL` is optional, but strongly recommended on Render.
- `ROOM_TTL_SECONDS` controls how long an inactive room code is kept. Default is `86400` seconds (24 hours).
- Empty rooms are no longer deleted immediately; they expire by TTL instead. This helps players recover after short disconnects or Render restarts.

## Render-only deployment
If you want the entire app on one Render web service:

1. Create a new Render web service from the repo root.
2. Use the default build/start commands from [render.yaml](/Users/akashibaba/Desktop/Gomoku/render.yaml), or:
   - Build command: `npm install`
   - Start command: `npm start`
3. Set:
   - `SITE_PASSWORD`
   - `REDIS_URL` for persistent rooms across restarts
   - optional TURN vars for better video reliability

In this mode:
- `SERVE_STATIC_FRONTEND=true`
- [public/config.js](/Users/akashibaba/Desktop/Gomoku/public/config.js) can keep `API_BASE_URL` empty
- frontend and backend run from the same Render URL
