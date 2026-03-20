// =============================================
// login.js — Sleep2Wake 로그인 로직
// =============================================

let currentTab = 'student';

function selectTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    const tabs = ['student', 'instructor', 'admin'];
    btn.classList.toggle('active', tabs[i] === tab);
  });

  const roomGroup      = document.getElementById('room-code-group');
  const adminNotice    = document.getElementById('admin-notice');
  const instructorNote = document.getElementById('instructor-notice');
  const btnText        = document.getElementById('login-btn-text');

  // 기본 숨김
  if (roomGroup)      roomGroup.style.display      = 'none';
  if (adminNotice)    adminNotice.style.display     = 'none';
  if (instructorNote) instructorNote.style.display  = 'none';

  if (tab === 'student') {
    // 수강생 — 방 코드 입력 필요
    if (roomGroup) roomGroup.style.display = 'block';
    if (btnText)   btnText.textContent     = '수업 입장하기';
  } else if (tab === 'instructor') {
    // 강사 — 방 코드 입력 없음, 안내 메시지만
    if (instructorNote) instructorNote.style.display = 'block';
    if (btnText)        btnText.textContent          = '강의실 입장하기';
  } else if (tab === 'admin') {
    // 매니저 — 방 코드 없음
    if (adminNotice) adminNotice.style.display = 'block';
    if (btnText)     btnText.textContent       = '대시보드 입장';
  }
}

function doLogin() {
  const name     = document.getElementById('input-name')?.value.trim() || '';
  const roomCode = document.getElementById('input-room')?.value.trim() || '';

  if (!name) {
    showToast('이름을 입력해주세요.');
    document.getElementById('input-name')?.focus();
    return;
  }

  // 수강생만 방 코드 필수
  if (currentTab === 'student' && !roomCode) {
    showToast('방 코드를 입력해주세요.');
    document.getElementById('input-room')?.focus();
    return;
  }

  sessionStorage.setItem('userName', name);
  sessionStorage.setItem('userRole', currentTab);
  sessionStorage.setItem('roomCode', roomCode || '');

  navigateTo(currentTab);
}

function quickLogin(role) {
  currentTab = role;
  // 수강생 데모일 때만 방 코드 자동 입력
  if (role === 'student') {
    const roomInput = document.getElementById('input-room');
    if (roomInput && !roomInput.value.trim()) roomInput.value = 'LION-2025';
  }
  // 이름도 없으면 데모 이름 자동 입력
  const nameInput = document.getElementById('input-name');
  if (nameInput && !nameInput.value.trim()) {
    const demoNames = { student: '수강생', instructor: '강사', admin: '매니저' };
    nameInput.value = demoNames[role] || role;
  }
  navigateTo(role);
}

function setRoomCode(code) {
  const el = document.getElementById('input-room');
  if (el) el.value = code;
}

async function pasteRoomCode() {
  try {
    const text = await navigator.clipboard.readText();
    const el   = document.getElementById('input-room');
    if (el) el.value = text.trim().toUpperCase();
  } catch {
    showToast('클립보드 접근 권한이 없습니다.');
  }
}

function navigateTo(role) {
  const map = {
    student:    'student.html',
    instructor: 'instructor.html',
    admin:      'admin.html',
  };
  if (map[role]) window.location.href = map[role];
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});