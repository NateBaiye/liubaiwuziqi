const path = require("path");
const http = require("http");
const express = require("express");
const crypto = require("crypto");
const { createClient } = require("redis");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Blocked by CORS"));
    },
    credentials: true
  },
  transports: ["polling", "websocket"],
  perMessageDeflate: false,
  pingInterval: 10000,
  pingTimeout: 20000
});

const PORT = process.env.PORT || 3000;
const BOARD_SIZE = 19;
const EMPTY = 0;
const SITE_PASSWORD = process.env.SITE_PASSWORD;
const FRONTEND_ORIGIN = String(process.env.FRONTEND_ORIGIN || "").trim();
const SERVE_STATIC_FRONTEND = process.env.SERVE_STATIC_FRONTEND !== "false";
const REDIS_URL = String(process.env.REDIS_URL || "").trim();
const ROOM_TTL_SECONDS = Math.max(60, Number.parseInt(process.env.ROOM_TTL_SECONDS || "86400", 10) || 86400);
const AUTH_COOKIE_NAME = "gomoku_auth";
const PLAYER_COOKIE_NAME = "gomoku_player";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const AUTH_MAX_ATTEMPTS = 5;
const AUTH_LOCK_MS = 60 * 60 * 1000;
const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];
const cors = require("cors");

function isAllowedOrigin(origin) {
  if (!FRONTEND_ORIGIN) return true;
  if (!origin) return true;
  return origin === FRONTEND_ORIGIN;
}

app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Blocked by CORS"));
  },
  credentials: true
}));

if (!SITE_PASSWORD) {
  throw new Error("Missing SITE_PASSWORD environment variable.");
}
const AUTH_TOKEN = crypto.createHash("sha256").update(SITE_PASSWORD).digest("hex");
const authAttempts = new Map();
const rooms = new Map();

let redisClient = null;
let redisConnectPromise = null;

if (REDIS_URL) {
  redisClient = createClient({ url: REDIS_URL });
  redisClient.on("error", (error) => {
    // eslint-disable-next-line no-console
    console.error("Redis error:", error.message);
  });
  redisConnectPromise = redisClient.connect().catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Redis connection failed:", error.message);
    redisClient = null;
    return null;
  });
}

app.use(express.urlencoded({ extended: false }));
app.set("trust proxy", 1);

function parseCookies(cookieHeader = "") {
  const cookies = {};
  if (!cookieHeader) return cookies;

  const rawCookies = cookieHeader.split(";");
  for (const rawCookie of rawCookies) {
    const index = rawCookie.indexOf("=");
    if (index === -1) continue;
    const key = rawCookie.slice(0, index).trim();
    const value = rawCookie.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch (_) {
      cookies[key] = value;
    }
  }
  return cookies;
}

function hasValidAuthCookie(cookieHeader) {
  const cookies = parseCookies(cookieHeader);
  return cookies[AUTH_COOKIE_NAME] === AUTH_TOKEN;
}

function getPlayerToken(cookieHeader) {
  const cookies = parseCookies(cookieHeader);
  return cookies[PLAYER_COOKIE_NAME] || null;
}

function buildAuthCookie(value, maxAgeSeconds) {
  const isProduction = process.env.NODE_ENV === "production";
  const parts = [
    `${AUTH_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${isProduction ? "None" : "Lax"}`,
    `Max-Age=${maxAgeSeconds}`
  ];
  if (isProduction) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function buildPlayerCookie(value, maxAgeSeconds) {
  const isProduction = process.env.NODE_ENV === "production";
  const parts = [
    `${PLAYER_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    `SameSite=${isProduction ? "None" : "Lax"}`,
    `Max-Age=${maxAgeSeconds}`
  ];
  if (isProduction) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function ensurePlayerToken(req, res) {
  const existingToken = getPlayerToken(req.headers.cookie);
  if (existingToken) return existingToken;
  const token = crypto.randomUUID();
  const currentSetCookie = res.getHeader("Set-Cookie");
  const cookies = Array.isArray(currentSetCookie)
    ? currentSetCookie.filter(Boolean)
    : currentSetCookie ? [currentSetCookie] : [];
  cookies.push(buildPlayerCookie(token, COOKIE_MAX_AGE_SECONDS));
  res.setHeader("Set-Cookie", cookies);
  return token;
}

function getPostLoginRedirect(rawTarget) {
  if (typeof rawTarget !== "string" || !rawTarget.trim()) {
    return FRONTEND_ORIGIN || "/";
  }

  const target = rawTarget.trim();
  if (target.startsWith("/") && !target.startsWith("//")) {
    return target;
  }
  if (FRONTEND_ORIGIN && target.startsWith(FRONTEND_ORIGIN)) {
    return target;
  }

  return FRONTEND_ORIGIN || "/";
}

function getClientIp(req) {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (forwardedFor.length > 0) return forwardedFor[0];
  return req.ip || req.socket.remoteAddress || "unknown";
}

async function getRedisClient() {
  if (!redisClient) return null;
  if (redisConnectPromise) {
    await redisConnectPromise;
    redisConnectPromise = null;
  }
  return redisClient?.isReady ? redisClient : null;
}

function recordFailedAuthAttempt(ip) {
  const now = Date.now();
  const entry = authAttempts.get(ip) || { count: 0, lockUntil: 0 };

  if (entry.lockUntil > now) {
    return entry.count;
  }

  entry.count += 1;
  if (entry.count >= AUTH_MAX_ATTEMPTS) {
    entry.lockUntil = now + AUTH_LOCK_MS;
  }

  authAttempts.set(ip, entry);
  return entry.count;
}

function clearAuthAttempts(ip) {
  authAttempts.delete(ip);
}

function tooManyAuthAttempts(ip) {
  const entry = authAttempts.get(ip);
  if (!entry) return false;
  if (entry.lockUntil > 0 && entry.lockUntil <= Date.now()) {
    authAttempts.delete(ip);
    return false;
  }
  return entry.lockUntil > Date.now();
}

function requireAuth(req, res, next) {
  if (hasValidAuthCookie(req.headers.cookie)) return next();
  if (req.accepts("html")) {
    res.redirect("/login");
    return;
  }
  res.status(401).json({ ok: false, error: "Unauthorized" });
}

app.get("/login", (req, res) => {
  ensurePlayerToken(req, res);
  if (hasValidAuthCookie(req.headers.cookie)) {
    res.redirect(getPostLoginRedirect(String(req.query?.returnTo || "")));
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "login.html"));
});

app.post("/auth", (req, res) => {
  const playerToken = ensurePlayerToken(req, res);
  const ip = getClientIp(req);
  if (tooManyAuthAttempts(ip)) {
    res.status(429).send("Too many login attempts. You are locked for 1 hour.");
    return;
  }

  const submitted = String(req.body?.password || "");
  if (submitted !== SITE_PASSWORD) {
    recordFailedAuthAttempt(ip);
    const returnTo = String(req.body?.returnTo || req.query?.returnTo || "");
    const nextQuery = returnTo ? `?error=1&returnTo=${encodeURIComponent(returnTo)}` : "?error=1";
    res.redirect(`/login${nextQuery}`);
    return;
  }
  clearAuthAttempts(ip);
  const returnTo = getPostLoginRedirect(String(req.body?.returnTo || req.query?.returnTo || ""));

  res.setHeader(
    "Set-Cookie",
    [
      buildAuthCookie(AUTH_TOKEN, COOKIE_MAX_AGE_SECONDS),
      buildPlayerCookie(playerToken, COOKIE_MAX_AGE_SECONDS)
    ]
  );
  res.redirect(returnTo);
});

app.post("/logout", (req, res) => {
  res.setHeader("Set-Cookie", buildAuthCookie("", 0));
  res.redirect("/login");
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.get("/webrtc-config", requireAuth, (_, res) => {
  const iceServers = [...DEFAULT_ICE_SERVERS];
  const turnUrls = String(process.env.TURN_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const turnUsername = process.env.TURN_USERNAME;
  const turnCredential = process.env.TURN_CREDENTIAL;

  if (turnUrls.length > 0 && turnUsername && turnCredential) {
    iceServers.push({
      urls: turnUrls,
      username: turnUsername,
      credential: turnCredential
    });
  }

  res.json({ iceServers });
});

if (SERVE_STATIC_FRONTEND) {
  app.use(requireAuth);
  app.use(express.static(path.join(__dirname, "..", "public")));
}

io.use((socket, next) => {
  if (hasValidAuthCookie(socket.handshake.headers.cookie)) {
    next();
    return;
  }
  next(new Error("Unauthorized"));
});

function randomRoomCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function newBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(EMPTY));
}

function inBounds(r, c) {
  return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;
}

function checkWin(board, row, col, player) {
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1]
  ];

  for (const [dr, dc] of directions) {
    let count = 1;

    let r = row + dr;
    let c = col + dc;
    while (inBounds(r, c) && board[r][c] === player) {
      count += 1;
      r += dr;
      c += dc;
    }

    r = row - dr;
    c = col - dc;
    while (inBounds(r, c) && board[r][c] === player) {
      count += 1;
      r -= dr;
      c -= dc;
    }

    if (count >= 5) return true;
  }
  return false;
}

function boardIsFull(board) {
  for (const row of board) {
    for (const cell of row) {
      if (cell === EMPTY) return false;
    }
  }
  return true;
}

function recomputeRoomStateFromHistory(room) {
  room.board = newBoard();
  room.winner = null;
  room.turn = 1;

  for (const move of room.history) {
    room.board[move.row][move.col] = move.mark;
  }

  if (room.history.length === 0) return;

  const lastMove = room.history[room.history.length - 1];
  if (checkWin(room.board, lastMove.row, lastMove.col, lastMove.mark)) {
    room.winner = lastMove.mark;
    return;
  }

  if (boardIsFull(room.board)) {
    room.winner = 0;
    return;
  }

  room.turn = lastMove.mark === 1 ? 2 : 1;
}

function roomStorageKey(code) {
  return `gomoku:room:${code}`;
}

function pruneDisconnectedPlayers(room) {
  room.players = room.players.map((player) => {
    if (player.id && io.sockets.sockets.has(player.id)) return player;
    return { ...player, id: null };
  });
}

function nextAvailableMark(room) {
  const taken = new Set(room.players.map((player) => player.mark));
  if (!taken.has(1)) return 1;
  if (!taken.has(2)) return 2;
  return null;
}

function findPlayerByToken(room, playerToken) {
  if (!playerToken) return null;
  return room.players.find((player) => player.playerToken === playerToken) || null;
}

async function loadRoom(code) {
  const normalizedCode = String(code || "").toUpperCase().trim();
  if (!normalizedCode) return null;

  let room = rooms.get(normalizedCode) || null;
  if (!room) {
    const redis = await getRedisClient();
    if (redis) {
      const rawRoom = await redis.get(roomStorageKey(normalizedCode));
      if (rawRoom) {
        room = JSON.parse(rawRoom);
        rooms.set(normalizedCode, room);
      }
    }
  }

  if (!room) return null;

  const previousPlayerCount = room.players.length;
  pruneDisconnectedPlayers(room);
  if (room.players.length !== previousPlayerCount) {
    await saveRoom(room);
  }

  return room;
}

async function saveRoom(room) {
  rooms.set(room.code, room);
  const redis = await getRedisClient();
  if (!redis) return;
  await redis.set(roomStorageKey(room.code), JSON.stringify(room), {
    EX: ROOM_TTL_SECONDS
  });
}

async function deleteRoom(code) {
  const normalizedCode = String(code || "").toUpperCase().trim();
  rooms.delete(normalizedCode);
  const redis = await getRedisClient();
  if (!redis) return;
  await redis.del(roomStorageKey(normalizedCode));
}

async function createRoom() {
  let code = randomRoomCode();
  while (await loadRoom(code)) {
    code = randomRoomCode();
  }
  const room = {
    code,
    players: [],
    board: newBoard(),
    turn: 1,
    winner: null,
    history: [],
    redoStack: []
  };
  await saveRoom(room);
  return room;
}

function getRoomState(room) {
  return {
    code: room.code,
    board: room.board,
    turn: room.turn,
    winner: room.winner,
    players: room.players.map((p) => ({
      id: p.id,
      mark: p.mark
    })),
    canUndo: room.history.length > 0,
    canRedo: room.redoStack.length > 0
  };
}

io.on("connection", (socket) => {
  socket.data.playerToken = getPlayerToken(socket.handshake.headers.cookie);

  socket.on("create-room", async (_, cb) => {
    const room = await createRoom();
    const player = { id: socket.id, mark: 1, playerToken: socket.data.playerToken };
    room.players.push(player);
    await saveRoom(room);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.mark = player.mark;
    cb?.({ ok: true, roomCode: room.code, mark: player.mark, state: getRoomState(room) });
  });

  socket.on("join-room", async ({ roomCode }, cb) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const room = await loadRoom(code);
    if (!room) {
      cb?.({ ok: false, error: "Room not found." });
      return;
    }
    const existingPlayer = findPlayerByToken(room, socket.data.playerToken);
    let player = existingPlayer;
    if (player) {
      player.id = socket.id;
    } else {
      const mark = nextAvailableMark(room);
      if (mark === null) {
        cb?.({ ok: false, error: "Room is full." });
        return;
      }
      player = { id: socket.id, mark, playerToken: socket.data.playerToken };
      room.players.push(player);
    }
    await saveRoom(room);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.mark = player.mark;

    cb?.({ ok: true, roomCode: room.code, mark: player.mark, state: getRoomState(room) });
    io.to(room.code).emit("room-updated", getRoomState(room));
  });

  socket.on("make-move", async ({ row, col }, cb) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) {
      cb?.({ ok: false, error: "You are not in a room." });
      return;
    }
    const room = await loadRoom(roomCode);
    if (!room) {
      cb?.({ ok: false, error: "Room not found." });
      return;
    }
    if (room.winner) {
      cb?.({ ok: false, error: "Game has finished." });
      return;
    }

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) {
      cb?.({ ok: false, error: "Player not in room." });
      return;
    }
    if (player.mark !== room.turn) {
      cb?.({ ok: false, error: "Not your turn." });
      return;
    }
    if (!inBounds(row, col)) {
      cb?.({ ok: false, error: "Invalid cell." });
      return;
    }
    if (room.board[row][col] !== EMPTY) {
      cb?.({ ok: false, error: "Cell is occupied." });
      return;
    }

    room.board[row][col] = player.mark;
    room.history.push({ row, col, mark: player.mark });
    room.redoStack = [];

    if (checkWin(room.board, row, col, player.mark)) {
      room.winner = player.mark;
    } else if (boardIsFull(room.board)) {
      room.winner = 0;
    } else {
      room.turn = room.turn === 1 ? 2 : 1;
    }

    await saveRoom(room);
    io.to(room.code).emit("room-updated", getRoomState(room));
    cb?.({ ok: true });
  });

  socket.on("reset-game", async (_, cb) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? await loadRoom(roomCode) : null;
    if (!room) {
      cb?.({ ok: false, error: "Room not found." });
      return;
    }
    room.board = newBoard();
    room.turn = 1;
    room.winner = null;
    room.history = [];
    room.redoStack = [];
    await saveRoom(room);
    io.to(room.code).emit("room-updated", getRoomState(room));
    cb?.({ ok: true });
  });

  socket.on("undo-move", async (_, cb) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? await loadRoom(roomCode) : null;
    if (!room) {
      cb?.({ ok: false, error: "Room not found." });
      return;
    }
    if (room.history.length === 0) {
      cb?.({ ok: false, error: "No move to undo." });
      return;
    }

    const move = room.history.pop();
    room.redoStack.push(move);
    recomputeRoomStateFromHistory(room);
    await saveRoom(room);
    io.to(room.code).emit("room-updated", getRoomState(room));
    cb?.({ ok: true });
  });

  socket.on("redo-move", async (_, cb) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? await loadRoom(roomCode) : null;
    if (!room) {
      cb?.({ ok: false, error: "Room not found." });
      return;
    }
    if (room.redoStack.length === 0) {
      cb?.({ ok: false, error: "No move to redo." });
      return;
    }

    const move = room.redoStack.pop();
    room.history.push(move);
    recomputeRoomStateFromHistory(room);
    await saveRoom(room);
    io.to(room.code).emit("room-updated", getRoomState(room));
    cb?.({ ok: true });
  });

  socket.on("webrtc-offer", ({ offer }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    socket.to(roomCode).emit("webrtc-offer", { offer });
  });

  socket.on("webrtc-answer", ({ answer }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    socket.to(roomCode).emit("webrtc-answer", { answer });
  });

  socket.on("webrtc-ice-candidate", ({ candidate }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    socket.to(roomCode).emit("webrtc-ice-candidate", { candidate });
  });

  socket.on("disconnect", async () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    const room = await loadRoom(roomCode);
    if (!room) return;

    room.players = room.players.map((player) => (
      player.id === socket.id ? { ...player, id: null } : player
    ));
    socket.to(room.code).emit("peer-left");

    if (room.players.every((player) => !player.id)) {
      // Keep the room alive until TTL expiry so short Render restarts
      // or reconnects do not immediately invalidate the room code.
      await saveRoom(room);
      return;
    }

    await saveRoom(room);
    io.to(room.code).emit("room-updated", getRoomState(room));
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running at http://localhost:${PORT}`);
});
