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
   npm install
   ```
2. Start server:
   ```bash
   npm start
   ```
3. Open in browser:
   - `http://localhost:3000`

### Set a private site password (recommended)
The site is password-protected. You must set a password before starting:

```bash
SITE_PASSWORD="your-strong-password" npm start
```

### Optional TURN config for better video reliability
To improve call success across strict networks, configure TURN on the server:

```bash
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
- WebRTC camera/mic generally requires HTTPS on public domains.
- STUN servers are included for NAT traversal.
- Some networks still block direct peer-to-peer traffic; if that happens, add a TURN server for relay.

## Future upgrade (recommended)
For more reliable global video calls, configure TURN (for example, Coturn or Twilio Network Traversal) and add credentials in `public/app.js` under `rtcConfig.iceServers`.
