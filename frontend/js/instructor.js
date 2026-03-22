// =============================================
// instructor.js — Sleep2Wake 강사 화면
// =============================================

const BACKEND_URL   = 'https://sleepdetection-production.up.railway.app/';
const ROTATION_SIZE = 4;

let students    = {};
let rotationIdx = 0;
let rotationOn  = true;
let rotInterval = null;
let elapsed     = 0;
let timerInterval;
let micOn = true, camOn = true, screenOn = false;

// Daily.co 인스턴스
let dailyCall = null;

// ── WebSocket ────────────────────────────────
let ws = null;

function connectWS() {
  try {
    ws = new WebSocket(`${BACKEND_URL.replace('http', 'ws')}/ws/admin`);
    ws.onopen    = () => console.log('강사 WS 연결됨');
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if      (msg.type === 'student_update') students[msg.data.student_id] = msg.data;
      else if (msg.type === 'student_left')   delete students[msg.student_id];
      else if (msg.type === 'full_state')     students = msg.data;
      updateStats();
      renderStudentGrid();
    };
    ws.onclose = () => setTimeout(connectWS, 3000);
    ws.onerror = () => loadDemoStudents();
  } catch { loadDemoStudents(); }
}

// ── 더미 데이터 ──────────────────────────────
function loadDemoStudents() {
  students = {
    '노은서': { student_id:'노은서', name:'노은서', status:'focused', drowsy_cnt:0, yawn_cnt:0, head_cnt:0 },
    '최현우': { student_id:'최현우', name:'최현우', status:'warning', drowsy_cnt:1, yawn_cnt:2, head_cnt:0 },
    '이채현': { student_id:'이채현', name:'이채현', status:'focused', drowsy_cnt:0, yawn_cnt:0, head_cnt:0 },
  };
  updateStats();
  renderStudentGrid();
}

// ── 통계 업데이트 ────────────────────────────
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
  if (fill) fill.style.width = avg + '%';
  if (pct) {
    pct.textContent  = avg + '%';
    pct.style.color  = avg >= 70 ? 'var(--accent-green)' : avg >= 40 ? 'var(--accent-yellow)' : 'var(--accent-red)';
  }

  const stretchBtn = document.getElementById('stretch-btn');
  if (stretchBtn) stretchBtn.style.display = avg < 40 ? 'block' : 'none';
}

// ── 학생 그리드 ──────────────────────────────
function renderStudentGrid() {
  const list  = Object.values(students);
  const start = rotationIdx * ROTATION_SIZE;
  const slice = list.slice(start, start + ROTATION_SIZE);
  const pages = Math.max(1, Math.ceil(list.length / ROTATION_SIZE));

  document.getElementById('rotation-page').textContent = `${rotationIdx + 1} / ${pages}`;

  const grid = document.getElementById('inst-student-grid');
  if (!grid) return;

  grid.innerHTML = slice.map(s => {
    const penalty  = (s.drowsy_cnt||0)*10 + (s.yawn_cnt||0)*5 + (s.head_cnt||0)*5;
    const score    = Math.max(0, 100 - penalty);
    const barClass = score <= 30 ? 'alert' : score <= 60 ? 'warn' : '';
    const bgColor  = s.status === 'drowsy' || s.status === 'absent'
      ? 'rgba(239,68,68,0.25)' : 'rgba(255,123,0,0.2)';
    const initial  = (s.name || s.student_id || '?').charAt(0);
    return `
    <div class="inst-student-tile">
      <div class="inst-student-fallback">
        <div class="inst-peer-avatar" style="background:${bgColor}">${initial}</div>
        <div class="inst-peer-name">${s.name || s.student_id}</div>
      </div>
      <div class="tile-battery-overlay">
        <div class="tile-battery-icon">
          <div class="tile-battery-bar ${barClass}" style="width:${score}%"></div>
        </div>
      </div>
      <div class="tile-student-label">${s.name || s.student_id}</div>
    </div>`;
  }).join('');

  // 빈 슬롯
  const empty = ROTATION_SIZE - slice.length;
  for (let i = 0; i < empty; i++) {
    grid.innerHTML += `
    <div class="inst-student-tile">
      <div class="inst-student-fallback">
        <div style="font-size:20px;opacity:0.2">👤</div>
        <div class="inst-peer-name" style="opacity:0.3">대기 중</div>
      </div>
    </div>`;
  }
}

// ── 로테이션 ─────────────────────────────────
function startRotation() {
  rotInterval = setInterval(() => {
    if (!rotationOn) return;
    const pages = Math.max(1, Math.ceil(Object.keys(students).length / ROTATION_SIZE));
    rotationIdx = (rotationIdx + 1) % pages;
    renderStudentGrid();
  }, 5000);
}

function toggleRotation(on) { rotationOn = on; }

// ── 스트레칭 제안 ────────────────────────────
function suggestStretch() {
  showToast('💪 스트레칭 시간! 잠깐 쉬어가요 🧘');
}

// ══════════════════════════════════════════════
// Daily.co — 방 코드 생성 + 입장
// ══════════════════════════════════════════════

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
    showToast('✅ 과정 코드: ' + room_code + ' — 학생들에게 공유해주세요!');

  } catch (e) {
    console.warn('방 생성 실패, 폴백:', e.message);
    _applyRoomCode('LION-2025');
    showToast('과정 코드: LION-2025 (로컬 테스트 모드)');
  }
}

function _applyRoomCode(code) {
  document.getElementById('rcd-code-text').textContent  = code;
  document.getElementById('room-code-display').style.display = 'flex';
  document.getElementById('create-room-btn').style.display   = 'none';
  sessionStorage.setItem('roomCode', code);
  const classEl = document.getElementById('inst-class-label');
  if (classEl) classEl.textContent = '멋쟁이사자처럼 · ' + code;
}

function copyRoomCode() {
  const code = document.getElementById('rcd-code-text').textContent;
  navigator.clipboard.writeText(code)
    .then(() => showToast('✅ 과정 코드 복사됨: ' + code))
    .catch(() => {
      const el = Object.assign(document.createElement('textarea'), { value: code });
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      showToast('✅ 과정 코드 복사됨: ' + code);
    });
}

// ── Daily.co 방 입장 ──────────────────────────
async function joinDailyRoom(userName, token, roomUrl) {
  try {
    dailyCall = DailyIframe.createCallObject({
      audioSource: true,
      videoSource: true,
    });

    await dailyCall.join({ url: roomUrl, token });

    // 화면 공유 이벤트 처리
    dailyCall
      .on('started-camera',    () => console.log('카메라 시작'))
      .on('track-started',     handleTrackStarted)
      .on('track-stopped',     handleTrackStopped)
      .on('participant-joined', (e) => console.log('참여:', e.participant.user_name))
      .on('participant-left',   (e) => console.log('퇴장:', e.participant.user_name));

    console.log('Daily.co 강사 입장 완료');
  } catch (e) {
    console.warn('Daily.co 연결 실패:', e.message);
  }
}

// ── 화면 공유 ────────────────────────────────
async function toggleScreenShare() {
  const btn = document.getElementById('screen-share-btn');

  if (!screenOn) {
    // 화면 공유 시작
    try {
      if (dailyCall) {
        await dailyCall.startScreenShare();
      } else {
        // Daily.co 없을 때 — 브라우저 네이티브 화면 공유
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenVideo = document.getElementById('screen-video');
        screenVideo.srcObject = stream;
        screenVideo.style.display = 'block';
        document.getElementById('inst-video').style.display = 'none';
        // 공유 중단 감지
        stream.getVideoTracks()[0].onended = () => stopScreenShare();
      }

      screenOn = true;
      btn.querySelector('.icon').textContent  = '🖥️';
      btn.querySelector('.label').textContent = '공유 중지';
      btn.classList.add('screen-active');
      document.getElementById('screen-share-badge').style.display = 'block';
      document.getElementById('inst-main-label').textContent = '🖥️ 화면 공유 중';

    } catch (e) {
      if (e.name !== 'NotAllowedError') {
        showToast('화면 공유를 시작할 수 없습니다.');
      }
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

function handleTrackStarted(e) {
  if (e.track.kind === 'video' && e.participant?.screen) {
    // 강사 화면 공유 트랙 시작
    const screenVideo = document.getElementById('screen-video');
    screenVideo.srcObject = new MediaStream([e.track]);
    screenVideo.style.display = 'block';
    document.getElementById('inst-video').style.display = 'none';
  }
}

function handleTrackStopped(e) {
  if (e.track.kind === 'video' && e.participant?.screen) {
    stopScreenShare();
  }
}

// ── 카메라/마이크 컨트롤 ────────────────────
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById('inst-video').srcObject = stream;
    document.getElementById('inst-cam-off').style.display = 'none';
  } catch {
    document.getElementById('inst-cam-off').style.display = 'flex';
    document.getElementById('inst-video').style.display   = 'none';
  }
}

function toggleMic() {
  micOn = !micOn;
  if (dailyCall) dailyCall.setLocalAudio(micOn);
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

// ── 타이머 ───────────────────────────────────
function startTimer() {
  timerInterval = setInterval(() => {
    elapsed++;
    document.getElementById('inst-timer').textContent =
      `🕐 ${pad2(Math.floor(elapsed / 60))}:${pad2(elapsed % 60)}`;
  }, 1000);
}

function leaveRoom() {
  dailyCall?.leave();
  clearInterval(timerInterval);
  clearInterval(rotInterval);
  goTo('login');
}

function goReport() { goTo('report'); }
function suggestStretch() { showToast('💪 스트레칭 시간! 잠깐 쉬어가요 🧘'); }

// ── 초기화 ───────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const userName = sessionStorage.getItem('userName') || '강사';
  const roomCode = sessionStorage.getItem('roomCode') || '';

  // 강사 아바타 이름 첫 글자
  const avatarEl = document.getElementById('inst-avatar-text');
  if (avatarEl) avatarEl.textContent = userName.charAt(0);

  // 기존 방 코드 있으면 표시
  if (roomCode) _applyRoomCode(roomCode);

  startCamera();
  startTimer();
  connectWS();
  startRotation();
});

window.addEventListener('beforeunload', () => {
  dailyCall?.leave();
  clearInterval(timerInterval);
  clearInterval(rotInterval);
});