// =============================================
// report.js - 리포트 페이지 로직
// =============================================

const sessions = [
  { date: '2025.03.10', title: 'React 기초 - Props & State',   duration: '2h 30m', avgFocus: 78, alerts: 12 },
  { date: '2025.03.08', title: 'JavaScript 비동기 처리',        duration: '2h 00m', avgFocus: 85, alerts:  7 },
  { date: '2025.03.06', title: 'HTML/CSS 레이아웃',             duration: '1h 45m', avgFocus: 91, alerts:  3 },
  { date: '2025.03.04', title: 'Git & GitHub 워크플로우',       duration: '2h 15m', avgFocus: 72, alerts: 18 },
];

// ── 초기화 ──────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  renderSessions();
});

// ── 세션 렌더링 ─────────────────────────────
function renderSessions() {
  document.getElementById('session-list').innerHTML = sessions
    .map((s) => {
      const color = focusColor(s.avgFocus);
      return `
      <div class="session-row">
        <div class="session-date">${s.date}</div>
        <div class="session-info">
          <div class="session-title">${s.title}</div>
          <div class="session-duration">수업 시간: ${s.duration}</div>
        </div>
        <div class="session-focus">
          <div class="session-focus-val" style="color:${color}">${s.avgFocus}%</div>
          <div class="session-focus-label">평균 집중도</div>
        </div>
        <div class="session-alerts">
          <div class="session-alerts-val">${s.alerts}</div>
          <div class="session-alerts-label">경고</div>
        </div>
        <div class="session-bar">
          <div class="session-bar-bg">
            <div class="session-bar-fill" style="width:${s.avgFocus}%;background:${color}"></div>
          </div>
        </div>
      </div>`;
    })
    .join('');
}

// ── CSV 내보내기 ─────────────────────────────
function exportCSV() {
  const header = '날짜,수업명,시간,평균집중도,경고횟수\n';
  const rows = sessions
    .map((s) => `${s.date},${s.title},${s.duration},${s.avgFocus}%,${s.alerts}`)
    .join('\n');
  const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'focusroom_report.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ── 페이지 이동 ─────────────────────────────
function goBack() { goTo('admin'); }