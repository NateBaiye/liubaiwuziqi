const socket = io();
const BOARD_SIZE = 15;
const STAR_POINTS = new Set(["3,3", "3,11", "7,7", "11,3", "11,11"]);

let roomCode = null;
let myMark = null;
let currentState = null;

let rawLocalStream = null;
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

  beautyOutputStream = beautyCanvas.captureStream(30);
  outgoingProcessedVideoTrack = beautyOutputStream.getVideoTracks()[0];
  previewProcessedVideoTrack = outgoingProcessedVideoTrack.clone();
  localVideo.srcObject = new MediaStream([previewProcessedVideoTrack]);
  localVideo.muted = true;
  localVideo.playsInline = true;
  await localVideo.play().catch(() => {});

  return new MediaStream([outgoingProcessedVideoTrack, ...rawStream.getAudioTracks()]);
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
  rawLocalStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
  localStream = await createProcessedVideoStream(rawLocalStream);
  muteBtn.disabled = false;
  stopVideoBtn.disabled = false;
  return localStream;
}

function stopLocalMedia() {
  if (!localStream && !rawLocalStream) return;
  if (beautyFrameRequestId) {
    cancelAnimationFrame(beautyFrameRequestId);
    beautyFrameRequestId = null;
  }
  if (beautySourceVideo) {
    beautySourceVideo.pause();
    beautySourceVideo.srcObject = null;
    beautySourceVideo = null;
  }
  if (localStream) {
    localStream.getVideoTracks().forEach((t) => t.stop());
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
  if (rawLocalStream) {
    rawLocalStream.getTracks().forEach((t) => t.stop());
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
  rawLocalStream = null;
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
  if (!rawLocalStream && !localStream) return;
  isMuted = !isMuted;
  const stream = rawLocalStream || localStream;
  stream.getAudioTracks().forEach((track) => {
    track.enabled = !isMuted;
  });
  muteBtn.textContent = isMuted ? "Unmute" : "Mute";
});

updateHeader();
renderBoard();
loadRtcConfig();
