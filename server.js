const path = require("path");
const http = require("http");
const express = require("express");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ["websocket", "polling"],
  perMessageDeflate: false,
  pingInterval: 10000,
  pingTimeout: 5000
});

const PORT = process.env.PORT || 3000;
const BOARD_SIZE = 15;
const EMPTY = 0;
const SITE_PASSWORD = process.env.SITE_PASSWORD;
const AUTH_COOKIE_NAME = "gomoku_auth";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const AUTH_MAX_ATTEMPTS = 5;
const AUTH_LOCK_MS = 60 * 60 * 1000;
const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];

if (!SITE_PASSWORD) {
  throw new Error("Missing SITE_PASSWORD environment variable.");
}
const AUTH_TOKEN = crypto.createHash("sha256").update(SITE_PASSWORD).digest("hex");
const authAttempts = new Map();

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

function buildAuthCookie(value, maxAgeSeconds) {
  const parts = [
    `${AUTH_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`
  ];
  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function getClientIp(req) {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (forwardedFor.length > 0) return forwardedFor[0];
  return req.ip || req.socket.remoteAddress || "unknown";
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
  if (hasValidAuthCookie(req.headers.cookie)) {
    res.redirect("/");
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/auth", (req, res) => {
  const ip = getClientIp(req);
  if (tooManyAuthAttempts(ip)) {
    res.status(429).send("Too many login attempts. You are locked for 1 hour.");
    return;
  }

  const submitted = String(req.body?.password || "");
  if (submitted !== SITE_PASSWORD) {
    recordFailedAuthAttempt(ip);
    res.redirect("/login?error=1");
    return;
  }
  clearAuthAttempts(ip);

  res.setHeader(
    "Set-Cookie",
    buildAuthCookie(AUTH_TOKEN, COOKIE_MAX_AGE_SECONDS)
  );
  res.redirect("/");
});

app.post("/logout", (req, res) => {
  res.setHeader("Set-Cookie", buildAuthCookie("", 0));
  res.redirect("/login");
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

app.use(requireAuth);
app.use(express.static(path.join(__dirname, "public")));

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

const rooms = new Map();

function createRoom() {
  let code = randomRoomCode();
  while (rooms.has(code)) {
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
  rooms.set(code, room);
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
  socket.on("create-room", (_, cb) => {
    const room = createRoom();
    const player = { id: socket.id, mark: 1 };
    room.players.push(player);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.mark = player.mark;
    cb?.({ ok: true, roomCode: room.code, mark: player.mark, state: getRoomState(room) });
  });

  socket.on("join-room", ({ roomCode }, cb) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) {
      cb?.({ ok: false, error: "Room not found." });
      return;
    }
    if (room.players.length >= 2) {
      cb?.({ ok: false, error: "Room is full." });
      return;
    }

    const player = { id: socket.id, mark: 2 };
    room.players.push(player);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.mark = player.mark;

    cb?.({ ok: true, roomCode: room.code, mark: player.mark, state: getRoomState(room) });
    io.to(room.code).emit("room-updated", getRoomState(room));
  });

  socket.on("make-move", ({ row, col }, cb) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) {
      cb?.({ ok: false, error: "You are not in a room." });
      return;
    }
    const room = rooms.get(roomCode);
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

    io.to(room.code).emit("room-updated", getRoomState(room));
    cb?.({ ok: true });
  });

  socket.on("reset-game", (_, cb) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      cb?.({ ok: false, error: "Room not found." });
      return;
    }
    room.board = newBoard();
    room.turn = 1;
    room.winner = null;
    room.history = [];
    room.redoStack = [];
    io.to(room.code).emit("room-updated", getRoomState(room));
    cb?.({ ok: true });
  });

  socket.on("undo-move", (_, cb) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
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
    io.to(room.code).emit("room-updated", getRoomState(room));
    cb?.({ ok: true });
  });

  socket.on("redo-move", (_, cb) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
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

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    room.players = room.players.filter((p) => p.id !== socket.id);
    socket.to(room.code).emit("peer-left");

    if (room.players.length === 0) {
      rooms.delete(room.code);
      return;
    }

    io.to(room.code).emit("room-updated", getRoomState(room));
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running at http://localhost:${PORT}`);
});
