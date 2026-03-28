// =============================================
// student.js — Sleep2Wake 수강생 수업 화면 (최종 통합본)
// =============================================

// ── 상수 ──────────────────────────────────────
const EYE_FRAMES     = 20;
const MOUTH_FRAMES   = 30;
const HEAD_FRAMES    = 25;
const ABSENCE_FRAMES = 30;
const MAR_THRESH     = 0.70;
const MAR_FRAMES     = 16;
const HEAD_THRESH    = 15;
const YAW_THRESH     = 20.0;
const YAW_ASSIST     = 15.0;
const PITCH_THRESH   = 28.0;
const ROLL_THRESH    = 25.0;
const GAZE_THRESH    = 0.015;
const CALIB_FRAMES   = 90;
const TOTAL_CHECKS   = 4;

const PERCLOS_WINDOW_SEC = 60;
const PERCLOS_WARNING = 0.20;
const PERCLOS_DROWSY = 0.30;
const MOE_THRESH = 2.0;
const MOE_SEC = 3.0;

const WARNING_WINDOW_MIN = 10;
const WARNING_MAX_COUNT = 3;
const WARNING_SEC = 15.0;
const DROWSY_SEC = 30.0;
const RECOVER_FOCUSED_SEC = 2.0;
const DISTRACTED_SEC = 3.0;
const DISTRACTED_RECOVER_SEC = 1.5;
const ABSENT_SEC = 3.0;
const FACE_MISSING_SLEEP_SEC = 0.5;
const DISTRACTED_ABSENT_SEC = 6.0;
const STARTUP_GRACE_SEC = 2.0;

// ── 5단계 상태 정의 ───────────────────────────
const STATES = {
  FOCUSED: 'focused',
  DISTRACTED: 'distracted',
  WARNING: 'warning',
  DROWSY: 'drowsy',
  ABSENT: 'absent',
};

const STATUS_UI = {
  [STATES.FOCUSED]:    { text: '🟢 집중',      bg: 'rgba(0,0,0,0.6)' },
  [STATES.DISTRACTED]: { text: '🟠 주의 산만', bg: 'rgba(249,115,22,0.85)' },
  [STATES.WARNING]:    { text: '🟡 졸음 의심', bg: 'rgba(245,158,11,0.85)' },
  [STATES.DROWSY]:     { text: '🔴 졸음 확정', bg: 'rgba(239,68,68,0.85)' },
  [STATES.ABSENT]:     { text: '🚶 자리 이탈', bg: 'rgba(107,114,128,0.85)' },
};

const L_EYE = [362, 385, 387, 263, 373, 380];
const R_EYE = [33,  160, 158, 133, 153, 144];
const MOUTH = [13,  14,  17,  18,  78,  308];
const L_IRIS = 473;
const R_IRIS = 468;

// ── DOM ───────────────────────────────────────
const videoEl  = document.getElementById('my-video');
const canvasEl = document.getElementById('my-canvas');
const ctx      = canvasEl.getContext('2d');
const calibCV  = document.getElementById('calib-canvas');
const calibCtx = calibCV.getContext('2d');

// ── 상태 변수 ─────────────────────────────────
let micOn = true, camOn = true;
let elapsed = 0, timerInterval;
let checkedCount = 0;
let cameraInstance = null;
let dailyCall = null;
let ws = null;
let captionViewerWs = null;
let captionClearTimer = null;
let sleepAlertInterval = null;
let sleepAlertActive = false;

// 감지 상태 및 카운터
let currentState = STATES.FOCUSED;
let eyeCount = 0, mouthCount = 0, headCount = 0, absenceCount = 0;
let drowsyCnt = 0, yawnCnt = 0, headCnt2 = 0;
let prevEyeAlert = false, prevYawnAlert = false, prevHeadAlert = false;

let eyeClosedElapsed = 0;
let eyeOpenElapsed = 0;
let focusedElapsed = 0;
let distractedElapsed = 0;
let moeElapsed = 0;
let perclosSamples = [];
let warningTimes = [];
let absentStartedAt = null;
let warningCount = 0;
let headCalib = [];
let headBase = { yaw: 0, pitch: 0, roll: 0 };
let calibEndedAt = null;
let lastDistractedAt = null;

// 하품 누적
let yawnFrameCount  = 0;
let yawnCandidate   = false;

// 캘리브레이션
let calibEars = [], isCalib = true, EAR_THRESH = 0.20;
let calibMars = [], MAR_DYNAMIC_THRESH = MAR_THRESH;
let calibStartedAt = null;

const IS_LOCAL_HOST = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const BACKEND_URL = IS_LOCAL_HOST
  ? 'http://127.0.0.1:8000'
  : 'https://sleepdetection-production.up.railway.app';

function getWsBaseUrl() {
  return BACKEND_URL.replace('https://', 'wss://').replace('http://', 'ws://');
}

// ── 자막 ─────────────────────────────────────
function renderCaption(text, speaker = '강사') {
  const captionEl = document.getElementById('student-live-caption');
  if (!captionEl) return;
  captionEl.textContent = `${speaker}: ${text}`;
  captionEl.classList.add('show');
  clearTimeout(captionClearTimer);
  captionClearTimer = setTimeout(() => {
    captionEl.classList.remove('show');
    captionEl.textContent = '';
  }, 5000);
}

function connectCaptionViewer(roomCode = 'GLOBAL') {
  if (captionViewerWs) captionViewerWs.close();
  const path = roomCode === 'GLOBAL'
    ? `${getWsBaseUrl()}/ws/caption-view`
    : `${getWsBaseUrl()}/ws/caption-view/${encodeURIComponent(roomCode)}`;
  captionViewerWs = new WebSocket(path);
  captionViewerWs.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'caption' && payload.text) {
      renderCaption(payload.text, payload.speaker || '강사');
    }
  };
}

// ── TTS 졸음 알림 ─────────────────────────────
function speakSleepAlert() {
  if (!('speechSynthesis' in window)) return;
  if (speechSynthesis.speaking) return;
  const utter = new SpeechSynthesisUtterance('졸음이 감지되었습니다.');
  utter.lang = 'ko-KR';
  speechSynthesis.speak(utter);
}

function startSleepAlert() {
  if (sleepAlertActive) return;
  sleepAlertActive = true;
  speakSleepAlert();
  sleepAlertInterval = setInterval(() => {
    if (!sleepAlertActive) return;
    speakSleepAlert();
  }, 5000);
}

function stopSleepAlert() {
  sleepAlertActive = false;
  if (sleepAlertInterval) {
    clearInterval(sleepAlertInterval);
    sleepAlertInterval = null;
  }
  if ('speechSynthesis' in window) {
    speechSynthesis.cancel();
  }
}

// ── 계산 함수 (Robust EAR, MAR, HeadPose) ─────
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function calcEAR(lm, idx) {
  return (dist(lm[idx[1]], lm[idx[5]]) + dist(lm[idx[2]], lm[idx[4]])) / (2 * dist(lm[idx[0]], lm[idx[3]]));
}

function calcMAR(lm, idx) {
  const tm = { x: (lm[idx[0]].x + lm[idx[1]].x) / 2, y: (lm[idx[0]].y + lm[idx[1]].y) / 2 };
  const bm = { x: (lm[idx[2]].x + lm[idx[3]].x) / 2, y: (lm[idx[2]].y + lm[idx[3]].y) / 2 };
  return dist(tm, bm) / dist(lm[idx[4]], lm[idx[5]]);
}

function calcHeadPoseProxy(lm) {
  const leftEye = lm[33];
  const rightEye = lm[263];
  const nose = lm[1];
  const forehead = lm[10];
  const chin = lm[152];
  const mouthCenter = {
    x: (lm[13].x + lm[14].x + lm[17].x + lm[18].x) / 4,
    y: (lm[13].y + lm[14].y + lm[17].y + lm[18].y) / 4,
  };

  const eyeCenter = {
    x: (leftEye.x + rightEye.x) / 2,
    y: (leftEye.y + rightEye.y) / 2,
  };

  const faceWidth = Math.max(Math.abs(lm[454].x - lm[234].x), 1e-6);
  const faceHeight = Math.max(Math.abs(chin.y - forehead.y), 1e-6);

  const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x) * 180 / Math.PI;
  const yaw = ((nose.x - eyeCenter.x) / faceWidth) * 120;
  const pitchBase = ((mouthCenter.y - eyeCenter.y) / faceHeight) - 0.18;
  const pitch = pitchBase * 180;

  return { yaw, pitch, roll };
}

function calcGazeScore(lm, eyeIdx, irisIdx) {
  const iris = lm[irisIdx];
  const xs = eyeIdx.map(i => lm[i].x);
  const ys = eyeIdx.map(i => lm[i].y);
  const eyeCenter = {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
  const eyeWidth = Math.max(Math.max(...xs) - Math.min(...xs), 1e-6);
  return dist(iris, eyeCenter) / (eyeWidth * 5.0);
}

function calcGazeProxy(lm) {
  const left = calcGazeScore(lm, L_EYE, L_IRIS);
  const right = calcGazeScore(lm, R_EYE, R_IRIS);
  return (left + right) / 2;
}

// ── canvas 크기 동기화 ────────────────────────
function syncCanvasSize() {
  const w = videoEl.offsetWidth, h = videoEl.offsetHeight;
  if (w > 0 && h > 0 && (canvasEl.width !== w || canvasEl.height !== h)) {
    canvasEl.width = w; canvasEl.height = h;
  }
}

// ── 캘리브레이션 프리뷰 ───────────────────────
function drawCalibFrame(lm) {
  const cw = calibCV.width, ch = calibCV.height;
  if (!cw || !ch) return;
  calibCtx.clearRect(0, 0, cw, ch);

  const vw = videoEl.videoWidth || 1280;
  const vh = videoEl.videoHeight || 720;

  const m = 0.13;
  const pts = [...L_EYE, ...R_EYE, 10, 152, 234, 454];
  const xs = pts.map(i => lm[i].x), ys = pts.map(i => lm[i].y);
  const fx  = Math.max(0, Math.min(...xs) - m);
  const fy  = Math.max(0, Math.min(...ys) - m * 1.5);
  const fx2 = Math.min(1, Math.max(...xs) + m);
  const fy2 = Math.min(1, Math.max(...ys) + m);
  const fw  = fx2 - fx, fh = fy2 - fy;

  try {
    calibCtx.drawImage(videoEl, fx * vw, fy * vh, fw * vw, fh * vh, 0, 0, cw, ch);
  } catch { return; }

  const img  = calibCtx.getImageData(0, 0, cw, ch);
  const flip = calibCtx.createImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const s = (y * cw + x) * 4, d = (y * cw + (cw - 1 - x)) * 4;
      flip.data[d]   = img.data[s];
      flip.data[d+1] = img.data[s+1];
      flip.data[d+2] = img.data[s+2];
      flip.data[d+3] = img.data[s+3];
    }
  }
  calibCtx.putImageData(flip, 0, 0);

  [[L_EYE, '#63b3ed', '왼눈'], [R_EYE, '#a78bfa', '오른눈']].forEach(([idx, color, label]) => {
    const exs = idx.map(i => (fx2 - lm[i].x) / fw * cw);
    const eys = idx.map(i => (lm[i].y - fy)   / fh * ch);
    const ex1 = Math.min(...exs) - 5, ey1 = Math.min(...eys) - 5;
    const ebw = Math.max(...exs) - Math.min(...exs) + 10;
    const ebh = Math.max(...eys) - Math.min(...eys) + 10;
    calibCtx.strokeStyle = color; calibCtx.lineWidth = 2.5;
    calibCtx.setLineDash([5, 3]); calibCtx.strokeRect(ex1, ey1, ebw, ebh);
    calibCtx.setLineDash([]);
    calibCtx.fillStyle = color; calibCtx.font = 'bold 12px sans-serif';
    calibCtx.fillText(label, ex1, Math.max(14, ey1 - 4));
  });

  const mxs = MOUTH.map(i => (fx2 - lm[i].x) / fw * cw);
  const mys = MOUTH.map(i => (lm[i].y - fy) / fh * ch);
  const mx1 = Math.min(...mxs) - 5, my1 = Math.min(...mys) - 5;
  const mbw = Math.max(...mxs) - Math.min(...mxs) + 10;
  const mbh = Math.max(...mys) - Math.min(...mys) + 10;
  calibCtx.strokeStyle = '#f59e0b';
  calibCtx.lineWidth = 2.5;
  calibCtx.setLineDash([5, 3]);
  calibCtx.strokeRect(mx1, my1, mbw, mbh);
  calibCtx.setLineDash([]);
  calibCtx.fillStyle = '#f59e0b';
  calibCtx.font = 'bold 12px sans-serif';
  calibCtx.fillText('입', mx1, Math.max(14, my1 - 4));

  const sy = (Date.now() % 1500) / 1500 * ch;
  const g  = calibCtx.createLinearGradient(0, sy - 12, 0, sy + 12);
  g.addColorStop(0, 'rgba(99,179,237,0)');
  g.addColorStop(0.5, 'rgba(99,179,237,0.28)');
  g.addColorStop(1, 'rgba(99,179,237,0)');
  calibCtx.fillStyle = g;
  calibCtx.fillRect(0, sy - 12, cw, 24);
}

// ── 뱃지 업데이트 ─────────────────────────────
function updateBadge(id, count, icon, label) {
  const el = document.getElementById('badge-' + id);
  if (!el) return;
  el.textContent = `${icon} ${label} ${count}회`;
  el.className = count === 0 ? 'detect-badge' : count <= 2 ? 'detect-badge warn' : 'detect-badge alert';
}

// ── 배터리 업데이트 ───────────────────────────
function updateBattery() {
  const fill = document.getElementById('battery-fill');
  const pct  = document.getElementById('battery-pct');
  if (!fill || !pct) return;
  const stateBase = {
    [STATES.FOCUSED]: 100,
    [STATES.DISTRACTED]: 75,
    [STATES.WARNING]: 50,
    [STATES.DROWSY]: 20,
    [STATES.ABSENT]: 0,
  }[currentState] ?? 100;
  const score   = stateBase;
  fill.className   = 'battery-fill';
  fill.style.width = score + '%';
  pct.textContent  = score + '%';
  if (currentState === STATES.DROWSY || currentState === STATES.ABSENT || score <= 40) {
    fill.classList.add('alert');
  } else if (currentState === STATES.WARNING || currentState === STATES.DISTRACTED || score <= 70) {
    fill.classList.add('warn');
  }
  pct.style.color = score <= 30 ? 'var(--accent-red)'
                  : score <= 60 ? 'var(--accent-yellow)'
                  : 'var(--text-secondary)';
}

// ── 상태 업데이트 (공통) ──────────────────────
function applyState(newState) {
  if (currentState === newState) return;
  const prev = currentState;
  currentState = newState;
  
  setStatus(STATUS_UI[newState].text, STATUS_UI[newState].bg);
  updateBattery();

  // 타일 테두리
  const wrap = document.getElementById('tile-me');
  wrap?.classList.toggle('drowsy-alert', newState === STATES.DROWSY);

  // TTS
  if (newState === STATES.DROWSY) {
    startSleepAlert();
  } else if (prev === STATES.DROWSY && newState === STATES.FOCUSED) {
    stopSleepAlert();
  }

  // warning 누적 (WARNING 진입 시)
  if (newState === STATES.WARNING && prev !== STATES.WARNING) {
    const nowSec = performance.now() / 1000;
    warningTimes.push(nowSec);
    warningTimes = warningTimes.filter(t => nowSec - t < WARNING_WINDOW_MIN * 60);
    warningCount = warningTimes.length;
  }
}

// ── MediaPipe 결과 처리 (핵심 탐지 알고리즘) ──
function onResults(results) {
  syncCanvasSize();
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

  // 1. 얼굴 없음 (자리이탈 판단 및 방어)
  if (!results.multiFaceLandmarks?.length) {
    const nowSec = performance.now() / 1000;
    if (!onResults._lastFrameTs) onResults._lastFrameTs = nowSec;
    onResults._lastFrameTs = nowSec;
    if (absentStartedAt === null) absentStartedAt = nowSec;
    const absentSec = nowSec - absentStartedAt;
    
    if (++absenceCount >= ABSENCE_FRAMES) {
      const recentDistractedContext =
        lastDistractedAt !== null && (nowSec - lastDistractedAt) < DISTRACTED_RECOVER_SEC;
      const likelyDrowsy =
        currentState === STATES.WARNING ||
        currentState === STATES.DROWSY ||
        eyeClosedElapsed > 0.6 ||
        warningCount >= WARNING_MAX_COUNT;

      if (likelyDrowsy && absentSec >= FACE_MISSING_SLEEP_SEC) {
        applyState(STATES.DROWSY);
      } else if (absentSec >= ABSENT_SEC) {
        applyState(STATES.ABSENT);
      } else if (recentDistractedContext && absentSec < DISTRACTED_ABSENT_SEC) {
        applyState(STATES.DISTRACTED);
      }
    }
    return;
  }

  absenceCount = 0;
  absentStartedAt = null;
  const lm = results.multiFaceLandmarks[0];
  const nowSec = performance.now() / 1000;
  const elapsedSec = onResults._lastFrameTs ? Math.min(nowSec - onResults._lastFrameTs, 0.25) : 0.033;
  onResults._lastFrameTs = nowSec;

  const lEAR   = calcEAR(lm, L_EYE);
  const rEAR   = calcEAR(lm, R_EYE);
  const avgEAR = (lEAR + rEAR) / 2;
  const marVal = calcMAR(lm, MOUTH);
  const { yaw, pitch, roll } = calcHeadPoseProxy(lm);
  const gaze = calcGazeProxy(lm);

  // 2. 캘리브레이션
  if (isCalib) {
    calibEars.push(avgEAR);
    calibMars.push(marVal);
    if (calibCV.width === 0 && calibCV.offsetWidth > 0) {
      calibCV.width  = calibCV.offsetWidth;
      calibCV.height = calibCV.offsetHeight;
    }
    const pct = calibEars.length / CALIB_FRAMES;
    const barEl = document.getElementById('calib-bar');
    const pctEl = document.getElementById('calib-percent');
    if (barEl) barEl.style.width = (pct * 100) + '%';
    if (pctEl) pctEl.textContent = Math.round(pct * 100) + '%';
    drawCalibFrame(lm);
    
    if (calibEars.length >= CALIB_FRAMES) {
      EAR_THRESH = (calibEars.reduce((a, b) => a + b) / calibEars.length) * 0.75;
      if (calibMars.length > 0) {
        const marAvg = calibMars.reduce((a, b) => a + b, 0) / calibMars.length;
        MAR_DYNAMIC_THRESH = Math.max(0.55, Math.min(0.9, marAvg * 1.6));
      }
      if (headCalib.length > 0) {
        headBase = headCalib.reduce(
          (acc, cur) => ({
            yaw: acc.yaw + cur.yaw / headCalib.length,
            pitch: acc.pitch + cur.pitch / headCalib.length,
            roll: acc.roll + cur.roll / headCalib.length,
          }), { yaw: 0, pitch: 0, roll: 0 }
        );
      }
      isCalib = false;
      calibEndedAt = nowSec;
      warningTimes = [];
      warningCount = 0;
      document.getElementById('calibration-overlay').style.display = 'none';
      console.log('캘리브레이션 완료. EAR_THRESH:', EAR_THRESH.toFixed(3), 'MAR_THRESH:', MAR_DYNAMIC_THRESH.toFixed(3));
    }
    headCalib.push({ yaw, pitch, roll });
    return;
  }

  // 3. 실시간 판정 (타이머 누적)
  const yawAdj = yaw - headBase.yaw;
  const pitchAdj = pitch - headBase.pitch;
  const rollAdj = roll - headBase.roll;
  const startupGrace = calibEndedAt !== null && (nowSec - calibEndedAt) < STARTUP_GRACE_SEC;
  const moe = marVal / (avgEAR + 1e-6);

  const eyeClosedNow = avgEAR < EAR_THRESH;
  if (eyeClosedNow) {
    eyeClosedElapsed += elapsedSec;
    eyeOpenElapsed = 0;
  } else {
    eyeOpenElapsed += elapsedSec;
    eyeClosedElapsed = 0;
  }

  const yawnCandidate = marVal > MAR_DYNAMIC_THRESH && Math.abs(yawAdj) <= 18 && Math.abs(rollAdj) <= 20;
  mouthCount = yawnCandidate ? mouthCount + 1 : 0;
  const yawnAlert = mouthCount >= MAR_FRAMES;

  const lookingAwayNow = gaze > GAZE_THRESH;
  const pitchDistractedNow = Math.abs(pitchAdj) > PITCH_THRESH && lookingAwayNow;
  const headDistractedNow = !startupGrace && (
      Math.abs(yawAdj) > YAW_THRESH ||
      Math.abs(rollAdj) > ROLL_THRESH ||
      pitchDistractedNow
  );
  
  const distractedNow = headDistractedNow || (Math.abs(yawAdj) > YAW_ASSIST && lookingAwayNow);
  
  if (eyeClosedNow || yawnAlert || distractedNow) focusedElapsed = 0;
  else focusedElapsed += elapsedSec;
  
  distractedElapsed = distractedNow ? distractedElapsed + elapsedSec : 0;
  if (distractedNow) lastDistractedAt = nowSec;
  
  moeElapsed = (moe > MOE_THRESH && marVal > MAR_DYNAMIC_THRESH && !eyeClosedNow) ? moeElapsed + elapsedSec : 0;
  const moeAlert = moeElapsed >= MOE_SEC;

  // PERCLOS 및 Warning
  perclosSamples.push({ t: nowSec, closed: eyeClosedNow });
  perclosSamples = perclosSamples.filter(sample => nowSec - sample.t <= PERCLOS_WINDOW_SEC);
  warningTimes = warningTimes.filter(t => nowSec - t <= WARNING_WINDOW_MIN * 60);
  warningCount = warningTimes.length;
  const repeatedWarningRisk = warningCount >= WARNING_MAX_COUNT;

  if (eyeClosedNow && !prevEyeAlert) { drowsyCnt++; updateBadge('eye', drowsyCnt, '👁', '눈감음'); prevEyeAlert = true; }
  else if (!eyeClosedNow) { prevEyeAlert = false; }
  if (yawnAlert && !prevYawnAlert) { yawnCnt++; updateBadge('yawn', yawnCnt, '👄', '하품'); prevYawnAlert = true; }
  else if (!yawnAlert) { prevYawnAlert = false; }
  
  // 4. 상태 머신
  let nextState = STATES.FOCUSED;
  if (eyeClosedElapsed >= DROWSY_SEC || (repeatedWarningRisk && eyeClosedElapsed >= WARNING_SEC)) {
    nextState = STATES.DROWSY;
  } else if (currentState === STATES.DROWSY && eyeOpenElapsed < RECOVER_FOCUSED_SEC) {
    nextState = STATES.DROWSY;
  } else if (currentState === STATES.DROWSY && eyeOpenElapsed >= RECOVER_FOCUSED_SEC) {
    nextState = STATES.FOCUSED;
  } else if (eyeClosedElapsed >= WARNING_SEC || (yawnAlert && moeAlert)) {
    nextState = STATES.WARNING;
  } else if (distractedElapsed >= DISTRACTED_SEC) {
    nextState = STATES.DISTRACTED;
  } else if (currentState === STATES.DISTRACTED && focusedElapsed < DISTRACTED_RECOVER_SEC) {
    nextState = STATES.DISTRACTED;
  }

  if (nextState === STATES.FOCUSED && eyeOpenElapsed >= RECOVER_FOCUSED_SEC) {
    warningTimes = [];
    warningCount = 0;
  }

  applyState(nextState);

  // 시각화
  if (!onResults._t || Date.now() - onResults._t > 1000) {
    sendDetectionData(currentState, avgEAR, marVal, drowsyCnt, yawnCnt, headCnt2);
    onResults._t = Date.now();
  }
}

function setStatus(text, bg) {
  const el = document.getElementById('my-status-badge');
  if (!el) return;
  el.textContent = text;
  el.style.background = bg;
}

function drawBox(lm, idx, color, label) {
  const w = canvasEl.width, h = canvasEl.height;
  const xs = idx.map(i => lm[i].x * w), ys = idx.map(i => lm[i].y * h);
  const x1 = Math.min(...xs) - 5, y1 = Math.min(...ys) - 5;
  const bw = Math.max(...xs) - Math.min(...xs) + 10;
  const bh = Math.max(...ys) - Math.min(...ys) + 10;
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.strokeRect(x1, y1, bw, bh);
  ctx.save(); ctx.scale(-1, 1);
  ctx.fillStyle = color; ctx.font = 'bold 11px sans-serif';
  ctx.fillText(label, -(x1 + bw), y1 - 3);
  ctx.restore();
}

// ── 카메라 + MediaPipe 시작 ───────────────────
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false
    });
    videoEl.srcObject = stream;

    videoEl.onloadedmetadata = () => {
      if (calibCV.offsetWidth > 0) {
        calibCV.width  = calibCV.offsetWidth;
        calibCV.height = calibCV.offsetHeight;
      }
    };

    const faceMesh = new FaceMesh({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`
    });
    faceMesh.setOptions({
      maxNumFaces: 1, refineLandmarks: true,
      minDetectionConfidence: 0.6, minTrackingConfidence: 0.6
    });
    faceMesh.onResults(onResults);

    cameraInstance = new Camera(videoEl, {
      onFrame: async () => {
        if (isCalib && calibCV.width === 0 && calibCV.offsetWidth > 0) {
          calibCV.width  = calibCV.offsetWidth;
          calibCV.height = calibCV.offsetHeight;
        }
        await faceMesh.send({ image: videoEl });
      },
      width: 1280, height: 720
    });
    cameraInstance.start();
    document.getElementById('cam-off-overlay').style.display = 'none';
  } catch {
    showToast('⚠️ 카메라 권한을 허용해주세요.');
    document.getElementById('cam-off-overlay').style.display    = 'flex';
    document.getElementById('calibration-overlay').style.display = 'none';
  }
}

// ── 타이머 ────────────────────────────────────
function startTimer() {
  timerInterval = setInterval(() => {
    elapsed++;
    const el = document.getElementById('timer');
    if (el) el.textContent = `🕐 ${pad2(Math.floor(elapsed / 60))}:${pad2(elapsed % 60)}`;
  }, 1000);
}

// ── 컨트롤 ───────────────────────────────────
function toggleMic() {
  micOn = !micOn;
  const btn = document.getElementById('mic-btn');
  if (!btn) return;
  btn.querySelector('.icon').textContent  = micOn ? '🎙️' : '🔇';
  btn.querySelector('.label').textContent = micOn ? '마이크' : '음소거';
  btn.classList.toggle('off', !micOn);
}

function toggleCam() {
  camOn = !camOn;
  const btn = document.getElementById('cam-btn');
  if (!btn) return;
  btn.querySelector('.icon').textContent  = camOn ? '📹' : '📷';
  btn.querySelector('.label').textContent = camOn ? '카메라' : '카메라 꺼짐';
  btn.classList.toggle('off', !camOn);
  videoEl.style.display = canvasEl.style.display = camOn ? 'block' : 'none';
  document.getElementById('cam-off-overlay').style.display = camOn ? 'none' : 'flex';
  camOn ? cameraInstance?.start() : cameraInstance?.stop();
}

function leaveRoom() {
  clearInterval(timerInterval);
  videoEl.srcObject?.getTracks().forEach(t => t.stop());
  dailyCall?.leave();
  if (captionViewerWs) captionViewerWs.close();
  goTo('login');
}

// ── 온보딩 ───────────────────────────────────
function handleCheck(input, idx) {
  const item = document.getElementById('check-item-' + idx);
  if (!item) return;
  item.classList.toggle('checked', input.checked);
  checkedCount += input.checked ? 1 : -1;

  const pct   = (checkedCount / TOTAL_CHECKS) * 100;
  const fill  = document.getElementById('ob-progress-fill');
  const text  = document.getElementById('ob-progress-text');
  const btn   = document.getElementById('ob-confirm-btn');
  const btext = document.getElementById('ob-btn-text');

  if (fill)  fill.style.width  = pct + '%';
  if (text)  text.textContent  = checkedCount + ' / ' + TOTAL_CHECKS + ' 확인됨';
  if (btn)   btn.disabled      = checkedCount < TOTAL_CHECKS;
  if (btext) btext.textContent = checkedCount === TOTAL_CHECKS ? '수업 입장하기' : '모두 확인 후 입장 가능합니다';
}

function confirmOnboarding() {
  if (checkedCount < TOTAL_CHECKS) return;
  const userName = sessionStorage.getItem('userName') || '나';
  const userRole = sessionStorage.getItem('userRole') || 'student';

  document.getElementById('onboarding-overlay').style.display  = 'none';
  document.getElementById('calibration-overlay').style.display = 'flex';

  fetch('assets/videos/lecture.mp4', { method: 'HEAD' })
    .then(r => {
      if (r.ok) {
        const v = document.getElementById('instructor-video');
        const f = document.getElementById('instructor-fallback');
        if (v) { v.src = 'assets/videos/lecture.mp4'; v.style.display = 'block'; }
        if (f) f.style.display = 'none';
      }
    }).catch(() => {});

  const roomCode = sessionStorage.getItem('roomCode') || 'GLOBAL';
  connectCaptionViewer(roomCode);
  joinDailyRoom(userName, userRole);
  startCamera();
  startTimer();
}

// ── Daily.co ─────────────────────────────────
async function joinDailyRoom(userName, role) {
  try {
    const roomCode = sessionStorage.getItem('roomCode') || 'LION-2025';
    const res = await fetch(
      `${BACKEND_URL}/api/room-token?user_name=${encodeURIComponent(userName)}&room_code=${encodeURIComponent(roomCode)}&role=${role}`
    );
    if (!res.ok) throw new Error('토큰 발급 실패');
    const { token, room_url } = await res.json();

    dailyCall = DailyIframe.createCallObject({ audioSource: false, videoSource: true });
    await dailyCall.join({ url: room_url, token });
    try { await dailyCall.setLocalVideo(true); } catch {}

    dailyCall
      .on('participant-joined',  onParticipantJoined)
      .on('participant-updated', onParticipantUpdated)
      .on('participant-left',    e => removePeerTile(e.participant.session_id))
      .on('track-started',       onTrackStarted);

    const existing = dailyCall.participants();
    Object.values(existing).forEach(p => {
      if (p.local) return;
      if (p.owner) {
        attachInstructorVideo(p);
      } else {
        addPeerTile(p.session_id, p.user_name || '참여자');
      }
      const videoTrack = p.tracks?.video?.track;
      if (videoTrack) {
        if (p.owner) {
          const v = document.getElementById('instructor-video');
          const f = document.getElementById('instructor-fallback');
          if (v) { v.srcObject = new MediaStream([videoTrack]); v.style.display = 'block'; if (f) f.style.display = 'none'; }
        } else {
          const pv = document.getElementById('peer-video-' + p.session_id);
          const pf = document.getElementById('peer-fallback-' + p.session_id);
          if (pv) { pv.srcObject = new MediaStream([videoTrack]); pv.style.display = 'block'; if (pf) pf.style.display = 'none'; }
        }
      }
    });
    console.log('Daily.co 입장 완료');
  } catch (e) { console.warn('Daily.co 연결 실패:', e.message); }
}

function onParticipantJoined(e) {
  if (e.participant.local) return;
  const { session_id: sid, user_name: name = '참여자', owner } = e.participant;
  if (owner) attachInstructorVideo(e.participant);
  else addPeerTile(sid, name);
}

function onParticipantUpdated(e) {
  if (e.participant.local) return;
  if (e.participant.owner) attachInstructorVideo(e.participant);
}

function onTrackStarted(e) {
  if (e.participant.local) return;
  if (e.track.kind !== 'video') return;
  const sid = e.participant.session_id;

  if (e.participant.owner) {
    const instVideo    = document.getElementById('instructor-video');
    const instFallback = document.getElementById('instructor-fallback');
    if (instVideo) {
      instVideo.srcObject = new MediaStream([e.track]);
      instVideo.style.display = 'block';
      if (instFallback) instFallback.style.display = 'none';
    }
  } else {
    const peerVideo    = document.getElementById('peer-video-' + sid);
    const peerFallback = document.getElementById('peer-fallback-' + sid);
    if (peerVideo) {
      peerVideo.srcObject = new MediaStream([e.track]);
      peerVideo.style.display = 'block';
      if (peerFallback) peerFallback.style.display = 'none';
    }
  }
}

function attachInstructorVideo(participant) {
  const videoTrack = participant.tracks?.video?.track;
  if (!videoTrack) return;
  const instVideo    = document.getElementById('instructor-video');
  const instFallback = document.getElementById('instructor-fallback');
  if (instVideo) {
    instVideo.srcObject = new MediaStream([videoTrack]);
    instVideo.style.display = 'block';
    if (instFallback) instFallback.style.display = 'none';
  }
}

// peer 타일 — 고정 슬롯 방식
const peerSlotMap = {};

function addPeerTile(sid, name) {
  if (peerSlotMap[sid]) return;
  for (let i = 0; i < 2; i++) {
    const slot = document.getElementById('peer-slot-' + i);
    if (slot && !slot.dataset.sid) {
      slot.dataset.sid = sid;
      slot.classList.remove('tile-empty');
      peerSlotMap[sid] = 'peer-slot-' + i;

      const video = document.createElement('video');
      video.id = 'peer-video-' + sid;
      video.autoplay = true; video.muted = true; video.playsInline = true;
      video.style.cssText = 'display:none; width:100%; height:100%; object-fit:cover; position:absolute; inset:0; border-radius:inherit;';
      slot.prepend(video);

      const fallback = document.getElementById('peer-slot-' + i + '-fallback');
      if (fallback) {
        fallback.innerHTML = `<div class="peer-avatar">${name.charAt(0)}</div>`;
        fallback.id = 'peer-fallback-' + sid;
      }
      const label = document.getElementById('peer-slot-' + i + '-label');
      if (label) { label.textContent = name; label.style.display = ''; }

      const dot = document.createElement('div');
      dot.className = 'peer-status-dot'; dot.style.background = '#22c55e';
      slot.appendChild(dot);
      return;
    }
  }

  const container = document.getElementById('peer-container');
  if (!container || document.getElementById('peer-tile-' + sid)) return;
  const tile = document.createElement('div');
  tile.className = 'tile tile-peer'; tile.id = 'peer-tile-' + sid;
  tile.onclick = () => swapToMain('peer-tile-' + sid);
  tile.innerHTML = `
    <video id="peer-video-${sid}" autoplay muted playsinline
           style="display:none; width:100%; height:100%; object-fit:cover; position:absolute; inset:0; border-radius:inherit;"></video>
    <div class="tile-fallback peer-fallback" id="peer-fallback-${sid}">
      <div class="peer-avatar">${name.charAt(0)}</div>
    </div>
    <div class="tile-label">${name}</div>
    <div class="peer-status-dot" style="background:#22c55e;"></div>`;
  container.appendChild(tile);
  peerSlotMap[sid] = 'peer-tile-' + sid;
}

function removePeerTile(sid) {
  const slotId = peerSlotMap[sid];
  if (!slotId) return;
  if (slotId.startsWith('peer-slot-')) {
    const slot = document.getElementById(slotId);
    if (slot) {
      slot.dataset.sid = ''; slot.classList.add('tile-empty');
      document.getElementById('peer-video-' + sid)?.remove();
      const fallback = document.getElementById('peer-fallback-' + sid);
      if (fallback) {
        fallback.id = slotId + '-fallback';
        fallback.innerHTML = `<div class="peer-waiting"><div class="peer-waiting-icon">👤</div><div class="peer-waiting-text">대기 중</div></div>`;
      }
      const label = document.getElementById(slotId + '-label');
      if (label) { label.textContent = ''; label.style.display = 'none'; }
      slot.querySelector('.peer-status-dot')?.remove();
    }
  } else {
    document.getElementById(slotId)?.remove();
  }
  delete peerSlotMap[sid];
}

// ── WebSocket ─────────────────────────────────
function connectWebSocket(studentId) {
  try {
    const roomCode = sessionStorage.getItem('roomCode') || 'LION-2025';
    ws = new WebSocket(`${getWsBaseUrl()}/ws/student/${encodeURIComponent(studentId)}?room_code=${encodeURIComponent(roomCode)}`);
    ws.onopen  = () => console.log('WS 연결됨');
    ws.onclose = () => setTimeout(() => connectWebSocket(studentId), 3000);
    ws.onerror = e => console.warn('WS 오류:', e);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'room_closed') {
          showToast('📢 강사가 수업을 종료했습니다. 잠시 후 나갑니다.');
          setTimeout(() => {
            dailyCall?.leave();
            clearInterval(timerInterval);
            videoEl.srcObject?.getTracks().forEach(t => t.stop());
            goTo('login');
          }, 2000);
        }
        if (msg.type === 'stretch_start') startStretchMode();
        if (msg.type === 'chat') {
          appendChatMessage(msg);
          if (document.getElementById('chat-panel').style.display === 'none') showChatBadge();
        }
        if (msg.type === 'hand_raise') appendHandRaise(msg.sender);
        if (msg.type === 'break_start') startBreakMode(msg.duration || 300);
        if (msg.type === 'break_end') endBreakMode();
      } catch {}
    };
  } catch (e) { console.warn('WebSocket 연결 실패:', e.message); }
}

function sendDetectionData(status, ear, mar, dc, yc, hc) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const name = sessionStorage.getItem('userName') || '익명';
  ws.send(JSON.stringify({
    student_id: name, name, status,
    ear: +ear.toFixed(2), mar: +mar.toFixed(2),
    drowsy_cnt: dc, yawn_cnt: yc, head_cnt: hc,
    warning_count: warningCount,
    timestamp: Date.now()
  }));
}

// ── 스트레칭 모드 ─────────────────────────────
function startStretchMode() {
  cameraInstance?.stop();
  const overlay = document.createElement('div');
  overlay.id = 'stretch-overlay';
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0,0,0,0.85);
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    color: white; font-family: sans-serif;
  `;
  overlay.innerHTML = `
    <div style="font-size:3rem; margin-bottom:1rem;">🧘</div>
    <div style="font-size:1.8rem; font-weight:bold; margin-bottom:0.5rem;">잠깐 스트레칭을 해봅시다!</div>
    <div style="font-size:1rem; color:#aaa; margin-bottom:2rem;">목, 어깨를 가볍게 풀어주세요</div>
    <div id="stretch-timer" style="font-size:4rem; font-weight:bold; color:#f97316;">5</div>
  `;
  document.body.appendChild(overlay);

  let count = 5;
  const interval = setInterval(() => {
    count--;
    const timerEl = document.getElementById('stretch-timer');
    if (timerEl) timerEl.textContent = count;
    if (count <= 0) {
      clearInterval(interval);
      overlay.remove();
      cameraInstance?.start();
    }
  }, 1000);
}

// ── 쉬는시간 모드 ─────────────────────────────
function startBreakMode(totalSeconds) {
  cameraInstance?.stop();
  stopSleepAlert();

  const utter = new SpeechSynthesisUtterance('쉬는시간입니다. 잠시 휴식을 취하세요.');
  utter.lang = 'ko-KR';
  speechSynthesis.speak(utter);

  const overlay = document.createElement('div');
  overlay.id = 'break-overlay';
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:9999;
    background:rgba(0,0,0,0.88);
    display:flex; flex-direction:column;
    align-items:center; justify-content:center;
    color:white; font-family:sans-serif;`;
  overlay.innerHTML = `
    <div style="font-size:3rem;margin-bottom:1rem;">☕</div>
    <div style="font-size:1.8rem;font-weight:bold;margin-bottom:0.5rem;">쉬는시간입니다!</div>
    <div style="font-size:1rem;color:#aaa;margin-bottom:2rem;">잠시 휴식을 취하세요 😊</div>
    <div id="break-student-timer" style="font-size:4rem;font-weight:bold;color:#f97316;font-family:monospace;">
      ${String(Math.floor(totalSeconds/60)).padStart(2,'0')}:${String(totalSeconds%60).padStart(2,'0')}
    </div>`;
  document.body.appendChild(overlay);

  let remaining = totalSeconds;
  window._breakInterval = setInterval(() => {
    remaining--;
    const el = document.getElementById('break-student-timer');
    if (el) el.textContent =
      `${String(Math.floor(remaining/60)).padStart(2,'0')}:${String(remaining%60).padStart(2,'0')}`;
    if (remaining <= 0) endBreakMode();
  }, 1000);
}

function endBreakMode() {
  clearInterval(window._breakInterval);
  document.getElementById('break-overlay')?.remove();
  cameraInstance?.start();

  const utter = new SpeechSynthesisUtterance('쉬는시간이 끝났습니다. 자리에 돌아와주세요.');
  utter.lang = 'ko-KR';
  speechSynthesis.speak(utter);
}

// ── 타일 스왑 ─────────────────────────────────
let currentMainId = 'tile-instructor';

function swapToMain(clickedId) {
  if (clickedId === currentMainId) return;
  const mainView   = document.getElementById('main-view');
  const rightPanel = document.getElementById('right-panel');
  const clicked    = document.getElementById(clickedId);
  const current    = document.getElementById(currentMainId);
  if (!clicked || !current) return;
  const ph = document.createElement('div');
  rightPanel.insertBefore(ph, clicked);
  clicked.classList.add('active-main');
  mainView.appendChild(clicked);
  current.classList.remove('active-main');
  rightPanel.insertBefore(current, ph);
  ph.remove();
  currentMainId = clickedId;
  requestAnimationFrame(syncCanvasSize);
}

// ── 초기화 ────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const userName = sessionStorage.getItem('userName') || '나';
  const roomCode = sessionStorage.getItem('roomCode') || '';

  const myLabel  = document.getElementById('my-name-label');
  const avatarSm = document.getElementById('my-avatar-sm');
  const classEl  = document.querySelector('.topbar-class');

  if (myLabel)  myLabel.textContent  = userName + ' (나)';
  if (avatarSm) avatarSm.textContent = userName.charAt(0);
  if (classEl && roomCode) classEl.textContent = '멋쟁이사자처럼 · ' + roomCode;

  connectWebSocket(userName);
  connectCaptionViewer(roomCode || 'GLOBAL');
});

window.addEventListener('beforeunload', () => {
  stopSleepAlert();
  if (captionViewerWs) captionViewerWs.close();
  clearInterval(timerInterval);
});

// ── 채팅 ─────────────────────────────────────
function toggleChat() {
  const panel = document.getElementById('chat-panel');
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'flex';
  if (!isOpen) hideChatBadge();
}

function sendChat() {
  const input = document.getElementById('chat-input');
  const text  = input.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  const name = sessionStorage.getItem('userName') || '나';
  ws.send(JSON.stringify({
    type: 'chat', sender: name, text,
    timestamp: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
  }));
  input.value = '';
}

function appendChatMessage(msg) {
  const myName  = sessionStorage.getItem('userName') || '나';
  const isInst  = msg.role === 'instructor';
  const isMine  = msg.sender === myName && !isInst;
  const cls     = isInst ? 'instructor' : 'mine'; 
  const senderLabel = isMine ? '' : `<div class="chat-msg-sender">${isInst ? '🎓 ' : ''}${msg.sender}</div>`;

  const div = document.createElement('div');
  div.className = `chat-msg ${cls}`;
  div.innerHTML = `${senderLabel}<div>${msg.text}</div><div style="font-size:9px;opacity:0.4;margin-top:3px;">${msg.timestamp || ''}</div>`;

  const messages = document.getElementById('chat-messages');
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function appendHandRaise(sender) {
  const div = document.createElement('div');
  div.className = 'chat-msg system';
  div.textContent = `🙋 ${sender} 학생이 손을 들었습니다`;
  const messages = document.getElementById('chat-messages');
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  if (document.getElementById('chat-panel').style.display === 'none') {
    showChatBadge();
  }
}

function showChatBadge() {
  const btn = document.getElementById('chat-btn');
  if (!btn.querySelector('.chat-badge')) {
    const badge = document.createElement('div');
    badge.className = 'chat-badge';
    btn.appendChild(badge);
  }
}

function hideChatBadge() {
  document.getElementById('chat-btn')?.querySelector('.chat-badge')?.remove();
}

// ── 손들기 ────────────────────────────────────
function raiseHand() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const name = sessionStorage.getItem('userName') || '나';
  ws.send(JSON.stringify({ type: 'hand_raise', sender: name }));
  showToast('🙋 손들기 전송!');

  const btn = document.getElementById('hand-btn');
  btn.classList.add('active');
  setTimeout(() => btn.classList.remove('active'), 3000);
}

window.addEventListener('resize', syncCanvasSize);
