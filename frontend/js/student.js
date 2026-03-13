// =============================================
// student.js - 학생 수업 페이지 + MediaPipe 감지
// =============================================

// ── DOM ───────────────────────────────────────
const videoEl            = document.getElementById('my-video');
const canvasEl           = document.getElementById('my-canvas');
const ctx                = canvasEl.getContext('2d');
const calibOverlay       = document.getElementById('calibration-overlay');
const calibBar           = document.getElementById('calib-bar');
const calibPercent       = document.getElementById('calib-percent');
const calibCanvasEl      = document.getElementById('calib-canvas');
const calibCtx           = calibCanvasEl.getContext('2d');
const camOffOverlay      = document.getElementById('cam-off-overlay');
const myCamWrap          = document.getElementById('tile-me');
const statusBadge        = document.getElementById('my-status-badge');
const instructorVideo    = document.getElementById('instructor-video');
const instructorFallback = document.getElementById('instructor-fallback');

// ── 상태 ──────────────────────────────────────
let micOn = true, camOn = true;
let elapsed = 0;
let timerInterval;

// ── 누적 이벤트 카운터 ────────────────────────
let drowsyCnt = 0, yawnCnt = 0, headCnt2 = 0;
// 이전 프레임 alert 상태 (중복 카운트 방지)
let prevEyeAlert = false, prevYawnAlert = false, prevHeadAlert = false;

// ── 감지 카운터 ───────────────────────────────
let eyeCount = 0, mouthCount = 0, headCount = 0, absenceCount = 0;
const EYE_FRAMES     = 20;
const MOUTH_FRAMES   = 30;
const HEAD_FRAMES    = 25;
const ABSENCE_FRAMES = 30;
const MAR_THRESH     = 0.70;
const HEAD_THRESH    = 15;

// ── 캘리브레이션 ──────────────────────────────
const CALIB_FRAMES = 90;
let calibEars = [], isCalib = true, EAR_THRESH = 0.20;

// ── 랜드마크 인덱스 ───────────────────────────
const L_EYE = [362, 385, 387, 263, 373, 380];
const R_EYE = [33,  160, 158, 133, 153, 144];
const MOUTH = [13,  14,  17,  18,  78,  308];

// ── 계산 함수 ─────────────────────────────────
function calcEAR(lm, idx) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  return (d(lm[idx[1]], lm[idx[5]]) + d(lm[idx[2]], lm[idx[4]])) / (2 * d(lm[idx[0]], lm[idx[3]]));
}

function calcMAR(lm, idx) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const tm = { x: (lm[idx[0]].x + lm[idx[1]].x) / 2, y: (lm[idx[0]].y + lm[idx[1]].y) / 2 };
  const bm = { x: (lm[idx[2]].x + lm[idx[3]].x) / 2, y: (lm[idx[2]].y + lm[idx[3]].y) / 2 };
  return d(tm, bm) / d(lm[idx[4]], lm[idx[5]]);
}

function calcTilt(lm) {
  return Math.abs(Math.atan2(lm[454].y - lm[234].y, lm[454].x - lm[234].x) * 180 / Math.PI);
}

// ── canvas 크기를 video 표시 영역에 동기화 (변경 있을 때만) ──
function syncCanvasSize() {
  const w = videoEl.offsetWidth;
  const h = videoEl.offsetHeight;
  if (w > 0 && h > 0 && (canvasEl.width !== w || canvasEl.height !== h)) {
    canvasEl.width  = w;
    canvasEl.height = h;
  }
}

// ── canvas를 video mirror와 동일하게 그리기 ──
function withMirror(fn) {
  ctx.save();
  ctx.scale(-1, 1);
  ctx.translate(-canvasEl.width, 0);
  fn();
  ctx.restore();
}

// ── 바운딩 박스 (withMirror 안에서 호출) ──────
function drawBox(lm, idx, color, label) {
  const w = canvasEl.width, h = canvasEl.height;
  const xs = idx.map(i => lm[i].x * w);
  const ys = idx.map(i => lm[i].y * h);
  const x1 = Math.min(...xs) - 5, y1 = Math.min(...ys) - 5;
  const bw = Math.max(...xs) - Math.min(...xs) + 10;
  const bh = Math.max(...ys) - Math.min(...ys) + 10;

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(x1, y1, bw, bh);

  ctx.save();
  ctx.scale(-1, 1);
  ctx.fillStyle = color;
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText(label, -(x1 + bw), y1 - 3);
  ctx.restore();
}

// ── 캘리브레이션: 얼굴 crop 확대 + 눈 박스 오버레이 ──
function drawCalibFrame(lm) {
  const cw = calibCanvasEl.width;
  const ch = calibCanvasEl.height;
  calibCtx.clearRect(0, 0, cw, ch);

  const vw = videoEl.videoWidth  || 1280;
  const vh = videoEl.videoHeight || 720;

  // 얼굴 bounding box - 원본 좌표(0~1) 기준
  const faceMargin = 0.13;
  const allFace = [...L_EYE, ...R_EYE, 10, 152, 234, 454];
  const fxs = allFace.map(i => lm[i].x);
  const fys = allFace.map(i => lm[i].y);
  const fx = Math.max(0, Math.min(...fxs) - faceMargin);
  const fy = Math.max(0, Math.min(...fys) - faceMargin * 1.5);
  const fx2 = Math.min(1, Math.max(...fxs) + faceMargin);
  const fy2 = Math.min(1, Math.max(...fys) + faceMargin);
  const fw = fx2 - fx;
  const fh = fy2 - fy;

  // video는 CSS mirror(scaleX -1)지만 drawImage는 원본 픽셀로 crop
  // → 그냥 원본 좌표로 crop하고 canvas에 그린 뒤
  //   canvas 전체를 scaleX(-1)로 뒤집어서 mirror 효과 적용
  try {
    // 1) 원본 crop → canvas에 그리기
    calibCtx.drawImage(
      videoEl,
      fx * vw, fy * vh, fw * vw, fh * vh,
      0, 0, cw, ch
    );
  } catch(e) { return; }

  // 2) canvas 좌우반전 (video CSS mirror와 동일하게)
  //    픽셀 데이터를 뒤집어서 다시 그리기
  const imageData = calibCtx.getImageData(0, 0, cw, ch);
  const flipped   = calibCtx.createImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const src = (y * cw + x) * 4;
      const dst = (y * cw + (cw - 1 - x)) * 4;
      flipped.data[dst]     = imageData.data[src];
      flipped.data[dst + 1] = imageData.data[src + 1];
      flipped.data[dst + 2] = imageData.data[src + 2];
      flipped.data[dst + 3] = imageData.data[src + 3];
    }
  }
  calibCtx.putImageData(flipped, 0, 0);

  // 3) 눈 박스 오버레이
  //    mirror 후 x좌표 = (1 - lm.x), crop 기준으로 정규화
  //    mirrorX = (1 - lm.x), cropStart_mirror = (1 - fx2), cropW = fw
  //    → canvasX = (mirrorX - (1 - fx2)) / fw * cw
  //              = (fx2 - lm.x) / fw * cw
  [[L_EYE, '#63b3ed', '왼눈'], [R_EYE, '#a78bfa', '오른눈']].forEach(([eyeIdx, color, label]) => {
    const exs = eyeIdx.map(i => (fx2 - lm[i].x) / fw * cw);
    const eys = eyeIdx.map(i => (lm[i].y - fy)  / fh * ch);
    const ex1 = Math.min(...exs) - 5;
    const ey1 = Math.min(...eys) - 5;
    const ebw = Math.max(...exs) - Math.min(...exs) + 10;
    const ebh = Math.max(...eys) - Math.min(...eys) + 10;

    calibCtx.strokeStyle = color;
    calibCtx.lineWidth = 2.5;
    calibCtx.setLineDash([5, 3]);
    calibCtx.strokeRect(ex1, ey1, ebw, ebh);
    calibCtx.setLineDash([]);

    eyeIdx.forEach(i => {
      const px = (fx2 - lm[i].x) / fw * cw;
      const py = (lm[i].y - fy)  / fh * ch;
      calibCtx.beginPath();
      calibCtx.arc(px, py, 3.5, 0, Math.PI * 2);
      calibCtx.fillStyle = color;
      calibCtx.fill();
    });

    calibCtx.fillStyle = color;
    calibCtx.font = 'bold 12px sans-serif';
    calibCtx.fillText(label, ex1, Math.max(14, ey1 - 4));
  });

  // 스캔 라인
  const scanY = (Date.now() % 1500) / 1500 * ch;
  const grad = calibCtx.createLinearGradient(0, scanY - 12, 0, scanY + 12);
  grad.addColorStop(0, 'rgba(99,179,237,0)');
  grad.addColorStop(0.5, 'rgba(99,179,237,0.28)');
  grad.addColorStop(1, 'rgba(99,179,237,0)');
  calibCtx.fillStyle = grad;
  calibCtx.fillRect(0, scanY - 12, cw, 24);
}

// ── 횟수 뱃지 업데이트 ───────────────────────
function updateCountBadge(id, count, icon, label) {
  const el = document.getElementById('badge-' + id);
  if (!el) return;
  el.textContent = `${icon} ${label} ${count}회`;
  el.className = count === 0 ? 'detect-badge'
               : count <= 2 ? 'detect-badge warn'
               :               'detect-badge alert';
}

// ── MediaPipe 결과 처리 ───────────────────────
function onResults(results) {
  syncCanvasSize();
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

  if (!results.multiFaceLandmarks?.length) {
    if (++absenceCount >= ABSENCE_FRAMES) {
      statusBadge.textContent = '🚶 자리 이탈';
      statusBadge.style.background = 'rgba(245,158,11,0.8)';
    }
    return;
  }

  absenceCount = 0;
  const lm       = results.multiFaceLandmarks[0];
  const leftEAR  = calcEAR(lm, L_EYE);
  const rightEAR = calcEAR(lm, R_EYE);
  const avgEAR   = (leftEAR + rightEAR) / 2;
  const marVal   = calcMAR(lm, MOUTH);
  const tilt     = calcTilt(lm);

  // ── 캘리브레이션 ────────────────────────────
  if (isCalib) {
    calibEars.push(avgEAR);
    const pct = calibEars.length / CALIB_FRAMES;
    calibBar.style.width = (pct * 100) + '%';
    calibPercent.textContent = Math.round(pct * 100) + '%';

    if (!calibCanvasEl.width || calibCanvasEl.width !== (calibCanvasEl.offsetWidth || 300)) {
      calibCanvasEl.width  = calibCanvasEl.offsetWidth  || 300;
      calibCanvasEl.height = calibCanvasEl.offsetHeight || 180;
    }
    drawCalibFrame(lm);

    if (calibEars.length >= CALIB_FRAMES) {
      EAR_THRESH = (calibEars.reduce((a, b) => a + b) / calibEars.length) * 0.75;
      isCalib = false;
      calibOverlay.style.display = 'none';
      console.log('캘리브레이션 완료. EAR_THRESH:', EAR_THRESH.toFixed(3));
    }
    return;
  }

  // ── 감지 프레임 카운터 ───────────────────────
  eyeCount   = avgEAR < EAR_THRESH  ? eyeCount + 1   : 0;
  mouthCount = marVal > MAR_THRESH  ? mouthCount + 1 : 0;
  headCount  = tilt   > HEAD_THRESH ? headCount + 1  : 0;

  const eyeAlert  = eyeCount   >= EYE_FRAMES;
  const yawnAlert = mouthCount >= MOUTH_FRAMES;
  const headAlert = headCount  >= HEAD_FRAMES;

  // ── 누적 이벤트 카운트 (alert 시작 시 1회 추가) ──
  if (eyeAlert  && !prevEyeAlert)  { drowsyCnt++;  updateCountBadge('eye',  drowsyCnt, '👁', '졸음'); }
  if (yawnAlert && !prevYawnAlert) { yawnCnt++;    updateCountBadge('yawn', yawnCnt,   '👄', '하품'); }
  if (headAlert && !prevHeadAlert) { headCnt2++;   updateCountBadge('head', headCnt2,  '🙆', '고개떨굼'); }
  prevEyeAlert  = eyeAlert;
  prevYawnAlert = yawnAlert;
  prevHeadAlert = headAlert;

  // ── 바운딩 박스 ──────────────────────────────
  withMirror(() => {
    drawBox(lm, L_EYE,
      leftEAR  < EAR_THRESH ? '#ef4444' : '#10b981',
      leftEAR  < EAR_THRESH ? 'Closed'  : 'Open');
    drawBox(lm, R_EYE,
      rightEAR < EAR_THRESH ? '#ef4444' : '#10b981',
      rightEAR < EAR_THRESH ? 'Closed'  : 'Open');
    drawBox(lm, MOUTH,
      yawnAlert ? '#ef4444' : marVal > MAR_THRESH ? '#f59e0b' : '#10b981',
      yawnAlert ? 'Yawn'    : marVal > MAR_THRESH ? 'Open'    : 'Closed');
  });

  // 수치 텍스트
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '10px monospace';
  ctx.fillText(`EAR:${avgEAR.toFixed(2)}  MAR:${marVal.toFixed(2)}  Tilt:${tilt.toFixed(0)}°`, 6, 14);

  // ── 내 캠 상태 뱃지 ──────────────────────────
  if (eyeAlert) {
    statusBadge.textContent = '😴 졸음 감지';
    statusBadge.style.background = 'rgba(239,68,68,0.8)';
    myCamWrap.classList.add('drowsy-alert');
  } else if (yawnAlert || headAlert) {
    statusBadge.textContent = yawnAlert ? '🥱 하품' : '😪 고개떨굼';
    statusBadge.style.background = 'rgba(245,158,11,0.8)';
    myCamWrap.classList.remove('drowsy-alert');
  } else {
    statusBadge.textContent = '🟢 정상';
    statusBadge.style.background = 'rgba(0,0,0,0.6)';
    myCamWrap.classList.remove('drowsy-alert');
  }
}


// ── 웹캠 + MediaPipe 시작 ─────────────────────
let cameraInstance = null;

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user',
        aspectRatio: { ideal: 16/9 }
      }, audio: false
    });
    videoEl.srcObject = stream;

    const faceMesh = new FaceMesh({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`
    });
    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6
    });
    faceMesh.onResults(onResults);

    cameraInstance = new Camera(videoEl, {
      onFrame: async () => await faceMesh.send({ image: videoEl }),
      width: 1280, height: 720
    });
    cameraInstance.start();
    camOffOverlay.style.display = 'none';
  } catch (e) {
    showToast('⚠️ 카메라 권한을 허용해주세요.');
    camOffOverlay.style.display = 'flex';
    calibOverlay.style.display  = 'none';
  }
}

// ── 타이머 ────────────────────────────────────
function startTimer() {
  timerInterval = setInterval(() => {
    elapsed++;
    document.getElementById('timer').textContent =
      `🕐 ${pad2(Math.floor(elapsed / 60))}:${pad2(elapsed % 60)}`;
  }, 1000);
}

// ── 컨트롤 ───────────────────────────────────
function toggleMic() {
  micOn = !micOn;
  const btn = document.getElementById('mic-btn');
  btn.querySelector('.icon').textContent  = micOn ? '🎙️' : '🔇';
  btn.querySelector('.label').textContent = micOn ? '마이크 끄기' : '마이크 켜기';
  btn.classList.toggle('off', !micOn);
}

function toggleCam() {
  camOn = !camOn;
  const btn = document.getElementById('cam-btn');
  btn.querySelector('.icon').textContent  = camOn ? '📹' : '📷';
  btn.querySelector('.label').textContent = camOn ? '카메라 끄기' : '카메라 켜기';
  btn.classList.toggle('off', !camOn);
  videoEl.style.display       = camOn ? 'block' : 'none';
  canvasEl.style.display      = camOn ? 'block' : 'none';
  camOffOverlay.style.display = camOn ? 'none'  : 'flex';

  if (camOn) {
    cameraInstance?.start();
  } else {
    cameraInstance?.stop();
    ['eye','yawn','head'].forEach(id => {
      const el = document.getElementById('badge-' + id);
      if (el) { el.textContent = {eye:'👁 --', yawn:'👄 --', head:'🙆 --'}[id]; el.className = 'detect-badge'; }
    });
    statusBadge.textContent = '📷 카메라 꺼짐';
    statusBadge.style.background = 'rgba(0,0,0,0.6)';
    myCamWrap.classList.remove('drowsy-alert');
  }
}

function leaveRoom() {
  clearInterval(timerInterval);
  videoEl.srcObject?.getTracks().forEach(t => t.stop());
  goTo('login');
}

// ── 초기화 ────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  fetch('assets/lecture.mp4', { method: 'HEAD' })
    .then(r => {
      if (r.ok) {
        instructorVideo.src = 'assets/lecture.mp4';
        instructorVideo.style.display = 'block';
        instructorFallback.style.display = 'none';
      }
    }).catch(() => {});

  startCamera();
  startTimer();
});

window.addEventListener('beforeunload', () => clearInterval(timerInterval));
window.addEventListener('resize', syncCanvasSize);

// ── 화면 스위치 (클릭한 타일 ↔ 현재 메인 자리 교체) ──
let currentMainId = 'tile-instructor';

function swapToMain(clickedId) {
  if (clickedId === currentMainId) return;

  const mainView    = document.getElementById('main-view');
  const rightPanel  = document.getElementById('right-panel');
  const clickedTile = document.getElementById(clickedId);
  const currentMain = document.getElementById(currentMainId);

  if (!clickedTile || !currentMain) return;

  // 클릭한 타일의 정확한 위치를 DOM 이동 전에 기억
  // placeholder로 위치 고정
  const placeholder = document.createElement('div');
  rightPanel.insertBefore(placeholder, clickedTile);

  // 1) 클릭한 타일 → 메인 뷰로
  clickedTile.classList.add('active-main');
  mainView.appendChild(clickedTile);

  // 2) 현재 메인 → placeholder 자리(클릭한 타일의 원래 위치)로
  currentMain.classList.remove('active-main');
  rightPanel.insertBefore(currentMain, placeholder);

  // placeholder 제거
  placeholder.remove();

  currentMainId = clickedId;

  requestAnimationFrame(syncCanvasSize);
}