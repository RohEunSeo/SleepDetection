// =============================================
// admin.js - 관리자 대시보드 로직
// =============================================

// 학생 데이터
const students = [
  { id: 1, name: '김민준', status: 'normal', ear: 0.32, alert: null,   avatar: 'KM' },
  { id: 2, name: '이서연', status: 'drowsy', ear: 0.14, alert: '졸음', avatar: 'LS' },
  { id: 3, name: '박지호', status: 'absent', ear: null, alert: '이탈', avatar: 'PJ' },
  { id: 4, name: '최아름', status: 'normal', ear: 0.28, alert: null,   avatar: 'CA' },
  { id: 5, name: '정우성', status: 'yawn',   ear: 0.31, alert: '하품', avatar: 'JW' },
  { id: 6, name: '한소희', status: 'normal', ear: 0.35, alert: null,   avatar: 'HS' },
  { id: 7, name: '오태양', status: 'drowsy', ear: 0.11, alert: '졸음', avatar: 'OT' },
  { id: 8, name: '신예은', status: 'normal', ear: 0.29, alert: null,   avatar: 'SY' },
];

const STATUS_LABEL = { normal: '정상', drowsy: '졸음', absent: '이탈', yawn: '하품' };
const STATUS_COLOR = {
  normal: '#10b981',
  drowsy: '#ef4444',
  absent: '#f59e0b',
  yawn:   '#f59e0b',
};

let currentFilter = 'all';
let searchQuery   = '';
let simInterval;

// ── 초기화 ──────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  renderGrid();
  startSim();
});

window.addEventListener('beforeunload', () => {
  clearInterval(simInterval);
});

// ── 시뮬레이션 ──────────────────────────────
function startSim() {
  simInterval = setInterval(() => {
    students.forEach((s) => {
      const r = Math.random();
      if      (r < 0.05) { s.status = 'drowsy'; s.alert = '졸음'; s.ear = 0.12; }
      else if (r < 0.08) { s.status = 'absent'; s.alert = '이탈'; s.ear = null; }
      else if (r < 0.16) { s.status = 'normal'; s.alert = null;   s.ear = 0.28 + Math.random() * 0.1; }
    });
    renderGrid();
  }, 3000);
}

// ── 통계 업데이트 ────────────────────────────
function updateStats() {
  const total  = students.length;
  const normal = students.filter((s) => s.status === 'normal').length;
  const alerts = students.filter((s) => s.alert).length;
  const avg    = Math.round((normal / total) * 100);

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-focus').textContent = normal;
  document.getElementById('stat-alert').textContent = alerts;
  document.getElementById('stat-avg').textContent   = avg + '%';

  // 경고 목록
  document.getElementById('alert-list').innerHTML = students
    .filter((s) => s.alert)
    .map(
      (s) => `
      <div class="alert-item">
        <div class="alert-dot"></div>
        <span class="alert-name">${s.name}</span>
        <span class="alert-tag">${s.alert}</span>
      </div>`
    )
    .join('');
}

// ── 그리드 렌더링 ────────────────────────────
function renderGrid() {
  updateStats();

  const filtered = students.filter((s) => {
    const matchFilter =
      currentFilter === 'all' ||
      (currentFilter === 'alert'  && s.alert) ||
      (currentFilter === 'normal' && !s.alert);
    const matchSearch = s.name.includes(searchQuery);
    return matchFilter && matchSearch;
  });

  document.getElementById('student-grid').innerHTML = filtered
    .map((s) => {
      const color = STATUS_COLOR[s.status];
      const label = STATUS_LABEL[s.status];
      const focusVal = s.ear != null ? Math.min(100, Math.round(s.ear * 300)) : null;

      return `
      <div class="student-card ${s.alert ? 'alert' : ''}">
        ${s.alert ? '<div class="card-pulse"></div>' : ''}
        <div class="cam-placeholder ${s.status}">
          <div class="student-avatar ${s.status}">${s.avatar}</div>
        </div>
        <div class="card-bottom">
          <span class="student-name">${s.name}</span>
          <span class="status-tag ${s.status === 'normal' ? 'normal' : s.status}">${label}</span>
        </div>
        ${focusVal != null
          ? `<div class="focus-bar-wrap">
               <div class="focus-bar-top">
                 <span>집중도</span>
                 <span style="color:${color}">${focusVal}%</span>
               </div>
               <div class="focus-bar-bg">
                 <div class="focus-bar-fill" style="width:${focusVal}%;background:${color}"></div>
               </div>
             </div>`
          : ''}
      </div>`;
    })
    .join('');
}

// ── 필터 / 검색 ─────────────────────────────
function setFilter(f, btn) {
  currentFilter = f;
  document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  renderGrid();
}

function filterStudents(q) {
  searchQuery = q;
  renderGrid();
}

// ── 페이지 이동 ─────────────────────────────
function goReport()  { goTo('report'); }
function doLogout()  { goTo('login'); }