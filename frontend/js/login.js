// =============================================
// login.js — Sleep2Wake 로그인 로직
// =============================================

let currentTab = 'student';

// ── 탭 전환 ──────────────────────────────────
function selectTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', ['student', 'instructor', 'admin'][i] === tab);
  });

  const roomGroup   = document.getElementById('room-code-group');
  const adminNotice = document.getElementById('admin-notice');
  const courseGroup = document.getElementById('instructor-course-group');
  const btnText     = document.getElementById('login-btn-text');

  if (roomGroup)   roomGroup.style.display   = 'none';
  if (adminNotice) adminNotice.style.display  = 'none';
  if (courseGroup) courseGroup.style.display  = 'none';

  if (tab === 'student') {
    if (roomGroup) roomGroup.style.display = 'block';
    if (btnText)   btnText.textContent     = '수업 입장하기';

  } else if (tab === 'instructor') {
    if (courseGroup) courseGroup.style.display = 'block';
    if (btnText)     btnText.textContent       = '강의실 입장하기';

    // 이미 이름이 입력돼 있으면 바로 과정명 확인
    const name = document.getElementById('input-name')?.value.trim();
    if (name) loadCourseForInstructor(name);
    else      showCourseInput();

  } else if (tab === 'admin') {
    if (adminNotice) adminNotice.style.display = 'block';
    if (btnText)     btnText.textContent       = '대시보드 입장';
  }
}

// ── 이름 입력 시 호출 (oninput) ──────────────
function onNameInput() {
  if (currentTab !== 'instructor') return;
  const name = document.getElementById('input-name')?.value.trim();
  if (name) loadCourseForInstructor(name);
  else      showCourseInput();
}

// ── 해당 강사 이름에 맞는 과정명 불러오기 ────
function loadCourseForInstructor(name) {
  const key   = `instructor_${name}_course`;
  const saved = localStorage.getItem(key);

  const inputWrap = document.getElementById('course-input-wrap');
  const savedWrap = document.getElementById('course-saved-wrap');
  const savedText = document.getElementById('course-saved-text');

  if (saved) {
    if (savedText) savedText.textContent   = saved;
    if (inputWrap) inputWrap.style.display = 'none';
    if (savedWrap) savedWrap.style.display = 'block';
  } else {
    showCourseInput();
  }
}

// ── 과정명 입력창만 보이게 ────────────────────
function showCourseInput() {
  const inputWrap = document.getElementById('course-input-wrap');
  const savedWrap = document.getElementById('course-saved-wrap');
  const inputEl   = document.getElementById('input-course');

  if (inputWrap) inputWrap.style.display = 'block';
  if (savedWrap) savedWrap.style.display = 'none';
  if (inputEl)   inputEl.value           = '';
}

// ── 과정명 변경 버튼 ──────────────────────────
function resetCourseName() {
  const inputWrap = document.getElementById('course-input-wrap');
  const savedWrap = document.getElementById('course-saved-wrap');
  const inputEl   = document.getElementById('input-course');

  if (inputWrap) inputWrap.style.display = 'block';
  if (savedWrap) savedWrap.style.display = 'none';
  if (inputEl)   { inputEl.value = ''; inputEl.focus(); }
}

// ── 입장하기 ─────────────────────────────────
function doLogin() {
  const name = document.getElementById('input-name')?.value.trim() || '';

  if (!name) {
    showToast('이름을 입력해주세요.');
    document.getElementById('input-name')?.focus();
    return;
  }

  if (currentTab === 'student') {
    const roomCode = document.getElementById('input-room')?.value.trim() || '';
    if (!roomCode) {
      showToast('방 코드를 입력해주세요.');
      document.getElementById('input-room')?.focus();
      return;
    }
    sessionStorage.setItem('userName', name);
    sessionStorage.setItem('userRole', 'student');
    sessionStorage.setItem('roomCode', roomCode);

  } else if (currentTab === 'instructor') {
    const key        = `instructor_${name}_course`;
    const saved      = localStorage.getItem(key);
    const inputEl    = document.getElementById('input-course');
    const courseName = saved || inputEl?.value.trim() || '';

    if (!courseName) {
      showToast('과정명을 입력해주세요.');
      inputEl?.focus();
      return;
    }

    // 강사 이름 기준으로 저장
    localStorage.setItem(key, courseName);

    sessionStorage.setItem('userName', name);
    sessionStorage.setItem('userRole', 'instructor');
    sessionStorage.setItem('courseName', courseName);
    sessionStorage.setItem('roomCode', '');

  } else if (currentTab === 'admin') {
    sessionStorage.setItem('userName', name);
    sessionStorage.setItem('userRole', 'admin');
    sessionStorage.setItem('roomCode', '');
  }

  navigateTo(currentTab);
}

// ── 기타 유틸 ────────────────────────────────
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

document.addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});