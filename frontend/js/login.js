// =============================================
// login.js - 로그인 페이지 로직
// =============================================

let currentTab = 'student';

/** 탭 선택 (student / admin) */
function selectTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', (i === 0 && tab === 'student') || (i === 1 && tab === 'admin'));
  });
}

/** 로그인 버튼 클릭 */
function doLogin() {
  const email    = document.querySelector('input[type="email"]').value.trim();
  const password = document.querySelector('input[type="password"]').value;

  // 간단한 유효성 검사 (실제 연동 시 API 호출로 교체)
  if (!email || !password) {
    showToast('이메일과 비밀번호를 입력해주세요.');
    return;
  }

  goTo(currentTab === 'admin' ? 'admin' : 'student');
}

/** Enter 키로 로그인 */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});