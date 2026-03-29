// =============================================
// instructor.js - Sleep2Wake 강사 화면
// =============================================

const IS_LOCAL_HOST = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const BACKEND_URL = IS_LOCAL_HOST
  ? 'http://127.0.0.1:8000'
  : 'https://sleepdetection-production.up.railway.app';
const ROTATION_SIZE = 4;

// ── 상태 색상 (student.js 와 동일 기준) ──────
const STATE_UI = {
  FOCUSED:    { text: '집중',     border: '#22c55e', bg: 'rgba(34,197,94,0.15)'   },
  DISTRACTED: { text: '주의산만', border: '#eab308', bg: 'rgba(234,179,8,0.15)'   },
  WARNING:    { text: '졸음의심', border: '#f97316', bg: 'rgba(249,115,22,0.15)'  },
  DROWSY:     { text: '졸음확정', border: '#ef4444', bg: 'rgba(239,68,68,0.15)'   },
  ABSENT:     { text: '자리이탈', border: '#64748b', bg: 'rgba(100,116,139,0.15)' },
};

let stretchPopupShown = false;
let breakTimerInterval = null;

let students = {};
let rotationIdx = 0;
let rotationOn = true;
let rotInterval = null;
let elapsed = 0;
let timerInterval;
let micOn = true, camOn = true, screenOn = false;

let dailyCall = null;
let ws = null;
let captionViewerWs = null;
let captionTextWs = null;

let localMediaStream = null;
let currentRoomCode = 'GLOBAL';
let captionClearTimer = null;
let captionRecognition = null;
let captionRecognitionRunning = false;
let lastCaptionSentText = '';
window.dailyCall = null;

const participantVideoMap = {};

function getWsBaseUrl() {
  return BACKEND_URL.replace('https://', 'wss://').replace('http://', 'ws://');
}

// ── 자막 ─────────────────────────────────────
function renderCaption(text, speaker = '강사', isFinal = true) {
  const captionEl = document.getElementById('inst-live-caption');
  if (!captionEl) return;
  captionEl.textContent = `${speaker}: ${text}`;
  captionEl.classList.add('show');
  captionEl.classList.toggle('interim', !isFinal);
  clearTimeout(captionClearTimer);
  captionClearTimer = setTimeout(() => {
    captionEl.classList.remove('show', 'interim');
    captionEl.textContent = '';
  }, 5000);
}

function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function connectCaptionTextWs() {
  if (captionTextWs) captionTextWs.close();
  const userName = sessionStorage.getItem('userName') || '강사';
  const roomCode = sessionStorage.getItem('roomCode') || currentRoomCode || 'GLOBAL';
  captionTextWs = new WebSocket(
    `${getWsBaseUrl()}/ws/caption-text?speaker=${encodeURIComponent(userName)}&room_code=${encodeURIComponent(roomCode)}`
  );
  captionTextWs.onclose = () => {
    if (micOn) setTimeout(connectCaptionTextWs, 2000);
  };
}

function sendCaptionText(text, isFinal = false) {
  if (!text || !captionTextWs || captionTextWs.readyState !== WebSocket.OPEN) return;
  const normalized = text.trim();
  if (!normalized) return;
  if (normalized === lastCaptionSentText && !isFinal) return;
  lastCaptionSentText = normalized;
  captionTextWs.send(JSON.stringify({
    text: normalized, final: isFinal,
    speaker: sessionStorage.getItem('userName') || '강사',
  }));
}

function stopBrowserCaptionRecognition() {
  if (!captionRecognition) return;
  captionRecognition.onresult = null;
  captionRecognition.onerror  = null;
  captionRecognition.onend    = null;
  if (captionRecognitionRunning) captionRecognition.stop();
  captionRecognitionRunning = false;
  captionRecognition = null;
}

function startBrowserCaptionRecognition() {
  const RecognitionCtor = getSpeechRecognitionCtor();
  if (!RecognitionCtor) return false;
  connectCaptionTextWs();

  captionRecognition = new RecognitionCtor();
  captionRecognition.lang = 'ko-KR';
  captionRecognition.continuous = true;
  captionRecognition.interimResults = true;
  captionRecognition.maxAlternatives = 1;

  captionRecognition.onresult = (event) => {
    let interimText = '', finalText = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0]?.transcript?.trim() || '';
      if (!transcript) continue;
      if (event.results[i].isFinal) finalText   += `${transcript} `;
      else                          interimText += `${transcript} `;
    }
    const interimNorm = interimText.trim();
    const finalNorm   = finalText.trim();
    if (interimNorm) { renderCaption(interimNorm, '강사', false); sendCaptionText(interimNorm, false); }
    if (finalNorm)   { renderCaption(finalNorm,   '강사', true);  sendCaptionText(finalNorm,   true);  }
  };
  captionRecognition.onerror = (e) => { if (e.error !== 'no-speech') console.warn('자막 오류:', e.error); };
  captionRecognition.onend   = () => {
    captionRecognitionRunning = false;
    if (!micOn) return;
    try { captionRecognition.start(); captionRecognitionRunning = true; } catch {}
  };

  try {
    captionRecognition.start();
    captionRecognitionRunning = true;
    console.log('브라우저 자막 인식 시작');
    return true;
  } catch (e) {
    captionRecognition = null;
    return false;
  }
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
      renderCaption(payload.text, payload.speaker || '강사', payload.final !== false);
    }
  };
}

function stopCaptionStreaming() {
  if (captionTextWs) captionTextWs.close();
  captionTextWs = null;
  stopBrowserCaptionRecognition();
}

function connectCaptionUploader(roomCode = 'GLOBAL') {
  currentRoomCode = roomCode;
  stopCaptionStreaming();
  if (startBrowserCaptionRecognition()) {
    console.log('자막 경로: browser speech recognition');
    return;
  }
  console.warn('Web Speech API 미지원 브라우저');
}

// ── WebSocket (학생 상태 수신) ─────────────────
function connectWS() {
  try {
    ws = new WebSocket(`${getWsBaseUrl()}/ws/admin`);
    ws.onopen    = () => console.log('강사 WS 연결됨');
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'student_update') {
        if (msg.data.status) msg.data.status = msg.data.status.toUpperCase();
        students[msg.data.student_id] = msg.data;
      } else if (msg.type === 'student_left') {
        delete students[msg.student_id];
      } else if (msg.type === 'full_state') {
        students = msg.data;
      }
      if (msg.type === 'chat') {
        appendInstChatMessage(msg);
      }
      if (msg.type === 'hand_raise') {
        appendInstHandRaise(msg.sender);
      }
      updateStats();
      renderStudentGrid();
      checkStretchTrigger();
    };
    ws.onclose = () => setTimeout(connectWS, 3000);
    ws.onerror = (e) => console.warn('강사 WS 오류:', e);
  } catch (e) {
    console.warn('WS 연결 실패:', e);
  }
}

// ── 통계 업데이트 ─────────────────────────────
function updateStats() {
  const list  = Object.values(students);
  const total = list.length;

  const counts = {
    FOCUSED:    list.filter(s => s.status === 'FOCUSED').length,
    DISTRACTED: list.filter(s => s.status === 'DISTRACTED').length,
    WARNING:    list.filter(s => s.status === 'WARNING').length,
    DROWSY:     list.filter(s => s.status === 'DROWSY').length,
    ABSENT:     list.filter(s => s.status === 'ABSENT').length,
  };

  const avg = total > 0 ? Math.round((counts.FOCUSED / total) * 100) : 0;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('inst-total',     total);
  set('cnt-focused',    counts.FOCUSED);
  set('cnt-distracted', counts.DISTRACTED);
  set('cnt-warning',    counts.WARNING);
  set('cnt-drowsy',     counts.DROWSY);
  set('cnt-absent',     counts.ABSENT);

  // 패널 집중도 바
  const fill = document.getElementById('class-focus-fill');
  const pct  = document.getElementById('class-focus-pct');
  if (fill) fill.style.width = `${avg}%`;
  if (pct) {
    pct.textContent = `${avg}%`;
    pct.style.color = avg >= 70 ? 'var(--accent-green)' : avg >= 40 ? 'var(--accent-yellow)' : 'var(--accent-red)';
  }
  // 헤더 집중도 바
  const fillH = document.getElementById('class-focus-fill-header');
  const pctH  = document.getElementById('class-focus-pct-header');
  if (fillH) fillH.style.width = `${avg}%`;
  if (pctH)  pctH.textContent  = `${avg}%`;

  renderStudentList();
}

// ── 학생 목록 패널 ────────────────────────────
function renderStudentList() {
  const listEl = document.getElementById('student-list-panel');
  if (!listEl) return;
  const list = Object.values(students);
  if (list.length === 0) {
    listEl.innerHTML = '<div style="color:var(--text-muted);font-size:12px;text-align:center;padding:12px;">접속 학생 없음</div>';
    return;
  }
  listEl.innerHTML = list.map(s => {
    const st = STATE_UI[s.status] || STATE_UI.FOCUSED;
    return `
      <div style="
        display:flex; align-items:center; gap:8px;
        padding:6px 8px; border-radius:8px; margin-bottom:4px;
        background:${st.bg}; border-left:3px solid ${st.border};
      ">
        <span style="font-size:11px;font-weight:600;color:${st.border};min-width:52px;">${st.text}</span>
        <span style="font-size:12px;color:var(--text-primary);flex:1;">${s.name || s.student_id}</span>
      </div>`;
  }).join('');
}

// ── 학생 타일 그리드 ──────────────────────────
function renderStudentGrid() {
  const list  = Object.values(students);
  const start = rotationIdx * ROTATION_SIZE;
  const slice = list.slice(start, start + ROTATION_SIZE);
  const pages = Math.max(1, Math.ceil(list.length / ROTATION_SIZE));

  const pageEl = document.getElementById('rotation-page');
  if (pageEl) pageEl.textContent = `${rotationIdx + 1} / ${pages}`;

  const grid = document.getElementById('inst-student-grid');
  if (!grid) return;

  const existingIds = new Set([...grid.querySelectorAll('.inst-student-tile[id]')].map(el => el.id));
  const neededIds   = new Set(slice.map(s => `tile-${s.student_id}`));
  existingIds.forEach(id => { if (!neededIds.has(id)) document.getElementById(id)?.remove(); });
  grid.querySelectorAll('.inst-student-tile:not([id])').forEach(el => el.remove());

  slice.forEach(s => {
    const sid     = s.student_id;
    const st      = STATE_UI[s.status] || STATE_UI.FOCUSED;
    const initial = (s.name || s.student_id || '?').charAt(0);

    let tile = document.getElementById(`tile-${sid}`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'inst-student-tile';
      tile.id = `tile-${sid}`;
      tile.innerHTML = `
        <video class="inst-student-video" id="video-${sid}" autoplay muted playsinline
               style="display:none; width:100%; height:100%; object-fit:cover; position:absolute; inset:0; border-radius:inherit;"></video>
        <div class="inst-student-fallback" id="fallback-${sid}">
          <div class="inst-peer-avatar" id="avatar-${sid}">${initial}</div>
          <div class="inst-peer-name">${s.name || s.student_id}</div>
        </div>
        <div class="tile-status-badge" id="status-${sid}">${st.text}</div>
        <div class="tile-student-label">${s.name || s.student_id}</div>`;
      grid.appendChild(tile);
      if (participantVideoMap[sid]) attachStudentVideo(sid, participantVideoMap[sid]);
    }

    // 상태 반영 — 테두리 + 뱃지
    tile.style.border     = `2.5px solid ${st.border}`;
    tile.style.boxShadow  = `0 0 10px ${st.border}55`;
    tile.style.background = st.bg;

    const badge = document.getElementById(`status-${sid}`);
    if (badge) {
      badge.textContent      = st.text;
      badge.style.background = st.border;
    }
  });

  // 빈 슬롯
  for (let i = 0; i < ROTATION_SIZE - slice.length; i++) {
    const el = document.createElement('div');
    el.className = 'inst-student-tile';
    el.innerHTML = `
      <div class="inst-student-fallback">
        <div style="font-size:20px;opacity:0.2">👤</div>
        <div class="inst-peer-name" style="opacity:0.3">대기 중</div>
      </div>`;
    grid.appendChild(el);
  }
}

function attachStudentVideo(sid, track) {
  const videoEl    = document.getElementById(`video-${sid}`);
  const fallbackEl = document.getElementById(`fallback-${sid}`);
  if (!videoEl) return;
  videoEl.srcObject     = new MediaStream([track]);
  videoEl.style.display = 'block';
  if (fallbackEl) fallbackEl.style.display = 'none';
}

function startRotation() {
  rotInterval = setInterval(() => {
    if (!rotationOn) return;
    const pages = Math.max(1, Math.ceil(Object.keys(students).length / ROTATION_SIZE));
    rotationIdx = (rotationIdx + 1) % pages;
    renderStudentGrid();
  }, 5000);
}

function toggleRotation(on) { rotationOn = on; }

// ── DROWSY 30% 체크 → 스트레칭 팝업 ──────────
function checkStretchTrigger() {
  if (stretchPopupShown) return;
  const list  = Object.values(students);
  const total = list.length;
  if (total === 0) return;
  const drowsyCount = list.filter(s => s.status === 'DROWSY').length;
  if (drowsyCount >= Math.ceil(total * 0.3)) {
    stretchPopupShown = true;
    showStretchPopup(drowsyCount);
  }
}

// ── 스트레칭 팝업 ─────────────────────────────
function showStretchPopup(drowsyCount) {
  document.getElementById('stretch-popup')?.remove();
  const popup = document.createElement('div');
  popup.id = 'stretch-popup';
  popup.style.cssText = `
    position:fixed; inset:0; z-index:9999;
    background:rgba(0,0,0,0.6);
    display:flex; align-items:center; justify-content:center;`;
  popup.innerHTML = `
    <div style="
      background:#1e2330; border-radius:16px; padding:32px 36px;
      max-width:380px; width:90%; text-align:center;
      border:1px solid #ef4444; box-shadow:0 0 30px rgba(239,68,68,0.3);
    ">
      <div style="font-size:2.5rem;margin-bottom:12px;">⚠️</div>
      <div style="font-size:1.2rem;font-weight:700;color:#fff;margin-bottom:8px;">졸음 학생 감지</div>
      <div style="font-size:0.95rem;color:#94a3b8;margin-bottom:24px;">
        현재 <strong style="color:#ef4444">${drowsyCount}명</strong>이 졸음 상태입니다.<br>
        스트레칭을 제안하시겠습니까?
      </div>
      <div style="display:flex;gap:12px;justify-content:center;">
        <button onclick="dismissStretchPopup()" style="
          padding:10px 24px;border-radius:8px;border:1px solid #475569;
          background:transparent;color:#94a3b8;cursor:pointer;font-size:14px;">거절</button>
        <button onclick="acceptStretch()" style="
          padding:10px 24px;border-radius:8px;border:none;
          background:#f97316;color:#fff;cursor:pointer;font-size:14px;font-weight:700;">✅ 수락</button>
      </div>
    </div>`;
  document.body.appendChild(popup);
}

function dismissStretchPopup() {
  document.getElementById('stretch-popup')?.remove();
  setTimeout(() => { stretchPopupShown = false; }, 60000);
}

async function acceptStretch() {
  document.getElementById('stretch-popup')?.remove();
  try {
    const res = await fetch(`${BACKEND_URL}/api/stretch`, { method: 'POST' });
    if (!res.ok) throw new Error(`stretch failed: ${res.status}`);
  } catch {
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'stretch_start' }));
  }
  showToast('🧘 스트레칭 시작! 학생 화면에 전송됨');
  setTimeout(() => { stretchPopupShown = false; }, 120000);
}

// ── 쉬는시간 팝업 ─────────────────────────────
function showBreakPopup() {
  document.getElementById('break-popup')?.remove();
  const popup = document.createElement('div');
  popup.id = 'break-popup';
  popup.style.cssText = `
    position:fixed; inset:0; z-index:9999;
    background:rgba(0,0,0,0.6);
    display:flex; align-items:center; justify-content:center;`;
  popup.innerHTML = `
    <div style="
      background:#1e2330; border-radius:16px; padding:32px 36px;
      max-width:380px; width:90%; text-align:center;
      border:1px solid #f97316;
    ">
      <div style="font-size:2.5rem;margin-bottom:12px;">☕</div>
      <div style="font-size:1.2rem;font-weight:700;color:#fff;margin-bottom:20px;">쉬는시간 설정</div>
      <div style="display:flex;gap:8px;justify-content:center;margin-bottom:16px;">
        <button onclick="selectBreakTime(5)"  id="break-5"  style="padding:8px 16px;border-radius:8px;border:1px solid #475569;background:transparent;color:#94a3b8;cursor:pointer;">5분</button>
        <button onclick="selectBreakTime(10)" id="break-10" style="padding:8px 16px;border-radius:8px;border:1px solid #475569;background:transparent;color:#94a3b8;cursor:pointer;">10분</button>
        <button onclick="selectBreakTime(15)" id="break-15" style="padding:8px 16px;border-radius:8px;border:1px solid #475569;background:transparent;color:#94a3b8;cursor:pointer;">15분</button>
      </div>
      <div style="margin-bottom:20px;">
        <input id="break-custom" type="number" min="1" max="60" placeholder="직접 입력 (분)" style="
          width:100%;padding:8px 12px;border-radius:8px;
          border:1px solid #475569;background:#0f1117;
          color:#fff;font-size:14px;text-align:center;box-sizing:border-box;"
          oninput="clearBreakBtnSelection()">
      </div>
      <div style="display:flex;gap:12px;justify-content:center;">
        <button onclick="document.getElementById('break-popup').remove()" style="
          padding:10px 24px;border-radius:8px;border:1px solid #475569;
          background:transparent;color:#94a3b8;cursor:pointer;font-size:14px;">취소</button>
        <button onclick="startBreak()" style="
          padding:10px 24px;border-radius:8px;border:none;
          background:#f97316;color:#fff;cursor:pointer;font-size:14px;font-weight:700;">☕ 시작</button>
      </div>
    </div>`;
  document.body.appendChild(popup);
}

let selectedBreakMinutes = 5;

function selectBreakTime(min) {
  selectedBreakMinutes = min;
  document.getElementById('break-custom').value = '';
  ['5','10','15'].forEach(m => {
    const btn = document.getElementById(`break-${m}`);
    if (!btn) return;
    btn.style.background  = m == min ? '#f97316' : 'transparent';
    btn.style.color       = m == min ? '#fff'    : '#94a3b8';
    btn.style.borderColor = m == min ? '#f97316' : '#475569';
  });
}

function clearBreakBtnSelection() {
  ['5','10','15'].forEach(m => {
    const btn = document.getElementById(`break-${m}`);
    if (!btn) return;
    btn.style.background = 'transparent';
    btn.style.color = '#94a3b8';
    btn.style.borderColor = '#475569';
  });
}

async function startBreak() {
  const customVal = parseInt(document.getElementById('break-custom')?.value);
  const minutes   = (!isNaN(customVal) && customVal > 0) ? customVal : selectedBreakMinutes;
  const seconds   = minutes * 60;

  document.getElementById('break-popup')?.remove();

  try {
    const res = await fetch(`${BACKEND_URL}/api/break/start?duration=${seconds}`, { method: 'POST' });
    if (!res.ok) throw new Error(`break start failed: ${res.status}`);
  } catch {
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'break_start', duration: seconds }));
  }

  showToast(`☕ 쉬는시간 ${minutes}분 시작!`);
  showBreakOverlay(seconds); // 강사 메인뷰 오버레이
}

// ── 쉬는시간 — 강사 메인뷰 오버레이 ──────────
function showBreakOverlay(totalSeconds) {
  document.getElementById('break-main-overlay')?.remove();

  const mainView = document.getElementById('inst-main-view');
  if (!mainView) return;

  const overlay = document.createElement('div');
  overlay.id = 'break-main-overlay';
  overlay.style.cssText = `
    position:absolute; inset:0; z-index:50;
    background:rgba(0,0,0,0.82);
    display:flex; flex-direction:column;
    align-items:center; justify-content:center;
    border-radius:inherit;`;
  overlay.innerHTML = `
    <div style="font-size:3rem;margin-bottom:16px;">☕</div>
    <div style="font-size:1.6rem;font-weight:700;color:#fff;margin-bottom:8px;">쉬는시간</div>
    <div style="font-size:1rem;color:#94a3b8;margin-bottom:24px;">학생들에게 쉬는시간이 안내되었습니다</div>
    <div id="break-overlay-timer" style="
      font-size:3.5rem;font-weight:700;color:#f97316;
      font-family:monospace;letter-spacing:4px;
      margin-bottom:28px;">${formatTime(totalSeconds)}</div>
    <button onclick="endBreakEarly()" style="
      padding:10px 28px;border-radius:10px;
      border:1px solid #475569;background:rgba(255,255,255,0.06);
      color:#94a3b8;cursor:pointer;font-size:14px;">⏹ 쉬는시간 종료</button>`;
  mainView.appendChild(overlay);

  let remaining = totalSeconds;
  clearInterval(breakTimerInterval);
  breakTimerInterval = setInterval(() => {
    remaining--;
    const el = document.getElementById('break-overlay-timer');
    if (el) el.textContent = formatTime(remaining);
    if (remaining <= 0) {
      clearInterval(breakTimerInterval);
      endBreak();
    }
  }, 1000);
}

async function endBreakEarly() {
  clearInterval(breakTimerInterval);
  document.getElementById('break-main-overlay')?.remove();
  try {
    const res = await fetch(`${BACKEND_URL}/api/break/end`, { method: 'POST' });
    if (!res.ok) throw new Error(`break end failed: ${res.status}`);
  } catch {
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'break_end' }));
  }
  showToast('☕ 쉬는시간이 종료되었습니다.');
}

async function endBreak() {
  document.getElementById('break-main-overlay')?.remove();
  try {
    const res = await fetch(`${BACKEND_URL}/api/break/end`, { method: 'POST' });
    if (!res.ok) throw new Error(`break end failed: ${res.status}`);
  } catch {
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'break_end' }));
  }
  showToast('☕ 쉬는시간 종료! 학생들에게 알림 전송됨');
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ── 수업 종료 — 리포트 팝업 ───────────────────
async function leaveRoom() {
  // 먼저 수업 종료 신호 전송
  try {
    const roomCode = sessionStorage.getItem('roomCode') || currentRoomCode;
    await fetch(`${BACKEND_URL}/api/room/close?room_code=${encodeURIComponent(roomCode)}`, { method: 'POST' });
  } catch {}

  dailyCall?.leave();
  stopCaptionStreaming();
  if (captionViewerWs) captionViewerWs.close();
  localMediaStream?.getTracks().forEach(t => t.stop());
  clearInterval(timerInterval);
  clearInterval(rotInterval);
  clearInterval(breakTimerInterval);

  // 리포트 확인 팝업
  showLeavePopup();
}

function showLeavePopup() {
  document.getElementById('leave-popup')?.remove();
  const popup = document.createElement('div');
  popup.id = 'leave-popup';
  popup.style.cssText = `
    position:fixed; inset:0; z-index:9999;
    background:rgba(0,0,0,0.7);
    display:flex; align-items:center; justify-content:center;`;
  popup.innerHTML = `
    <div style="
      background:#1e2330; border-radius:16px; padding:32px 36px;
      max-width:380px; width:90%; text-align:center;
      border:1px solid #334155;
    ">
      <div style="font-size:2.5rem;margin-bottom:12px;">📊</div>
      <div style="font-size:1.2rem;font-weight:700;color:#fff;margin-bottom:8px;">수업이 종료되었습니다</div>
      <div style="font-size:0.95rem;color:#94a3b8;margin-bottom:24px;">
        오늘 수업 리포트를 확인하시겠습니까?
      </div>
      <div style="display:flex;gap:12px;justify-content:center;">
        <button onclick="confirmLeave(false)" style="
          padding:10px 24px;border-radius:8px;border:1px solid #475569;
          background:transparent;color:#94a3b8;cursor:pointer;font-size:14px;">나중에</button>
        <button onclick="confirmLeave(true)" style="
          padding:10px 24px;border-radius:8px;border:none;
          background:linear-gradient(135deg,#f97316,#ef4444);
          color:#fff;cursor:pointer;font-size:14px;font-weight:700;">📊 리포트 확인</button>
      </div>
    </div>`;
  document.body.appendChild(popup);
}

function confirmLeave(goReport) {
  document.getElementById('leave-popup')?.remove();
  if (goReport) {
    goTo('report');
  } else {
    goTo('login');
  }
}

// ── 방 생성 ───────────────────────────────────
async function createRoom() {
  const btn        = document.getElementById('create-room-btn');
  const userName   = sessionStorage.getItem('userName')  || '강사';
  const courseName = sessionStorage.getItem('courseName') || '';  // ← 온보딩에서 저장한 과정명
  btn.disabled    = true;
  btn.textContent = '생성 중...';

  try {
    const res = await fetch(
      `${BACKEND_URL}/api/create-room?instructor_name=${encodeURIComponent(userName)}&course_name=${encodeURIComponent(courseName)}`,
      { method: 'POST' }
    );
    if (!res.ok) throw new Error('방 생성 실패');
    const { room_code, token, room_url } = await res.json();
    _applyRoomCode(room_code);
    await joinDailyRoom(userName, token, room_url);
    showToast(`✅ 과정 코드: ${room_code} - 학생들에게 공유해주세요!`);
  } catch (e) {
    console.warn('방 생성 실패, 폴백:', e.message);
    _applyRoomCode('LION-2025');
    showToast('과정 코드: LION-2025 (로컬 테스트 모드)');
  } finally {
    btn.disabled    = false;
    btn.textContent = '+ 과정 코드 생성';
  }
}

function _applyRoomCode(code) {
  currentRoomCode = code;
  // 과정 코드 표시란에는 실제 코드 유지
  document.getElementById('rcd-code-text').textContent       = code;
  document.getElementById('room-code-display').style.display = 'flex';
  document.getElementById('create-room-btn').style.display   = 'none';
  sessionStorage.setItem('roomCode', code);
  // 헤더 왼쪽: 멋쟁이사자처럼 · 과정명 날짜
  const courseName = sessionStorage.getItem('courseName') || '';
  const today = new Date();
  const dateLabel = `${today.getMonth()+1}/${today.getDate()}`;
  const classEl = document.getElementById('inst-class-label');
  if (classEl) {
    classEl.textContent = courseName
      ? `멋쟁이사자처럼 · ${courseName} ${dateLabel}`
      : `멋쟁이사자처럼 · ${code}`;
  }
  connectCaptionTextWs();
}

function copyRoomCode() {
  const code = document.getElementById('rcd-code-text').textContent;
  navigator.clipboard.writeText(code)
    .then(() => showToast(`✅ 과정 코드 복사됨: ${code}`))
    .catch(() => {
      const el = Object.assign(document.createElement('textarea'), { value: code });
      document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el);
      showToast(`✅ 과정 코드 복사됨: ${code}`);
    });
}

// ── Daily.co ─────────────────────────────────
async function joinDailyRoom(userName, token, roomUrl) {
  try {
    dailyCall = DailyIframe.createCallObject({ audioSource: true, videoSource: true });
    window.dailyCall = dailyCall;
    await dailyCall.join({ url: roomUrl, token });
    dailyCall
      .on('joined-meeting',      e => console.log('강사 joined-meeting', e))
      .on('started-camera',     () => console.log('카메라 시작'))
      .on('track-started',      handleTrackStarted)
      .on('track-stopped',      handleTrackStopped)
      .on('participant-joined', onParticipantJoined)
      .on('participant-left',   onParticipantLeft)
      .on('participant-updated', e => console.log('강사 participant-updated', e.participant?.user_name, e.participant?.tracks))
      .on('error', e => console.warn('강사 Daily error', e));
    console.log('Daily.co 강사 입장 완료');
  } catch (e) {
    console.warn('Daily.co 연결 실패:', e.message);
  }
}

async function reconnectDailyRoomIfNeeded(userName, roomCode) {
  if (!roomCode || dailyCall) return;
  try {
    const res = await fetch(
      `${BACKEND_URL}/api/room-token?user_name=${encodeURIComponent(userName)}&room_code=${encodeURIComponent(roomCode)}&role=instructor`
    );
    if (!res.ok) throw new Error('강사 토큰 재발급 실패');
    const { token, room_url } = await res.json();
    await joinDailyRoom(userName, token, room_url);
  } catch (e) {
    console.warn('강사 Daily 재입장 실패:', e.message);
  }
}

function onParticipantJoined(e) {
  if (e.participant.local) return;
  const { user_name: name = '참여자' } = e.participant;
  console.log('학생 입장:', name);
  if (!students[name]) {
    students[name] = { student_id: name, name, status: 'FOCUSED', drowsy_cnt: 0, yawn_cnt: 0, head_cnt: 0 };
  }
  updateStats();
  renderStudentGrid();
}

function onParticipantLeft(e) {
  const { user_name: name = '' } = e.participant;
  console.log('학생 퇴장:', name);
  delete students[name];
  delete participantVideoMap[name];
  updateStats();
  renderStudentGrid();
}

function handleTrackStarted(e) {
  if (e.participant.local) return;
  console.log('강사 track-started', e.participant.user_name, { kind: e.track.kind, screen: e.participant.screen, tracks: e.participant.tracks });
  if (e.track.kind === 'video' && e.participant.screen) {
    const sv = document.getElementById('screen-video');
    if (sv) { sv.srcObject = new MediaStream([e.track]); sv.style.display = 'block'; document.getElementById('inst-video').style.display = 'none'; }
    return;
  }
  if (e.track.kind === 'video') {
    const name = e.participant.user_name || '';
    participantVideoMap[name] = e.track;
    attachStudentVideo(name, e.track);
  }
}

function handleTrackStopped(e) {
  if (e.track.kind === 'video' && e.participant?.screen) stopScreenShare();
}

// ── 화면 공유 ─────────────────────────────────
async function toggleScreenShare() {
  const btn = document.getElementById('screen-share-btn');
  if (!screenOn) {
    try {
      if (dailyCall) {
        await dailyCall.startScreenShare();
      } else {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const sv = document.getElementById('screen-video');
        sv.srcObject = stream; sv.style.display = 'block';
        document.getElementById('inst-video').style.display = 'none';
        stream.getVideoTracks()[0].onended = () => stopScreenShare();
      }
      screenOn = true;
      btn.querySelector('.icon').textContent  = '🖥️';
      btn.querySelector('.label').textContent = '공유 중지';
      btn.classList.add('screen-active');
      document.getElementById('screen-share-badge').style.display = 'block';
      document.getElementById('inst-main-label').textContent = '🖥️ 화면 공유 중';
    } catch (e) {
      if (e.name !== 'NotAllowedError') showToast('화면 공유를 시작할 수 없습니다.');
    }
  } else {
    stopScreenShare();
  }
}

function stopScreenShare() {
  if (dailyCall) {
    dailyCall.stopScreenShare();
  } else {
    const sv = document.getElementById('screen-video');
    sv.srcObject?.getTracks().forEach(t => t.stop());
    sv.style.display = 'none';
    document.getElementById('inst-video').style.display = camOn ? 'block' : 'none';
  }
  screenOn = false;
  const btn = document.getElementById('screen-share-btn');
  btn.querySelector('.icon').textContent  = '🖥️';
  btn.querySelector('.label').textContent = '화면 공유';
  btn.classList.remove('screen-active');
  document.getElementById('screen-share-badge').style.display = 'none';
  document.getElementById('inst-main-label').textContent = '🎓 강사 (나)';
}

// ── 카메라 ────────────────────────────────────
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, aspectRatio: { ideal: 16/9 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 16000, sampleSize: 16 }
    });
    localMediaStream = stream;
    document.getElementById('inst-video').srcObject    = stream;
    document.getElementById('inst-cam-off').style.display = 'none';
    connectCaptionUploader(currentRoomCode);
  } catch {
    document.getElementById('inst-cam-off').style.display = 'flex';
    document.getElementById('inst-video').style.display   = 'none';
  }
}

function toggleMic() {
  micOn = !micOn;
  if (dailyCall) dailyCall.setLocalAudio(micOn);
  localMediaStream?.getAudioTracks().forEach(t => { t.enabled = micOn; });
  if (!micOn) stopBrowserCaptionRecognition();
  else if (!captionRecognitionRunning) startBrowserCaptionRecognition();
  const btn = document.getElementById('inst-mic-btn');
  btn.querySelector('.icon').textContent  = micOn ? '🎙️' : '🔇';
  btn.querySelector('.label').textContent = micOn ? '마이크' : '음소거';
  btn.classList.toggle('off', !micOn);
}

function toggleCam() {
  camOn = !camOn;
  if (dailyCall) dailyCall.setLocalVideo(camOn);
  const btn = document.getElementById('inst-cam-btn');
  btn.querySelector('.icon').textContent  = camOn ? '📹' : '📷';
  btn.querySelector('.label').textContent = camOn ? '카메라' : '카메라 꺼짐';
  btn.classList.toggle('off', !camOn);
  if (!screenOn) {
    document.getElementById('inst-video').style.display   = camOn ? 'block' : 'none';
    document.getElementById('inst-cam-off').style.display = camOn ? 'none'  : 'flex';
  }
}

// ── 타이머 ────────────────────────────────────
function startTimer() {
  timerInterval = setInterval(() => {
    elapsed++;
    document.getElementById('inst-timer').textContent =
      `🕐 ${pad2(Math.floor(elapsed / 60))}:${pad2(elapsed % 60)}`;
  }, 1000);
}

// ── 초기화 ────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const userName   = sessionStorage.getItem('userName')   || '강사';
  const roomCode   = sessionStorage.getItem('roomCode')   || '';
  const courseName = sessionStorage.getItem('courseName') || '';

  // 과정명 헤더에 고정 표시
  const classLabel = document.getElementById('inst-class-label');
  if (classLabel) {
    classLabel.textContent = courseName || '멋쟁이사자처럼';
  }

  const avatarEl = document.getElementById('inst-avatar-text');
  if (avatarEl) avatarEl.textContent = userName.charAt(0);

  if (roomCode) {
    // sessionStorage에 코드 있으면 바로 적용
    _applyRoomCode(roomCode);
  } else if (courseName) {
    // 코드 없어도 과정명 있으면 자동으로 백엔드에서 오늘 세션 조회
    autoLoadRoomCode(userName, courseName);
  }

  startCamera();
  startTimer();
  connectWS();
  connectCaptionViewer();
  startRotation();
  if (roomCode) reconnectDailyRoomIfNeeded(userName, roomCode);
});

// 오늘 날짜 + 과정명으로 기존 세션 자동 조회
async function autoLoadRoomCode(userName, courseName) {
  try {
    const res = await fetch(
      `${BACKEND_URL}/api/create-room?instructor_name=${encodeURIComponent(userName)}&course_name=${encodeURIComponent(courseName)}`,
      { method: 'POST' }
    );
    if (!res.ok) return;
    const { room_code, token, room_url } = await res.json();
    _applyRoomCode(room_code);
    await joinDailyRoom(userName, token, room_url);
  } catch(e) {
    console.warn('[강사] 자동 세션 로드 실패:', e.message);
  }
}

// ── 강사 채팅 ─────────────────────────────────
function sendInstructorChat() {
  const input = document.getElementById('inst-chat-input');
  const text  = input.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  const name = sessionStorage.getItem('userName') || '강사';
  ws.send(JSON.stringify({
    type: 'chat', sender: name, text,
    role: 'instructor',
    timestamp: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
  }));
  input.value = '';
}

function appendInstChatMessage(msg) {
  const myName = sessionStorage.getItem('userName') || '강사';
  const isMine = msg.role === 'instructor';
  const cls    = isMine ? 'mine' : 'other';
  const senderLabel = isMine ? '' : `<div class="chat-msg-sender">${msg.sender}</div>`;

  const div = document.createElement('div');
  div.className = `chat-msg ${cls}`;
  div.innerHTML = `${senderLabel}<div>${msg.text}</div><div style="font-size:9px;opacity:0.4;margin-top:2px;">${msg.timestamp || ''}</div>`;

  const messages = document.getElementById('inst-chat-messages');
  if (!messages) return;
  // 기존 빈 상태 메시지 제거
  messages.querySelector('.feed-empty')?.remove();
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;

  // 인터랙션 피드에도 표시
  addFeedItem('chat', msg.sender, msg.text);
}

function appendInstHandRaise(sender) {
  const div = document.createElement('div');
  div.className = 'chat-msg system';
  div.textContent = `🙋 ${sender} 학생이 손을 들었습니다`;

  const messages = document.getElementById('inst-chat-messages');
  if (!messages) return;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;

  addFeedItem('hand', sender, '손들기');
  showToast(`🙋 ${sender} 학생이 손을 들었습니다!`);
}

function addFeedItem(type, name, text) {
  const feedList = document.getElementById('feed-list');
  if (!feedList) return;
  feedList.querySelector('.feed-empty')?.remove();

  const now  = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  const icon = type === 'hand' ? '🙋' : '💬';
  const item = document.createElement('div');
  item.className = `feed-item ${type}`;
  item.innerHTML = `
    <div class="feed-item-icon">${icon}</div>
    <div class="feed-item-body">
      <div class="feed-item-name">${name}</div>
      <div class="feed-item-text">${text}</div>
      <div class="feed-item-time">${now}</div>
    </div>`;
  feedList.prepend(item);
}

window.addEventListener('beforeunload', () => {
  dailyCall?.leave();
  stopCaptionStreaming();
  if (captionViewerWs) captionViewerWs.close();
  localMediaStream?.getTracks().forEach(t => t.stop());
  clearInterval(timerInterval);
  clearInterval(rotInterval);
  clearInterval(breakTimerInterval);
});