// =============================================
// admin.js — Sleep2Wake 관리자 대시보드
// =============================================

const BACKEND_URL = 'https://sleepdetection-production.up.railway.app';

// ── 수업 방 데이터 ────────────────────────────
const rooms = {
  'LION-2025': {
    code: 'LION-2025', name: 'AI 엔지니어 과정',
    students: {
      '김민준': { student_id:'김민준', name:'김민준', status:'focused', ear:0.32, drowsy_cnt:0, yawn_cnt:0, head_cnt:0 },
      '이서연': { student_id:'이서연', name:'이서연', status:'drowsy',  ear:0.14, drowsy_cnt:3, yawn_cnt:1, head_cnt:0 },
      '박지호': { student_id:'박지호', name:'박지호', status:'absent',  ear:null, drowsy_cnt:0, yawn_cnt:0, head_cnt:0 },
      '최아름': { student_id:'최아름', name:'최아름', status:'focused', ear:0.28, drowsy_cnt:0, yawn_cnt:2, head_cnt:1 },
      '정우성': { student_id:'정우성', name:'정우성', status:'warning', ear:0.31, drowsy_cnt:1, yawn_cnt:3, head_cnt:0 },
      '한소희': { student_id:'한소희', name:'한소희', status:'focused', ear:0.35, drowsy_cnt:0, yawn_cnt:0, head_cnt:0 },
    }
  },
  'LION-2026': {
    code: 'LION-2026', name: 'Web 개발 과정',
    students: {
      '오민석': { student_id:'오민석', name:'오민석', status:'focused', ear:0.30, drowsy_cnt:0, yawn_cnt:0, head_cnt:0 },
      '윤지현': { student_id:'윤지현', name:'윤지현', status:'focused', ear:0.33, drowsy_cnt:0, yawn_cnt:1, head_cnt:0 },
      '장태민': { student_id:'장태민', name:'장태민', status:'drowsy',  ear:0.12, drowsy_cnt:2, yawn_cnt:0, head_cnt:1 },
    }
  }
};

const STATUS_LABEL = { focused:'집중', warning:'경고', drowsy:'졸음', absent:'이탈' };
const STATUS_COLOR = { focused:'#22c55e', warning:'#f59e0b', drowsy:'#ef4444', absent:'#f59e0b' };

let currentRoomCode = null;
let currentFilter   = 'all';
let searchQuery     = '';
let elapsed         = 0;
let simInterval, timerInterval;

// ── 탭 전환 ──────────────────────────────────
function switchTab(tab, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.remove('hidden');
  btn.classList.add('active');
  if (tab === 'report') renderSessions();
  if (tab === 'monitor') renderMonitor();
}

// ── 수업 방 탭 선택 ──────────────────────────
function selectRoom(code) {
  currentRoomCode = code;

  // 탭 버튼 active
  document.querySelectorAll('.room-tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.code === code);
  });

  // 수업 카드 active
  document.querySelectorAll('.room-card').forEach(c => {
    c.classList.toggle('active-room', c.dataset.code === code);
  });

  // 사이드바 현재 수업 표시
  const room = rooms[code];
  if (room) {
    document.getElementById('sidebar-current-room').style.display = 'block';
    document.getElementById('scr-code-text').textContent = room.code;
    document.getElementById('scr-name-text').textContent = room.name;
  }

  renderMonitor();
  updateAlertList();
}

// ── 수업 탭 바 렌더링 ────────────────────────
function renderRoomTabs() {
  const tabs = document.getElementById('room-tabs');
  tabs.innerHTML = Object.values(rooms).map(r => {
    const alertCnt = Object.values(r.students).filter(s => s.status==='drowsy'||s.status==='absent').length;
    return `
    <button class="room-tab-btn ${currentRoomCode===r.code?'active':''}"
            data-code="${r.code}"
            onclick="selectRoom('${r.code}')">
      <div class="room-tab-dot"></div>
      ${r.code}
      ${alertCnt > 0 ? `<span style="background:rgba(239,68,68,0.2);color:#ef4444;padding:1px 6px;border-radius:4px;font-size:10px">⚠️${alertCnt}</span>` : ''}
    </button>`;
  }).join('');
}

// ── 전체 현황 탭 ─────────────────────────────
function renderOverview() {
  const allStudents = Object.values(rooms).flatMap(r => Object.values(r.students));
  const total   = allStudents.length;
  const focused = allStudents.filter(s => s.status==='focused').length;
  const alerts  = allStudents.filter(s => s.status==='drowsy'||s.status==='absent').length;
  const avg     = total > 0 ? Math.round((focused/total)*100) : 0;

  document.getElementById('overview-summary').innerHTML = `
    <div class="ov-sum-card">
      <div class="ov-sum-icon">🏫</div>
      <div><div class="ov-sum-val" style="color:#FF7B00">${Object.keys(rooms).length}</div><div class="ov-sum-label">진행 중 수업</div></div>
    </div>
    <div class="ov-sum-card">
      <div class="ov-sum-icon">👥</div>
      <div><div class="ov-sum-val" style="color:#22c55e">${total}</div><div class="ov-sum-label">전체 접속 학생</div></div>
    </div>
    <div class="ov-sum-card">
      <div class="ov-sum-icon">⚠️</div>
      <div><div class="ov-sum-val" style="color:#ef4444">${alerts}</div><div class="ov-sum-label">경고 발생</div></div>
    </div>`;

  document.getElementById('room-cards').innerHTML = Object.values(rooms).map(r => {
    const list    = Object.values(r.students);
    const cnt     = list.length;
    const foc     = list.filter(s=>s.status==='focused').length;
    const alr     = list.filter(s=>s.status==='drowsy'||s.status==='absent').length;
    const ravg    = cnt > 0 ? Math.round((foc/cnt)*100) : 0;
    return `
    <div class="room-card ${currentRoomCode===r.code?'active-room':''}" data-code="${r.code}" onclick="selectRoom('${r.code}')">
      <div class="rc-header">
        <div class="rc-live"><div class="rc-live-dot"></div><span class="rc-live-text">LIVE</span></div>
        <div class="rc-code">${r.code}</div>
        <div class="rc-name">${r.name}</div>
      </div>
      <div class="rc-stats">
        <div class="rc-stat-item"><div class="rc-stat-val">${cnt}</div><div class="rc-stat-label">학생</div></div>
        <div class="rc-stat-item"><div class="rc-stat-val" style="color:#22c55e">${foc}</div><div class="rc-stat-label">집중</div></div>
        <div class="rc-stat-item"><div class="rc-stat-val" style="color:#ef4444">${alr}</div><div class="rc-stat-label">경고</div></div>
        <div class="rc-stat-item"><div class="rc-stat-val" style="color:#FF7B00">${ravg}%</div><div class="rc-stat-label">평균</div></div>
      </div>
      <div class="rc-focus-bar"><div class="rc-focus-fill" style="width:${ravg}%"></div></div>
      <button class="rc-enter-btn" onclick="event.stopPropagation();enterRoom('${r.code}')">
        모니터링 보기 →
      </button>
    </div>`;
  }).join('');
}

function enterRoom(code) {
  selectRoom(code);
  const monitorTab = document.querySelector('.nav-item:nth-child(2)');
  switchTab('monitor', monitorTab);
}

// ── 모니터링 탭 ──────────────────────────────
function renderMonitor() {
  if (!currentRoomCode) return;
  const room = rooms[currentRoomCode];
  if (!room) return;

  document.getElementById('monitor-title').textContent = `${room.code} · ${room.name}`;
  document.getElementById('monitor-sub').textContent = '실시간 학생 집중도 모니터링';

  const list    = Object.values(room.students);
  const total   = list.length;
  const focused = list.filter(s=>s.status==='focused').length;
  const alerts  = list.filter(s=>s.status==='drowsy'||s.status==='absent').length;
  const avg     = total > 0 ? Math.round((focused/total)*100) : 0;

  document.getElementById('m-total').textContent = total;
  document.getElementById('m-focus').textContent = focused;
  document.getElementById('m-alert').textContent = alerts;
  document.getElementById('m-avg').textContent   = avg + '%';

  const filtered = list.filter(s => {
    const mf = currentFilter==='all'
      || (currentFilter==='alert'  && (s.status==='drowsy'||s.status==='absent'))
      || (currentFilter==='normal' && s.status==='focused');
    return mf && (s.name||s.student_id||'').includes(searchQuery);
  });

  const grid = document.getElementById('student-grid');
  if (filtered.length === 0) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-text">검색 결과가 없습니다</div></div>`;
    return;
  }

  grid.innerHTML = filtered.map(s => {
    const color   = STATUS_COLOR[s.status]||'#22c55e';
    const label   = STATUS_LABEL[s.status]||'집중';
    const penalty = (s.drowsy_cnt||0)*10+(s.yawn_cnt||0)*5+(s.head_cnt||0)*5;
    const focus   = s.ear!=null ? Math.min(100,Math.max(0,100-penalty)) : null;
    const isAlert = s.status==='drowsy'||s.status==='absent';
    const initial = (s.name||s.student_id||'?').charAt(0);
    return `
    <div class="student-card ${isAlert?'alert':''}">
      ${isAlert?'<div class="card-pulse"></div>':''}
      <div class="cam-placeholder ${s.status}">
        <div class="student-avatar ${s.status}">${initial}</div>
      </div>
      <div class="card-bottom">
        <span class="student-name">${s.name||s.student_id}</span>
        <span class="status-tag ${s.status==='focused'?'normal':s.status}">${label}</span>
      </div>
      ${focus!=null?`
      <div class="focus-bar-top"><span>집중도</span><span style="color:${color}">${focus}%</span></div>
      <div class="focus-bar-bg"><div class="focus-bar-fill" style="width:${focus}%;background:${color}"></div></div>`:''}
    </div>`;
  }).join('');
}

// ── 경고 목록 ────────────────────────────────
function updateAlertList() {
  const room = currentRoomCode ? rooms[currentRoomCode] : null;
  const list = room ? Object.values(room.students).filter(s=>s.status==='drowsy'||s.status==='absent') : [];
  const alertListEl = document.getElementById('sb-alert-list');
  alertListEl.innerHTML = list.length === 0
    ? '<div class="sb-no-alert">경고 없음 ✓</div>'
    : list.map(s=>`
      <div class="alert-item">
        <div class="alert-dot"></div>
        <span class="alert-name">${s.name||s.student_id}</span>
        <span class="alert-tag">${STATUS_LABEL[s.status]}</span>
      </div>`).join('');
}

// ── 필터 ─────────────────────────────────────
function setFilter(f, btn) {
  currentFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderMonitor();
}
function filterStudents(q) { searchQuery=q; renderMonitor(); }

// ── 시뮬레이션 ───────────────────────────────
function startSim() {
  simInterval = setInterval(() => {
    Object.values(rooms).forEach(room => {
      const keys = Object.keys(room.students);
      if (!keys.length) return;
      const key = keys[Math.floor(Math.random()*keys.length)];
      const r = Math.random();
      if      (r < 0.05) room.students[key] = {...room.students[key], status:'drowsy', drowsy_cnt:(room.students[key].drowsy_cnt||0)+1};
      else if (r < 0.08) room.students[key] = {...room.students[key], status:'absent'};
      else if (r < 0.15) room.students[key] = {...room.students[key], status:'focused'};
    });
    renderOverview();
    renderRoomTabs();
    renderMonitor();
    updateAlertList();
  }, 3000);
}

// ── 리포트 ───────────────────────────────────
const sessions = [
  { date:'2025.03.10', title:'React 기초 - Props & State', duration:'2h 30m', avgFocus:78, alerts:12 },
  { date:'2025.03.08', title:'JavaScript 비동기 처리',     duration:'2h 00m', avgFocus:85, alerts: 7 },
  { date:'2025.03.06', title:'HTML/CSS 레이아웃',          duration:'1h 45m', avgFocus:91, alerts: 3 },
  { date:'2025.03.04', title:'Git & GitHub 워크플로우',    duration:'2h 15m', avgFocus:72, alerts:18 },
];

function renderSessions() {
  document.getElementById('session-list').innerHTML = sessions.map(s => {
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
  }).join('');
}

function exportCSV() {
  const rows = ['날짜,수업명,시간,평균집중도,경고횟수',
    ...sessions.map(s=>`${s.date},${s.title},${s.duration},${s.avgFocus}%,${s.alerts}`)
  ].join('\n');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([rows],{type:'text/csv;charset=utf-8;'})),
    download: 'sleep2wake_report.csv'
  });
  a.click();
}

function doLogout() { goTo('login'); }

// ── 초기화 ───────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  renderRoomTabs();
  renderOverview();
  startSim();
});

window.addEventListener('beforeunload', () => clearInterval(simInterval));