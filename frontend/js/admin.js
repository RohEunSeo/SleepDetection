// =============================================
// admin.js — Sleep2Wake 관리자 (제미나이 스타일)
// Supabase API 연동 + 실시간 WebSocket
// =============================================

const IS_LOCAL_HOST = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const BACKEND_URL = IS_LOCAL_HOST
  ? 'http://127.0.0.1:8000'
  : 'https://sleepdetection-production.up.railway.app';

function getWsBaseUrl() {
  return BACKEND_URL.replace('https://', 'wss://').replace('http://', 'ws://');
}

// ── 상태 ──────────────────────────────────
const STATUS_LABEL = {
  focused: '집중', distracted: '주의산만',
  warning: '졸음의심', drowsy: '졸음확정', absent: '자리이탈',
};
const STATUS_COLOR = {
  focused: '#10b981', distracted: '#eab308',
  warning: '#f97316', drowsy: '#ef4444', absent: '#9ca3af',
};
const ATTITUDE_COLORS = [
  '#FF7710','#f97316','#6366f1','#a855f7','#ec4899',
  '#3b82f6','#0ea5e9','#14b8a6','#10b981','#22c55e',
];

let activeSessions  = [];
let wsStudents      = {};
let ws              = null;
let pollInterval    = null;
let selectedCourse  = '';
let currentSessions = [];
let selectedSession = null;

// ── 유틸 ─────────────────────────────────
function focusColor(pct) {
  if (pct >= 80) return '#10b981';  // 초록
  if (pct >= 60) return '#FF7710';  // 주황
  return '#ef4444';                  // 빨강
}

// ── 뷰 전환 ──────────────────────────────
function switchView(tab, btn) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  if (tab === 'dashboard') {
    document.getElementById('view-dashboard-list').classList.add('active');
  } else {
    const el = document.getElementById('view-' + tab);
    if (el) el.classList.add('active');
    if (tab === 'report') loadCourses();
  }
}

function goBackToCourseList() {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-dashboard-list').classList.add('active');
}

function doLogout() {
  if (typeof goTo === 'function') goTo('login');
  else location.href = 'index.html';
}

// ── WebSocket ─────────────────────────────
function connectWS() {
  try {
    ws = new WebSocket(`${getWsBaseUrl()}/ws/admin`);
    ws.onopen    = () => console.log('[Admin WS] 연결됨');
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'student_update') {
        if (msg.data?.status) msg.data.status = msg.data.status.toLowerCase();
        wsStudents[msg.data.student_id] = msg.data;
        renderStudentAttitude();
        renderCourseGrid(); // 카드 학생 수 실시간 갱신
      } else if (msg.type === 'student_left') {
        delete wsStudents[msg.student_id];
        renderStudentAttitude();
        renderCourseGrid(); // 카드 학생 수 실시간 갱신
      }
    };
    ws.onclose = () => setTimeout(connectWS, 3000);
  } catch(e) { console.warn('[Admin WS]', e); }
}

// ── 진행 중 세션 폴링 ─────────────────────
async function pollActiveSessions() {
  try {
    const res  = await fetch(`${BACKEND_URL}/api/sessions/active`);
    const data = await res.json();
    activeSessions = Array.isArray(data) ? data : [];
    renderCourseGrid();
  } catch(e) { console.warn('[Admin] 폴링 실패:', e); }
}

// ── 수업 카드 그리드 렌더링 ───────────────
function renderCourseGrid() {
  const grid = document.getElementById('course-grid');
  if (!activeSessions.length) {
    grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:60px 0;color:#9ca3af;">
        <div style="font-size:40px;margin-bottom:12px;">🎓</div>
        <div style="font-size:14px;">현재 진행 중인 수업이 없습니다</div>
      </div>`;
    return;
  }
  grid.innerHTML = activeSessions.map((s, i) => {
    // Python True/False 문자열 및 boolean 모두 처리
    const isLive = s.is_active === true || s.is_active === 'true' || s.is_active === 'True';
    const focus    = s.avg_focus    || 0;
    const alerts   = s.alert_count  || 0;
    // 실시간 접속 학생 수: wsStudents 기준으로 카운트
    const wsCount  = Object.values(wsStudents).length;
    const students = wsCount > 0 ? wsCount : (s.student_count || 0);
    return `
    <div class="course-card" onclick="enterCourse('${s.room_code}', '${s.course_name || s.room_code}', ${isLive})">
      <div class="course-card-header">
        <div class="course-card-name">${s.course_name || s.room_code}</div>
        ${isLive
          ? `<span class="live-badge"><span class="live-dot"></span>LIVE</span>`
          : `<span class="ended-badge">종료됨</span>`}
      </div>
      <div class="course-stats">
        <div class="cstat-box gray">
          <div class="cstat-label">학생 수</div>
          <div class="cstat-val">${students}명</div>
        </div>
        <div class="cstat-box indigo">
          <div class="cstat-label indigo">오늘 집중도</div>
          <div class="cstat-val indigo">${focus}%</div>
        </div>
        <div class="cstat-box ${alerts > 0 ? 'orange' : 'gray'}">
          <div class="cstat-label ${alerts > 0 ? 'orange' : ''}">실시간 경고</div>
          <div class="cstat-val ${alerts > 0 ? 'orange' : ''}">${alerts}건</div>
        </div>
      </div>
      <button class="course-enter-btn">일간 대시보드 보기</button>
    </div>`;
  }).join('');
}

function enterCourse(roomCode, courseName, isLive) {
  selectedSession = activeSessions.find(s => s.room_code === roomCode) || {};

  // 상세 뷰 전환
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-dashboard-detail').classList.add('active');

  // 헤더 업데이트
  document.getElementById('detail-course-name').textContent = courseName;

  // 오늘 날짜로 초기화
  const todayStr = new Date().toISOString().split('T')[0];
  setDetailDate(todayStr);

  // 날짜 input 초기화
  const dateInput = document.getElementById('detail-date-input');
  if (dateInput) {
    dateInput.value = todayStr;
    dateInput.max   = todayStr;
  }
  document.getElementById('date-picker-label').textContent = '오늘';

  // 수업중 배지
  updateStatusBadge(isLive);

  // 통계 카드
  document.getElementById('d-students').textContent = `${selectedSession.student_count || 0}명`;
  document.getElementById('d-focus').textContent    = `${selectedSession.avg_focus || 0}%`;
  document.getElementById('d-alert').textContent    = `${selectedSession.alert_count || 0}건`;

  renderStudentAttitude();
  drawFocusChart();
}

function setDetailDate(dateStr) {
  const d    = new Date(dateStr);
  const days = ['일','월','화','수','목','금','토'];
  const label = `${d.getFullYear()}년 ${d.getMonth()+1}월 ${d.getDate()}일 (${days[d.getDay()]})`;
  document.getElementById('detail-date').textContent = label;
}

function updateStatusBadge(isLive) {
  const badge = document.getElementById('detail-status-badge');
  if (!badge) return;
  badge.style.display = 'flex';
  if (isLive) {
    badge.style.background = '#fef2f2';
    badge.style.color      = '#ef4444';
    badge.style.border     = '1px solid #fecaca';
    badge.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:#ef4444;animation:pulse 1.5s infinite;display:inline-block;"></span> 수업중';
  } else {
    badge.style.background = '#f3f4f6';
    badge.style.color      = '#6b7280';
    badge.style.border     = '1px solid #e5e7eb';
    badge.innerHTML = '수업종료';
  }
}

async function loadSessionByDate(dateStr) {
  const todayStr  = new Date().toISOString().split('T')[0];
  const isToday   = dateStr === todayStr;
  const courseName = document.getElementById('detail-course-name')?.textContent || '';

  // 날짜 레이블 업데이트
  setDetailDate(dateStr);
  document.getElementById('date-picker-label').textContent = isToday ? '오늘' : dateStr;

  if (isToday) {
    // 오늘 → 실시간 모드
    updateStatusBadge(true);
    document.getElementById('d-students').textContent = `${selectedSession.student_count||0}명`;
    document.getElementById('d-focus').textContent    = `${selectedSession.avg_focus||0}%`;
    document.getElementById('d-alert').textContent    = `${selectedSession.alert_count||0}건`;
    renderStudentAttitude();
  } else {
    // 과거 날짜 → Supabase 조회
    try {
      const url  = `${BACKEND_URL}/api/sessions?course_name=${encodeURIComponent(courseName)}`;
      const res  = await fetch(url);
      const sessions = await res.json();
      const match = Array.isArray(sessions) ? sessions.find(s => s.date === dateStr) : null;
      if (match) {
        updateStatusBadge(false);
        document.getElementById('d-students').textContent = `${match.student_count||0}명`;
        document.getElementById('d-focus').textContent    = `${match.avg_focus||0}%`;
        document.getElementById('d-alert').textContent    = `${match.alert_count||0}건`;
        document.getElementById('student-attitude-list').innerHTML =
          `<div class="empty-msg">📅 ${dateStr} 수업 기록 — 총 ${match.student_count||0}명 참여, 평균 집중도 ${match.avg_focus||0}%</div>`;
      } else {
        updateStatusBadge(false);
        document.getElementById('d-students').textContent = '-';
        document.getElementById('d-focus').textContent    = '-';
        document.getElementById('d-alert').textContent    = '-';
        document.getElementById('student-attitude-list').innerHTML =
          `<div class="empty-msg">📭 ${dateStr}에 해당하는 수업 기록이 없습니다.</div>`;
      }
    } catch(e) {
      document.getElementById('student-attitude-list').innerHTML = '<div class="empty-msg">데이터 조회 실패</div>';
    }
    drawFocusChart();
  }
}

// ── 학생 태도 테이블 ─────────────────────
function renderStudentAttitude() {
  const list = Object.values(wsStudents);
  const el   = document.getElementById('student-attitude-list');
  if (!el) return;

  if (!list.length) {
    el.innerHTML = '<div class="empty-msg">접속 중인 학생이 없습니다</div>';
    return;
  }

  // 집중도 낮은 순 정렬
  const sorted = [...list].sort((a, b) => {
    const pa = (a.drowsy_cnt||0)*10+(a.yawn_cnt||0)*5+(a.head_cnt||0)*3;
    const pb = (b.drowsy_cnt||0)*10+(b.yawn_cnt||0)*5+(b.head_cnt||0)*3;
    return pb - pa;
  });

  el.innerHTML = sorted.map((s, i) => {
    const penalty = (s.drowsy_cnt||0)*10+(s.yawn_cnt||0)*5+(s.head_cnt||0)*3;
    const focus   = Math.max(0, 100 - penalty);
    const color   = ATTITUDE_COLORS[i % ATTITUDE_COLORS.length];
    const status  = (s.status || 'focused').toLowerCase();
    const label   = STATUS_LABEL[status] || '집중';
    return `
    <div class="student-row">
      <div class="student-num">${String(i+1).padStart(2,'0')}</div>
      <div class="student-name-cell">${s.name || s.student_id}</div>
      <div class="attitude-bar-wrap">
        <div class="attitude-bar-bg">
          <div class="attitude-bar-fill" style="width:${focus}%;background:${color}"></div>
        </div>
      </div>
      <div class="align-right">
        <span class="status-chip ${status}">${label}</span>
      </div>
    </div>`;
  }).join('');
}

// ── 집중도 차트 그리기 (SVG) ─────────────
const CHART_DATA = [
  { time:'09:00', focus:85, sleep:2 },
  { time:'10:00', focus:88, sleep:1 },
  { time:'11:00', focus:72, sleep:15 },
  { time:'12:00', focus:60, sleep:25 },
  { time:'13:00', focus:45, sleep:35 },
  { time:'14:00', focus:80, sleep:5  },
  { time:'15:00', focus:82, sleep:4  },
];

function drawChart(svgId, data, keys) {
  const svg = document.getElementById(svgId);
  if (!svg) return;
  const W = 1000, H = 300, PAD = 40;
  const n = data.length;
  const xStep = (W - PAD*2) / (n - 1);

  const getY = (val, max=100) => H - PAD - ((val / max) * (H - PAD*2));
  const getX = (i) => PAD + i * xStep;

  let html = '';

  // 그리드
  [0,1,2,3,4].forEach(i => {
    const y = PAD + i * ((H - PAD*2) / 4);
    const val = 100 - i * 25;
    html += `<line x1="${PAD}" y1="${y}" x2="${W-PAD}" y2="${y}" stroke="#f3f4f6" stroke-dasharray="4 4" stroke-width="1"/>`;
    html += `<text x="${PAD-8}" y="${y+4}" fill="#9ca3af" font-size="11" text-anchor="end" font-family="Pretendard,sans-serif">${val}%</text>`;
  });

  // X축 라벨
  data.forEach((d, i) => {
    html += `<text x="${getX(i)}" y="${H-8}" fill="#9ca3af" font-size="11" text-anchor="middle" font-family="Pretendard,sans-serif">${d.time}</text>`;
  });

  keys.forEach(({ key, color, gradId }) => {
    const points = data.map((d,i) => `${getX(i)},${getY(d[key])}`).join(' ');
    const linePath = data.map((d,i) => `${i===0?'M':'L'} ${getX(i)} ${getY(d[key])}`).join(' ');
    const areaPath = `${linePath} L ${getX(n-1)} ${H-PAD} L ${getX(0)} ${H-PAD} Z`;

    if (gradId) {
      html += `<path d="${areaPath}" fill="url(#${gradId})"/>`;
    }
    html += `<path d="${linePath}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    data.forEach((d, i) => {
      html += `<circle cx="${getX(i)}" cy="${getY(d[key])}" r="5" fill="#fff" stroke="${color}" stroke-width="2.5"/>`;
    });
  });

  svg.innerHTML = svg.innerHTML + html;
}

function drawFocusChart() {
  const svg = document.getElementById('focus-chart');
  if (svg) svg.innerHTML = `<defs><linearGradient id="focusGrad" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#6366f1" stop-opacity="0.15"/><stop offset="100%" stop-color="#6366f1" stop-opacity="0"/></linearGradient></defs>`;
  drawChart('focus-chart', CHART_DATA, [
    { key: 'focus', color: '#6366f1', gradId: 'focusGrad' },
    { key: 'sleep', color: '#FF7710', gradId: null },
  ]);
}

function drawReportChart() {
  const svg = document.getElementById('report-chart');
  if (svg) svg.innerHTML = `<defs><linearGradient id="reportGrad" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#FF7710" stop-opacity="0.15"/><stop offset="100%" stop-color="#FF7710" stop-opacity="0"/></linearGradient></defs>`;
  drawChart('report-chart', CHART_DATA, [
    { key: 'focus', color: '#FF7710', gradId: 'reportGrad' },
  ]);
}

// ── 리포트: 과정 목록 ────────────────────
async function loadCourses() {
  try {
    const res     = await fetch(`${BACKEND_URL}/api/courses`);
    const courses = await res.json();
    const select  = document.getElementById('report-course-select');
    if (!select) return;
    select.innerHTML = '<option value="">수업을 선택해주세요</option>'
      + (Array.isArray(courses) ? courses : []).map(c =>
          `<option value="${c}" ${c===selectedCourse?'selected':''}>${c}</option>`
        ).join('');
    if (selectedCourse) loadSessions(selectedCourse);
  } catch(e) { console.warn('[Admin] 과정 로드 실패:', e); }
}

function onReportCourseChange(course) {
  selectedCourse = course;
  if (course) {
    loadSessions(course);
  } else {
    document.getElementById('report-empty').style.display   = 'flex';
    document.getElementById('report-content').style.display = 'none';
  }
}

async function loadSessions(courseName) {
  selectedCourse = courseName;

  // 과정 미선택 시 초기 상태
  if (!courseName) {
    document.getElementById('report-empty').style.display   = 'flex';
    document.getElementById('report-content').style.display = 'none';
    const pdfBtn = document.getElementById('btn-open-pdf');
    if (pdfBtn) pdfBtn.style.display = 'none';
    const titleEl = document.getElementById('report-main-title');
    if (titleEl) titleEl.textContent = '기간별 누적 리포트';
    return;
  }

  try {
    const url = `${BACKEND_URL}/api/sessions?course_name=${encodeURIComponent(courseName)}`;
    const res  = await fetch(url);
    const data = await res.json();
    currentSessions = Array.isArray(data) ? data : [];

    // 제목 업데이트
    const titleEl = document.getElementById('report-main-title');
    if (titleEl) titleEl.textContent = `${courseName} 종합 리포트`;

    // 빈 상태 페이드 아웃
    const emptyEl = document.getElementById('report-empty');
    if (emptyEl) {
      emptyEl.style.transition = 'opacity 0.25s ease';
      emptyEl.style.opacity = '0';
      setTimeout(() => { emptyEl.style.display = 'none'; emptyEl.style.opacity = '1'; }, 260);
    }

    // 콘텐츠 페이드인 + 슬라이드업
    const contentEl = document.getElementById('report-content');
    if (contentEl) {
      contentEl.style.opacity = '0';
      contentEl.style.transform = 'translateY(12px)';
      contentEl.style.display = 'flex';
      contentEl.style.flexDirection = 'column';
      contentEl.style.gap = '20px';
      contentEl.style.transition = 'opacity 0.35s ease, transform 0.35s ease';
      setTimeout(() => {
        contentEl.style.opacity = '1';
        contentEl.style.transform = 'translateY(0)';
      }, 280);
    }

    // PDF 버튼 페이드인
    const pdfBtn = document.getElementById('btn-open-pdf');
    if (pdfBtn) {
      pdfBtn.style.opacity = '0';
      pdfBtn.style.display = 'flex';
      pdfBtn.style.transition = 'opacity 0.3s ease';
      setTimeout(() => { pdfBtn.style.opacity = '1'; }, 300);
    }

    renderReportStats();
    renderSessionList();
    renderTop5();
    drawReportChart();
  } catch(e) {
    console.warn('[Admin] 세션 로드 실패:', e);
  }
}

function renderReportStats() {
  const total    = currentSessions.length;
  const avgFocus = total > 0
    ? Math.round(currentSessions.reduce((a,s) => a+(s.avg_focus||0), 0) / total)
    : 0;
  const totalAlerts = currentSessions.reduce((a,s) => a+(s.alert_count||0), 0);

  document.getElementById('r-attendance').textContent = '93.7%';
  document.getElementById('r-focus').textContent      = `${avgFocus}%`;
  document.getElementById('r-alerts').textContent     = `${totalAlerts}건`;
  const badge = document.getElementById('r-focus-badge');
  if (badge) { badge.textContent = '지난 달 대비 + 2.1%'; }
}

function renderSessionList() {
  const el = document.getElementById('session-list');
  if (!el) return;
  if (!currentSessions.length) {
    el.innerHTML = '<div class="empty-msg">수업 기록이 없습니다</div>';
    return;
  }
  el.innerHTML = currentSessions.map(s => {
    const focus = s.avg_focus || 0;
    const color = focusColor(focus);
    const dur   = s.duration_min
      ? `${Math.floor(s.duration_min/60)}h ${Math.round(s.duration_min%60)}m` : '-';
    return `
    <div class="session-row-item">
      <div class="session-date-cell">${s.date || '-'}</div>
      <div>
        <div class="session-info-name">${s.course_name || s.room_code}</div>
        <div class="session-info-sub">강사: ${s.instructor || '-'} · ${dur}</div>
      </div>
      <div class="session-focus-val" style="color:${color}">${focus}%</div>
      <div class="session-alert-val">${s.alert_count || 0}</div>
      <div class="session-bar-bg">
        <div class="session-bar-fill" style="width:${focus}%;background:${color}"></div>
      </div>
    </div>`;
  }).join('');
}

function renderTop5() {
  const el = document.getElementById('top5-list');
  if (!el) return;
  const dummy = [
    { name:'김OO', type:'danger',  title:'잦은 이탈',    desc:'총 이탈 25분 / 3회 발생',        action:'상담 필요' },
    { name:'이OO', type:'warning', title:'심한 졸음',    desc:'졸음 상태 지속 시간 최고치',       action:'주의 관찰' },
    { name:'최OO', type:'warning', title:'주의 산만',    desc:'화면 이탈 및 딴짓 감지 12회',      action:'주의 관찰' },
    { name:'정OO', type:'danger',  title:'장기 이탈',    desc:'수업 참여율 30% 미만',             action:'상담 필요' },
    { name:'박OO', type:'success', title:'베스트 집중',  desc:'정상 상태 98% 유지',               action:''          },
  ];
  el.innerHTML = dummy.map(s => `
    <div class="top5-item ${s.type}">
      <div class="top5-left">
        <div class="top5-icon" style="background:${s.type==='danger'?'#fecaca':s.type==='warning'?'#fed7aa':'#bbf7d0'}">
          ${s.type==='success'?'🏆':s.type==='danger'?'🔴':'🟠'}
        </div>
        <div>
          <div class="top5-name ${s.type}">${s.name} 학생 (${s.title})</div>
          <div class="top5-desc ${s.type}">${s.desc}</div>
        </div>
      </div>
      ${s.action ? `<button class="top5-action-btn ${s.type}">${s.action}</button>` : ''}
    </div>`).join('');
}

// ── CSV 내보내기 ─────────────────────────
function exportCSV() {
  if (!currentSessions.length) { showToast('내보낼 데이터가 없습니다.'); return; }
  const rows = [
    '날짜,과정명,강사,시작,종료,시간(분),학생수,평균집중도,경고횟수',
    ...currentSessions.map(s =>
      `${s.date||''},${s.course_name||''},${s.instructor||''},${s.started_at||''},${s.ended_at||''},${s.duration_min||0},${s.student_count||0},${s.avg_focus||0}%,${s.alert_count||0}`
    )
  ].join('\n');
  const a = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(new Blob(['\uFEFF'+rows], {type:'text/csv;charset=utf-8;'})),
    download: `sleep2wake_report_${selectedCourse||'전체'}.csv`,
  });
  a.click();
}

// ── 초기화 ──────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // 관리자 이름 표시
  const adminName = sessionStorage.getItem('userName') || '관리자';
  document.querySelectorAll('#admin-name, #profile-name-text').forEach(el => {
    if (el) el.textContent = adminName;
  });

  // ── 탭 전환 ──
  document.querySelectorAll('#sidebar-nav .nav-item[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (tab === 'dashboard') {
        document.getElementById('view-dashboard-list').classList.add('active');
      } else {
        document.getElementById('view-' + tab)?.classList.add('active');
        if (tab === 'report') loadCourses();
      }
    });
  });

  // 나가기
  document.getElementById('nav-signout')?.addEventListener('click', doLogout);

  // 뒤로가기
  document.getElementById('btn-back-list')?.addEventListener('click', goBackToCourseList);

  // 날짜 선택
  const datePicker = document.getElementById('btn-date-picker');
  const dateInput  = document.getElementById('detail-date-input');
  datePicker?.addEventListener('click', () => {
    if (dateInput) {
      try { dateInput.showPicker(); } catch(e) { dateInput.click(); }
    }
  });
  dateInput?.addEventListener('change', (e) => {
    if (e.target.value) loadSessionByDate(e.target.value);
  });

  // 리포트 과정 선택
  document.getElementById('report-course-select')?.addEventListener('change', (e) => {
    loadSessions(e.target.value);
  });

  // PDF 열기
  document.getElementById('btn-open-pdf')?.addEventListener('click', openPdfPreview);

  // PDF 모달 컨트롤
  document.getElementById('btn-pdf-prev')?.addEventListener('click', () => {
    if (pdfPage > 1) { pdfPage--; updatePdfPage(); }
  });
  document.getElementById('btn-pdf-next')?.addEventListener('click', () => {
    if (pdfPage < 2) { pdfPage++; updatePdfPage(); }
  });
  document.getElementById('btn-pdf-save')?.addEventListener('click', savePdf);
  document.getElementById('btn-pdf-close')?.addEventListener('click', () => {
    document.getElementById('pdf-preview-modal').style.display = 'none';
  });
  document.getElementById('pdf-preview-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'pdf-preview-modal') e.target.style.display = 'none';
  });

  // 캐시 지우기
  document.getElementById('btn-clear-cache')?.addEventListener('click', () => {
    localStorage.clear();
    if (typeof showToast === 'function') showToast('캐시가 초기화되었습니다.');
  });

  // 토글들
  ['toggle-absent','toggle-drowsy','toggle-report','toggle-sound','toggle-autosave'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', function() { this.classList.toggle('on'); });
  });

  // 다크모드 (설정 탭에만 있는 토글)
  document.getElementById('dark-mode-toggle')?.addEventListener('click', function() {
    toggleDarkMode(this);
  });

  // 슬라이더
  document.getElementById('drowsy-range')?.addEventListener('input', (e) => updateDrowsyLabel(e.target.value));
  document.getElementById('gaze-range')?.addEventListener('input', (e) => updateGazeLabel(e.target.value));
  document.getElementById('absent-range')?.addEventListener('input', (e) => {
    const el = document.getElementById('absent-val-label');
    if (el) el.textContent = `${e.target.value}초`;
  });

  // 새로고침 주기
  document.getElementById('poll-interval-select')?.addEventListener('change', (e) => {
    clearInterval(pollInterval);
    pollInterval = setInterval(pollActiveSessions, parseInt(e.target.value));
    if (typeof showToast === 'function') showToast(`새로고침 주기: ${e.target.value/1000}초`);
  });

  // 프로필 이미지
  document.getElementById('btn-edit-avatar')?.addEventListener('click', () => {
    document.getElementById('profile-img-input')?.click();
  });
  document.getElementById('btn-profile-edit')?.addEventListener('click', () => {
    document.getElementById('profile-img-input')?.click();
  });
  document.getElementById('profile-img-input')?.addEventListener('change', function() {
    onProfileImgChange(this);
  });

  // 다크모드 복원
  if (localStorage.getItem('darkMode') === '1') {
    document.body.classList.add('dark-mode');
    document.getElementById('dark-mode-toggle')?.classList.add('on');
  }

  // 프로필 이미지 복원
  const savedImg = localStorage.getItem('profileImg');
  if (savedImg) {
    const img = document.getElementById('profile-big-img');
    const headerImg = document.getElementById('header-avatar');
    if (img) img.src = savedImg;
    if (headerImg) headerImg.src = savedImg;
  }

  connectWS();
  pollActiveSessions();
  pollInterval = setInterval(pollActiveSessions, 5000);
});

// ── PDF 미리보기 ──────────────────────────
let pdfPage = 1;

function openPdfPreview() {
  const modal = document.getElementById('pdf-preview-modal');
  if (!modal) { console.warn('PDF 모달 없음'); return; }

  const courseName  = selectedCourse || '전체';
  const today       = new Date();
  const dateStr     = `${today.getFullYear()}. ${today.getMonth()+1}. ${today.getDate()}.`;
  const total       = currentSessions.length;
  const avgFocus    = total > 0 ? Math.round(currentSessions.reduce((a,s)=>a+(s.avg_focus||0),0)/total) : 0;
  const totalAlerts = currentSessions.reduce((a,s)=>a+(s.alert_count||0),0);

  document.getElementById('pdf-content-1').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #FF7710;padding-bottom:20px;margin-bottom:24px;">
      <div>
        <div style="font-size:22px;font-weight:800;color:#111827;margin-bottom:4px;">교육 성취도 종합 리포트</div>
        <div style="font-size:14px;font-weight:600;color:#6b7280;">${courseName}</div>
      </div>
      <div style="text-align:right;">
        <div style="color:#FF7710;font-weight:800;font-size:15px;">🦁 LIKELION</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px;">작성일: ${dateStr}</div>
      </div>
    </div>
    <div style="margin-bottom:24px;">
      <div style="font-size:13px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:10px;margin-bottom:14px;">1. 기간 내 요약 지표</div>
      <div style="display:flex;gap:12px;">
        <div style="flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:16px;text-align:center;"><div style="font-size:22px;font-weight:800;color:#111827;">93.7%</div><div style="font-size:11px;color:#9ca3af;margin-top:2px;">평균 출석률</div></div>
        <div style="flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:16px;text-align:center;"><div style="font-size:22px;font-weight:800;color:#FF7710;">${avgFocus}%</div><div style="font-size:11px;color:#9ca3af;margin-top:2px;">평균 집중도</div></div>
        <div style="flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:16px;text-align:center;"><div style="font-size:22px;font-weight:800;color:#ef4444;">${totalAlerts}건</div><div style="font-size:11px;color:#9ca3af;margin-top:2px;">경고 발생 누적</div></div>
      </div>
    </div>
    <div style="margin-bottom:24px;">
      <div style="font-size:13px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:10px;margin-bottom:14px;">2. 시간대별 평균 누적 집중도</div>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;height:180px;">
        <svg viewBox="0 0 700 140" style="width:100%;height:100%;" preserveAspectRatio="none">
          <defs><linearGradient id="pdfG" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#FF7710" stop-opacity="0.2"/><stop offset="100%" stop-color="#FF7710" stop-opacity="0"/></linearGradient></defs>
          ${[0,1,2,3].map(i=>`<line x1="0" y1="${i*46}" x2="700" y2="${i*46}" stroke="#e5e7eb" stroke-dasharray="4 4" stroke-width="1"/>`).join('')}
          <path d="M 0 25 L 117 15 L 233 60 L 350 90 L 467 115 L 583 32 L 700 28 L 700 140 L 0 140 Z" fill="url(#pdfG)"/>
          <path d="M 0 25 L 117 15 L 233 60 L 350 90 L 467 115 L 583 32 L 700 28" fill="none" stroke="#FF7710" stroke-width="2.5" stroke-linecap="round"/>
          ${[[0,25],[117,15],[233,60],[350,90],[467,115],[583,32],[700,28]].map(([x,y])=>`<circle cx="${x}" cy="${y}" r="4" fill="#fff" stroke="#FF7710" stroke-width="2"/>`).join('')}
        </svg>
      </div>
    </div>
    <div>
      <div style="font-size:13px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:10px;margin-bottom:14px;">3. 수업 기록 요약</div>
      ${currentSessions.length > 0 ? `
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:#f3f4f6;"><th style="padding:10px 12px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">날짜</th><th style="padding:10px 12px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">강사</th><th style="padding:10px 12px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">참여 학생</th><th style="padding:10px 12px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">평균 집중도</th><th style="padding:10px 12px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">경고 횟수</th></tr></thead>
        <tbody>${currentSessions.slice(0,6).map(s=>`
          <tr><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">${s.date||'-'}</td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">${s.instructor||'-'}</td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">${s.student_count||0}명</td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:${focusColor(s.avg_focus||0)};font-weight:700;">${s.avg_focus||0}%</td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">${s.alert_count||0}건</td></tr>`).join('')}</tbody>
      </table>` : '<div style="color:#9ca3af;text-align:center;padding:20px;font-size:13px;">수업 기록이 없습니다</div>'}
    </div>
    <div style="text-align:center;font-size:11px;color:#9ca3af;padding-top:20px;border-top:1px solid #e5e7eb;margin-top:24px;">
      본 리포트는 멋쟁이사자처럼 AI 수강생 태도 분석 시스템에 의해 자동으로 생성되었습니다. — 1 / 2 —
    </div>`;

  document.getElementById('pdf-content-2').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #FF7710;padding-bottom:16px;margin-bottom:24px;">
      <div style="font-size:14px;font-weight:600;color:#6b7280;">${courseName} — 종합 리포트 (계속)</div>
      <div style="color:#FF7710;font-weight:800;font-size:14px;">🦁 LIKELION</div>
    </div>
    <div style="margin-bottom:24px;">
      <div style="font-size:13px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:10px;margin-bottom:14px;">4. 누적 집중 관리 요망 학생</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:#f3f4f6;"><th style="padding:10px 12px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">학생명</th><th style="padding:10px 12px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">상태 분류</th><th style="padding:10px 12px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">상세 내용</th><th style="padding:10px 12px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">권장 조치</th></tr></thead>
        <tbody>
          <tr><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-weight:700;">김OO</td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;"><span style="background:#fee2e2;color:#dc2626;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;">잦은 이탈</span></td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#6b7280;">총 이탈 25분 / 3회 발생</td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#6366f1;font-weight:700;">상담 필요</td></tr>
          <tr><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-weight:700;">이OO</td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;"><span style="background:#ffedd5;color:#c2410c;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;">심한 졸음</span></td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#6b7280;">졸음 상태 지속 시간 최고치</td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#6366f1;font-weight:700;">주의 관찰</td></tr>
          <tr><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-weight:700;">최OO</td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;"><span style="background:#ffedd5;color:#c2410c;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;">주의 산만</span></td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#6b7280;">화면 이탈 및 딴짓 감지 12회</td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#6366f1;font-weight:700;">주의 관찰</td></tr>
          <tr><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-weight:700;">정OO</td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;"><span style="background:#fee2e2;color:#dc2626;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;">장기 이탈</span></td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#6b7280;">수업 참여율 30% 미만</td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#6366f1;font-weight:700;">상담 필요</td></tr>
          <tr><td style="padding:10px 12px;font-weight:700;">박OO</td><td style="padding:10px 12px;"><span style="background:#d1fae5;color:#059669;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;">베스트 집중</span></td><td style="padding:10px 12px;color:#6b7280;">정상 상태 98% 유지</td><td style="padding:10px 12px;color:#10b981;font-weight:700;">우수</td></tr>
        </tbody>
      </table>
    </div>
    <div>
      <div style="font-size:13px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:10px;margin-bottom:14px;">5. 장기 운영 인사이트</div>
      <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:14px;margin-bottom:10px;">
        <div style="font-weight:700;color:#c2410c;margin-bottom:4px;font-size:13px;">⚠️ 고질적인 식후 집중도 저하</div>
        <div style="font-size:12px;color:#6b7280;">조회 기간 내내 13:00 구간의 평균 집중도가 50%를 밑돕니다. 커리큘럼 조정(실습 위주)을 권장합니다.</div>
      </div>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px;">
        <div style="font-weight:700;color:#059669;margin-bottom:4px;font-size:13px;">✅ 안정적인 출석 유지율</div>
        <div style="font-size:12px;color:#6b7280;">과정 초반 대비 출석률 저하가 발생하지 않았습니다. 우수한 관리 상태입니다.</div>
      </div>
    </div>
    <div style="text-align:center;font-size:11px;color:#9ca3af;padding-top:20px;border-top:1px solid #e5e7eb;margin-top:24px;">
      본 리포트는 멋쟁이사자처럼 AI 수강생 태도 분석 시스템에 의해 자동으로 생성되었습니다. — 2 / 2 —
    </div>`;

  pdfPage = 1;
  updatePdfPage();
  modal.style.display = 'flex';
}

function updatePdfPage() {
  document.getElementById('pdf-page-1').style.display = pdfPage === 1 ? 'block' : 'none';
  document.getElementById('pdf-page-2').style.display = pdfPage === 2 ? 'block' : 'none';
  document.getElementById('pdf-page-indicator').textContent = `${pdfPage} / 2`;
  const prev = document.getElementById('btn-pdf-prev');
  const next = document.getElementById('btn-pdf-next');
  if (prev) prev.disabled = pdfPage === 1;
  if (next) next.disabled = pdfPage === 2;
}

async function savePdf() {
  const btn = document.getElementById('btn-pdf-save');
  if (btn) { btn.textContent = '저장 중...'; btn.disabled = true; }
  try {
    // 라이브러리 동적 로드
    if (!window.jspdf) {
      await new Promise((res,rej)=>{ const s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'; s.onload=res; s.onerror=rej; document.head.appendChild(s); });
    }
    if (!window.html2canvas) {
      await new Promise((res,rej)=>{ const s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'; s.onload=res; s.onerror=rej; document.head.appendChild(s); });
    }
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation:'portrait', unit:'mm', format:'a4' });

    // 페이지 1
    document.getElementById('pdf-page-1').style.display = 'block';
    document.getElementById('pdf-page-2').style.display = 'none';
    const c1 = await html2canvas(document.getElementById('pdf-page-1'), { scale:2, useCORS:true, backgroundColor:'#fff' });
    pdf.addImage(c1.toDataURL('image/jpeg',0.95), 'JPEG', 0, 0, 210, 297);

    // 페이지 2
    pdf.addPage();
    document.getElementById('pdf-page-1').style.display = 'none';
    document.getElementById('pdf-page-2').style.display = 'block';
    const c2 = await html2canvas(document.getElementById('pdf-page-2'), { scale:2, useCORS:true, backgroundColor:'#fff' });
    pdf.addImage(c2.toDataURL('image/jpeg',0.95), 'JPEG', 0, 0, 210, 297);

    pdf.save(`Sleep2Wake_${selectedCourse||'리포트'}.pdf`);
  } catch(e) {
    console.error('PDF 저장 실패:', e);
    if (typeof showToast === 'function') showToast('PDF 저장 실패. 다시 시도해주세요.');
  } finally {
    updatePdfPage();
    if (btn) { btn.textContent = '💾 PDF 저장'; btn.disabled = false; }
  }
}

window.addEventListener('beforeunload', () => {
  clearInterval(pollInterval);
  ws?.close();
});

// ── 슬라이더 동적 라벨 ───────────────────
function updateDrowsyLabel(val) {
  const el = document.getElementById('drowsy-val-label');
  if (!el) return;
  const labels = { '1': '여유 (Loose)', '2': '보통 (Standard)', '3': '엄격 (Strict)' };
  el.textContent = labels[val] || '보통 (Standard)';
}

function updateGazeLabel(val) {
  const el = document.getElementById('gaze-val-label');
  if (!el) return;
  el.textContent = `${val}초`;
}

// ── 다크 모드 토글 ───────────────────────
function toggleDarkMode(btn) {
  btn.classList.toggle('on');
  document.body.classList.toggle('dark-mode');
  localStorage.setItem('darkMode', document.body.classList.contains('dark-mode') ? '1' : '0');
}

// ── 프로필 이미지 업로드 ─────────────────
function onProfileImgChange(input) {
  if (!input.files || !input.files[0]) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = document.getElementById('profile-big-img');
    const headerImg = document.querySelector('.profile-avatar');
    if (img) img.src = e.target.result;
    if (headerImg) headerImg.src = e.target.result;
    localStorage.setItem('profileImg', e.target.result);
  };
  reader.readAsDataURL(input.files[0]);
}