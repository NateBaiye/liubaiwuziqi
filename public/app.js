const socket = io();
const BOARD_SIZE = 15;
const STAR_POINTS = new Set(["3,3", "3,11", "7,7", "11,3", "11,11"]);

let roomCode = null;
let myMark = null;
let currentState = null;

let localStream = null;
let peerConnection = null;
let isMuted = false;
let pendingIceCandidates = [];
let callStarted = false;
let optimisticMove = null;

let rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

const createRoomBtn = document.getElementById("createRoomBtn");
const joinRoomBtn = document.getElementById("joinRoomBtn");
const roomCodeInput = document.getElementById("roomCodeInput");
const roomCodeLabel = document.getElementById("roomCodeLabel");
const youAreLabel = document.getElementById("youAreLabel");
const gameStatusLabel = document.getElementById("gameStatusLabel");
const message = document.getElementById("message");
const resetBtn = document.getElementById("resetBtn");
const undoBtn = document.getElementById("undoBtn");
const redoBtn = document.getElementById("redoBtn");
const boardEl = document.getElementById("board");

const startVideoBtn = document.getElementById("startVideoBtn");
const muteBtn = document.getElementById("muteBtn");
const stopVideoBtn = document.getElementById("stopVideoBtn");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const remoteAudio = document.getElementById("remoteAudio");
const remoteStream = new MediaStream();

function showMessage(text) {
  message.textContent = text || "";
}

function emitWithAck(eventName, payload, onSuccess, fallbackErrorMessage) {
  if (!socket.connected) {
    showMessage("Not connected to server. Please refresh.");
    return;
  }

  socket.timeout(7000).emit(eventName, payload, (err, res) => {
    if (err) {
      showMessage(fallbackErrorMessage || "Server did not respond. Please try again.");
      return;
    }
    onSuccess(res);
  });
}

async function loadRtcConfig() {
  try {
    const response = await fetch("/webrtc-config");
    if (!response.ok) return;
    const data = await response.json();
    if (Array.isArray(data?.iceServers) && data.iceServers.length > 0) {
      rtcConfig = { iceServers: data.iceServers };
    }
  } catch (_) {
    // Keep default STUN config if request fails.
  }
}

function markToText(mark) {
  return mark === 1 ? "Black" : mark === 2 ? "White" : "-";
}

function isStarPoint(row, col) {
  return STAR_POINTS.has(`${row},${col}`);
}

function updateHeader() {
  roomCodeLabel.textContent = roomCode || "-";
  youAreLabel.textContent = markToText(myMark);

  if (!currentState) {
    gameStatusLabel.textContent = "Create or join a room";
    resetBtn.disabled = true;
    undoBtn.disabled = true;
    redoBtn.disabled = true;
    return;
  }

  resetBtn.disabled = false;
  undoBtn.disabled = !currentState.canUndo;
  redoBtn.disabled = !currentState.canRedo;

  if (currentState.players.length < 2) {
    gameStatusLabel.textContent = "Waiting for friend to join";
    return;
  }

  if (currentState.winner === 1 || currentState.winner === 2) {
    gameStatusLabel.textContent = `${markToText(currentState.winner)} wins`;
    return;
  }

  if (currentState.winner === 0) {
    gameStatusLabel.textContent = "Draw";
    return;
  }

  gameStatusLabel.textContent = `${markToText(currentState.turn)} to move`;
}

function renderBoard() {
  boardEl.innerHTML = "";

  const board = currentState?.board || Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));
  for (let r = 0; r < BOARD_SIZE; r += 1) {
    for (let c = 0; c < BOARD_SIZE; c += 1) {
      const btn = document.createElement("button");
      btn.className = "cell";
      btn.dataset.row = String(r);
      btn.dataset.col = String(c);

      if (isStarPoint(r, c)) {
        const starDot = document.createElement("span");
        starDot.className = "star-dot";
        btn.appendChild(starDot);
      }

      if (board[r][c] === 1 || board[r][c] === 2) {
        const stone = document.createElement("span");
        stone.className = `stone ${board[r][c] === 1 ? "black" : "white"}`;
        btn.appendChild(stone);
      } else if (canPlayCell(r, c)) {
        const previewStone = document.createElement("span");
        previewStone.className = `preview-stone ${myMark === 1 ? "black" : "white"}`;
        btn.appendChild(previewStone);
      }

      btn.disabled = !canPlayCell(r, c);
      btn.addEventListener("click", onCellClick);
      boardEl.appendChild(btn);
    }
  }
}

function canPlayCell(r, c) {
  if (!currentState || !roomCode || !myMark) return false;
  if (currentState.winner !== null) return false;
  if (currentState.turn !== myMark) return false;
  if (currentState.players.length < 2) return false;
  return currentState.board[r][c] === 0;
}

function onCellClick(e) {
  const row = Number(e.currentTarget.dataset.row);
  const col = Number(e.currentTarget.dataset.col);

  // Optimistic update: show the move instantly for better responsiveness.
  optimisticMove = {
    row,
    col,
    prevTurn: currentState.turn
  };
  currentState.board[row][col] = myMark;
  currentState.turn = myMark === 1 ? 2 : 1;
  renderBoard();
  updateHeader();

  emitWithAck(
    "make-move",
    { row, col },
    (res) => {
      if (!res?.ok) {
        if (optimisticMove && currentState) {
          currentState.board[optimisticMove.row][optimisticMove.col] = 0;
          currentState.turn = optimisticMove.prevTurn;
        }
        optimisticMove = null;
        renderBoard();
        updateHeader();
        showMessage(res?.error || "Move failed");
        return;
      }
      optimisticMove = null;
    },
    "Move request timed out."
  );
}

function applyRoomResponse(res) {
  if (!res?.ok) {
    showMessage(res?.error || "Request failed");
    return;
  }
  roomCode = res.roomCode;
  myMark = res.mark;
  currentState = res.state;
  updateHeader();
  renderBoard();
  showMessage("");
  maybeStartCallFlow();
}

createRoomBtn.addEventListener("click", () => {
  emitWithAck("create-room", {}, applyRoomResponse, "Create room timed out.");
});

joinRoomBtn.addEventListener("click", () => {
  const code = roomCodeInput.value.trim().toUpperCase();
  emitWithAck("join-room", { roomCode: code }, applyRoomResponse, "Join room timed out.");
});

resetBtn.addEventListener("click", () => {
  emitWithAck(
    "reset-game",
    {},
    (res) => {
      if (!res?.ok) showMessage(res?.error || "Reset failed");
    },
    "Reset request timed out."
  );
});

undoBtn.addEventListener("click", () => {
  emitWithAck(
    "undo-move",
    {},
    (res) => {
      if (!res?.ok) showMessage(res?.error || "Undo failed");
    },
    "Undo request timed out."
  );
});

redoBtn.addEventListener("click", () => {
  emitWithAck(
    "redo-move",
    {},
    (res) => {
      if (!res?.ok) showMessage(res?.error || "Redo failed");
    },
    "Redo request timed out."
  );
});

socket.on("room-updated", (state) => {
  optimisticMove = null;
  currentState = state;
  updateHeader();
  renderBoard();
  maybeStartCallFlow();
});

socket.on("connect_error", (err) => {
  if (String(err?.message || "").includes("Unauthorized")) {
    window.location.href = "/login";
    return;
  }
  showMessage(`Connection issue: ${err?.message || "Unable to reach server"}`);
});

socket.on("connect", () => {
  showMessage("");
});

socket.on("disconnect", () => {
  showMessage("Disconnected from server. Reconnecting...");
});

socket.on("peer-left", () => {
  closePeerConnection();
  remoteVideo.srcObject = null;
  remoteAudio.srcObject = null;
  remoteStream.getTracks().forEach((track) => remoteStream.removeTrack(track));
  showMessage("Your friend disconnected.");
});

async function startLocalMedia() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
  localVideo.srcObject = localStream;
  muteBtn.disabled = false;
  stopVideoBtn.disabled = false;
  return localStream;
}

function stopLocalMedia() {
  if (!localStream) return;
  localStream.getTracks().forEach((t) => t.stop());
  localStream = null;
  localVideo.srcObject = null;
  muteBtn.disabled = true;
  stopVideoBtn.disabled = true;
  isMuted = false;
  muteBtn.textContent = "Mute";
}

function ensurePeerConnection() {
  if (peerConnection) return peerConnection;

  peerConnection = new RTCPeerConnection(rtcConfig);

  peerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("webrtc-ice-candidate", { candidate: e.candidate });
    }
  };

  peerConnection.ontrack = (e) => {
    const alreadyAdded = remoteStream.getTracks().some((track) => track.id === e.track.id);
    if (!alreadyAdded) {
      remoteStream.addTrack(e.track);
    }
    remoteVideo.srcObject = remoteStream;
    remoteAudio.srcObject = remoteStream;
    remoteVideo.muted = false;
    remoteVideo.volume = 1;
    remoteAudio.muted = false;
    remoteAudio.volume = 1;
    const playPromise = Promise.all([remoteVideo.play(), remoteAudio.play()]);
    if (playPromise?.catch) {
      playPromise.catch(() => {
        showMessage("Remote video is ready. If you cannot hear audio, click on the page once.");
      });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(peerConnection.connectionState)) {
      remoteVideo.srcObject = null;
      remoteAudio.srcObject = null;
      remoteStream.getTracks().forEach((track) => remoteStream.removeTrack(track));
    }
  };

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });
  }

  return peerConnection;
}

function closePeerConnection() {
  if (!peerConnection) return;
  peerConnection.onicecandidate = null;
  peerConnection.ontrack = null;
  peerConnection.close();
  peerConnection = null;
  remoteVideo.srcObject = null;
  remoteAudio.srcObject = null;
  remoteStream.getTracks().forEach((track) => remoteStream.removeTrack(track));
  pendingIceCandidates = [];
  callStarted = false;
}

async function flushPendingIceCandidates(pc) {
  if (!pc?.remoteDescription) return;
  while (pendingIceCandidates.length > 0) {
    const candidate = pendingIceCandidates.shift();
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
}

async function maybeStartCallFlow() {
  if (!currentState || currentState.players.length < 2 || !roomCode || !myMark || !localStream) {
    return;
  }

  const pc = ensurePeerConnection();
  if (["connected", "connecting"].includes(pc.connectionState)) return;

  if (myMark === 1 && pc.signalingState === "stable" && !pc.remoteDescription && !callStarted) {
    callStarted = true;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("webrtc-offer", { offer });
  }
}

socket.on("webrtc-offer", async ({ offer }) => {
  try {
    await startLocalMedia();
    const pc = ensurePeerConnection();
    callStarted = true;
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await flushPendingIceCandidates(pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("webrtc-answer", { answer });
  } catch (err) {
    showMessage(`WebRTC offer error: ${err.message}`);
  }
});

socket.on("webrtc-answer", async ({ answer }) => {
  try {
    if (!peerConnection) return;
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    await flushPendingIceCandidates(peerConnection);
    callStarted = true;
  } catch (err) {
    showMessage(`WebRTC answer error: ${err.message}`);
  }
});

socket.on("webrtc-ice-candidate", async ({ candidate }) => {
  try {
    if (!candidate) return;
    if (!peerConnection || !peerConnection.remoteDescription) {
      pendingIceCandidates.push(candidate);
      return;
    }
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    showMessage(`ICE error: ${err.message}`);
  }
});

startVideoBtn.addEventListener("click", async () => {
  try {
    await startLocalMedia();
    await maybeStartCallFlow();
    showMessage("");
  } catch (err) {
    showMessage(`Camera/mic access failed: ${err.message}`);
  }
});

stopVideoBtn.addEventListener("click", () => {
  stopLocalMedia();
  closePeerConnection();
  remoteVideo.srcObject = null;
  remoteAudio.srcObject = null;
});

muteBtn.addEventListener("click", () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach((track) => {
    track.enabled = !isMuted;
  });
  muteBtn.textContent = isMuted ? "Unmute" : "Mute";
});

updateHeader();
renderBoard();
loadRtcConfig();
