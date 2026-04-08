const API_BASE_URL = String(window.APP_CONFIG?.API_BASE_URL || "").replace(/\/$/, "");
const socket = io(API_BASE_URL || undefined, {
  withCredentials: true,
  transports: ["polling", "websocket"]
});
const BOARD_SIZE = 19;
const STAR_POINTS = new Set([
  "4,4", "4,10", "4,16",
  "10,4", "10,10", "10,16",
  "16,4", "16,10", "16,16"
]);

let roomCode = null;
let myMark = null;
let currentState = null;

let micStream = null;
let rawVideoStream = null;
let localStream = null;
let peerConnection = null;
let isMuted = false;
let pendingIceCandidates = [];
let callStarted = false;
let optimisticMove = null;
const BEAUTY_LEVEL = 45;
let beautyCanvas = null;
let beautyCtx = null;
let beautySourceVideo = null;
let beautyFrameRequestId = null;
let beautyOutputStream = null;
let outgoingProcessedVideoTrack = null;
let previewProcessedVideoTrack = null;
let faceDetector = null;
let faceBox = null;
let faceTiltRad = 0;
let smoothedFaceTiltRad = 0;
let faceDetectPending = false;
let beautyFrameCounter = 0;
let workingCanvas = null;
let workingCtx = null;
let currentPcGeneration = 0;
let rtcConfigPromise = null;
let renegotiating = false;

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
const gamePanelEl = document.getElementById("gamePanel");
const shrinkGamePanelBtn = document.getElementById("shrinkGamePanelBtn");
const toggleGamePanelBtn = document.getElementById("toggleGamePanelBtn");

const startVoiceBtn = document.getElementById("startVoiceBtn");
const startVideoBtn = document.getElementById("startVideoBtn");
const toggleMicBtn = document.getElementById("toggleMicBtn");
const toggleCameraBtn = document.getElementById("toggleCameraBtn");
const endCallBtn = document.getElementById("endCallBtn");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const remoteAudio = document.getElementById("remoteAudio");
const appEl = document.querySelector(".app");
const videoPanelEl = document.getElementById("videoPanel");
const shrinkVideoBtn = document.getElementById("shrinkVideoBtn");
const toggleVideoPanelBtn = document.getElementById("toggleVideoPanelBtn");
const remoteStream = new MediaStream();

function apiUrl(path) {
  return `${API_BASE_URL}${path}`;
}

function redirectToLogin() {
  const loginUrl = `${apiUrl("/login")}?returnTo=${encodeURIComponent(window.location.href)}`;
  window.location.href = loginUrl;
}

function showMessage(text) {
  message.textContent = text || "";
}

function setCallButtonState(button, positive, label, title, icon) {
  if (!button) return;
  button.classList.toggle("is-positive", positive);
  button.classList.toggle("is-negative", !positive);
  button.setAttribute("aria-label", label);
  button.setAttribute("title", title);
  button.innerHTML = icon;
}

function updateCallControls() {
  const inRoom = Boolean(roomCode && myMark);
  const hasMic = Boolean(micStream);
  const hasVideo = Boolean(outgoingProcessedVideoTrack);
  const hasAnyLocalMedia = hasMic || hasVideo;

  startVoiceBtn.disabled = !inRoom || hasMic;
  startVideoBtn.disabled = !inRoom || hasVideo;
  toggleMicBtn.disabled = !inRoom || !hasMic;
  toggleCameraBtn.disabled = !inRoom || (!hasMic && !hasVideo);
  endCallBtn.disabled = !hasAnyLocalMedia && !peerConnection;

  setCallButtonState(
    toggleMicBtn,
    !isMuted,
    isMuted ? "Turn microphone on" : "Turn microphone off",
    isMuted ? "Turn microphone on" : "Turn microphone off",
    isMuted
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z" /><path d="M18 11.5a6 6 0 0 1-12 0" /><path d="M12 17.5V21" /><path d="M4.5 4.5 19.5 19.5" /></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z" /><path d="M18 11.5a6 6 0 0 1-12 0" /><path d="M12 17.5V21" /></svg>'
  );

  setCallButtonState(
    toggleCameraBtn,
    hasVideo,
    hasVideo ? "Turn camera off" : "Turn camera on",
    hasVideo ? "Turn camera off" : "Turn camera on",
    hasVideo
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H14a2.5 2.5 0 0 1 2.5 2.5v1.3l3.6-2.4c.8-.54 1.9.03 1.9.99v9.24c0 .96-1.1 1.53-1.9.99l-3.6-2.4v1.3A2.5 2.5 0 0 1 14 19H6.5A2.5 2.5 0 0 1 4 16.5v-9Z" /></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H14a2.5 2.5 0 0 1 2.5 2.5v1.3l3.6-2.4c.8-.54 1.9.03 1.9.99v9.24c0 .96-1.1 1.53-1.9.99l-3.6-2.4v1.3A2.5 2.5 0 0 1 14 19H6.5A2.5 2.5 0 0 1 4 16.5v-9Z" /><path d="M5 5 19 19" /></svg>'
  );
}

function updateVideoPanelButtons() {
  if (!appEl) return;
  const isGameCompact = appEl.classList.contains("game-compact");
  const isGameCollapsed = appEl.classList.contains("game-collapsed");
  const isCompact = appEl.classList.contains("video-compact");
  const isCollapsed = appEl.classList.contains("video-collapsed");
  shrinkGamePanelBtn.setAttribute("aria-label", isGameCompact ? "Restore game panel size" : "Make game panel smaller");
  toggleGamePanelBtn.setAttribute("aria-label", isGameCollapsed ? "Show game panel" : "Minimize game panel");
  shrinkVideoBtn.setAttribute("aria-label", isCompact ? "Restore video panel size" : "Make video panel smaller");
  toggleVideoPanelBtn.setAttribute("aria-label", isCollapsed ? "Show video panel" : "Minimize video panel");
  if (gamePanelEl) {
    gamePanelEl.setAttribute("aria-expanded", String(!isGameCollapsed));
  }
  if (videoPanelEl) {
    videoPanelEl.setAttribute("aria-expanded", String(!isCollapsed));
  }
}

function toggleCompactGamePanel() {
  if (!appEl) return;
  appEl.classList.toggle("game-compact");
  updateVideoPanelButtons();
}

function toggleCollapseGamePanel() {
  if (!appEl) return;
  appEl.classList.toggle("game-collapsed");
  updateVideoPanelButtons();
}

function toggleCompactVideoPanel() {
  if (!appEl) return;
  appEl.classList.toggle("video-compact");
  updateVideoPanelButtons();
}

function toggleCollapseVideoPanel() {
  if (!appEl) return;
  appEl.classList.toggle("video-collapsed");
  updateVideoPanelButtons();
}

function beautyFilter(level) {
  const blurPx = 0.6 + (level / 100) * 1.6;
  const brightness = 1 + level / 500;
  const contrast = 1 - level / 1300;
  const saturate = 1 + level / 1200;
  return `blur(${blurPx}px) brightness(${brightness}) contrast(${contrast}) saturate(${saturate})`;
}

function findLandmark(face, type) {
  const landmarks = face?.landmarks || [];
  return landmarks.find((lm) => lm.type === type);
}

async function detectFaceBox() {
  if (!faceDetector || !beautySourceVideo || faceDetectPending) return;
  if (beautySourceVideo.readyState < 2) return;

  faceDetectPending = true;
  try {
    const faces = await faceDetector.detect(beautySourceVideo);
    if (faces.length > 0) {
      const face = faces[0];
      faceBox = face.boundingBox;

      const leftEye = findLandmark(face, "leftEye");
      const rightEye = findLandmark(face, "rightEye");
      if (leftEye?.locations?.[0] && rightEye?.locations?.[0]) {
        const dx = rightEye.locations[0].x - leftEye.locations[0].x;
        const dy = rightEye.locations[0].y - leftEye.locations[0].y;
        faceTiltRad = Math.atan2(dy, dx);
        // Smooth tilt over time to avoid jitter and side warping artifacts.
        smoothedFaceTiltRad = smoothedFaceTiltRad * 0.82 + faceTiltRad * 0.18;
      }
    } else {
      smoothedFaceTiltRad *= 0.92;
    }
  } catch (_) {
    // Keep last faceBox on detect failure.
  } finally {
    faceDetectPending = false;
  }
}

function drawSourceWithHeadCorrection() {
  if (!workingCtx || !workingCanvas || !beautySourceVideo) return;

  const w = workingCanvas.width;
  const h = workingCanvas.height;
  workingCtx.clearRect(0, 0, w, h);

  const baseTilt = smoothedFaceTiltRad || faceTiltRad;
  let strength = 0.45;
  if (faceBox && beautySourceVideo.videoWidth && beautySourceVideo.videoHeight) {
    const cx = faceBox.x + faceBox.width / 2;
    const cy = faceBox.y + faceBox.height / 2;
    const nx = Math.abs(cx / beautySourceVideo.videoWidth - 0.5) * 2;
    const ny = Math.abs(cy / beautySourceVideo.videoHeight - 0.5) * 2;
    const edgeFactor = Math.max(nx, ny);
    strength *= 1 - Math.min(0.5, edgeFactor * 0.5);
  }

  const maxCorrection = (5 * Math.PI) / 180;
  let correction = Math.max(-maxCorrection, Math.min(maxCorrection, -baseTilt * strength));
  if (Math.abs(correction) < 0.01) correction = 0;

  if (Math.abs(correction) < 0.001) {
    workingCtx.drawImage(beautySourceVideo, 0, 0, w, h);
    return;
  }

  let anchorX = w / 2;
  let anchorY = h / 2;
  if (faceBox && beautySourceVideo.videoWidth && beautySourceVideo.videoHeight) {
    const scaleX = w / beautySourceVideo.videoWidth;
    const scaleY = h / beautySourceVideo.videoHeight;
    anchorX = (faceBox.x + faceBox.width / 2) * scaleX;
    anchorY = (faceBox.y + faceBox.height / 2) * scaleY;
  }

  workingCtx.save();
  workingCtx.translate(anchorX, anchorY);
  workingCtx.rotate(correction);
  const overscan = 1.06;
  const dw = w * overscan;
  const dh = h * overscan;
  workingCtx.drawImage(beautySourceVideo, -dw / 2, -dh / 2, dw, dh);
  workingCtx.restore();
}

function applyFaceBeauty() {
  if (!faceBox || !beautyCtx || !beautyCanvas || !workingCanvas || !beautySourceVideo) return;

  const scaleX = beautyCanvas.width / beautySourceVideo.videoWidth;
  const scaleY = beautyCanvas.height / beautySourceVideo.videoHeight;
  const x = faceBox.x * scaleX;
  const y = faceBox.y * scaleY;
  const w = faceBox.width * scaleX;
  const h = faceBox.height * scaleY;

  beautyCtx.save();
  beautyCtx.beginPath();
  beautyCtx.ellipse(
    x + w / 2,
    y + h / 2,
    (w * 0.7),
    (h * 0.9),
    0,
    0,
    Math.PI * 2
  );
  beautyCtx.clip();

  beautyCtx.filter = "blur(2.4px) brightness(1.07) saturate(1.04)";
  beautyCtx.drawImage(workingCanvas, 0, 0, beautyCanvas.width, beautyCanvas.height);
  beautyCtx.restore();
}

function renderBeautyFrame() {
  if (!beautyCtx || !beautyCanvas || !beautySourceVideo || !workingCanvas) return;
  if (beautySourceVideo.readyState >= 2) {
    drawSourceWithHeadCorrection();
    beautyCtx.filter = "brightness(1.03) contrast(0.99) saturate(1.03)";
    beautyCtx.drawImage(workingCanvas, 0, 0, beautyCanvas.width, beautyCanvas.height);

    beautyCtx.filter = beautyFilter(BEAUTY_LEVEL);
    beautyCtx.drawImage(workingCanvas, 0, 0, beautyCanvas.width, beautyCanvas.height);
    applyFaceBeauty();

    beautyFrameCounter += 1;
    if (beautyFrameCounter % 8 === 0) {
      detectFaceBox();
    }
  }
  beautyFrameRequestId = requestAnimationFrame(renderBeautyFrame);
}

async function createProcessedVideoStream(rawStream) {
  const rawVideoTrack = rawStream.getVideoTracks()[0];
  if (!rawVideoTrack) {
    return rawStream;
  }
  const settings = rawVideoTrack.getSettings ? rawVideoTrack.getSettings() : {};
  const width = settings.width || 640;
  const height = settings.height || 480;

  beautyCanvas = document.createElement("canvas");
  beautyCanvas.width = width;
  beautyCanvas.height = height;
  beautyCtx = beautyCanvas.getContext("2d", { alpha: false });
  workingCanvas = document.createElement("canvas");
  workingCanvas.width = width;
  workingCanvas.height = height;
  workingCtx = workingCanvas.getContext("2d", { alpha: false });

  beautySourceVideo = document.createElement("video");
  beautySourceVideo.autoplay = true;
  beautySourceVideo.muted = true;
  beautySourceVideo.playsInline = true;
  beautySourceVideo.srcObject = new MediaStream([rawVideoTrack]);
  await beautySourceVideo.play();

  if ("FaceDetector" in window) {
    try {
      faceDetector = new FaceDetector({
        fastMode: true,
        maxDetectedFaces: 1
      });
    } catch (_) {
      faceDetector = null;
    }
  } else {
    faceDetector = null;
  }
  faceBox = null;
  faceTiltRad = 0;
  smoothedFaceTiltRad = 0;
  faceDetectPending = false;
  beautyFrameCounter = 0;

  if (beautyFrameRequestId) cancelAnimationFrame(beautyFrameRequestId);
  renderBeautyFrame();

  if (typeof beautyCanvas.captureStream === "function") {
    beautyOutputStream = beautyCanvas.captureStream(30);
    outgoingProcessedVideoTrack = beautyOutputStream.getVideoTracks()[0] || null;
  } else {
    beautyOutputStream = null;
    outgoingProcessedVideoTrack = null;
  }

  if (!outgoingProcessedVideoTrack) {
    outgoingProcessedVideoTrack = rawVideoTrack.clone();
  }

  previewProcessedVideoTrack = outgoingProcessedVideoTrack.clone();
  localVideo.srcObject = new MediaStream([previewProcessedVideoTrack]);
  localVideo.muted = true;
  localVideo.playsInline = true;
  await localVideo.play().catch(() => {});

  return rebuildLocalStream();
}

async function syncPeerConnectionTracks() {
  if (!peerConnection) return;

  const audioTrack = micStream?.getAudioTracks?.()[0] || null;
  const videoTrack = outgoingProcessedVideoTrack || null;
  const senders = peerConnection.getSenders();

  const audioSender = senders.find((sender) => sender.track?.kind === "audio");
  if (audioTrack) {
    if (audioSender) {
      await audioSender.replaceTrack(audioTrack);
    } else {
      peerConnection.addTrack(audioTrack, localStream);
    }
  } else if (audioSender) {
    peerConnection.removeTrack(audioSender);
  }

  const videoSender = senders.find((sender) => sender.track?.kind === "video");
  if (videoTrack) {
    if (videoSender) {
      await videoSender.replaceTrack(videoTrack);
    } else {
      peerConnection.addTrack(videoTrack, localStream);
    }
  } else if (videoSender) {
    peerConnection.removeTrack(videoSender);
  }
}

async function rebuildLocalStream() {
  const tracks = [];
  if (outgoingProcessedVideoTrack) {
    tracks.push(outgoingProcessedVideoTrack);
  }
  if (micStream) {
    tracks.push(...micStream.getAudioTracks());
  }
  localStream = new MediaStream(tracks);
  await syncPeerConnectionTracks();
  updateCallControls();
  return localStream;
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
    const response = await fetch(apiUrl("/webrtc-config"), {
      credentials: "include"
    });
    if (!response.ok) {
      rtcConfigPromise = null;
      return;
    }
    const data = await response.json();
    if (Array.isArray(data?.iceServers) && data.iceServers.length > 0) {
      rtcConfig = { iceServers: data.iceServers };
    }
  } catch (_) {
    rtcConfigPromise = null;
    // Keep default STUN config if request fails.
  }
}

function ensureRtcConfigLoaded() {
  if (!rtcConfigPromise) {
    rtcConfigPromise = loadRtcConfig();
  }
  return rtcConfigPromise;
}

async function renegotiatePeerConnection() {
  if (renegotiating || !peerConnection || !currentState || currentState.players.length < 2) {
    return;
  }
  if (peerConnection.signalingState !== "stable") return;

  renegotiating = true;
  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit("webrtc-offer", { offer });
    callStarted = true;
  } catch (err) {
    showMessage(`Call update failed: ${err.message}`);
  } finally {
    renegotiating = false;
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
  updateCallControls();

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
    redirectToLogin();
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
  updateCallControls();
});

async function startLocalAudio() {
  await ensureRtcConfigLoaded();
  if (micStream) return localStream || rebuildLocalStream();
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  });
  isMuted = false;
  updateCallControls();
  return rebuildLocalStream();
}

async function startLocalMedia() {
  await ensureRtcConfigLoaded();
  await startLocalAudio();
  if (outgoingProcessedVideoTrack) return localStream;
  rawVideoStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: false
  });
  updateCallControls();
  return createProcessedVideoStream(rawVideoStream);
}

async function stopLocalMedia() {
  if (!outgoingProcessedVideoTrack && !rawVideoStream) return;
  if (beautyFrameRequestId) {
    cancelAnimationFrame(beautyFrameRequestId);
    beautyFrameRequestId = null;
  }
  if (beautySourceVideo) {
    beautySourceVideo.pause();
    beautySourceVideo.srcObject = null;
    beautySourceVideo = null;
  }
  if (previewProcessedVideoTrack) {
    previewProcessedVideoTrack.stop();
    previewProcessedVideoTrack = null;
  }
  if (outgoingProcessedVideoTrack) {
    outgoingProcessedVideoTrack.stop();
    outgoingProcessedVideoTrack = null;
  }
  beautyOutputStream = null;
  if (rawVideoStream) {
    rawVideoStream.getTracks().forEach((t) => t.stop());
  }
  beautyCanvas = null;
  beautyCtx = null;
  workingCanvas = null;
  workingCtx = null;
  faceDetector = null;
  faceBox = null;
  faceTiltRad = 0;
  smoothedFaceTiltRad = 0;
  faceDetectPending = false;
  beautyFrameCounter = 0;
  rawVideoStream = null;
  localVideo.srcObject = null;
  await rebuildLocalStream();
  updateCallControls();
  await renegotiatePeerConnection();
}

async function endCall() {
  await stopLocalMedia();
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
  isMuted = false;
  localStream = new MediaStream();
  closePeerConnection();
  updateCallControls();
}

function ensurePeerConnection() {
  if (peerConnection) return peerConnection;

  peerConnection = new RTCPeerConnection(rtcConfig);
  const pcGeneration = ++currentPcGeneration;

  peerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("webrtc-ice-candidate", { candidate: e.candidate });
    }
  };

  peerConnection.ontrack = (e) => {
    const incomingStream = e.streams?.[0] || null;

    if (incomingStream) {
      const currentTracks = remoteStream.getTracks();
      currentTracks.forEach((track) => remoteStream.removeTrack(track));
      incomingStream.getTracks().forEach((track) => remoteStream.addTrack(track));
    } else {
      const alreadyAdded = remoteStream.getTracks().some((track) => track.id === e.track.id);
      if (!alreadyAdded) {
        remoteStream.addTrack(e.track);
      }
    }

    if (remoteVideo.srcObject !== remoteStream) {
      remoteVideo.srcObject = remoteStream;
    }
    if (remoteAudio.srcObject !== remoteStream) {
      remoteAudio.srcObject = remoteStream;
    }

    // Keep the video element muted so autoplay policies don't block the picture.
    // Remote sound comes from the dedicated audio element below.
    remoteVideo.muted = true;
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
    if (!peerConnection || pcGeneration !== currentPcGeneration) return;
    if (["failed", "closed", "disconnected"].includes(peerConnection.connectionState)) {
      remoteVideo.srcObject = null;
      remoteAudio.srcObject = null;
      remoteStream.getTracks().forEach((track) => remoteStream.removeTrack(track));
      callStarted = false;
      pendingIceCandidates = [];
      showMessage("Call disconnected. Use the call controls to reconnect voice or add video again.");
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    if (!peerConnection || pcGeneration !== currentPcGeneration) return;
    if (["failed", "disconnected"].includes(peerConnection.iceConnectionState)) {
      callStarted = false;
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
  peerConnection.onconnectionstatechange = null;
  peerConnection.oniceconnectionstatechange = null;
  peerConnection.close();
  peerConnection = null;
  currentPcGeneration += 1;
  remoteVideo.srcObject = null;
  remoteAudio.srcObject = null;
  remoteStream.getTracks().forEach((track) => remoteStream.removeTrack(track));
  pendingIceCandidates = [];
  callStarted = false;
  updateCallControls();
}

async function flushPendingIceCandidates(pc) {
  if (!pc?.remoteDescription) return;
  while (pendingIceCandidates.length > 0) {
    const candidate = pendingIceCandidates.shift();
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
}

async function maybeStartCallFlow() {
  if (!currentState || currentState.players.length < 2 || !roomCode || !myMark || !localStream || localStream.getTracks().length === 0) {
    return;
  }

  const pc = ensurePeerConnection();
  if (["connected", "connecting"].includes(pc.connectionState)) return;
  if (pc.signalingState === "have-local-offer") return;

  if (myMark === 1 && pc.signalingState === "stable" && !pc.remoteDescription && !callStarted) {
    callStarted = true;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("webrtc-offer", { offer });
  }
}

socket.on("webrtc-offer", async ({ offer }) => {
  try {
    const pc = ensurePeerConnection();
    if (pc.signalingState !== "stable") {
      closePeerConnection();
    }
    const activePc = ensurePeerConnection();
    callStarted = true;
    await activePc.setRemoteDescription(new RTCSessionDescription(offer));
    await flushPendingIceCandidates(activePc);
    const answer = await activePc.createAnswer();
    await activePc.setLocalDescription(answer);
    socket.emit("webrtc-answer", { answer });
  } catch (err) {
    callStarted = false;
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
    callStarted = false;
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

startVoiceBtn.addEventListener("click", async () => {
  try {
    await startLocalAudio();
    await maybeStartCallFlow();
    await renegotiatePeerConnection();
    showMessage("");
  } catch (err) {
    showMessage(`Microphone access failed: ${err.message}`);
  }
});

startVideoBtn.addEventListener("click", async () => {
  try {
    await startLocalMedia();
    await maybeStartCallFlow();
    showMessage("");
  } catch (err) {
    showMessage(`Camera access failed: ${err.message}`);
  }
});

shrinkGamePanelBtn.addEventListener("click", () => {
  toggleCompactGamePanel();
});

toggleGamePanelBtn.addEventListener("click", () => {
  toggleCollapseGamePanel();
});

shrinkVideoBtn.addEventListener("click", () => {
  toggleCompactVideoPanel();
});

toggleVideoPanelBtn.addEventListener("click", () => {
  toggleCollapseVideoPanel();
});

toggleCameraBtn.addEventListener("click", async () => {
  if (outgoingProcessedVideoTrack) {
    await stopLocalMedia();
  } else {
    try {
      await startLocalMedia();
      await maybeStartCallFlow();
      await renegotiatePeerConnection();
    } catch (err) {
      showMessage(`Camera access failed: ${err.message}`);
      return;
    }
  }
  showMessage("");
});

toggleMicBtn.addEventListener("click", async () => {
  if (!micStream) return;
  isMuted = !isMuted;
  micStream.getAudioTracks().forEach((track) => {
    track.enabled = !isMuted;
  });
  updateCallControls();
});

endCallBtn.addEventListener("click", async () => {
  await endCall();
  showMessage("");
});

updateHeader();
renderBoard();
ensureRtcConfigLoaded();
updateVideoPanelButtons();
updateCallControls();
