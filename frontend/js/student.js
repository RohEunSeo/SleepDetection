// =============================================
// student.js — Sleep2Wake 수강생 수업 화면
// =============================================

// ── 상수 ──────────────────────────────────────
const CALIB_FRAMES   = 90;
const TOTAL_CHECKS   = 4;
const ABSENCE_FRAMES = 30;
const MAR_FRAMES     = 16;

const L_EYE  = [362, 385, 387, 263, 373, 380];
const R_EYE  = [33,  160, 158, 133, 153, 144];
const MOUTH  = [13,  14,  17,  18,  78,  308];
const L_IRIS = 473;
const R_IRIS = 468;

// ── 5단계 상태 정의 ───────────────────────────
const STATES = {
  FOCUSED:    'FOCUSED',
  DISTRACTED: 'DISTRACTED',
  WARNING:    'WARNING',
  DROWSY:     'DROWSY',
  ABSENT:     'ABSENT'
};

const STATUS_UI = {
  FOCUSED:    { text: '🟢 집중',     bg: 'rgba(34,197,94,0.8)'   },
  DISTRACTED: { text: '🟡 주의산만', bg: 'rgba(234,179,8,0.8)'   },
  WARNING:    { text: '🟠 졸음의심', bg: 'rgba(249,115,22,0.8)'  },
  DROWSY:     { text: '🔴 졸음확정', bg: 'rgba(239,68,68,0.8)'   },
  ABSENT:     { text: '⚫ 자리이탈', bg: 'rgba(100,116,139,0.8)' },
};

// ── 임계값 (노션 문서 기준) ────────────────────
const WARNING_SEC            = 15.0;   // 눈 감김 15초 → 졸음의심
const DROWSY_SEC             = 30.0;   // 눈 감김 30초 → 졸음확정
const RECOVER_FOCUSED_SEC    = 2.0;    // 눈 뜨고 2초 유지 → 집중 복귀
const DISTRACTED_SEC         = 3.0;    // 고개 3초 이상 → 주의산만
const DISTRACTED_RECOVER_SEC = 1.5;    // 고개 돌아오고 1.5초 → 집중 복귀
const ABSENT_SEC             = 3.0;    // 얼굴 없고 3초 → 자리이탈
const FACE_MISSING_SLEEP_SEC = 0.5;    // 졸음 상태에서 얼굴 사라지면 0.5초 → DROWSY 유지
const DISTRACTED_ABSENT_SEC  = 6.0;    // 주의산만 맥락에서 자리이탈 유예
const STARTUP_GRACE_SEC      = 2.0;    // 캘리브레이션 직후 2초 유예

// head pose 임계값
const YAW_THRESH   = 20.0;
const PITCH_THRESH = 28.0;
const ROLL_THRESH  = 25.0;
const YAW_ASSIST   = 15.0;
const GAZE_THRESH  = 0.015;

// warning 누적
const WARNING_MAX_COUNT = 3;
const WARNING_WINDOW_SEC = 600; // 10분

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

// 현재 상태
let currentState = STATES.FOCUSED;

// 감지 카운터
let absenceCount = 0;

// 누적 이벤트
let drowsyCnt = 0, yawnCnt = 0;

// 캘리브레이션
let calibEars = [], isCalib = true, EAR_THRESH = 0.20;
let calibMars = [], MAR_DYNAMIC_THRESH = 0.70;
let calibStartedAt = null;

// head pose
let yaw = 0, pitch = 0, roll = 0;
let headCalib = [];
let headBase  = { yaw: 0, pitch: 0, roll: 0 };

// 상태 유지/회복 타이머
let eyeClosedElapsed  = 0;
let eyeOpenElapsed    = 0;
let distractedElapsed = 0;
let absentStartedAt   = null;
let lastDistractedAt  = null;
let calibEndedAt      = null;

// warning 누적
let warningCount = 0;
let warningTimes = [];

// PERCLOS (60초 윈도우)
const PERCLOS_WINDOW_SEC = 60;
const PERCLOS_WARNING    = 0.20;
const PERCLOS_DROWSY     = 0.30;
let perclosSamples = []; // { ts, closed }

// 하품 누적
let yawnFrameCount  = 0;
let yawnCandidate   = false;
let prevYawnAlert   = false;

// MOE
const MOE_THRESH = 2.0;
const MOE_SEC    = 3.0;
let moeElapsed   = 0;

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
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

// ── 계산 함수 ─────────────────────────────────
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function calcEAR(lm, idx) {
  return (dist(lm[idx[1]], lm[idx[5]]) + dist(lm[idx[2]], lm[idx[4]])) / (2 * dist(lm[idx[0]], lm[idx[3]]));
}

function calcMAR(lm, idx) {
  const tm = { x: (lm[idx[0]].x + lm[idx[1]].x) / 2, y: (lm[idx[0]].y + lm[idx[1]].y) / 2 };
  const bm = { x: (lm[idx[2]].x + lm[idx[3]].x) / 2, y: (lm[idx[2]].y + lm[idx[3]].y) / 2 };
  return dist(tm, bm) / dist(lm[idx[4]], lm[idx[5]]);
}

// head pose 프록시 계산 (MediaPipe 랜드마크 기반)
function calcHeadPoseProxy(lm) {
  const nose   = lm[1];
  const left   = lm[234];
  const right  = lm[454];
  const top    = lm[10];
  const bottom = lm[152];

  const dx        = right.x - left.x;
  const dy        = right.y - left.y;
  const faceWidth = Math.hypot(dx, dy);

  const noseOffsetX = nose.x - (left.x + right.x) / 2;
  const noseOffsetY = nose.y - (top.y  + bottom.y) / 2;
  const faceHeight  = Math.hypot(bottom.x - top.x, bottom.y - top.y);

  return {
    yaw:   (noseOffsetX / (faceWidth  || 1)) * 90,
    pitch: (noseOffsetY / (faceHeight || 1)) * 90,
    roll:  Math.atan2(dy, dx) * 180 / Math.PI,
  };
}

// gaze score 계산
function calcGazeScore(lm) {
  try {
    const lIris  = lm[L_IRIS];
    const rIris  = lm[R_IRIS];
    const lInner = lm[L_EYE[0]], lOuter = lm[L_EYE[3]];
    const rInner = lm[R_EYE[0]], rOuter = lm[R_EYE[3]];
    const lGaze  = (lIris.x - lInner.x) / (dist(lInner, lOuter) || 1) - 0.5;
    const rGaze  = (rIris.x - rInner.x) / (dist(rInner, rOuter) || 1) - 0.5;
    return Math.abs((lGaze + rGaze) / 2);
  } catch { return 0; }
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

  const m   = 0.13;
  const pts = [...L_EYE, ...R_EYE, 10, 152, 234, 454];
  const xs  = pts.map(i => lm[i].x), ys = pts.map(i => lm[i].y);
  const fx  = Math.max(0, Math.min(...xs) - m);
  const fy  = Math.max(0, Math.min(...ys) - m * 1.5);
  const fx2 = Math.min(1, Math.max(...xs) + m);
  const fy2 = Math.min(1, Math.max(...ys) + m);
  const fw  = fx2 - fx, fh = fy2 - fy;

  try {
    calibCtx.drawImage(videoEl, fx * vw, fy * vh, fw * vw, fh * vh, 0, 0, cw, ch);
  } catch { return; }

  // 좌우 반전
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

  // 눈 박스
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

  // 입 박스
  const mxs = MOUTH.map(i => (fx2 - lm[i].x) / fw * cw);
  const mys = MOUTH.map(i => (lm[i].y - fy)   / fh * ch);
  const mx1 = Math.min(...mxs) - 5, my1 = Math.min(...mys) - 5;
  const mbw = Math.max(...mxs) - Math.min(...mxs) + 10;
  const mbh = Math.max(...mys) - Math.min(...mys) + 10;
  calibCtx.strokeStyle = '#f59e0b'; calibCtx.lineWidth = 2.5;
  calibCtx.setLineDash([5, 3]); calibCtx.strokeRect(mx1, my1, mbw, mbh);
  calibCtx.setLineDash([]);
  calibCtx.fillStyle = '#f59e0b'; calibCtx.font = 'bold 12px sans-serif';
  calibCtx.fillText('입', mx1, Math.max(14, my1 - 4));

  // 스캔 라인
  const sy = (Date.now() % 1500) / 1500 * ch;
  const g  = calibCtx.createLinearGradient(0, sy - 12, 0, sy + 12);
  g.addColorStop(0, 'rgba(99,179,237,0)');
  g.addColorStop(0.5, 'rgba(99,179,237,0.28)');
  g.addColorStop(1, 'rgba(99,179,237,0)');
  calibCtx.fillStyle = g;
  calibCtx.fillRect(0, sy - 12, cw, 24);
}

// ── 배터리 업데이트 ───────────────────────────
function updateBattery() {
  const fill = document.getElementById('battery-fill');
  const pct  = document.getElementById('battery-pct');
  if (!fill || !pct) return;
  const score = {
    [STATES.FOCUSED]:    100,
    [STATES.DISTRACTED]: 75,
    [STATES.WARNING]:    50,
    [STATES.DROWSY]:     20,
    [STATES.ABSENT]:     0,
  }[currentState] ?? 100;

  fill.className   = 'battery-fill';
  fill.style.width = score + '%';
  pct.textContent  = score + '%';

  if (currentState === STATES.DROWSY || currentState === STATES.ABSENT) {
    fill.classList.add('alert');
  } else if (currentState === STATES.WARNING || currentState === STATES.DISTRACTED) {
    fill.classList.add('warn');
  }
  pct.style.color = score <= 30 ? 'var(--accent-red)'
                  : score <= 60 ? 'var(--accent-yellow)'
                  : 'var(--text-secondary)';
}

// ── 상태 업데이트 (공통) ──────────────────────
function applyState(newState) {
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
    // 10분 이전 기록 제거
    warningTimes = warningTimes.filter(t => nowSec - t < WARNING_WINDOW_SEC);
    warningCount = warningTimes.length;
  }
}

// ── MediaPipe 결과 처리 ───────────────────────
function onResults(results) {
  syncCanvasSize();
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

  // ── 얼굴 없음 (자리이탈 판단) ────────────────
  if (!results.multiFaceLandmarks?.length) {
    const nowSec = performance.now() / 1000;
    if (absentStartedAt === null) absentStartedAt = nowSec;
    const absentSec = nowSec - absentStartedAt;

    if (++absenceCount >= ABSENCE_FRAMES) {
      const recentDistracted =
        lastDistractedAt !== null && (nowSec - lastDistractedAt) < DISTRACTED_ABSENT_SEC;
      const likelyDrowsy =
        currentState === STATES.WARNING ||
        currentState === STATES.DROWSY  ||
        eyeClosedElapsed > 0.6           ||
        warningCount >= WARNING_MAX_COUNT;

      if (likelyDrowsy && absentSec < FACE_MISSING_SLEEP_SEC) {
        applyState(STATES.DROWSY);
      } else if (absentSec >= ABSENT_SEC) {
        applyState(STATES.ABSENT);
      } else if (recentDistracted) {
        applyState(STATES.DISTRACTED);
      }
    }
    return;
  }

  // ── 얼굴 감지됨 ──────────────────────────────
  absenceCount    = 0;
  absentStartedAt = null;

  const lm     = results.multiFaceLandmarks[0];
  const nowSec = performance.now() / 1000;
  const dt     = onResults._prevTs ? Math.min(nowSec - onResults._prevTs, 0.2) : 0.033;
  onResults._prevTs = nowSec;

  const lEAR   = calcEAR(lm, L_EYE);
  const rEAR   = calcEAR(lm, R_EYE);
  const avgEAR = (lEAR + rEAR) / 2;
  const marVal = calcMAR(lm, MOUTH);

  // head pose
  const pose  = calcHeadPoseProxy(lm);
  const yawAdj   = pose.yaw   - headBase.yaw;
  const pitchAdj = pose.pitch - headBase.pitch;
  const rollAdj  = pose.roll  - headBase.roll;
  yaw = yawAdj; pitch = pitchAdj; roll = rollAdj;

  // ── 캘리브레이션 ─────────────────────────────
  if (isCalib) {
    if (!calibStartedAt) calibStartedAt = nowSec;
    calibEars.push(avgEAR);
    calibMars.push(marVal);
    headCalib.push({ yaw: pose.yaw, pitch: pose.pitch, roll: pose.roll });

    if (calibCV.width === 0 && calibCV.offsetWidth > 0) {
      calibCV.width  = calibCV.offsetWidth;
      calibCV.height = calibCV.offsetHeight;
    }
    const pct   = calibEars.length / CALIB_FRAMES;
    const barEl = document.getElementById('calib-bar');
    const pctEl = document.getElementById('calib-percent');
    if (barEl) barEl.style.width  = (pct * 100) + '%';
    if (pctEl) pctEl.textContent  = Math.round(pct * 100) + '%';
    drawCalibFrame(lm);

    if (calibEars.length >= CALIB_FRAMES) {
      // EAR 임계값: 상위 80% 평균 × 0.75
      const sorted = [...calibEars].sort((a, b) => b - a);
      const top80  = sorted.slice(0, Math.floor(sorted.length * 0.8));
      EAR_THRESH   = (top80.reduce((a, b) => a + b, 0) / top80.length) * 0.75;

      // MAR 동적 임계값
      if (calibMars.length > 0) {
        const marAvg = calibMars.reduce((a, b) => a + b, 0) / calibMars.length;
        MAR_DYNAMIC_THRESH = Math.max(0.55, Math.min(0.9, marAvg * 1.6));
      }

      // head base (개인 정면 기준)
      if (headCalib.length > 0) {
        headBase = headCalib.reduce(
          (acc, cur) => ({
            yaw:   acc.yaw   + cur.yaw   / headCalib.length,
            pitch: acc.pitch + cur.pitch / headCalib.length,
            roll:  acc.roll  + cur.roll  / headCalib.length,
          }),
          { yaw: 0, pitch: 0, roll: 0 }
        );
      }

      isCalib      = false;
      calibEndedAt = nowSec;
      document.getElementById('calibration-overlay').style.display = 'none';
      console.log('캘리브레이션 완료. EAR:', EAR_THRESH.toFixed(3), 'MAR:', MAR_DYNAMIC_THRESH.toFixed(3));
    }
    return;
  }

  // ── 캘리브레이션 직후 유예 (2초) ─────────────
  const inGrace = calibEndedAt !== null && (nowSec - calibEndedAt) < STARTUP_GRACE_SEC;

  // ── PERCLOS 업데이트 ─────────────────────────
  const eyeClosed = avgEAR < EAR_THRESH;
  perclosSamples.push({ ts: nowSec, closed: eyeClosed });
  perclosSamples = perclosSamples.filter(s => nowSec - s.ts < PERCLOS_WINDOW_SEC);
  const perclos = perclosSamples.length > 0
    ? perclosSamples.filter(s => s.closed).length / perclosSamples.length
    : 0;

  // ── 눈 감김 elapsed ───────────────────────────
  if (eyeClosed) {
    eyeClosedElapsed += dt;
    eyeOpenElapsed    = 0;
  } else {
    eyeOpenElapsed   += dt;
    eyeClosedElapsed  = 0;
  }

  // ── MOE (입+눈 조합) ──────────────────────────
  const moe = marVal / (avgEAR + 0.001);
  if (moe > MOE_THRESH) {
    moeElapsed += dt;
  } else {
    moeElapsed = 0;
  }

  // ── 하품 판정 (보수적) ────────────────────────
  const isFrontal = Math.abs(yaw) < 25 && Math.abs(roll) < 20;
  yawnCandidate   = marVal > MAR_DYNAMIC_THRESH && isFrontal;
  if (yawnCandidate) {
    yawnFrameCount++;
  } else {
    if (yawnFrameCount >= MAR_FRAMES && !prevYawnAlert) {
      yawnCnt++;
    }
    yawnFrameCount = 0;
  }
  const yawnAlert = yawnFrameCount >= MAR_FRAMES;
  if (!yawnAlert && prevYawnAlert) { /* 하품 종료 */ }
  prevYawnAlert = yawnAlert;

  // ── gaze ─────────────────────────────────────
  const gazeScore  = calcGazeScore(lm);
  const lookingAway = Math.abs(yaw) > YAW_ASSIST && gazeScore > GAZE_THRESH;

  // ── head pose 이탈 판단 ───────────────────────
  const headOut = !inGrace && (
    Math.abs(yaw)   > YAW_THRESH   ||
    Math.abs(pitch) > PITCH_THRESH ||
    Math.abs(roll)  > ROLL_THRESH  ||
    lookingAway
  );

  if (headOut) {
    distractedElapsed += dt;
    lastDistractedAt   = nowSec;
  } else {
    distractedElapsed  = Math.max(0, distractedElapsed - dt);
  }

  // ── repeatedWarningRisk ───────────────────────
  const repeatedWarningRisk = warningCount >= WARNING_MAX_COUNT;
  const warnSec   = repeatedWarningRisk ? WARNING_SEC * 0.7 : WARNING_SEC;
  const drowsySec = repeatedWarningRisk ? DROWSY_SEC  * 0.7 : DROWSY_SEC;

  // ── 상태 전이 (노션 문서 기준) ────────────────
  if (currentState === STATES.FOCUSED || currentState === STATES.DISTRACTED) {

    // 집중 → 졸음의심: 눈 감김 15초 or MOE 보조
    if (eyeClosedElapsed >= warnSec || moeElapsed >= MOE_SEC) {
      applyState(STATES.WARNING);
      eyeClosedElapsed = warnSec; // 초과분 유지

    // 집중 → 주의산만: 고개 3초 이상 이탈
    } else if (!inGrace && distractedElapsed >= DISTRACTED_SEC) {
      applyState(STATES.DISTRACTED);

    // 주의산만 → 집중 복귀
    } else if (currentState === STATES.DISTRACTED && distractedElapsed < 0.1) {
      applyState(STATES.FOCUSED);
    }

  } else if (currentState === STATES.WARNING) {

    // 졸음의심 → 졸음확정: 눈 감김 30초
    if (eyeClosedElapsed >= drowsySec) {
      applyState(STATES.DROWSY);

    // 졸음의심 → 집중: 눈 뜨면 바로 복귀
    } else if (!eyeClosed && eyeOpenElapsed >= 0.3) {
      applyState(STATES.FOCUSED);
      eyeClosedElapsed = 0;
    }

  } else if (currentState === STATES.DROWSY) {

    // 졸음확정 → 집중: 눈 뜨고 2초 유지 후 복귀
    if (!eyeClosed && eyeOpenElapsed >= RECOVER_FOCUSED_SEC) {
      applyState(STATES.FOCUSED);
      eyeClosedElapsed = 0;
      drowsyCnt++;
    }

  } else if (currentState === STATES.ABSENT) {
    // 자리이탈 → 집중: 얼굴 다시 감지되면 복귀
    applyState(STATES.FOCUSED);
    eyeClosedElapsed = 0;
  }

  // ── 1초마다 서버 전송 ────────────────────────
  if (!onResults._t || Date.now() - onResults._t > 1000) {
    sendDetectionData(currentState, avgEAR, marVal, drowsyCnt, yawnCnt, 0);
    onResults._t = Date.now();
  }
}

function setStatus(text, bg) {
  const el = document.getElementById('my-status-badge');
  if (!el) return;
  el.textContent      = text;
  el.style.background = bg;
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
  } catch (e) {
    console.warn('Daily.co 연결 실패:', e.message);
  }
}

function onParticipantJoined(e) {
  if (e.participant.local) return;
  const { session_id: sid, user_name: name = '참여자', owner } = e.participant;
  if (owner) {
    attachInstructorVideo(e.participant);
  } else {
    addPeerTile(sid, name);
  }
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
      console.log('강사 영상 연결됨');
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
        // 스트레칭 이벤트 수신
        if (msg.type === 'stretch_start') {
          startStretchMode();
        }
        if (msg.type === 'chat') {
          appendChatMessage(msg);
          // 채팅창 닫혀있으면 알림 뱃지 표시
          if (document.getElementById('chat-panel').style.display === 'none') {
            showChatBadge();
          }
        }
        if (msg.type === 'hand_raise') {
          appendHandRaise(msg.sender);
        }
        if (msg.type === 'break_start') {
          startBreakMode(msg.duration || 300);
        }
        if (msg.type === 'break_end') {
          endBreakMode();
        }
      } catch {}
    };
  } catch (e) {
    console.warn('WebSocket 연결 실패:', e.message);
  }
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
  // 감지 일시 정지
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
      // 감지 재시작
      cameraInstance?.start();
    }
  }, 1000);
}

// ── 쉬는시간 모드 ─────────────────────────────
function startBreakMode(totalSeconds) {
  cameraInstance?.stop(); // 감지 정지
  stopSleepAlert();

  // TTS
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
  cameraInstance?.start(); // 감지 재시작

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
  const cls     = isInst ? 'instructor' : 'mine'; // 강사만 왼쪽, 나머지 학생 전부 오른쪽
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
  // 채팅창 닫혀있으면 알림
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

  // 버튼 활성화 표시 (3초 후 원복)
  const btn = document.getElementById('hand-btn');
  btn.classList.add('active');
  setTimeout(() => btn.classList.remove('active'), 3000);
}

window.addEventListener('resize', syncCanvasSize);