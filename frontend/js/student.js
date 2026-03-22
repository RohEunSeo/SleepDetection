// =============================================
// student.js — Sleep2Wake 수강생 수업 화면
// =============================================

// ── 상수 ──────────────────────────────────────
const EYE_FRAMES     = 20;
const MOUTH_FRAMES   = 30;
const HEAD_FRAMES    = 25;
const ABSENCE_FRAMES = 30;
const MAR_THRESH     = 0.70;
const HEAD_THRESH    = 15;
const CALIB_FRAMES   = 90;
const TOTAL_CHECKS   = 4;

const L_EYE = [362, 385, 387, 263, 373, 380];
const R_EYE = [33,  160, 158, 133, 153, 144];
const MOUTH = [13,  14,  17,  18,  78,  308];

// ── DOM ───────────────────────────────────────
const videoEl  = document.getElementById('my-video');
const canvasEl = document.getElementById('my-canvas');
const ctx      = canvasEl.getContext('2d');
const calibCV  = document.getElementById('calib-canvas');
const calibCtx = calibCV.getContext('2d');

// ── 상태 ──────────────────────────────────────
let micOn = true, camOn = true;
let elapsed = 0, timerInterval;
let checkedCount = 0;
let cameraInstance = null;
let dailyCall = null;
let ws = null;

// 감지 카운터
let eyeCount = 0, mouthCount = 0, headCount = 0, absenceCount = 0;

// 누적 이벤트 (배터리 + 뱃지)
let drowsyCnt = 0, yawnCnt = 0, headCnt2 = 0;
let prevEyeAlert = false, prevYawnAlert = false, prevHeadAlert = false;

// 캘리브레이션
let calibEars = [], isCalib = true, EAR_THRESH = 0.20;

const BACKEND_URL = 'https://sleepdetection-production.up.railway.app/';

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

function calcTilt(lm) {
  return Math.abs(Math.atan2(lm[454].y - lm[234].y, lm[454].x - lm[234].x) * 180 / Math.PI);
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

  // 좌우반전
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

  // 스캔 라인
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
function updateBattery(eyeAlert, yawnAlert, headAlert, absent) {
  const fill = document.getElementById('battery-fill');
  const pct  = document.getElementById('battery-pct');
  if (!fill || !pct) return;
  const penalty = drowsyCnt * 10 + yawnCnt * 5 + headCnt2 * 5;
  const score   = Math.max(0, 100 - penalty);
  fill.className   = 'battery-fill';
  fill.style.width = score + '%';
  pct.textContent  = score + '%';
  if (absent || eyeAlert)           fill.classList.add('alert');
  else if (yawnAlert || score < 60) fill.classList.add('warn');
  pct.style.color = score <= 30 ? 'var(--accent-red)'
                  : score <= 60 ? 'var(--accent-yellow)'
                  : 'var(--text-secondary)';
}

// ── MediaPipe 결과 처리 ───────────────────────
function onResults(results) {
  syncCanvasSize();
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

  if (!results.multiFaceLandmarks?.length) {
    if (++absenceCount >= ABSENCE_FRAMES) setStatus('🚶 자리 이탈', 'rgba(245,158,11,0.8)');
    return;
  }

  absenceCount = 0;
  const lm     = results.multiFaceLandmarks[0];
  const lEAR   = calcEAR(lm, L_EYE);
  const rEAR   = calcEAR(lm, R_EYE);
  const avgEAR = (lEAR + rEAR) / 2;
  const marVal = calcMAR(lm, MOUTH);
  const tilt   = calcTilt(lm);

  // ── 캘리브레이션 ────────────────────────────
  if (isCalib) {
    calibEars.push(avgEAR);

    if (calibCV.width === 0 && calibCV.offsetWidth > 0) {
      calibCV.width  = calibCV.offsetWidth;
      calibCV.height = calibCV.offsetHeight;
    }

    const pct   = calibEars.length / CALIB_FRAMES;
    const barEl = document.getElementById('calib-bar');
    const pctEl = document.getElementById('calib-percent');
    if (barEl) barEl.style.width   = (pct * 100) + '%';
    if (pctEl) pctEl.textContent   = Math.round(pct * 100) + '%';

    drawCalibFrame(lm);

    if (calibEars.length >= CALIB_FRAMES) {
      EAR_THRESH = (calibEars.reduce((a, b) => a + b) / calibEars.length) * 0.75;
      isCalib    = false;
      document.getElementById('calibration-overlay').style.display = 'none';
      console.log('캘리브레이션 완료. EAR_THRESH:', EAR_THRESH.toFixed(3));
    }
    return;
  }

  // ── 감지 카운터 ──────────────────────────────
  eyeCount   = avgEAR < EAR_THRESH  ? eyeCount + 1   : 0;
  mouthCount = marVal > MAR_THRESH  ? mouthCount + 1 : 0;
  headCount  = tilt   > HEAD_THRESH ? headCount + 1  : 0;

  const eyeAlert  = eyeCount   >= EYE_FRAMES;
  const yawnAlert = mouthCount >= MOUTH_FRAMES;
  const headAlert = headCount  >= HEAD_FRAMES;

  if (eyeAlert  && !prevEyeAlert)  { drowsyCnt++; updateBadge('eye',  drowsyCnt, '👁',  '졸음'); }
  if (yawnAlert && !prevYawnAlert) { yawnCnt++;   updateBadge('yawn', yawnCnt,   '👄',  '하품'); }
  if (headAlert && !prevHeadAlert) { headCnt2++;  updateBadge('head', headCnt2,  '🙆', '고개떨굼'); }
  prevEyeAlert = eyeAlert; prevYawnAlert = yawnAlert; prevHeadAlert = headAlert;

  // ── 바운딩 박스 ──────────────────────────────
  ctx.save(); ctx.scale(-1, 1); ctx.translate(-canvasEl.width, 0);
  [[L_EYE, lEAR], [R_EYE, rEAR]].forEach(([idx, ear]) => {
    drawBox(lm, idx, ear < EAR_THRESH ? '#ef4444' : '#10b981', ear < EAR_THRESH ? 'Closed' : 'Open');
  });
  drawBox(lm, MOUTH,
    yawnAlert ? '#ef4444' : marVal > MAR_THRESH ? '#f59e0b' : '#10b981',
    yawnAlert ? 'Yawn'    : marVal > MAR_THRESH ? 'Open'    : 'Closed');
  ctx.restore();

  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '10px monospace';
  ctx.fillText(`EAR:${avgEAR.toFixed(2)}  MAR:${marVal.toFixed(2)}  Tilt:${tilt.toFixed(0)}°`, 6, 14);

  // ── 상태 뱃지 ────────────────────────────────
  const wrap = document.getElementById('tile-me');
  if (eyeAlert) {
    setStatus('😴 졸음 감지', 'rgba(239,68,68,0.8)');
    wrap?.classList.add('drowsy-alert');
  } else if (yawnAlert || headAlert) {
    setStatus(yawnAlert ? '🥱 하품' : '😪 고개떨굼', 'rgba(245,158,11,0.8)');
    wrap?.classList.remove('drowsy-alert');
  } else {
    setStatus('🟢 집중', 'rgba(0,0,0,0.6)');
    wrap?.classList.remove('drowsy-alert');
  }

  updateBattery(eyeAlert, yawnAlert, headAlert, false);

  // WebSocket 전송 (1초 1회)
  if (!onResults._t || Date.now() - onResults._t > 1000) {
    const status = eyeAlert ? 'drowsy'
                 : absenceCount >= ABSENCE_FRAMES ? 'absent'
                 : yawnAlert || headAlert ? 'warning' : 'focused';
    sendDetectionData(status, avgEAR, marVal, drowsyCnt, yawnCnt, headCnt2);
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
  goTo('login');
}

// ── 온보딩 ───────────────────────────────────
// student.html에서 onchange="handleCheck(this, 1~4)" 로 호출됨
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

  // 강사 영상 fallback
  fetch('assets/videos/lecture.mp4', { method: 'HEAD' })
    .then(r => {
      if (r.ok) {
        const v = document.getElementById('instructor-video');
        const f = document.getElementById('instructor-fallback');
        if (v) { v.src = 'assets/videos/lecture.mp4'; v.style.display = 'block'; }
        if (f) f.style.display = 'none';
      }
    }).catch(() => {});

  joinDailyRoom(userName, userRole);
  startCamera();
  startTimer();
}

// ── Daily.co ─────────────────────────────────
async function joinDailyRoom(userName, role) {
  try {
    const res = await fetch(
      `${BACKEND_URL}/api/room-token?user_name=${encodeURIComponent(userName)}&role=${role}`
    );
    if (!res.ok) throw new Error('토큰 발급 실패');
    const { token, room_url } = await res.json();
    dailyCall = DailyIframe.createCallObject({ audioSource: true, videoSource: true });
    await dailyCall.join({ url: room_url, token });
    dailyCall
      .on('participant-joined',  updatePeerTiles)
      .on('participant-updated', updatePeerTiles)
      .on('participant-left',    e => removePeerTile(e.participant.session_id));
    console.log('Daily.co 입장 완료');
  } catch (e) {
    console.warn('Daily.co 연결 실패 (로컬 테스트):', e.message);
  }
}

function updatePeerTiles(e) {
  if (e.participant.local) return;
  const { session_id: sid, user_name: name = '참여자' } = e.participant;
  document.querySelectorAll('.peer-avatar').forEach(el => {
    if (!el.dataset.sid) {
      el.dataset.sid = sid;
      el.textContent = name.charAt(0);
      const label = el.closest('.tile')?.querySelector('.tile-label');
      if (label) label.textContent = name;
    }
  });
}

function removePeerTile(sid) {
  document.querySelectorAll('.peer-avatar').forEach(el => {
    if (el.dataset.sid === sid) { el.dataset.sid = ''; el.textContent = '?'; }
  });
}

// ── WebSocket ─────────────────────────────────
function connectWebSocket(studentId) {
  try {
    const wsUrl = BACKEND_URL.replace('https://', 'wss://').replace('http://', 'ws://');
    ws = new WebSocket(`${wsUrl}/ws/student/${encodeURIComponent(studentId)}`);
    ws.onopen  = () => console.log('WS 연결됨');
    ws.onclose = () => setTimeout(() => connectWebSocket(studentId), 3000);
    ws.onerror = e => console.warn('WS 오류:', e);
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
    timestamp: Date.now()
  }));
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
});

window.addEventListener('beforeunload', () => clearInterval(timerInterval));
window.addEventListener('resize', syncCanvasSize);