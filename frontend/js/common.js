// =============================================
// common.js - 공통 유틸리티
// =============================================

/**
 * 페이지 이동 (href 방식)
 * @param {string} page - 'login' | 'student' | 'admin' | 'report'
 */
function goTo(page) {
  const map = {
    login:   'index.html',
    student: 'student.html',
    admin:   'admin.html',
    report:  'report.html',
  };
  if (map[page]) window.location.href = map[page];
}

/**
 * 토스트 알림 표시
 * @param {string} msg - 표시할 메시지
 * @param {number} duration - 표시 시간 (ms), 기본 4000
 */
function showToast(msg, duration = 4000) {
  let toast = document.getElementById('alert-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'alert-toast';
    toast.className = 'alert-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), duration);
}

/**
 * 숫자를 두 자리 문자열로 변환
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 집중도 값에 따른 색상 반환
 * @param {number} score - 0~100
 * @returns {string} CSS color
 */
function focusColor(score) {
  if (score >= 80) return '#10b981';
  if (score >= 60) return '#f59e0b';
  return '#ef4444';
}