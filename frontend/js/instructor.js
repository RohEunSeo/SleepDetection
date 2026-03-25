// =============================================
// instructor.js - Sleep2Wake 강사 화면
// =============================================

const IS_LOCAL_HOST = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const BACKEND_URL = IS_LOCAL_HOST
  ? 'http://127.0.0.1:8000'
  : 'https://sleepdetection-production.up.railway.app';
const ROTATION_SIZE = 4;

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

// [수정] Daily.co participant → session_id 매핑 (영상 타일 관리용)
const participantVideoMap = {};

function getWsBaseUrl() {
  return BACKEND_URL.replace('https://', 'wss://').replace('http://', 'ws://');
}

function renderCaption(text, speaker = '강사', isFinal = true) {
  const captionEl = document.getElementById('inst-live-caption');
  if (!captionEl) return;
  captionEl.textContent = `${speaker}: ${text}`;
  captionEl.classList.add('show');
  captionEl.classList.toggle('interim', !isFinal);
  clearTimeout(captionClearTimer);
  captionClearTimer = setTimeout(() => {
    captionEl.classList.remove('show');
    captionEl.classList.remove('interim');
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
}

function sendCaptionText(text, isFinal = false) {
  if (!text || !captionTextWs || captionTextWs.readyState !== WebSocket.OPEN) return;
  const normalized = text.trim();
  if (!normalized) return;
  if (normalized === lastCaptionSentText && !isFinal) return;
  lastCaptionSentText = normalized;
  captionTextWs.send(JSON.stringify({
    text: normalized,
    final: isFinal,
    speaker: sessionStorage.getItem('userName') || '강사',
  }));
}

function stopBrowserCaptionRecognition() {
  if (!captionRecognition) return;
  captionRecognition.onresult = null;
  captionRecognition.onerror = null;
  captionRecognition.onend = null;
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
      if (event.results[i].isFinal) finalText += `${transcript} `;
      else interimText += `${transcript} `;
    }
    const interimNormalized = interimText.trim();
    const finalNormalized   = finalText.trim();
    if (interimNormalized) { renderCaption(interimNormalized, '강사', false); sendCaptionText(interimNormalized, false); }
    if (finalNormalized)   { renderCaption(finalNormalized,   '강사', true);  sendCaptionText(finalNormalized,   true);  }
  };

  captionRecognition.onerror = (event) => {
    if (event.error === 'no-speech') return;
    console.warn('브라우저 자막 인식 오류:', event.error);
  };

  captionRecognition.onend = () => {
    captionRecognitionRunning = false;
    if (!micOn) return;
    try { captionRecognition.start(); captionRecognitionRunning = true; } catch {}
  };

  try {
    captionRecognition.start();
    captionRecognitionRunning = true;
    console.log('브라우저 자막 인식 시작');
    return true;
  } catch (error) {
    console.warn('브라우저 자막 인식 시작 실패:', error);
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
  console.warn('이 브라우저는 Web Speech API를 지원하지 않습니다.');
}

function connectWS() {
  try {
    ws = new WebSocket(`${getWsBaseUrl()}/ws/admin`);
    ws.onopen = () => console.log('강사 WS 연결됨');
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'student_update') students[msg.data.student_id] = msg.data;
      else if (msg.type === 'student_left') delete students[msg.student_id];
      else if (msg.type === 'full_state') students = msg.data;
      updateStats();
      renderStudentGrid();
    };
    ws.onclose = () => setTimeout(connectWS, 3000);
    ws.onerror = () => loadDemoStudents();
  } catch {
    loadDemoStudents();
  }
}

function loadDemoStudents() {
  students = {
    '노은서': { student_id: '노은서', name: '노은서', status: 'focused', drowsy_cnt: 0, yawn_cnt: 0, head_cnt: 0 },
    '최현우': { student_id: '최현우', name: '최현우', status: 'warning', drowsy_cnt: 1, yawn_cnt: 2, head_cnt: 0 },
    '이채현': { student_id: '이채현', name: '이채현', status: 'focused', drowsy_cnt: 0, yawn_cnt: 0, head_cnt: 0 },
  };
  updateStats();
  renderStudentGrid();
}

function updateStats() {
  const list    = Object.values(students);
  const total   = list.length;
  const focused = list.filter(s => s.status === 'focused').length;
  const alerts  = list.filter(s => s.status === 'drowsy' || s.status === 'absent').length;
  const avg     = total > 0 ? Math.round((focused / total) * 100) : 0;

  document.getElementById('inst-total').textContent = total;
  document.getElementById('inst-focus').textContent = focused;
  document.getElementById('inst-alert').textContent = alerts;

  const fill = document.getElementById('class-focus-fill');
  const pct  = document.getElementById('class-focus-pct');
  if (fill) fill.style.width = `${avg}%`;
  if (pct) {
    pct.textContent = `${avg}%`;
    pct.style.color = avg >= 70 ? 'var(--accent-green)' : avg >= 40 ? 'var(--accent-yellow)' : 'var(--accent-red)';
  }

  const stretchBtn = document.getElementById('stretch-btn');
  if (stretchBtn) stretchBtn.style.display = avg < 40 ? 'block' : 'none';
}

function renderStudentGrid() {
  const list  = Object.values(students);
  const start = rotationIdx * ROTATION_SIZE;
  const slice = list.slice(start, start + ROTATION_SIZE);
  const pages = Math.max(1, Math.ceil(list.length / ROTATION_SIZE));

  document.getElementById('rotation-page').textContent = `${rotationIdx + 1} / ${pages}`;

  const grid = document.getElementById('inst-student-grid');
  if (!grid) return;

  // [수정] innerHTML 통째 교체 대신 DOM diff — 기존 타일 재사용해서 깜빡임 방지
  const existingIds = new Set([...grid.querySelectorAll('.inst-student-tile[id]')].map(el => el.id));
  const neededIds   = new Set(slice.map(s => `tile-${s.student_id}`));

  // 필요없는 타일 제거
  existingIds.forEach(id => {
    if (!neededIds.has(id)) document.getElementById(id)?.remove();
  });

  // 빈 슬롯 제거
  grid.querySelectorAll('.inst-student-tile:not([id])').forEach(el => el.remove());

  // 학생 타일 추가/업데이트
  slice.forEach((s, idx) => {
    const sid      = s.student_id;
    const penalty  = (s.drowsy_cnt || 0) * 10 + (s.yawn_cnt || 0) * 5 + (s.head_cnt || 0) * 5;
    const score    = Math.max(0, 100 - penalty);
    const barClass = score <= 30 ? 'alert' : score <= 60 ? 'warn' : '';
    const bgColor  = s.status === 'drowsy' || s.status === 'absent' ? 'rgba(239,68,68,0.25)' : 'rgba(255,123,0,0.2)';
    const initial  = (s.name || s.student_id || '?').charAt(0);

    let tile = document.getElementById(`tile-${sid}`);
    if (!tile) {
      // 새 타일 생성
      tile = document.createElement('div');
      tile.className = 'inst-student-tile';
      tile.id = `tile-${sid}`;
      tile.innerHTML = `
        <video class="inst-student-video" id="video-${sid}" autoplay muted playsinline
               style="display:none; width:100%; height:100%; object-fit:cover; position:absolute; inset:0; border-radius:inherit;"></video>
        <div class="inst-student-fallback" id="fallback-${sid}">
          <div class="inst-peer-avatar" style="background:${bgColor}">${initial}</div>
          <div class="inst-peer-name">${s.name || s.student_id}</div>
        </div>
        <div class="tile-battery-overlay">
          <div class="tile-battery-icon">
            <div class="tile-battery-bar ${barClass}" id="bar-${sid}" style="width:${score}%"></div>
          </div>
        </div>
        <div class="tile-student-label">${s.name || s.student_id}</div>`;
      grid.appendChild(tile);
      // 트랙 연결
      if (participantVideoMap[sid]) attachStudentVideo(sid, participantVideoMap[sid]);
    } else {
      // 기존 타일 업데이트 (배터리만 갱신, video 태그 건드리지 않음)
      const bar = document.getElementById(`bar-${sid}`);
      if (bar) { bar.style.width = `${score}%`; bar.className = `tile-battery-bar ${barClass}`; }
      const fallback = document.getElementById(`fallback-${sid}`);
      if (fallback) fallback.querySelector('.inst-peer-avatar')?.setAttribute('style', `background:${bgColor}`);
    }
  });

  // 빈 슬롯 채우기
  const empty = ROTATION_SIZE - slice.length;
  for (let i = 0; i < empty; i++) {
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

// [수정] 학생 video 태그에 트랙 연결하는 헬퍼
function attachStudentVideo(sid, track) {
  const videoEl    = document.getElementById(`video-${sid}`);
  const fallbackEl = document.getElementById(`fallback-${sid}`);
  if (!videoEl) return;

  videoEl.srcObject = new MediaStream([track]);
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

function suggestStretch() {
  showToast('💪 스트레칭 시간! 잠깐 쉬어가요 🧘');
}

async function createRoom() {
  const btn      = document.getElementById('create-room-btn');
  const userName = sessionStorage.getItem('userName') || '강사';
  btn.disabled   = true;
  btn.textContent = '생성 중...';

  try {
    const res = await fetch(
      `${BACKEND_URL}/api/create-room?instructor_name=${encodeURIComponent(userName)}`,
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
    btn.textContent = '방 생성';
  }
}

function _applyRoomCode(code) {
  currentRoomCode = code;
  document.getElementById('rcd-code-text').textContent = code;
  document.getElementById('room-code-display').style.display = 'flex';
  document.getElementById('create-room-btn').style.display   = 'none';
  sessionStorage.setItem('roomCode', code);
  const classEl = document.getElementById('inst-class-label');
  if (classEl) classEl.textContent = `멋쟁이사자처럼 · ${code}`;
  connectCaptionTextWs();
}

function copyRoomCode() {
  const code = document.getElementById('rcd-code-text').textContent;
  navigator.clipboard.writeText(code)
    .then(() => showToast(`✅ 과정 코드 복사됨: ${code}`))
    .catch(() => {
      const el = Object.assign(document.createElement('textarea'), { value: code });
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      showToast(`✅ 과정 코드 복사됨: ${code}`);
    });
}

async function joinDailyRoom(userName, token, roomUrl) {
  try {
    dailyCall = DailyIframe.createCallObject({
      audioSource: true,
      videoSource: true,
    });

    await dailyCall.join({ url: roomUrl, token });

    dailyCall
      .on('started-camera',     () => console.log('카메라 시작'))
      .on('track-started',      handleTrackStarted)
      .on('track-stopped',      handleTrackStopped)
      // [수정] 학생 입장/퇴장 처리
      .on('participant-joined', onParticipantJoined)
      .on('participant-left',   onParticipantLeft);

    console.log('Daily.co 강사 입장 완료');
  } catch (e) {
    console.warn('Daily.co 연결 실패:', e.message);
  }
}

// [수정] 학생 입장 — WS students 객체에 추가 + 그리드 갱신
function onParticipantJoined(e) {
  if (e.participant.local) return;
  const { session_id: sid, user_name: name = '참여자' } = e.participant;
  console.log('학생 입장:', name);

  if (!students[name]) {
    students[name] = { student_id: name, name, status: 'focused', drowsy_cnt: 0, yawn_cnt: 0, head_cnt: 0 };
  }
  updateStats();
  renderStudentGrid();
}

// [수정] 학생 퇴장 — students 객체에서 제거 + 그리드 갱신
function onParticipantLeft(e) {
  const { session_id: sid, user_name: name = '' } = e.participant;
  console.log('학생 퇴장:', name);
  delete students[name];
  delete participantVideoMap[name];
  updateStats();
  renderStudentGrid();
}

// [수정] 트랙 시작 — 학생 video 태그에 영상 연결
function handleTrackStarted(e) {
  if (e.participant.local) return;

  if (e.track.kind === 'video' && e.participant.screen) {
    // 화면 공유 트랙
    const screenVideo = document.getElementById('screen-video');
    if (screenVideo) {
      screenVideo.srcObject = new MediaStream([e.track]);
      screenVideo.style.display = 'block';
      document.getElementById('inst-video').style.display = 'none';
    }
    return;
  }

  if (e.track.kind === 'video' && !e.participant.screen) {
    // 학생 웹캠 트랙
    const name = e.participant.user_name || '';
    participantVideoMap[name] = e.track;
    attachStudentVideo(name, e.track);
  }
}

function handleTrackStopped(e) {
  if (e.track.kind === 'video' && e.participant?.screen) {
    stopScreenShare();
  }
}

async function toggleScreenShare() {
  const btn = document.getElementById('screen-share-btn');

  if (!screenOn) {
    try {
      if (dailyCall) {
        await dailyCall.startScreenShare();
      } else {
        const stream      = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenVideo = document.getElementById('screen-video');
        screenVideo.srcObject = stream;
        screenVideo.style.display = 'block';
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
    const screenVideo = document.getElementById('screen-video');
    screenVideo.srcObject?.getTracks().forEach(t => t.stop());
    screenVideo.style.display = 'none';
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

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
        channelCount: 1,
        sampleRate:   16000,
        sampleSize:   16,
      }
    });
    localMediaStream = stream;
    document.getElementById('inst-video').srcObject = stream;
    document.getElementById('inst-cam-off').style.display = 'none';
    connectCaptionUploader(currentRoomCode);
  } catch {
    document.getElementById('inst-cam-off').style.display    = 'flex';
    document.getElementById('inst-video').style.display      = 'none';
  }
}

function toggleMic() {
  micOn = !micOn;
  if (dailyCall) dailyCall.setLocalAudio(micOn);
  localMediaStream?.getAudioTracks().forEach(track => { track.enabled = micOn; });
  if (!micOn) { stopBrowserCaptionRecognition(); }
  else if (!captionRecognitionRunning) { startBrowserCaptionRecognition(); }
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
    document.getElementById('inst-video').style.display    = camOn ? 'block' : 'none';
    document.getElementById('inst-cam-off').style.display  = camOn ? 'none'  : 'flex';
  }
}

function startTimer() {
  timerInterval = setInterval(() => {
    elapsed++;
    document.getElementById('inst-timer').textContent =
      `🕐 ${pad2(Math.floor(elapsed / 60))}:${pad2(elapsed % 60)}`;
  }, 1000);
}

// [수정] 수업 종료 — 백엔드에 room_closed broadcast 요청
async function leaveRoom() {
  try {
    const roomCode = sessionStorage.getItem('roomCode') || currentRoomCode;
    await fetch(`${BACKEND_URL}/api/room/close?room_code=${encodeURIComponent(roomCode)}`, {
      method: 'POST'
    });
  } catch {}

  dailyCall?.leave();
  stopCaptionStreaming();
  if (captionViewerWs) captionViewerWs.close();
  localMediaStream?.getTracks().forEach(track => track.stop());
  clearInterval(timerInterval);
  clearInterval(rotInterval);
  goTo('login');
}

function goReport() { goTo('report'); }

window.addEventListener('DOMContentLoaded', () => {
  const userName = sessionStorage.getItem('userName') || '강사';
  const roomCode = sessionStorage.getItem('roomCode') || '';

  const avatarEl = document.getElementById('inst-avatar-text');
  if (avatarEl) avatarEl.textContent = userName.charAt(0);

  if (roomCode) _applyRoomCode(roomCode);

  startCamera();
  startTimer();
  connectWS();
  connectCaptionViewer();
  startRotation();
});

window.addEventListener('beforeunload', () => {
  dailyCall?.leave();
  stopCaptionStreaming();
  if (captionViewerWs) captionViewerWs.close();
  localMediaStream?.getTracks().forEach(track => track.stop());
  clearInterval(timerInterval);
  clearInterval(rotInterval);
});