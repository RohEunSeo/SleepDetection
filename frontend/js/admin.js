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

// ── 더미 데이터 플래그 ────────────────────
// 누적 추이 / 종합 리포트 / 위험군은 장기 데이터 필요
// 실제 베타 테스트로 데이터 쌓이면 false로 변경
const USE_DUMMY_TREND = true;

// ── 유틸 ─────────────────────────────────
function focusColor(pct) {
  if (pct >= 80) return '#10b981';
  if (pct >= 60) return '#FF7710';
  return '#ef4444';
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
// 시간별 집중도 누적 데이터 (실시간 차트용)
// key: "HH:00" → { totalFocus: number, count: number }
let realtimeFocusMap = {};

function _recordRealtimeFocus(studentData) {
  const now  = new Date();
  const hour = now.getHours();
  // 점심시간(12:00~12:59) 제외
  if (hour === 12) return;
  const key  = `${String(hour).padStart(2,'0')}:00`;
  if (!realtimeFocusMap[key]) realtimeFocusMap[key] = { totalFocus: 0, count: 0 };
  // focus_pct가 있으면 사용, 없으면 status 기반 추정
  const STATUS_FOCUS = { focused:100, distracted:70, warning:50, drowsy:20, absent:0 };
  const fp = studentData.focus_pct !== undefined
    ? studentData.focus_pct
    : (STATUS_FOCUS[(studentData.status||'focused').toLowerCase()] ?? 70);
  realtimeFocusMap[key].totalFocus += fp;
  realtimeFocusMap[key].count += 1;
}

// ── WS 연결 상태 ──────────────────────────
let _wsConnected = false;

function _updateWsIndicator(connected) {
  _wsConnected = connected;
  const el = document.getElementById('ws-status');
  if (!el) return;
  if (connected) {
    el.textContent = '🟢 실시간 연결됨';
    el.style.color = '#10b981';
  } else {
    el.textContent = '🔴 연결 끊김 — 재연결 중...';
    el.style.color = '#ef4444';
  }
}

function connectWS() {
  try {
    ws = new WebSocket(`${getWsBaseUrl()}/ws/admin`);
    ws.onopen = () => {
      console.log('[Admin WS] 연결됨');
      _updateWsIndicator(true);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'student_update') {
        if (msg.data?.status) msg.data.status = msg.data.status.toLowerCase();
        const sid  = msg.data.student_id;
        const prev = wsStudents[sid];
        // 집중도 지수이동평균 (EMA α=0.3) — 배터리 급변 방지
        if (prev && msg.data.focus_pct !== undefined) {
          msg.data.focus_pct = Math.round(prev.focus_pct * 0.7 + msg.data.focus_pct * 0.3);
        }
        wsStudents[sid] = msg.data;
        _recordRealtimeFocus(msg.data);
        // 대시보드 통계 즉시 갱신
        _updateDashboardStats();
        renderRealtimeMonitor();
        if (document.getElementById('view-dashboard-detail')?.classList.contains('active')) {
          drawFocusChart();
        }
      } else if (msg.type === 'student_left') {
        delete wsStudents[msg.student_id];
        _updateDashboardStats();
        renderRealtimeMonitor();
      }
    };
    ws.onclose = () => {
      _updateWsIndicator(false);
      setTimeout(connectWS, 3000);
    };
    ws.onerror = () => _updateWsIndicator(false);
  } catch(e) { console.warn('[Admin WS]', e); }
}

// 대시보드 실시간 통계 업데이트 (카드 그리드 + 상세뷰)
function _updateDashboardStats() {
  const arr    = Object.values(wsStudents);
  const total  = arr.length;
  const avg    = total ? Math.round(arr.reduce((a,s) => a + (s.focus_pct||0), 0) / total) : 0;
  const drowsy = arr.filter(s => s.status === 'drowsy').length;
  const absent = arr.filter(s => s.status === 'absent').length;
  // 과정 목록 카드 갱신
  renderCourseGrid();
  // 상세 뷰가 열려있으면 숫자 갱신
  if (document.getElementById('view-dashboard-detail')?.classList.contains('active')) {
    document.getElementById('d-students').textContent = `${total}명`;
    document.getElementById('d-focus').textContent    = `${avg}%`;
    if (document.getElementById('d-drowsy')) document.getElementById('d-drowsy').textContent = `${drowsy}건`;
    if (document.getElementById('d-absent')) document.getElementById('d-absent').textContent = total > 0 ? `${Math.round(absent/total*100)}%` : '0%';
  }
}

// ── 진행 중 세션 폴링 ─────────────────────
async function pollActiveSessions() {
  try {
    const now   = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const res  = await fetch(`${BACKEND_URL}/api/sessions?date=${today}`);
    const data = await res.json();
    activeSessions = Array.isArray(data) ? data : [];

    // 오늘 세션이 없으면 — 전체 세션에서 과정명 기준 최신 세션 유지 (과정 카드 유지용)
    if (!activeSessions.length) {
      try {
        const allRes  = await fetch(`${BACKEND_URL}/api/sessions`);
        const allData = await allRes.json();
        if (Array.isArray(allData) && allData.length) {
          const courseMap = {};
          allData.forEach(s => {
            const cname = s.course_name || s.room_code;
            if (!courseMap[cname] || (s.date||'') > (courseMap[cname].date||'')) {
              // 반드시 date 필드 유지 + is_active 강제 false (오늘 수업이 없으므로)
              courseMap[cname] = { ...s, is_active: false };
            }
          });
          activeSessions = Object.values(courseMap);
        }
      } catch(e2) { console.warn('[Admin] 전체 세션 조회 실패:', e2); }
    }

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
        <div style="font-size:14px;">오늘 진행된 수업이 없습니다</div>
        <div style="font-size:12px;margin-top:6px;color:#d1d5db;">강사가 수업을 시작하면 자동으로 표시됩니다</div>
      </div>`;
    return;
  }
  const nowD   = new Date();
  const todayS = `${nowD.getFullYear()}-${String(nowD.getMonth()+1).padStart(2,'0')}-${String(nowD.getDate()).padStart(2,'0')}`;

  // 과정명 기준 중복 제거 — 같은 과정명이면 최신 세션 하나만 표시
  const courseMap = {};
  activeSessions.forEach(s => {
    const key = s.course_name || s.room_code;
    if (!courseMap[key] || (s.date||'') >= (courseMap[key].date||'')) {
      courseMap[key] = s;
    }
  });
  const sessions = Object.values(courseMap);

  grid.innerHTML = sessions.map((s) => {
    const apiIsLive = s.is_active === true || s.is_active === 'true' || s.is_active === 'True';
    const sessDate  = s.date || '';
    const isFuture  = sessDate !== '' && sessDate > todayS;
    const isPast    = sessDate !== '' && sessDate < todayS;
    const isLive    = !isFuture && !isPast && apiIsLive;

    let badgeHtml;
    if (isLive) {
      badgeHtml = `<span class="live-badge"><span class="live-dot"></span>LIVE</span>`;
    } else if (isFuture) {
      badgeHtml = `<span style="padding:3px 8px;border-radius:5px;font-size:11px;font-weight:700;background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;">수업전</span>`;
    } else {
      badgeHtml = `<span class="ended-badge">수업종료</span>`;
    }

    let students, focus, drowsyCnt, absentRate;
    if (isLive) {
      // LIVE: wsStudents 실시간 값
      const wsArr  = Object.values(wsStudents);
      students   = wsArr.length > 0 ? wsArr.length : (s.student_count || 0);
      focus      = wsArr.length > 0
        ? Math.round(wsArr.reduce((a,w) => a + (w.focus_pct || 0), 0) / wsArr.length)
        : (s.avg_focus || 0);
      drowsyCnt  = wsArr.filter(w => (w.status||'').toLowerCase() === 'drowsy').length;
      const absentCnt = wsArr.filter(w => (w.status||'').toLowerCase() === 'absent').length;
      absentRate = students > 0 ? Math.round(absentCnt / students * 100) : 0;
    } else {
      // 수업종료 / 수업전: 실시간 수치 의미 없으므로 모두 0 초기화
      students   = 0;
      focus      = 0;
      drowsyCnt  = 0;
      absentRate = 0;
    }
    return `
    <div class="course-card" onclick="enterCourse('${s.room_code}', '${s.course_name || s.room_code}', ${isLive})">
      <div class="course-card-header">
        <div class="course-card-name">${s.course_name || s.room_code}</div>
        <div style="display:flex;align-items:center;gap:6px;">
          ${badgeHtml}
          <button onclick="event.stopPropagation();deleteSession('${s.session_id}')"
            style="width:24px;height:24px;border:none;background:#f3f4f6;border-radius:6px;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;color:#9ca3af;"
            title="삭제">🗑️</button>
        </div>
      </div>
      <div class="course-stats-4">
        <div class="cstat-box gray">
          <div class="cstat-label">참여 학생</div>
          <div class="cstat-val">${students}명</div>
        </div>
        <div class="cstat-box indigo">
          <div class="cstat-label indigo">실시간 집중도</div>
          <div class="cstat-val indigo">${focus}%</div>
        </div>
        <div class="cstat-box ${drowsyCnt > 0 ? 'orange' : 'gray'}">
          <div class="cstat-label ${drowsyCnt > 0 ? 'orange' : ''}">졸음 확정</div>
          <div class="cstat-val ${drowsyCnt > 0 ? 'orange' : ''}">${drowsyCnt}건</div>
        </div>
        <div class="cstat-box ${absentRate > 10 ? 'orange' : 'gray'}">
          <div class="cstat-label ${absentRate > 10 ? 'orange' : ''}">이탈률</div>
          <div class="cstat-val ${absentRate > 10 ? 'orange' : ''}">${absentRate}%</div>
        </div>
      </div>
      <button class="course-enter-btn">일간 대시보드 보기</button>
    </div>`;
  }).join('');
}

// ── 삭제 모달 ─────────────────────────────
let _deleteCallback = null;

function showDeleteModal(title, desc, onConfirm) {
  document.getElementById('delete-modal-title').textContent = title;
  document.getElementById('delete-modal-desc').innerHTML = desc;
  document.getElementById('delete-modal').style.display = 'flex';
  _deleteCallback = onConfirm;
  document.getElementById('delete-modal-confirm').onclick = () => {
    closeDeleteModal();
    if (_deleteCallback) _deleteCallback();
  };
}

function closeDeleteModal() {
  document.getElementById('delete-modal').style.display = 'none';
  _deleteCallback = null;
}

async function deleteSession(sessionId) {
  showDeleteModal(
    '수업 기록 삭제',
    '이 수업 기록을 삭제할까요?<br>삭제된 데이터는 복구할 수 없습니다.',
    async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/sessions/${sessionId}`, { method: 'DELETE' });
        if (res.ok) {
          if (typeof showToast === 'function') showToast('수업 기록이 삭제됐음');
          pollActiveSessions();
        }
      } catch(e) { console.warn('삭제 실패:', e); }
    }
  );
}

async function deleteAllSessions() {
  const now   = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  showDeleteModal(
    '오늘 수업 전체 삭제',
    `오늘(${today}) 수업 기록을 전부 삭제할까요?<br>삭제된 데이터는 복구할 수 없습니다.`,
    async () => {
      try {
        const ids = activeSessions.map(s => s.session_id);
        await Promise.all(ids.map(id =>
          fetch(`${BACKEND_URL}/api/sessions/${id}`, { method: 'DELETE' })
        ));
        if (typeof showToast === 'function') showToast('오늘 수업 기록이 모두 삭제됐음');
        pollActiveSessions();
      } catch(e) { console.warn('전체 삭제 실패:', e); }
    }
  );
}

function enterCourse(roomCode, courseName, isLive) {
  selectedSession = activeSessions.find(s => s.room_code === roomCode) || {};
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-dashboard-detail').classList.add('active');
  document.getElementById('detail-course-name').textContent = courseName;
  const nowDate  = new Date();
  const todayStr = `${nowDate.getFullYear()}-${String(nowDate.getMonth()+1).padStart(2,'0')}-${String(nowDate.getDate()).padStart(2,'0')}`;
  setDetailDate(todayStr);
  const dateInput = document.getElementById('detail-date-input');
  if (dateInput) { dateInput.value = todayStr; dateInput.max = todayStr; }
  document.getElementById('date-picker-label').textContent = '오늘';

  // 날짜 기준 실제 상태 결정 — isLive 파라미터보다 날짜 비교 우선
  const sessDate = selectedSession.date || '';
  const isFuture = sessDate !== '' && sessDate > todayStr;
  const isPast   = sessDate !== '' && sessDate < todayStr;
  const realIsLive = !isFuture && !isPast && isLive;

  updateStatusBadge(realIsLive);

  // 모니터링 카드 제목 동적 변경
  const titleEl    = document.getElementById('monitor-title-text');
  const subtitleEl = document.getElementById('monitor-card-subtitle');
  const liveDotEl  = document.getElementById('monitor-live-dot');

  if (realIsLive) {
    if (titleEl)    titleEl.textContent    = '실시간 학생 모니터링';
    if (subtitleEl) subtitleEl.textContent = '상태별 그룹 — 강사 실시간 모니터링 뷰';
    if (liveDotEl)  { liveDotEl.style.display = 'inline-block'; liveDotEl.style.background = '#ef4444'; liveDotEl.style.animation = ''; }
  } else if (isFuture) {
    if (titleEl)    titleEl.textContent    = '수업 예정';
    if (subtitleEl) subtitleEl.textContent = '아직 수업이 시작되지 않았습니다';
    if (liveDotEl)  liveDotEl.style.display = 'none';
  } else {
    // 과거 or 오늘 종료
    if (titleEl)    titleEl.textContent    = '당일 학생 수업 태도';
    if (subtitleEl) subtitleEl.textContent = '집중도 낮은 순 정렬 — 수업 결과 요약';
    if (liveDotEl)  { liveDotEl.style.display = 'inline-block'; liveDotEl.style.background = '#9ca3af'; liveDotEl.style.animation = 'none'; }
  }

  if (realIsLive) {
    const wsArr  = Object.values(wsStudents);
    const drowsy = wsArr.filter(w => (w.status||'').toLowerCase() === 'drowsy').length;
    const absent = wsArr.filter(w => (w.status||'').toLowerCase() === 'absent').length;
    const total  = wsArr.length || selectedSession.student_count || 0;
    document.getElementById('d-students').textContent = `${total}명`;
    document.getElementById('d-focus').textContent    = `${selectedSession.avg_focus || 0}%`;
    if (document.getElementById('d-drowsy')) document.getElementById('d-drowsy').textContent = `${drowsy}건`;
    if (document.getElementById('d-absent')) document.getElementById('d-absent').textContent = total > 0 ? `${Math.round(absent/total*100)}%` : '0%';
    renderRealtimeMonitor(true);
  } else if (isFuture) {
    document.getElementById('d-students').textContent = '-';
    document.getElementById('d-focus').textContent    = '-';
    if (document.getElementById('d-drowsy')) document.getElementById('d-drowsy').textContent = '-';
    if (document.getElementById('d-absent')) document.getElementById('d-absent').textContent = '-';
    const grid = document.getElementById('realtime-monitor-grid');
    if (grid) grid.innerHTML = `<div style="padding:30px;text-align:center;color:#9ca3af;font-size:13px;">📅 수업 예정일입니다</div>`;
  } else {
    // 수업 종료 — API에서 실제 집계값 표시 + 학생 목록 로드
    const sc = selectedSession.student_count || 0;
    const dc = selectedSession.drowsy_count  || 0;
    const ac = selectedSession.absent_count  || 0;
    const af = selectedSession.avg_focus     || 0;
    document.getElementById('d-students').textContent = `${sc}명`;
    document.getElementById('d-focus').textContent    = `${af}%`;
    if (document.getElementById('d-drowsy')) document.getElementById('d-drowsy').textContent = `${dc}건`;
    if (document.getElementById('d-absent')) document.getElementById('d-absent').textContent = sc > 0 ? `${Math.round(ac/sc*100)}%` : '0%';
    // 학생 카드 표시: wsStudents 있으면 바로 표시, 없으면 API 조회
    if (Object.keys(wsStudents).length > 0) {
      renderRealtimeMonitor(false);
    } else if (selectedSession.session_id) {
      renderRealtimeMonitor(false);
      renderEndedAttitude(selectedSession.session_id);
    } else {
      renderRealtimeMonitor(false);
    }
  }
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
  setDetailDate(dateStr);
  document.getElementById('date-picker-label').textContent = isToday ? '오늘' : dateStr;
  if (isToday) {
    updateStatusBadge(true);
    document.getElementById('d-students').textContent = `${selectedSession.student_count||0}명`;
    document.getElementById('d-focus').textContent    = `${selectedSession.avg_focus||0}%`;
    document.getElementById('d-alert').textContent    = `${selectedSession.alert_count||0}건`;
    renderStudentAttitude();
  } else {
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

// ── 수업 종료 후 학생별 태도 테이블 ──────────
async function renderEndedAttitude(sessionId) {
  const el = document.getElementById('student-attitude-list');
  if (!el) return;

  // API 조회
  let list = null;
  if (sessionId) {
    el.innerHTML = '<div class="empty-msg">학생 데이터 불러오는 중...</div>';
    try {
      const res = await fetch(`${BACKEND_URL}/api/sessions/${sessionId}/students`);
      const data = await res.json();
      if (Array.isArray(data) && data.length) list = data;
    } catch(e) { console.warn('renderEndedAttitude 조회 실패:', e); }
  }

  if (!list || !list.length) {
    const el2 = document.getElementById('student-attitude-list');
    if (el2) el2.innerHTML = '<div class="empty-msg">수업 데이터가 없습니다</div>';
    return;
  }
  window._endedStudentsList = list;

  // 집중도 낮은 순 정렬
  const sorted = [...list].sort((a, b) => {
    const fa = a.focus_pct !== undefined ? a.focus_pct : calcFocus(a);
    const fb = b.focus_pct !== undefined ? b.focus_pct : calcFocus(b);
    return fa - fb; // 낮은 순
  });

  el.innerHTML = sorted.slice(0, 5).map((s, i) => {
    const focus = s.focus_pct !== undefined ? s.focus_pct : calcFocus(s);
    const fc    = focus >= 70 ? '#10b981' : focus >= 50 ? '#FF7710' : '#ef4444';
    return `
    <div class="student-row">
      <div class="student-num">${String(i+1).padStart(2,'0')}</div>
      <div class="student-name-cell">${s.name || s.student_id}</div>
      <div class="attitude-bar-wrap">
        <div class="attitude-bar-bg">
          <div class="attitude-bar-fill" style="width:${focus}%;background:${fc}"></div>
        </div>
        <span style="font-size:12px;font-weight:700;color:${fc};min-width:36px;text-align:right;">${focus}%</span>
      </div>
      <div class="align-right">
        <button onclick="showStudentReport(${JSON.stringify(s).replace(/"/g,'&quot;')})"
          style="padding:5px 12px;background:#FF7710;border:none;border-radius:6px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;">
          개별 리포트
        </button>
      </div>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════════════
// ── 학생 개별 리포트 ──────────────────────────
// ══════════════════════════════════════════════

let _currentReportStudent = null;
let _srActiveTab = 'daily';
let _srSelectedDate = '';

function _getTodayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
}

function showStudentReport(student) {
  _currentReportStudent = student;
  _srSelectedDate = _getTodayStr();
  _srActiveTab = 'daily';

  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-student-report')?.classList.add('active');

  const nameEl = document.getElementById('sr-student-name');
  if (nameEl) nameEl.textContent = `${student.name || student.student_id} 학생 개별 리포트`;

  const badgeEl = document.getElementById('sr-student-badge');
  if (badgeEl) {
    const focus = student.focus_pct !== undefined ? student.focus_pct : (calcFocus(student)||0);
    badgeEl.style.display = 'inline-block';
    badgeEl.textContent = focus >= 70 ? '😊 집중 양호' : focus >= 50 ? '⚠️ 주의 필요' : '🚨 면담 권장';
    badgeEl.style.background = focus >= 70 ? '#d1fae5' : focus >= 50 ? '#fef9c3' : '#fee2e2';
    badgeEl.style.color      = focus >= 70 ? '#059669' : focus >= 50 ? '#92400e' : '#dc2626';
    badgeEl.style.border     = focus >= 70 ? '1px solid #6ee7b7' : focus >= 50 ? '1px solid #fde68a' : '1px solid #fca5a5';
  }

  const dateLabel = document.getElementById('sr-date-label');
  if (dateLabel) dateLabel.textContent = '오늘';
  const dateInput = document.getElementById('sr-date-input');
  if (dateInput) { dateInput.value = _srSelectedDate; dateInput.max = _srSelectedDate; }

  switchSrTab('daily');
}

// ── 탭 전환 ──────────────────────────────────
function switchSrTab(tab) {
  _srActiveTab = tab;
  document.getElementById('sr-tab-daily')?.classList.toggle('active', tab === 'daily');
  document.getElementById('sr-tab-trend')?.classList.toggle('active', tab === 'trend');

  // 날짜 선택은 당일 탭에서만 표시
  const dateWrap = document.getElementById('sr-date-wrap');
  if (dateWrap) dateWrap.style.display = tab === 'daily' ? '' : 'none';

  const dailyEl = document.getElementById('sr-body-daily');
  const trendEl = document.getElementById('sr-body-trend');
  if (dailyEl) dailyEl.style.display = tab === 'daily' ? 'flex' : 'none';
  if (trendEl) trendEl.style.display = tab === 'trend' ? 'flex' : 'none';

  if (tab === 'daily') {
    if (_currentReportStudent) renderStudentReportBody(_currentReportStudent);
  } else {
    if (_currentReportStudent) renderSrTrend(_currentReportStudent);
  }
}

function closeStudentReport() {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-all-students')?.classList.add('active');
}

// ── 당일 탭 렌더링 ───────────────────────────
function renderStudentReportBody(student) {
  const el = document.getElementById('sr-body-daily');
  if (!el) return;

  const focus      = student.focus_pct !== undefined ? student.focus_pct : (calcFocus(student) || 0);
  const drowsy     = student.drowsy_cnt     || 0;
  const absent     = student.absent_cnt     || 0;
  const warning    = student.warning_cnt    || 0;
  const yawn       = student.yawn_cnt       || 0;
  const head       = student.head_cnt       || 0;
  const distracted = student.distracted_cnt || 0;
  const noFace     = student.no_face_cnt    || 0;
  const attendance = student.attendance_ok  || 0;
  const absenceCnt = student.absence_total  || 0;
  const lateCnt    = student.late_total     || 0;

  const suspectEye      = warning;
  const suspectYawn     = yawn;
  const transitionRate  = suspectEye > 0 ? Math.round((drowsy / suspectEye) * 100) : 0;
  const transitionColor = transitionRate >= 50 ? '#dc2626' : transitionRate >= 30 ? '#d97706' : '#059669';
  const focusColorVal   = focus >= 70 ? '#059669' : focus >= 50 ? '#d97706' : '#dc2626';

  // ── 종합 의견 상세 생성 ──
  let opinionParts = [];
  // 집중도 평가
  if (focus >= 80)       opinionParts.push(`당일 집중도는 ${focus}%로 매우 우수합니다. 수업 전 구간에서 안정적인 집중 상태를 유지했습니다.`);
  else if (focus >= 70)  opinionParts.push(`당일 집중도는 ${focus}%로 양호한 수준입니다. 전반적으로 수업에 성실히 참여했습니다.`);
  else if (focus >= 50)  opinionParts.push(`당일 집중도는 ${focus}%로 평균 수준입니다. 일부 구간에서 집중력 저하가 감지되었습니다.`);
  else                   opinionParts.push(`당일 집중도는 ${focus}%로 낮은 수준입니다. 전반적인 수업 참여도 개선이 필요합니다.`);
  // 졸음 평가
  if (drowsy === 0)      opinionParts.push('졸음 확정 감지 없음 — 수업 중 각성 상태를 유지했습니다.');
  else if (drowsy <= 2)  opinionParts.push(`졸음 확정 ${drowsy}회 감지됨. 특정 시간대에 피로도가 높았던 것으로 보입니다.`);
  else                   opinionParts.push(`졸음 확정이 ${drowsy}회로 반복 감지되었습니다. 수면 패턴 점검 및 개별 면담을 권장합니다.`);
  // 전환율 평가
  if (transitionRate >= 50) opinionParts.push(`눈 감김 의심 → 졸음 확정 전환율이 ${transitionRate}%로 높아 만성적 졸음 패턴이 우려됩니다.`);
  else if (transitionRate >= 30) opinionParts.push(`졸음 전환율 ${transitionRate}% — 지속 관찰이 필요합니다.`);
  // 이탈 평가
  if (absent === 0)      opinionParts.push('자리 이탈 감지 없음 — 수업 전 구간 착석 유지했습니다.');
  else if (absent >= 2)  opinionParts.push(`자리 이탈이 ${absent}회 발생하여 수업 집중에 방해가 되었습니다.`);
  // 행동 지표 평가
  if (head >= 10)        opinionParts.push(`고개 떨굼이 ${head}회로 높게 감지되었습니다. 수업 중 자세 유지에 어려움이 있었던 것으로 판단됩니다.`);
  if (distracted >= 5)   opinionParts.push(`시선 이탈이 ${distracted}회 감지되어 외부 자극에 주의가 분산된 것으로 보입니다.`);
  if (noFace >= 3)       opinionParts.push('얼굴 미감지 횟수가 많아 수업 참여 여부 추가 확인이 필요합니다.');
  // 권장 사항
  const actions = [];
  if (focus < 60 || drowsy >= 3)    actions.push('개별 면담');
  if (absent >= 2)                  actions.push('출석 경고');
  if (transitionRate >= 50)         actions.push('수면 패턴 점검');
  if (actions.length) opinionParts.push(`📌 권장 조치: ${actions.join(' · ')}`);
  else opinionParts.push('📌 현재 수준을 유지하도록 격려해주세요.');

  const opinion = opinionParts.join(' ');

  // ── 졸음 발생 시간대 (더미 or 실제) ──
  const sessionStartedAt = selectedSession?.started_at || null;
  const drowsyTimeSlots = student.drowsy_timestamps
    ? student.drowsy_timestamps.map(ts => {
        if (!sessionStartedAt) return '-';
        const d = new Date(ts), h = d.getHours(), m = d.getMinutes();
        return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      })
    : Array.from({length: drowsy}, (_, i) => {
        const base = 9 + Math.floor(i * 1.5);
        return `${String(base).padStart(2,'0')}:${i%2===0?'15':'45'}`;
      });

  el.innerHTML = `
    <!-- ① 누적 출결 현황 -->
    <div class="card" style="padding:20px;">
      <div class="sr-section-title">📋 누적 출결 현황</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:12px;">
        <div class="sr-stat-card" style="border-top:3px solid #10b981;">
          <div class="sr-stat-icon" style="background:#dcfce7;"><svg viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" width="18" height="18"><polyline points="20 6 9 17 4 12"/></svg></div>
          <div class="sr-stat-val">${attendance}<span class="sr-stat-unit">회</span></div>
          <div class="sr-stat-label">총 출석</div>
        </div>
        <div class="sr-stat-card" style="border-top:3px solid #ef4444;">
          <div class="sr-stat-icon" style="background:#fee2e2;"><svg viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.5" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div>
          <div class="sr-stat-val">${absenceCnt}<span class="sr-stat-unit">회</span></div>
          <div class="sr-stat-label">총 결석</div>
        </div>
        <div class="sr-stat-card" style="border-top:3px solid #eab308;">
          <div class="sr-stat-icon" style="background:#fef9c3;"><svg viewBox="0 0 24 24" fill="none" stroke="#ca8a04" stroke-width="2.5" width="18" height="18"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
          <div class="sr-stat-val">${lateCnt}<span class="sr-stat-unit">회</span></div>
          <div class="sr-stat-label">총 지각</div>
        </div>
      </div>
    </div>

    <!-- ② 시간별 집중도 흐름 — 오전/오후 분리 -->
    <div class="card" style="padding:20px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;">
        <div>
          <div class="sr-section-title" style="margin-bottom:2px;">📈 시간별 집중도 흐름</div>
          <div style="font-size:11px;color:#9ca3af;">당일 실시간 웹캠 분석 데이터 기반 | 점심시간 제외</div>
        </div>
        <div style="display:flex;gap:10px;font-size:11px;">
          <span style="display:flex;align-items:center;gap:4px;color:#6b7280;font-weight:600;"><span style="width:8px;height:8px;border-radius:50%;background:#FF7710;display:inline-block;"></span>집중도</span>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
        <!-- 오전 -->
        <div style="border:1.5px solid #e0e7ff;border-radius:12px;padding:12px;background:#fafaff;">
          <div style="font-size:11px;font-weight:700;color:#2563eb;margin-bottom:8px;">☀️ 오전 (09:00~12:00)</div>
          <svg id="sr-focus-chart-am" viewBox="0 0 420 150" style="width:100%;overflow:visible;">
            <defs><linearGradient id="srFocusGradAM" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stop-color="#FF7710" stop-opacity="0.18"/>
              <stop offset="100%" stop-color="#FF7710" stop-opacity="0"/>
            </linearGradient></defs>
          </svg>
        </div>
        <!-- 오후 -->
        <div style="border:1.5px solid #ffedd5;border-radius:12px;padding:12px;background:#fffaf5;">
          <div style="font-size:11px;font-weight:700;color:#ea580c;margin-bottom:8px;">🌆 오후 (13:00~18:00)</div>
          <svg id="sr-focus-chart-pm" viewBox="0 0 420 150" style="width:100%;overflow:visible;">
            <defs><linearGradient id="srFocusGradPM" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stop-color="#FF7710" stop-opacity="0.18"/>
              <stop offset="100%" stop-color="#FF7710" stop-opacity="0"/>
            </linearGradient></defs>
          </svg>
        </div>
      </div>
    </div>

    <!-- ③ 행동 지표(표) + 전환율/졸음시간대+녹화본 통합 — 2컬럼 -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;">

      <!-- 왼쪽: 행동 누적 지표 표 형태 (글씨 크게, 간격 넓게) -->
      <div class="card" style="padding:22px;">
        <div class="sr-section-title" style="margin-bottom:16px;">🔍 행동 누적 지표</div>
        <table style="width:100%;border-collapse:collapse;font-size:13.5px;">
          <thead>
            <tr style="background:#f9fafb;">
              <th style="padding:11px 12px;text-align:left;font-weight:700;color:#6b7280;border-bottom:2px solid #e5e7eb;font-size:12px;">항목</th>
              <th style="padding:11px 12px;text-align:center;font-weight:700;color:#6b7280;border-bottom:2px solid #e5e7eb;font-size:12px;">횟수</th>
              <th style="padding:11px 12px;text-align:left;font-weight:700;color:#6b7280;border-bottom:2px solid #e5e7eb;font-size:12px;">설명</th>
            </tr>
          </thead>
          <tbody>
            ${[
              ['😴 졸음 확정',   '#ef4444', drowsy,     'PERCLOS 기준'],
              ['🚶 자리 이탈',   '#f97316', absent,     '화면 미감지'],
              ['😪 눈 감김 의심','#eab308', warning,    'EAR↓ 기준'],
              ['🥱 하품',        '#f59e0b', yawn,       'MAR↑ 기준'],
              ['🤔 고개 떨굼',   '#8b5cf6', head,       'Pitch/Yaw 이탈'],
              ['👀 시선 이탈',   '#6366f1', distracted, 'Gaze score 이탈'],
              ['🫥 얼굴 미감지', '#9ca3af', noFace,     '카메라 미인식'],
            ].map(([label, color, val, desc]) => `
            <tr style="border-bottom:1px solid #f3f4f6;">
              <td style="padding:12px 12px;font-weight:600;color:#374151;">${label}</td>
              <td style="padding:12px 12px;text-align:center;font-size:15px;font-weight:900;color:${color};">${val}회</td>
              <td style="padding:12px 12px;color:#9ca3af;font-size:12px;">${desc}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <!-- 오른쪽: 전환율(상단 고정) + 졸음시간대+녹화본 통합(이전/다음) -->
      <div style="display:flex;flex-direction:column;gap:12px;">

        <!-- 전환율 고정 카드 -->
        <div class="card" style="padding:18px;">
          <div class="sr-section-title" style="margin-bottom:12px;font-size:13px;">⚡ 눈 감김 의심 → 졸음 확정 전환율</div>
          <div style="display:flex;align-items:center;gap:14px;">
            <div style="flex:1;">
              <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
                <span style="font-size:11px;color:#6b7280;">눈 감김 의심 ${suspectEye}회 → 졸음 확정 ${drowsy}회</span>
                <span style="font-size:12px;font-weight:800;color:${transitionColor};">${transitionRate}%</span>
              </div>
              <div style="height:10px;background:#f3f4f6;border-radius:5px;overflow:hidden;">
                <div style="width:${Math.min(transitionRate,100)}%;height:100%;background:${transitionColor};border-radius:5px;transition:width 0.6s;"></div>
              </div>
              <div style="font-size:10px;color:#9ca3af;margin-top:6px;">
                ${transitionRate >= 50 ? '⚠️ 만성적 졸음 패턴 — 면담 권장' : transitionRate >= 30 ? '🔶 주의 수준' : '✅ 정상 범위'}
              </div>
            </div>
            <div style="text-align:center;flex-shrink:0;">
              <div style="font-size:32px;font-weight:900;color:${transitionColor};line-height:1;">${transitionRate}%</div>
              <div style="font-size:9px;color:#9ca3af;margin-top:2px;">전환율</div>
            </div>
          </div>
        </div>

        <!-- 졸음 발생 시간대 + 녹화본 통합 카드 (이전/다음 페이지) -->
        ${(() => {
          // 이벤트 목록 생성
          const reviewEvents = [
            ...drowsyTimeSlots.map((startT, i) => {
              const [h, m] = startT.split(':').map(Number);
              const recovMin = m + 15 + (i % 2 === 0 ? 8 : 3);
              const recovH   = h + Math.floor(recovMin / 60);
              const recovM   = recovMin % 60;
              const endT = `${String(Math.min(recovH,17)).padStart(2,'0')}:${String(recovM).padStart(2,'0')}`;
              const durMin = 15 + (i % 2 === 0 ? 8 : 3);
              return { type:'😴 졸음 확정', icon:'😴', color:'#ef4444', bg:'#fef2f2', border:'#fecaca', startT, endT, durMin, idx:i+1, kind:'drowsy' };
            }),
            ...Array.from({length:absent}, (_, i) => ({
              type:'🚶 자리 이탈', icon:'🚶', color:'#f97316', bg:'#fff7ed', border:'#fed7aa',
              startT: `1${3+i}:${20+i*5}`, endT: `1${3+i}:${35+i*5}`, durMin: 15, idx:i+1, kind:'absent',
            })),
          ];

          if (reviewEvents.length === 0) {
            return `
            <div class="card" style="padding:18px;flex:1;">
              <div class="sr-section-title" style="margin-bottom:12px;font-size:13px;">⏰ 졸음 발생 시간대 &amp; 🎬 녹화본 안내</div>
              <div style="display:flex;align-items:center;gap:10px;padding:14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;">
                <span style="font-size:22px;">🎉</span>
                <div>
                  <div style="font-size:13px;font-weight:700;color:#059669;">이탈 구간 없음!</div>
                  <div style="font-size:11px;color:#6b7280;margin-top:2px;">졸음 확정 및 자리 이탈이 감지되지 않았습니다.</div>
                </div>
              </div>
            </div>`;
          }

          const total = reviewEvents.length;
          const cardId = `review-card-${student.student_id || 's'}`;

          // 각 이벤트를 카드 슬라이드로
          const slides = reviewEvents.map((ev, idx) => `
          <div class="review-slide" data-idx="${idx}" style="${idx===0?'':'display:none;'}">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
              <span style="font-size:12px;font-weight:700;color:${ev.color};">${ev.type} #${ev.idx}</span>
              <span style="font-size:10px;background:#fff;border:1px solid ${ev.border};padding:2px 8px;border-radius:4px;color:${ev.color};font-weight:700;">${ev.durMin}분 구간</span>
            </div>
            <!-- 졸음 발생 시각 -->
            <div style="margin-bottom:10px;">
              <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;">⏰ 발생 시각</div>
              <div style="display:flex;align-items:center;gap:6px;">
                <div style="padding:5px 10px;background:#fff;border:1px solid ${ev.border};border-radius:6px;font-size:13px;font-weight:800;color:#374151;">${ev.startT}</div>
              </div>
            </div>
            <!-- 녹화본 다시 보기 구간 -->
            <div style="background:${ev.bg};border:1px solid ${ev.border};border-left:3px solid ${ev.color};border-radius:8px;padding:10px;">
              <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;">🎬 다시 보기 권장 구간</div>
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                <div style="display:flex;align-items:center;gap:3px;padding:4px 8px;background:#fff;border:1px solid ${ev.border};border-radius:5px;">
                  <span style="font-size:11px;">⏱</span>
                  <span style="font-size:12px;font-weight:800;color:#374151;">${ev.startT}</span>
                  <span style="font-size:10px;color:#9ca3af;">시작</span>
                </div>
                <span style="font-size:13px;color:#9ca3af;">→</span>
                <div style="display:flex;align-items:center;gap:3px;padding:4px 8px;background:#fff;border:1px solid #e5e7eb;border-radius:5px;">
                  <span style="font-size:11px;">✅</span>
                  <span style="font-size:12px;font-weight:800;color:#374151;">${ev.endT}</span>
                  <span style="font-size:10px;color:#9ca3af;">회복</span>
                </div>
              </div>
              <div style="font-size:10px;color:#FF7710;font-weight:700;">
                ▶ ${ev.startT}~${ev.endT} (~${ev.durMin}분) 다시 보기 권장
              </div>
            </div>
          </div>`).join('');

          return `
          <div class="card" style="padding:18px;" id="${cardId}">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
              <div class="sr-section-title" style="font-size:13px;">⏰ 졸음 시간대 &amp; 🎬 녹화본 안내</div>
              <span style="font-size:9px;background:#d1fae5;color:#059669;padding:2px 7px;border-radius:4px;font-weight:700;">✅ 구간 기반</span>
            </div>
            <!-- 슬라이드 본문 -->
            <div id="${cardId}-slides">${slides}</div>
            <!-- 페이지 컨트롤 -->
            <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;padding-top:10px;border-top:1px solid #f3f4f6;">
              <button onclick="_reviewPrev('${cardId}',${total})"
                style="display:flex;align-items:center;gap:4px;padding:6px 12px;background:#f3f4f6;border:none;border-radius:7px;font-size:12px;font-weight:700;color:#6b7280;cursor:pointer;transition:all 0.15s;"
                onmouseover="this.style.background='#e5e7eb'" onmouseout="this.style.background='#f3f4f6'">◀ 이전</button>
              <span id="${cardId}-indicator" style="font-size:11px;color:#9ca3af;font-weight:600;">1 / ${total}</span>
              <button onclick="_reviewNext('${cardId}',${total})"
                style="display:flex;align-items:center;gap:4px;padding:6px 12px;background:#FF7710;border:none;border-radius:7px;font-size:12px;font-weight:700;color:#fff;cursor:pointer;transition:all 0.15s;"
                onmouseover="this.style.background='#e8680e'" onmouseout="this.style.background='#FF7710'">다음 ▶</button>
            </div>
            ${total === 1 ? '' : `<div style="font-size:10px;color:#c4c9d4;margin-top:6px;text-align:center;">총 ${total}개 구간 | 이전/다음 버튼으로 확인</div>`}
          </div>`;
        })()}
      </div>
    </div>

    <!-- ④ 종합 의견 — 풀 라인 -->
    <div class="card" style="padding:22px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <div class="sr-section-title">💬 종합 의견</div>
        <span style="font-size:10px;font-weight:600;color:#9ca3af;background:#f3f4f6;padding:3px 8px;border-radius:4px;">AI 자동 생성</span>
      </div>
      <!-- 집중도 + 상태 요약 한 줄 -->
      <div style="display:flex;align-items:stretch;gap:12px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:12px;padding:16px 20px;background:#f8f9fa;border-radius:10px;flex-shrink:0;">
          <div style="text-align:center;">
            <div style="font-size:36px;font-weight:900;color:${focusColorVal};line-height:1;">${focus}%</div>
            <div style="font-size:10px;color:#9ca3af;margin-top:2px;">당일 집중도</div>
          </div>
          <div style="width:1px;height:40px;background:#e5e7eb;flex-shrink:0;"></div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-size:11px;color:#6b7280;">졸음 확정</span>
              <span style="font-size:13px;font-weight:800;color:${drowsy>0?'#ef4444':'#10b981'};">${drowsy}회</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-size:11px;color:#6b7280;">자리 이탈</span>
              <span style="font-size:13px;font-weight:800;color:${absent>0?'#f97316':'#10b981'};">${absent}회</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-size:11px;color:#6b7280;">전환율</span>
              <span style="font-size:13px;font-weight:800;color:${transitionColor};">${transitionRate}%</span>
            </div>
          </div>
        </div>
        <!-- 집중도 바 -->
        <div style="flex:1;display:flex;flex-direction:column;justify-content:center;gap:8px;">
          <div style="height:14px;background:#e5e7eb;border-radius:7px;overflow:hidden;">
            <div style="width:${focus}%;height:100%;background:${focusColorVal};border-radius:7px;transition:width 0.5s;"></div>
          </div>
          <div style="font-size:12px;color:#6b7280;font-weight:600;">${focus >= 70 ? '✅ 상위 집중도 유지' : focus >= 50 ? '⚠️ 평균 집중도 — 관찰 필요' : '🚨 집중도 미흡 — 면담 권장'}</div>
        </div>
      </div>
      <!-- 상세 피드백 -->
      <div style="font-size:13px;color:#4b5563;line-height:1.9;padding:16px 18px;background:#fffbf7;border:1px solid #fed7aa;border-radius:10px;">
        ${opinion}
      </div>
    </div>
  `;

  // 오전/오후 차트 렌더링
  setTimeout(() => renderSrFocusChartSplit(student), 50);
}

// ── 녹화본 다시 보기 구간 안내 ───────────────
function buildReviewSection(student) {
  const drowsy = student.drowsy_cnt || 0;
  const absent = student.absent_cnt || 0;
  const warning = student.warning_cnt || 0;

  if (drowsy === 0 && absent === 0 && warning < 3) {
    return `
    <div class="card" style="padding:20px;margin-bottom:8px;">
      <div class="sr-section-title" style="margin-bottom:12px;">🎬 수업 녹화본 다시 보기 안내</div>
      <div style="display:flex;align-items:center;gap:12px;padding:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;">
        <span style="font-size:28px;flex-shrink:0;">🎉</span>
        <div>
          <div style="font-size:13px;font-weight:700;color:#059669;margin-bottom:2px;">이탈 구간 없음 — 수업 전체 집중 유지!</div>
          <div style="font-size:12px;color:#6b7280;">졸음 확정 및 자리 이탈이 감지되지 않았습니다.</div>
        </div>
      </div>
    </div>`;
  }

  const sessionStartedAt = selectedSession?.started_at || null;

  function makeTimestamps(cnt, startOffset, spacing) {
    if (!sessionStartedAt) {
      return Array.from({ length: cnt }, (_, i) => `__dummy__${startOffset + i * spacing}`);
    }
    const startMs = new Date(sessionStartedAt).getTime();
    return Array.from({ length: cnt }, (_, i) =>
      new Date(startMs + (startOffset + i * spacing) * 60000).toISOString()
    );
  }

  const drowsyTimestamps = student.drowsy_timestamps || makeTimestamps(drowsy, 25, 20);
  const absentTimestamps = student.absent_timestamps  || makeTimestamps(absent, 40, 15);

  function toElapsed(ts) {
    if (ts.startsWith('__dummy__')) {
      const mins = parseInt(ts.replace('__dummy__', ''));
      const h = Math.floor(mins / 60), m = mins % 60;
      return h > 0 ? `${h}시간 ${String(m).padStart(2,'0')}분경` : `${m}분경`;
    }
    if (!sessionStartedAt) return '-';
    const sec = Math.floor((new Date(ts) - new Date(sessionStartedAt)) / 1000);
    if (sec < 0) return '-';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h > 0
      ? `${h}시간 ${String(m).padStart(2,'0')}분 ${String(s).padStart(2,'0')}초`
      : `${m}분 ${String(s).padStart(2,'0')}초`;
  }

  function getRewindMins(ts) {
    if (ts.startsWith('__dummy__')) return Math.max(0, parseInt(ts.replace('__dummy__','')) - 2);
    if (!sessionStartedAt) return null;
    return Math.max(0, Math.floor((new Date(ts) - new Date(sessionStartedAt)) / 60000) - 2);
  }

  const allEvents = [
    ...drowsyTimestamps.map(ts => ({ type: 'drowsy', ts })),
    ...absentTimestamps.map(ts => ({ type: 'absent', ts })),
  ].sort((a, b) => {
    if (a.ts.startsWith('__dummy__') || b.ts.startsWith('__dummy__')) return 0;
    return new Date(a.ts) - new Date(b.ts);
  });

  const isDummy = !sessionStartedAt && !student.drowsy_timestamps;

  const cards = allEvents.map((ev, i) => {
    const isDrowsy = ev.type === 'drowsy';
    const icon     = isDrowsy ? '😴' : '🚶';
    const label    = isDrowsy ? '졸음 확정 감지' : '자리 이탈 감지';
    const color    = isDrowsy ? '#ef4444' : '#f97316';
    const bg       = isDrowsy ? '#fef2f2' : '#fff7ed';
    const border   = isDrowsy ? '#fecaca' : '#fed7aa';
    const elapsed  = toElapsed(ev.ts);
    const rewind   = getRewindMins(ev.ts);
    const rewindStr = rewind !== null ? `${rewind}분 00초부터` : '-';
    return `
    <div style="display:flex;gap:12px;align-items:flex-start;padding:14px;background:${bg};border:1px solid ${border};border-radius:10px;margin-bottom:10px;">
      <div style="flex-shrink:0;width:36px;height:36px;background:#fff;border-radius:50%;border:2px solid ${border};display:flex;align-items:center;justify-content:center;font-size:18px;">${icon}</div>
      <div style="flex:1;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <span style="font-size:12px;font-weight:800;color:${color};">${label}</span>
          <span style="font-size:11px;color:#9ca3af;">수업 시작 후 <strong style="color:#374151;">${elapsed}</strong></span>
          ${isDummy ? '<span style="font-size:10px;color:#c4c9d4;background:#f9fafb;padding:1px 6px;border-radius:4px;">추정값</span>' : ''}
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="#FF7710" stroke-width="2" width="13" height="13"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <span style="font-size:12px;color:#374151;font-weight:600;">녹화본 <span style="color:#FF7710;font-weight:800;">${rewindStr}</span> 다시 보기 권장</span>
        </div>
      </div>
      <div style="flex-shrink:0;text-align:right;">
        <div style="font-size:10px;color:#9ca3af;margin-bottom:4px;">이탈 #${i+1}</div>
        ${selectedSession?.recording_url
          ? `<a href="${selectedSession.recording_url}#t=${(rewind||0)*60}" target="_blank"
               style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;background:#FF7710;border-radius:6px;color:#fff;font-size:11px;font-weight:700;text-decoration:none;">▶ 바로 이동</a>`
          : `<span style="font-size:10px;color:#c4c9d4;">녹화본 링크 없음</span>`}
      </div>
    </div>`;
  }).join('');

  return `
  <div class="card" style="padding:20px;margin-bottom:8px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
      <div class="sr-section-title">🎬 수업 녹화본 다시 보기 안내</div>
      ${isDummy
        ? `<span style="font-size:10px;color:#c4c9d4;background:#f9fafb;border:1px solid #e5e7eb;padding:3px 8px;border-radius:6px;">⚠️ 추정 시각 표시</span>`
        : `<span style="font-size:10px;font-weight:600;color:#059669;background:#d1fae5;padding:3px 8px;border-radius:6px;">✅ 실시간 타임스탬프 기반</span>`}
    </div>
    <div style="font-size:12px;color:#9ca3af;margin-bottom:14px;">졸음 확정 및 자리 이탈 감지 시점 기준, 약 2분 전부터 다시 보기를 권장합니다.</div>
    ${cards}
    <div style="margin-top:14px;padding:12px 14px;background:#f8f9fa;border-radius:8px;display:flex;align-items:flex-start;gap:8px;">
      <span style="font-size:14px;flex-shrink:0;">💡</span>
      <div style="font-size:12px;color:#6b7280;line-height:1.7;">
        이탈 구간의 수업 내용을 <strong>녹화본에서 해당 시점부터</strong> 다시 확인하면 놓친 내용을 보완할 수 있습니다.
        ${selectedSession?.recording_url ? '' : '<br>강사에게 녹화본 링크를 요청하거나 Daily.co 대시보드에서 확인하세요.'}
      </div>
    </div>
  </div>`;
}

// ── 녹화본 카드 이전/다음 페이지 ────────────
function _reviewPrev(cardId, total) {
  const slides = document.querySelectorAll(`#${cardId}-slides .review-slide`);
  const indicator = document.getElementById(`${cardId}-indicator`);
  let cur = 0;
  slides.forEach((s, i) => { if (s.style.display !== 'none') cur = i; });
  slides[cur].style.display = 'none';
  const prev = (cur - 1 + total) % total;
  slides[prev].style.display = 'block';
  if (indicator) indicator.textContent = `${prev + 1} / ${total}`;
}

function _reviewNext(cardId, total) {
  const slides = document.querySelectorAll(`#${cardId}-slides .review-slide`);
  const indicator = document.getElementById(`${cardId}-indicator`);
  let cur = 0;
  slides.forEach((s, i) => { if (s.style.display !== 'none') cur = i; });
  slides[cur].style.display = 'none';
  const next = (cur + 1) % total;
  slides[next].style.display = 'block';
  if (indicator) indicator.textContent = `${next + 1} / ${total}`;
}

// ── 학생 리포트 오전/오후 분리 집중도 차트 ──────
function renderSrFocusChartSplit(student) {
  const base = student.focus_pct !== undefined ? student.focus_pct : (calcFocus(student)||70);
  const history = student.focus_history || [
    { time:'09:00', focus: Math.min(100, base+15) },
    { time:'10:00', focus: Math.min(100, base+18) },
    { time:'11:00', focus: Math.min(100, base+5)  },
    { time:'13:00', focus: Math.max(0,   base-22) },
    { time:'14:00', focus: Math.min(100, base+8)  },
    { time:'15:00', focus: Math.min(100, base+12) },
    { time:'16:00', focus: Math.min(100, base+5)  },
    { time:'17:00', focus: Math.min(100, base)    },
  ];
  const amH = history.filter(d => parseInt(d.time) < 12);
  const pmH = history.filter(d => parseInt(d.time) >= 13);

  function drawSrChart(svgId, data, gradId, color) {
    const svg = document.getElementById(svgId);
    if (!svg || !data.length) return;
    const W=420, H=150, PX=36, PY=14;
    const n = data.length;
    const getX = i => PX + i * ((W-PX*2)/Math.max(n-1,1));
    const getY = v => H - PY - (v/100)*(H-PY*2);
    let h = '';
    [0,50,100].forEach(v => {
      const y = getY(v);
      h += `<line x1="${PX}" y1="${y}" x2="${W-PX}" y2="${y}" stroke="#f0f0f0" stroke-dasharray="3 3" stroke-width="1"/>`;
      h += `<text x="${PX-4}" y="${y+4}" fill="#d1d5db" font-size="9" text-anchor="end" font-family="Pretendard,sans-serif">${v}%</text>`;
    });
    data.forEach((d,i) => {
      h += `<text x="${getX(i)}" y="${H-1}" fill="#c4c9d4" font-size="9" text-anchor="middle" font-family="Pretendard,sans-serif">${d.time}</text>`;
    });
    const lp = data.map((d,i)=>`${i===0?'M':'L'} ${getX(i)} ${getY(d.focus)}`).join(' ');
    const ap = `${lp} L ${getX(n-1)} ${H-PY} L ${getX(0)} ${H-PY} Z`;
    h += `<path d="${ap}" fill="url(#${gradId})"/>`;
    h += `<path d="${lp}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    data.forEach((d,i) => {
      h += `<circle cx="${getX(i)}" cy="${getY(d.focus)}" r="4.5" fill="#fff" stroke="${color}" stroke-width="2"/>`;
    });
    svg.innerHTML = svg.innerHTML + h;
  }

  drawSrChart('sr-focus-chart-am', amH, 'srFocusGradAM', '#FF7710');
  drawSrChart('sr-focus-chart-pm', pmH, 'srFocusGradPM', '#FF7710');
}

// ── 3/30 더미 학생 데이터 (WebSocket 데이터 없을 때 fallback) ──
// ── 실시간 학생 모니터링 보드 ────────────────
const STATUS_GROUP_CFG = {
  focused:    { label: '🟢 집중 중',   border: '#10b981', bg: '#f0fdf4', badgeBg: '#d1fae5', badgeColor: '#059669', order: 0 },
  distracted: { label: '🟡 주의 산만', border: '#eab308', bg: '#fefce8', badgeBg: '#fef9c3', badgeColor: '#92400e', order: 1 },
  warning:    { label: '🟠 졸음 의심', border: '#f97316', bg: '#fff7ed', badgeBg: '#ffedd5', badgeColor: '#c2410c', order: 2 },
  drowsy:     { label: '🔴 졸음 확정', border: '#ef4444', bg: '#fef2f2', badgeBg: '#fee2e2', badgeColor: '#dc2626', order: 3 },
  absent:     { label: '⬜ 자리 이탈', border: '#9ca3af', bg: '#f9fafb', badgeBg: '#f3f4f6', badgeColor: '#6b7280', order: 4 },
};

let _monitorSearchQuery = '';
let _monitorIsLive = true;

// renderRealtimeMonitor(isLive) — isLive=true: 수업중, false: 종료
function renderRealtimeMonitor(isLive) {
  if (isLive !== undefined) _monitorIsLive = isLive;
  const grid = document.getElementById('realtime-monitor-grid');
  const lastUpdated = document.getElementById('monitor-last-updated');
  if (!grid) return;

  // 수업 중: wsStudents 실시간 / 수업 종료: _endedStudentsList(API 집계) 우선
  const wsArr = Object.values(wsStudents);
  const list  = (isLive || wsArr.length > 0)
    ? wsArr
    : (window._endedStudentsList || []);

  const now = new Date();
  if (lastUpdated) {
    if (wsArr.length > 0) {
      lastUpdated.textContent = `최종 업데이트: ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
      lastUpdated.style.color = '#9ca3af';
    } else {
      lastUpdated.textContent = '';
    }
  }

  if (!list.length) {
    grid.innerHTML = `<div style="padding:30px;text-align:center;color:#9ca3af;font-size:13px;">
      ${_monitorIsLive ? '👥 학생 접속을 기다리는 중...' : '📭 수업 데이터가 없습니다'}</div>`;
    return;
  }

  // 검색창 — 최초 1회만 DOM 생성 (한글 IME 버그 방지)
  if (!document.getElementById('monitor-search-input')) {
    const wrap = document.createElement('div');
    wrap.id = 'monitor-search-wrap';
    wrap.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;';
    wrap.innerHTML = `
      <div style="position:relative;flex:1;max-width:260px;">
        <svg style="position:absolute;left:10px;top:50%;transform:translateY(-50%);pointer-events:none;"
          viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" width="14" height="14">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input id="monitor-search-input" type="text" placeholder="학생 이름 검색..."
          style="width:100%;padding:7px 10px 7px 32px;border:1px solid #e5e7eb;border-radius:8px;font-size:12px;color:#374151;outline:none;font-family:inherit;box-sizing:border-box;"
          onfocus="this.style.borderColor='#FF7710'" onblur="this.style.borderColor='#e5e7eb'">
      </div>
      <span id="monitor-count-label" style="font-size:12px;color:#9ca3af;"></span>
      <span style="font-size:11px;color:#6b7280;margin-left:auto;">💡 카드 클릭 → 개별 리포트</span>`;
    const cardsDiv = document.createElement('div');
    cardsDiv.id = 'monitor-cards-area';
    grid.innerHTML = '';
    grid.appendChild(wrap);
    grid.appendChild(cardsDiv);
    // input: 카드 영역만 업데이트 — 검색창 DOM 건드리지 않음
    document.getElementById('monitor-search-input').addEventListener('input', function() {
      _monitorSearchQuery = this.value;
      _renderMonitorCards();
    });
  }

  _renderMonitorCards();
}

// 카드 영역만 갱신 — IME 안전
function _renderMonitorCards() {
  const cardsArea  = document.getElementById('monitor-cards-area');
  const countLabel = document.getElementById('monitor-count-label');
  if (!cardsArea) return;

  const wsArr = Object.values(wsStudents);
  const list  = wsArr; // 실데이터만
  const query  = (_monitorSearchQuery || '').trim().toLowerCase();

  const filtered = query
    ? list.filter(s => (s.name||s.student_id||'').toLowerCase().includes(query))
    : list;

  if (countLabel) countLabel.textContent = `${filtered.length}명 표시 중`;

  if (!filtered.length) {
    cardsArea.innerHTML = `<div style="padding:20px;text-align:center;color:#9ca3af;font-size:13px;">${query ? '검색 결과 없음' : '데이터 없음'}</div>`;
    return;
  }

  let sorted;
  if (_monitorIsLive) {
    // 수업 중: 위험 먼저 (drowsy→absent→warning→distracted→focused 순)
    const statusOrder = { drowsy:0, absent:1, warning:2, distracted:3, focused:4 };
    sorted = [...filtered].sort((a, b) => {
      const sa = statusOrder[(a.status||'focused').toLowerCase()] ?? 4;
      const sb = statusOrder[(b.status||'focused').toLowerCase()] ?? 4;
      if (sa !== sb) return sa - sb;
      return (a.name||a.student_id||'').localeCompare(b.name||b.student_id||'', 'ko');
    });
  } else {
    // 수업 종료: 집중도 낮은 순 → 동점이면 가나다순
    sorted = [...filtered].sort((a, b) => {
      const fa = a.focus_pct !== undefined ? a.focus_pct : calcFocus(a);
      const fb = b.focus_pct !== undefined ? b.focus_pct : calcFocus(b);
      if (fa !== fb) return fa - fb;
      return (a.name||a.student_id||'').localeCompare(b.name||b.student_id||'', 'ko');
    });
  }

  // 한 행 10명: 카드 너비를 calc로 고정 (gap 8px 기준)
  cardsArea.innerHTML = `<div style="display:grid;grid-template-columns:repeat(10,1fr);gap:8px;">${sorted.map(s => _makeMonitorCard(s, _monitorIsLive)).join('')}</div>`;
}

function _makeMonitorCard(s, isLive) {
  const status    = (s.status || 'focused').toLowerCase();
  const cfg       = STATUS_GROUP_CFG[status] || STATUS_GROUP_CFG.focused;
  const isAlert   = ['drowsy','absent'].includes(status);
  const focus     = s.focus_pct !== undefined ? s.focus_pct : calcFocus(s);
  const drowsyCnt = s.drowsy_cnt || 0;
  const battPct   = Math.max(0, Math.min(100, focus));
  const battColor = battPct >= 70 ? '#10b981' : battPct >= 40 ? '#f97316' : '#ef4444';
  const borderColor = isLive
    ? (isAlert ? cfg.border : '#e5e7eb')
    : battColor;
  const topRight = isLive
    ? `<span style="font-size:8px;font-weight:700;padding:1px 4px;border-radius:3px;background:${cfg.badgeBg};color:${cfg.badgeColor};white-space:nowrap;flex-shrink:0;">${STATUS_LABEL[status]||'집중'}</span>`
    : '';

  return `
  <div onclick="showStudentReport(${JSON.stringify(s).replace(/"/g,'&quot;')})"
    style="cursor:pointer;background:#fff;border:2px solid ${borderColor};border-radius:10px;padding:9px 10px;transition:all 0.18s;position:relative;min-width:0;"
    onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 6px 16px rgba(0,0,0,0.12)';"
    onmouseout="this.style.transform='';this.style.boxShadow=''">
    ${isAlert && isLive ? `<div style="position:absolute;top:-6px;right:-6px;font-size:11px;line-height:1;">🚨</div>` : ''}
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;gap:3px;">
      <div style="font-size:11px;font-weight:700;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.name||s.student_id}</div>
      ${topRight}
    </div>
    <div style="margin-bottom:6px;">
      <div style="display:flex;align-items:center;gap:2px;margin-bottom:2px;">
        <div style="flex:1;height:9px;background:#f3f4f6;border-radius:4px 0 0 4px;overflow:hidden;">
          <div style="width:${battPct}%;height:100%;background:${battColor};border-radius:4px 0 0 4px;transition:width 0.4s;"></div>
        </div>
        <div style="width:3px;height:6px;background:#d1d5db;border-radius:0 2px 2px 0;flex-shrink:0;"></div>
      </div>
      <div style="font-size:10px;font-weight:700;color:${battColor};">⚡ ${battPct}%</div>
    </div>
    <div style="text-align:center;padding:3px 0;background:#f9fafb;border-radius:5px;font-size:9px;font-weight:700;color:#6b7280;">
      📄 리포트 →
    </div>
  </div>`;
}
// ── 누적 추이 탭 렌더링 ───────────────────────
let _srTrendPeriod = '1w'; // 기간 상태: 1w/1m/3m/all

function renderSrTrend(student) {
  const el = document.getElementById('sr-body-trend');
  if (!el) return;

  if (!USE_DUMMY_TREND) {
    // TODO: 실제 API에서 학생별 누적 데이터 가져오기
    // GET /api/students/{student_id}/trend?period={_srTrendPeriod}
    el.innerHTML = `<div class="empty-msg">누적 데이터를 불러오는 중...</div>`;
    return;
  }

  // 기간별 데이터 세트 (더미)
  const PERIOD_DATA = {
    '1w': {
      label: '최근 1주일',
      dates: ['03/24','03/25','03/26','03/27','03/28','03/29','03/30'],
      focus:  [0, 5, 62, 3, 2, 2, student.focus_pct || 85],
      drowsy: [0, 0, 1,  0, 0, 0, student.drowsy_cnt || 0],
      absent: [0, 0, 0,  0, 0, 0, student.absent_cnt || 0],
      warn:   [3, 2, 5,  1, 4, 2, student.warning_cnt || 4],
      yawn:   [1, 0, 2,  0, 1, 0, student.yawn_cnt || 0],
      head:   [5, 3, 8,  2, 6, 4, student.head_cnt || 112],
    },
    '1m': {
      label: '최근 1개월',
      dates: ['3/2','3/5','3/9','3/12','3/16','3/19','3/23','3/26','3/30'],
      focus:  [72, 68, 75, 80, 65, 70, 78, 62, student.focus_pct || 85],
      drowsy: [1, 2, 0, 0, 3, 1, 0, 1, student.drowsy_cnt || 0],
      absent: [0, 1, 0, 0, 1, 0, 0, 0, student.absent_cnt || 0],
      warn:   [4, 5, 3, 2, 6, 4, 3, 5, student.warning_cnt || 4],
      yawn:   [2, 1, 0, 1, 3, 2, 1, 2, student.yawn_cnt || 0],
      head:   [8, 12, 6, 4, 15, 9, 5, 8, student.head_cnt || 112],
    },
    '3m': {
      label: '최근 3개월',
      dates: ['1월','2월초','2월중','2월말','3월초','3월중','3월말'],
      focus:  [60, 65, 58, 70, 72, 68, student.focus_pct || 85],
      drowsy: [3, 2, 4, 1, 2, 1, student.drowsy_cnt || 0],
      absent: [1, 1, 2, 0, 1, 0, student.absent_cnt || 0],
      warn:   [6, 5, 8, 4, 5, 4, student.warning_cnt || 4],
      yawn:   [3, 2, 4, 1, 2, 1, student.yawn_cnt || 0],
      head:   [15, 12, 18, 8, 12, 9, student.head_cnt || 112],
    },
    'all': {
      label: '전체 과정',
      dates: ['1월초','1월말','2월초','2월말','3월초','3월말'],
      focus:  [55, 62, 65, 70, 68, student.focus_pct || 85],
      drowsy: [4,  3,  2,  1,  2,  student.drowsy_cnt || 0],
      absent: [2,  1,  1,  0,  1,  student.absent_cnt || 0],
      warn:   [8,  6,  5,  4,  5,  student.warning_cnt || 4],
      yawn:   [4,  3,  2,  1,  2,  student.yawn_cnt || 0],
      head:   [20, 16, 12, 9,  12, student.head_cnt || 112],
    },
  };

  const pd = PERIOD_DATA[_srTrendPeriod];
  const n  = pd.dates.length;

  const avgFocus    = Math.round(pd.focus.reduce((a,b)=>a+b,0) / n);
  const totalDrowsy = pd.drowsy.reduce((a,b)=>a+b,0);
  const totalAbsent = pd.absent.reduce((a,b)=>a+b,0);
  const fColor      = avgFocus >= 70 ? '#059669' : avgFocus >= 50 ? '#d97706' : '#dc2626';

  // 추세 판정 (전반/후반 비교)
  const half = Math.floor(n / 2);
  const firstAvg = Math.round(pd.focus.slice(0, half).reduce((a,b)=>a+b,0) / half);
  const lastAvg  = Math.round(pd.focus.slice(-half).reduce((a,b)=>a+b,0) / half);
  const diff     = lastAvg - firstAvg;
  const trendLabel = diff >= 5 ? '📈 상승 추세' : diff <= -5 ? '📉 하락 추세' : '➡️ 유지 수준';
  const trendColor = diff >= 5 ? '#059669' : diff <= -5 ? '#dc2626' : '#6b7280';
  const trendMsg   = diff >= 5
    ? `집중도가 꾸준히 개선되고 있습니다. 수업 참여 태도가 긍정적으로 변화하고 있습니다.`
    : diff <= -5
    ? `집중도가 하락하고 있습니다. 피로 누적 또는 학습 의욕 저하가 우려됩니다. 개별 면담을 권장합니다.`
    : `집중도가 안정적으로 유지되고 있습니다.`;

  // 히트맵 셀 색상 계산
  function heatColor(val, max, baseColor) {
    if (val === 0) return '#f3f4f6';
    const intensity = Math.min(val / Math.max(max, 1), 1);
    // 색상: 연한(0.2) → 진한(1.0) 불투명도
    const alpha = 0.2 + intensity * 0.75;
    return baseColor + Math.round(alpha * 255).toString(16).padStart(2,'0');
  }
  const maxDrowsy = Math.max(...pd.drowsy, 1);
  const maxAbsent = Math.max(...pd.absent, 1);
  const maxWarn   = Math.max(...pd.warn, 1);
  const maxHead   = Math.max(...pd.head, 1);

  el.innerHTML = `
    <!-- 기간 선택 탭 -->
    <div style="display:flex;gap:6px;flex-wrap:wrap;">
      ${[['1w','최근 1주일'],['1m','최근 1개월'],['3m','최근 3개월'],['all','전체 과정']].map(([key,label])=>`
      <button onclick="window._srTrendPeriod='${key}';renderSrTrend(_currentReportStudent);"
        style="padding:7px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;transition:all 0.15s;
               ${_srTrendPeriod===key ? 'background:#FF7710;color:#fff;border:none;' : 'background:#fff;color:#6b7280;border:1px solid #e5e7eb;'}">
        ${label}
      </button>`).join('')}
    </div>

    <!-- 요약 카드 3개 -->
    <div class="card" style="padding:20px;">
      <div class="sr-section-title" style="margin-bottom:14px;">📆 ${pd.label} 누적 요약</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;">
        <div class="sr-stat-card" style="border-top:3px solid ${fColor};">
          <div class="sr-stat-icon" style="background:${avgFocus>=70?'#dcfce7':avgFocus>=50?'#fef9c3':'#fee2e2'};">
            <svg viewBox="0 0 24 24" fill="none" stroke="${fColor}" stroke-width="2.5" width="18" height="18"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
          </div>
          <div class="sr-stat-val" style="color:${fColor};">${avgFocus}<span class="sr-stat-unit">%</span></div>
          <div class="sr-stat-label">평균 집중도</div>
        </div>
        <div class="sr-stat-card" style="border-top:3px solid #ef4444;">
          <div class="sr-stat-icon" style="background:#fee2e2;"><span style="font-size:18px;line-height:1;">😴</span></div>
          <div class="sr-stat-val" style="color:#ef4444;">${totalDrowsy}<span class="sr-stat-unit">회</span></div>
          <div class="sr-stat-label">졸음 확정 합계</div>
        </div>
        <div class="sr-stat-card" style="border-top:3px solid #f97316;">
          <div class="sr-stat-icon" style="background:#ffedd5;"><span style="font-size:18px;line-height:1;">🚶</span></div>
          <div class="sr-stat-val" style="color:#f97316;">${totalAbsent}<span class="sr-stat-unit">회</span></div>
          <div class="sr-stat-label">자리 이탈 합계</div>
        </div>
      </div>
    </div>

    <!-- 집중도 꺾은선 (단일, 깔끔) -->
    <div class="card" style="padding:20px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;">
        <div>
          <div class="sr-section-title" style="margin-bottom:2px;">📈 집중도 추이</div>
          <div style="font-size:11px;color:#9ca3af;">${pd.label} 수업 기준</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <span class="trend-badge ${diff>=5?'up':diff<=-5?'down':'flat'}" style="font-size:11px;">
            ${trendLabel} <span style="font-weight:400;">(${diff>=0?'+':''}${diff}%p)</span>
          </span>
        </div>
      </div>
      <svg id="sr-trend-focus-chart" viewBox="0 0 860 160" style="width:100%;overflow:visible;">
        <defs><linearGradient id="srTrendGrad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="#FF7710" stop-opacity="0.15"/>
          <stop offset="100%" stop-color="#FF7710" stop-opacity="0"/>
        </linearGradient></defs>
      </svg>
      <!-- 전반/후반 평균 비교 -->
      <div style="display:flex;gap:10px;margin-top:12px;">
        <div style="flex:1;padding:10px 14px;background:#f9fafb;border-radius:8px;display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:11px;color:#6b7280;">초반 평균</span>
          <span style="font-size:14px;font-weight:800;color:#374151;">${firstAvg}%</span>
        </div>
        <div style="flex:1;padding:10px 14px;background:#f9fafb;border-radius:8px;display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:11px;color:#6b7280;">최근 평균</span>
          <span style="font-size:14px;font-weight:800;color:#374151;">${lastAvg}%</span>
        </div>
        <div style="flex:2;padding:10px 14px;background:${diff>=5?'#f0fdf4':diff<=-5?'#fef2f2':'#f3f4f6'};border-radius:8px;display:flex;align-items:center;gap:8px;">
          <span style="font-size:13px;font-weight:700;color:${trendColor};">${trendLabel}</span>
          <span style="font-size:11px;color:#6b7280;">${trendMsg}</span>
        </div>
      </div>
    </div>

    <!-- 행동 지표 히트맵 -->
    <div class="card" style="padding:20px;">
      <div class="sr-section-title" style="margin-bottom:6px;">🗓 행동 지표 히트맵</div>
      <div style="font-size:11px;color:#9ca3af;margin-bottom:14px;">색상이 진할수록 해당 날짜의 발생 횟수가 많음 — 어떤 날이 문제였는지 한눈에 파악</div>

      <!-- 히트맵 테이블 -->
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:separate;border-spacing:4px;font-size:11px;">
          <thead>
            <tr>
              <th style="text-align:left;padding:6px 8px;color:#9ca3af;font-weight:600;min-width:80px;">지표</th>
              ${pd.dates.map(d => `<th style="text-align:center;padding:6px 4px;color:#9ca3af;font-weight:600;min-width:48px;font-size:10px;">${d}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${[
              { label:'😴 졸음 확정', data:pd.drowsy, max:maxDrowsy, hex:'#ef4444' },
              { label:'🚶 자리 이탈', data:pd.absent, max:maxAbsent, hex:'#f97316' },
              { label:'😪 눈 감김', data:pd.warn,   max:maxWarn,   hex:'#eab308' },
              { label:'🤔 고개 떨굼', data:pd.head,   max:maxHead,   hex:'#8b5cf6' },
            ].map(row => `
            <tr>
              <td style="padding:6px 8px;font-weight:600;color:#374151;white-space:nowrap;">${row.label}</td>
              ${row.data.map((val,i) => {
                const bg = val === 0 ? '#f3f4f6' : row.hex + Math.round((0.2 + Math.min(val/row.max,1)*0.75)*255).toString(16).padStart(2,'0');
                const textColor = val === 0 ? '#d1d5db' : (Math.min(val/row.max,1) > 0.6 ? '#fff' : '#374151');
                return `<td style="text-align:center;padding:6px 4px;">
                  <div style="width:44px;height:32px;background:${bg};border-radius:6px;display:flex;align-items:center;justify-content:center;margin:0 auto;font-size:11px;font-weight:700;color:${textColor};">
                    ${val > 0 ? val : ''}
                  </div>
                </td>`;
              }).join('')}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <!-- 히트맵 범례 -->
      <div style="display:flex;align-items:center;gap:6px;margin-top:12px;justify-content:flex-end;">
        <span style="font-size:10px;color:#9ca3af;">낮음</span>
        ${['#f3f4f6','#fca5a533','#fca5a566','#fca5a5aa','#ef4444'].map(c=>`
          <div style="width:20px;height:12px;background:${c};border-radius:3px;"></div>`).join('')}
        <span style="font-size:10px;color:#9ca3af;">높음</span>
      </div>
    </div>
  `;

  // 꺾은선 차트 그리기
  setTimeout(() => {
    const svg = document.getElementById('sr-trend-focus-chart');
    if (!svg) return;
    const W=860, H=160, PX=44, PY=18;
    const getX = i => PX + i * ((W-PX*2) / Math.max(n-1,1));
    const getY = v => H - PY - (v/100)*(H-PY*2);
    let h = '';
    [0,25,50,75,100].forEach(v => {
      const y = getY(v);
      h += `<line x1="${PX}" y1="${y}" x2="${W-PX}" y2="${y}" stroke="#f0f0f0" stroke-dasharray="3 3" stroke-width="1"/>`;
      h += `<text x="${PX-6}" y="${y+4}" fill="#d1d5db" font-size="10" text-anchor="end" font-family="Pretendard,sans-serif">${v}%</text>`;
    });
    pd.dates.forEach((d,i) => {
      h += `<text x="${getX(i)}" y="${H-2}" fill="#b0b7c3" font-size="10" text-anchor="middle" font-family="Pretendard,sans-serif">${d}</text>`;
    });
    // 평균선
    const avgY = getY(avgFocus);
    h += `<line x1="${PX}" y1="${avgY}" x2="${W-PX}" y2="${avgY}" stroke="#e5e7eb" stroke-dasharray="6 3" stroke-width="1.5"/>`;
    h += `<text x="${W-PX+4}" y="${avgY+4}" fill="#9ca3af" font-size="9" font-family="Pretendard,sans-serif">평균</text>`;
    // 집중도 꺾은선
    const lp = pd.focus.map((v,i)=>`${i===0?'M':'L'} ${getX(i)} ${getY(v)}`).join(' ');
    const ap = `${lp} L ${getX(n-1)} ${H-PY} L ${getX(0)} ${H-PY} Z`;
    h += `<path d="${ap}" fill="url(#srTrendGrad)"/>`;
    h += `<path d="${lp}" fill="none" stroke="#FF7710" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    pd.focus.forEach((v,i) => {
      const isLast = i === n-1;
      h += `<circle cx="${getX(i)}" cy="${getY(v)}" r="${isLast?6:4.5}" fill="${isLast?'#FF7710':'#fff'}" stroke="#FF7710" stroke-width="2"/>`;
      h += `<text x="${getX(i)}" y="${getY(v)-10}" fill="#FF7710" font-size="9" text-anchor="middle" font-family="Pretendard,sans-serif" font-weight="700">${v}%</text>`;
    });
    svg.innerHTML = svg.innerHTML + h;
  }, 50);
}

// ── PDF 버튼 — 탭에 따라 분기 ────────────────
function exportStudentPdf() {
  if (_srActiveTab === 'trend') {
    openStudentPdfTrend();
  } else {
    openStudentPdfDaily();
  }
}

// ── 당일 탭 PDF 미리보기 ──────────────────────
function openStudentPdfDaily() {
  const student = _currentReportStudent;
  if (!student) return;
  const modal   = document.getElementById('sr-pdf-modal');
  const content = document.getElementById('sr-pdf-content');
  const titleEl = document.getElementById('sr-pdf-title');
  if (!modal || !content) return;

  const name   = student.name || student.student_id;
  const now    = new Date();
  const dateStr = `${now.getFullYear()}년 ${now.getMonth()+1}월 ${now.getDate()}일`;

  const focus      = student.focus_pct !== undefined ? student.focus_pct : (calcFocus(student)||0);
  const drowsy     = student.drowsy_cnt     || 0;
  const absent     = student.absent_cnt     || 0;
  const warning    = student.warning_cnt    || 0;
  const yawn       = student.yawn_cnt       || 0;
  const head       = student.head_cnt       || 0;
  const distracted = student.distracted_cnt || 0;
  const noFace     = student.no_face_cnt    || 0;
  const attendance = student.attendance_ok  || 0;
  const absenceCnt = student.absence_total  || 0;
  const lateCnt    = student.late_total     || 0;
  const transitionRate = warning > 0 ? Math.round((drowsy/warning)*100) : 0;
  const fColor = focus >= 70 ? '#059669' : focus >= 50 ? '#d97706' : '#dc2626';

  let opinion = '';
  if (focus >= 70 && drowsy < 2 && absent < 2) opinion = '전반적으로 집중도가 우수하고 수업 참여도가 높습니다.';
  else if (focus >= 50) opinion = '집중도가 보통 수준입니다. 주의 깊게 관찰이 필요합니다.';
  else opinion = '집중도가 낮습니다. 개별 면담을 권장합니다.';
  if (drowsy >= 3) opinion += ' 졸음이 반복적으로 확정 감지되었습니다.';
  if (transitionRate >= 50) opinion += ` 졸음 의심→확정 전환율 ${transitionRate}%로 만성적 졸음 패턴 우려.`;
  if (absent >= 2) opinion += ' 자리 이탈이 여러 차례 발생했습니다.';

  // 다시 보기 구간 (PDF용)
  const reviewRows = (() => {
    const events = [];
    for (let i=0; i<drowsy; i++) events.push({ type:'졸음 확정', icon:'😴', color:'#ef4444', mins: 25+i*20 });
    for (let i=0; i<absent; i++) events.push({ type:'자리 이탈', icon:'🚶', color:'#f97316', mins: 40+i*15 });
    events.sort((a,b)=>a.mins-b.mins);
    if (!events.length) return '<div style="padding:10px;color:#059669;font-weight:600;font-size:12px;">🎉 이탈 구간 없음 — 전체 수업 집중 유지</div>';
    return `<table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr style="background:#f3f4f6;">
        <th style="padding:8px 12px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">감지 유형</th>
        <th style="padding:8px 12px;text-align:center;font-weight:700;border-bottom:2px solid #e5e7eb;">발생 시점</th>
        <th style="padding:8px 12px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">다시 보기 권장 구간</th>
      </tr></thead>
      <tbody>
        ${events.map(ev=>`<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:${ev.color};font-weight:600;">${ev.icon} ${ev.type}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:center;font-weight:700;color:#374151;">수업 후 ${ev.mins}분경</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:#FF7710;font-weight:700;">▶ ${Math.max(0,ev.mins-2)}분부터</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div style="margin-top:8px;font-size:10px;color:#9ca3af;">※ 발생 시점은 세션 시작 기준 추정값입니다.</div>`;
  })();

  if (titleEl) titleEl.textContent = `${name} — 당일 리포트`;
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #FF7710;padding-bottom:16px;margin-bottom:24px;">
      <div>
        <div style="font-size:18px;font-weight:900;color:#111827;">${name} 학생 개별 리포트</div>
        <div style="font-size:12px;color:#9ca3af;margin-top:4px;">생성일: ${dateStr} | 멋쟁이사자처럼 AI 수강생 태도 분석 시스템</div>
      </div>
      <div style="font-size:14px;font-weight:800;color:#FF7710;">🦁 LIKELION</div>
    </div>

    <div style="margin-bottom:22px;">
      <div style="font-size:13px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:10px;margin-bottom:12px;">1. 누적 출결 현황</div>
      <div style="display:flex;gap:10px;">
        ${[['✅ 총 출석','#059669',attendance+'회'],['❌ 총 결석','#dc2626',absenceCnt+'회'],['⏰ 총 지각','#ca8a04',lateCnt+'회']].map(([l,c,v])=>
          `<div style="flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px;text-align:center;">
            <div style="font-size:10px;color:#6b7280;margin-bottom:4px;">${l}</div>
            <div style="font-size:22px;font-weight:800;color:${c};">${v}</div>
          </div>`).join('')}
      </div>
    </div>

    <div style="margin-bottom:22px;">
      <div style="font-size:13px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:10px;margin-bottom:12px;">2. 당일 집중도</div>
      <div style="display:flex;align-items:center;gap:14px;padding:12px;background:#f9fafb;border-radius:8px;">
        <div style="font-size:32px;font-weight:900;color:${fColor};min-width:64px;text-align:center;">${focus}%</div>
        <div style="flex:1;">
          <div style="height:12px;background:#e5e7eb;border-radius:6px;overflow:hidden;">
            <div style="width:${focus}%;height:100%;background:${fColor};border-radius:6px;"></div>
          </div>
          <div style="font-size:11px;color:#9ca3af;margin-top:4px;">${focus>=70?'집중도 우수':'집중도 '+(focus>=50?'보통':'미흡')}</div>
        </div>
      </div>
    </div>

    <div style="margin-bottom:22px;">
      <div style="font-size:13px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:10px;margin-bottom:12px;">3. 행동 누적 지표</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:#f3f4f6;">
          <th style="padding:8px 12px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">항목</th>
          <th style="padding:8px 12px;text-align:center;font-weight:700;border-bottom:2px solid #e5e7eb;">횟수</th>
          <th style="padding:8px 12px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">설명</th>
        </tr></thead>
        <tbody>
          ${[['😴 졸음 확정','#ef4444',drowsy,'PERCLOS 기준'],['🚶 자리 이탈','#f97316',absent,'화면 미감지'],
             ['😪 눈 감김 의심','#eab308',warning,'EAR↓ 기준'],['🥱 하품','#f59e0b',yawn,'MAR↑ 기준'],
             ['🤔 고개 떨굼','#8b5cf6',head,'Pitch/Yaw 이탈'],['👀 시선 이탈','#6366f1',distracted,'Gaze score 이탈'],
             ['🫥 얼굴 미감지','#9ca3af',noFace,'카메라 미인식']
          ].map(([l,c,v,d])=>`<tr>
            <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${l}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:center;font-weight:800;color:${c};">${v}회</td>
            <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:#6b7280;">${d}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div style="margin-bottom:22px;">
      <div style="font-size:13px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:10px;margin-bottom:12px;">4. 졸음 의심 → 확정 전환율</div>
      <div style="padding:12px;background:#f9fafb;border-radius:8px;display:flex;align-items:center;gap:16px;">
        <div style="font-size:28px;font-weight:900;color:${fColor};min-width:60px;text-align:center;">${transitionRate}%</div>
        <div style="flex:1;">
          <div style="height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden;margin-bottom:6px;">
            <div style="width:${Math.min(transitionRate,100)}%;height:100%;background:${fColor};border-radius:5px;"></div>
          </div>
          <div style="font-size:11px;color:#6b7280;">눈 감김 의심 ${warning}회 → 졸음 확정 ${drowsy}회 | ${transitionRate>=50?'⚠️ 만성적 졸음 패턴':transitionRate>=30?'🔶 주의 필요':'✅ 정상 범위'}</div>
        </div>
      </div>
    </div>

    <div style="margin-bottom:22px;">
      <div style="font-size:13px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:10px;margin-bottom:12px;">5. 종합 의견 (AI 자동 생성)</div>
      <div style="padding:14px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;font-size:12px;color:#4b5563;line-height:1.8;">${opinion}</div>
    </div>

    <div style="margin-bottom:22px;">
      <div style="font-size:13px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:10px;margin-bottom:12px;">6. 수업 녹화본 다시 보기 권장 구간</div>
      ${reviewRows}
    </div>

    <div style="text-align:center;font-size:10px;color:#9ca3af;margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb;">
      본 리포트는 멋쟁이사자처럼 Sleep2Wake AI 수강생 태도 분석 시스템에 의해 자동으로 생성되었습니다.
    </div>
  `;
  modal.style.display = 'flex';
}

// ── 누적 추이 탭 PDF 미리보기 ─────────────────
function openStudentPdfTrend() {
  const student = _currentReportStudent;
  if (!student) return;
  const modal   = document.getElementById('sr-pdf-modal');
  const content = document.getElementById('sr-pdf-content');
  const titleEl = document.getElementById('sr-pdf-title');
  if (!modal || !content) return;

  const name    = student.name || student.student_id;
  const now     = new Date();
  const dateStr = `${now.getFullYear()}년 ${now.getMonth()+1}월 ${now.getDate()}일`;

  const trendDates  = ['03/24','03/25','03/26','03/27','03/28','03/29','03/30'];
  const base        = student.focus_pct !== undefined ? student.focus_pct : (calcFocus(student)||60);
  const focusTrend  = trendDates.map((_,i) => Math.min(100,Math.max(0, base + [-8,+5,-12,+3,+10,-5,0][i])));
  const drowsyTrend = trendDates.map((_,i) => (student.drowsy_cnt||0) > 0 ? [2,1,3,0,2,1,student.drowsy_cnt||0][i] : [0,0,1,0,0,0,0][i]);
  const absentTrend = trendDates.map((_,i) => (student.absent_cnt||0) > 0 ? [1,0,2,0,1,0,student.absent_cnt||0][i] : [0,0,0,0,0,0,0][i]);
  const warnTrend   = trendDates.map((_,i) => [3,2,5,1,4,2,student.warning_cnt||0][i]);

  const avgFocus    = Math.round(focusTrend.reduce((a,b)=>a+b,0)/focusTrend.length);
  const totalDrowsy = drowsyTrend.reduce((a,b)=>a+b,0);
  const totalAbsent = absentTrend.reduce((a,b)=>a+b,0);
  const fColor      = avgFocus >= 70 ? '#059669' : avgFocus >= 50 ? '#d97706' : '#dc2626';
  const first3avg   = Math.round(focusTrend.slice(0,3).reduce((a,b)=>a+b,0)/3);
  const last3avg    = Math.round(focusTrend.slice(-3).reduce((a,b)=>a+b,0)/3);
  const diff        = last3avg - first3avg;
  const trendLabel  = diff >= 5 ? '📈 상승 추세' : diff <= -5 ? '📉 하락 추세' : '➡️ 유지 수준';
  const trendColor  = diff >= 5 ? '#059669' : diff <= -5 ? '#dc2626' : '#6b7280';

  const makePdfBars = (data, color) => trendDates.map((d,i) => {
    const max = Math.max(...data,1);
    const pct = Math.round((data[i]/max)*100);
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <span style="font-size:10px;color:#9ca3af;min-width:36px;">${d}</span>
      <div style="flex:1;height:8px;background:#f3f4f6;border-radius:4px;overflow:hidden;">
        <div style="width:${pct}%;height:100%;background:${color};border-radius:4px;"></div>
      </div>
      <span style="font-size:11px;font-weight:700;color:${color};min-width:18px;text-align:right;">${data[i]}</span>
    </div>`;
  }).join('');

  if (titleEl) titleEl.textContent = `${name} — 누적 추이 리포트`;
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #FF7710;padding-bottom:16px;margin-bottom:24px;">
      <div>
        <div style="font-size:18px;font-weight:900;color:#111827;">${name} 학생 누적 추이 리포트</div>
        <div style="font-size:12px;color:#9ca3af;margin-top:4px;">생성일: ${dateStr} | 최근 7회 수업 기준 | 멋쟁이사자처럼 AI 수강생 태도 분석 시스템</div>
      </div>
      <div style="font-size:14px;font-weight:800;color:#FF7710;">🦁 LIKELION</div>
    </div>

    <div style="margin-bottom:22px;">
      <div style="font-size:13px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:10px;margin-bottom:12px;">1. 최근 7회 수업 누적 요약</div>
      <div style="display:flex;gap:10px;">
        ${[['📊 평균 집중도', fColor, avgFocus+'%'],['😴 졸음 확정','#ef4444',totalDrowsy+'회'],['🚶 자리 이탈','#f97316',totalAbsent+'회']].map(([l,c,v])=>
          `<div style="flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px;text-align:center;">
            <div style="font-size:10px;color:#6b7280;margin-bottom:4px;">${l}</div>
            <div style="font-size:22px;font-weight:800;color:${c};">${v}</div>
          </div>`).join('')}
      </div>
    </div>

    <div style="margin-bottom:22px;">
      <div style="font-size:13px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:10px;margin-bottom:12px;">2. 집중도 추세 분석</div>
      <div style="display:flex;gap:10px;">
        <div style="flex:1;padding:14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;text-align:center;">
          <div style="font-size:11px;color:#6b7280;margin-bottom:4px;">초반 3회 평균</div>
          <div style="font-size:24px;font-weight:800;color:#374151;">${first3avg}%</div>
        </div>
        <div style="flex:1;padding:14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;text-align:center;">
          <div style="font-size:11px;color:#6b7280;margin-bottom:4px;">최근 3회 평균</div>
          <div style="font-size:24px;font-weight:800;color:#374151;">${last3avg}%</div>
        </div>
        <div style="flex:1;padding:14px;background:#fff;border:2px solid ${trendColor};border-radius:8px;text-align:center;">
          <div style="font-size:11px;color:#6b7280;margin-bottom:4px;">전체 추세</div>
          <div style="font-size:16px;font-weight:800;color:${trendColor};">${trendLabel}</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:2px;">${diff>=0?'+':''}${diff}%p</div>
        </div>
      </div>
    </div>

    <div style="margin-bottom:22px;">
      <div style="font-size:13px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:10px;margin-bottom:12px;">3. 날짜별 집중도 기록</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:#f3f4f6;">
          <th style="padding:8px 12px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">날짜</th>
          <th style="padding:8px 12px;text-align:center;font-weight:700;border-bottom:2px solid #e5e7eb;">집중도</th>
          <th style="padding:8px 12px;text-align:center;font-weight:700;border-bottom:2px solid #e5e7eb;">졸음 확정</th>
          <th style="padding:8px 12px;text-align:center;font-weight:700;border-bottom:2px solid #e5e7eb;">자리 이탈</th>
          <th style="padding:8px 12px;text-align:center;font-weight:700;border-bottom:2px solid #e5e7eb;">눈 감김 의심</th>
        </tr></thead>
        <tbody>
          ${trendDates.map((d,i)=>{
            const fc = focusTrend[i];
            const fcColor = fc>=70?'#059669':fc>=50?'#d97706':'#dc2626';
            return `<tr>
              <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-weight:600;">${d}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:center;font-weight:800;color:${fcColor};">${fc}%</td>
              <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:center;color:#ef4444;font-weight:700;">${drowsyTrend[i]}회</td>
              <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:center;color:#f97316;font-weight:700;">${absentTrend[i]}회</td>
              <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:center;color:#eab308;font-weight:700;">${warnTrend[i]}회</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>

    <div style="margin-bottom:22px;">
      <div style="font-size:13px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:10px;margin-bottom:12px;">4. 행동 지표 날짜별 막대 그래프</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;">
        <div><div style="font-size:11px;font-weight:700;color:#ef4444;margin-bottom:8px;">😴 졸음 확정</div>${makePdfBars(drowsyTrend,'#ef4444')}</div>
        <div><div style="font-size:11px;font-weight:700;color:#f97316;margin-bottom:8px;">🚶 자리 이탈</div>${makePdfBars(absentTrend,'#f97316')}</div>
        <div><div style="font-size:11px;font-weight:700;color:#eab308;margin-bottom:8px;">😪 눈 감김</div>${makePdfBars(warnTrend,'#eab308')}</div>
      </div>
    </div>

    <div style="text-align:center;font-size:10px;color:#9ca3af;margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb;">
      본 리포트는 멋쟁이사자처럼 Sleep2Wake AI 수강생 태도 분석 시스템에 의해 자동으로 생성되었습니다.
    </div>
  `;
  modal.style.display = 'flex';
}

// ── PDF 저장 (공통) ───────────────────────────
async function saveStudentPdf() {
  const btn = document.getElementById('sr-pdf-save-btn');
  if (btn) { btn.textContent = '저장 중...'; btn.disabled = true; }
  try {
    if (!window.jspdf) {
      await new Promise((res,rej)=>{ const s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'; s.onload=res; s.onerror=rej; document.head.appendChild(s); });
    }
    if (!window.html2canvas) {
      await new Promise((res,rej)=>{ const s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'; s.onload=res; s.onerror=rej; document.head.appendChild(s); });
    }
    const { jsPDF } = window.jspdf;
    const pdf    = new jsPDF({ orientation:'portrait', unit:'mm', format:'a4' });
    const page   = document.getElementById('sr-pdf-page');
    const canvas = await html2canvas(page, { scale:2, useCORS:true, backgroundColor:'#fff' });
    pdf.addImage(canvas.toDataURL('image/jpeg',0.95), 'JPEG', 0, 0, 210, 297);
    const name   = _currentReportStudent?.name || _currentReportStudent?.student_id || '학생';
    const suffix = _srActiveTab === 'trend' ? '누적추이' : '당일';
    pdf.save(`Sleep2Wake_${name}_${suffix}_리포트.pdf`);
  } catch(e) {
    console.error('PDF 저장 실패:', e);
    if (typeof showToast === 'function') showToast('PDF 저장 실패. 다시 시도해주세요.');
  } finally {
    if (btn) { btn.textContent = '💾 PDF 저장'; btn.disabled = false; }
  }
}

// ══════════════════════════════════════════════
// ── 학생 태도 테이블 ──────────────────────────
// ══════════════════════════════════════════════

function renderStudentAttitude() {
  const list = Object.values(wsStudents);
  const el   = document.getElementById('student-attitude-list');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<div class="empty-msg">접속 중인 학생이 없습니다</div>';
    return;
  }
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
        <div class="attitude-bar-bg"><div class="attitude-bar-fill" style="width:${focus}%;background:${color}"></div></div>
      </div>
      <div class="align-right"><span class="status-chip ${status}">${label}</span></div>
    </div>`;
  }).join('');
}

// ── 전체 학생 뷰 전환 ────────────────────────
function toggleAllStudents() {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const allView = document.getElementById('view-all-students');
  if (allView) allView.classList.add('active');
  renderAllStudentsView();
}

function closeAllStudents() {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-dashboard-detail').classList.add('active');
}

function renderAllStudentsView() {
  const el = document.getElementById('all-students-view-list');
  if (!el) return;
  let list = Object.values(wsStudents);
  if (window._endedStudentsList && window._endedStudentsList.length) list = window._endedStudentsList;
  if (!list.length) {
    el.innerHTML = '<div class="empty-msg" style="padding:40px 0;">접속 중인 학생이 없습니다</div>';
    return;
  }
  const sorted = [...list].sort((a, b) => {
    const pa = (a.drowsy_cnt||0)*10+(a.absent_cnt||0)*8+(a.warning_cnt||0)*5+(a.yawn_cnt||0)*3+(a.head_cnt||0)*2;
    const pb = (b.drowsy_cnt||0)*10+(b.absent_cnt||0)*8+(b.warning_cnt||0)*5+(b.yawn_cnt||0)*3+(b.head_cnt||0)*2;
    return pb - pa;
  });
  el.innerHTML = sorted.map((s, i) => {
    const focus = s.focus_pct !== undefined ? s.focus_pct : calcFocus(s);
    const color = focusColor(focus);
    return `
    <div style="display:grid;grid-template-columns:40px 1fr 2fr 100px;gap:12px;align-items:center;padding:14px 12px;border-bottom:1px solid #f3f4f6;transition:background 0.15s;"
         onmouseover="this.style.background='#fafafa'" onmouseout="this.style.background=''">
      <span style="font-size:12px;font-weight:700;color:#9ca3af;">${String(i+1).padStart(2,'0')}</span>
      <span style="font-size:14px;font-weight:600;color:#111827;">${s.name || s.student_id}</span>
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="flex:1;height:8px;background:#f3f4f6;border-radius:4px;overflow:hidden;">
          <div style="width:${focus}%;height:100%;background:${color};border-radius:4px;transition:width 0.3s;"></div>
        </div>
        <span style="font-size:12px;font-weight:700;color:${color};min-width:34px;">${focus}%</span>
      </div>
      <div style="text-align:right;">
        <button onclick="showStudentReport(${JSON.stringify(s).replace(/"/g,'&quot;')})"
          style="padding:5px 12px;background:#FFF3E8;border:1px solid #FF7710;border-radius:6px;color:#FF7710;font-size:11px;font-weight:700;cursor:pointer;transition:all 0.15s;"
          onmouseover="this.style.background='#FF7710';this.style.color='#fff'"
          onmouseout="this.style.background='#FFF3E8';this.style.color='#FF7710'">
          📄 생성
        </button>
      </div>
    </div>`;
  }).join('');
}

function renderAllStudentsPanel(sorted) { renderAllStudentsView(); }

function calcFocus(s) {
  const penalty = (s.drowsy_cnt||0)*10+(s.absent_cnt||s.absent||0)*15+(s.warning_cnt||0)*5+(s.yawn_cnt||0)*3+(s.head_cnt||0)*3;
  return Math.max(0, 100 - penalty);
}

// ── 집중도 차트 (SVG) ─────────────────────────
// 부트캠프 시간표 기준 슬롯: 09~12시(오전), 13~18시(오후), 12~13시 제외
const BOOTCAMP_SLOTS = [
  '09:00','10:00','11:00', // 오전
  '13:00','14:00','15:00','16:00','17:00', // 오후 (점심 건너뜀)
];

// ── 집중도 차트 데이터 빌드 ─────────────────
/**
 * buildChartData — 실시간 누적 데이터(realtimeFocusMap)만 사용
 * 데이터 없는 슬롯은 포함하지 않음
 */
function buildChartData() {
  return BOOTCAMP_SLOTS
    .map(slot => {
      const rt = realtimeFocusMap[slot];
      if (!rt || rt.count === 0) return null;
      return {
        time:  slot,
        focus: Math.round(rt.totalFocus / rt.count),
        sleep: rt.drowsyCount || 0,
      };
    })
    .filter(Boolean);
}

/**
 * drawSimpleChart — 단순 꺾은선 차트 (빵꾸 없음)
 * @param {string} svgId SVG ID
 * @param {Array}  data  [{time, focus}]
 * @param {string} lineColor 선 색상
 * @param {string} gradId 그라디언트 ID
 */
function drawSimpleChart(svgId, data, lineColor, gradId) {
  const svg = document.getElementById(svgId);
  if (!svg || !data.length) return;
  const W=400, H=160, PX=36, PY=18;
  const n = data.length;
  const getX = i => PX + i * ((W-PX*2) / Math.max(n-1,1));
  const getY = v => H - PY - (v/100)*(H-PY*2);
  let h = '';
  // 그리드
  [0,50,100].forEach(v => {
    const y = getY(v);
    h += `<line x1="${PX}" y1="${y}" x2="${W-PX}" y2="${y}" stroke="#f3f4f6" stroke-dasharray="3 3" stroke-width="1"/>`;
    h += `<text x="${PX-4}" y="${y+4}" fill="#d1d5db" font-size="9" text-anchor="end" font-family="Pretendard,sans-serif">${v}%</text>`;
  });
  // X축 라벨
  data.forEach((d, i) => {
    h += `<text x="${getX(i)}" y="${H-2}" fill="#c4c9d4" font-size="9" text-anchor="middle" font-family="Pretendard,sans-serif">${d.time}</text>`;
  });
  // 선 + 영역
  const lp = data.map((d,i)=>`${i===0?'M':'L'} ${getX(i)} ${getY(d.focus)}`).join(' ');
  const ap = `${lp} L ${getX(n-1)} ${H-PY} L ${getX(0)} ${H-PY} Z`;
  h += `<path d="${ap}" fill="url(#${gradId})"/>`;
  h += `<path d="${lp}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  // 현재 시각 마지막 포인트 강조 (실시간)
  data.forEach((d, i) => {
    const isLast = i === data.length - 1;
    h += `<circle cx="${getX(i)}" cy="${getY(d.focus)}" r="${isLast ? 6 : 4}" fill="#fff" stroke="${lineColor}" stroke-width="2"/>`;
    if (isLast && realtimeFocusMap[d.time]) {
      // 실시간 점: 오렌지 채움 + 현재시각 라벨
      h += `<circle cx="${getX(i)}" cy="${getY(d.focus)}" r="5" fill="${lineColor}" stroke="#fff" stroke-width="1.5"/>`;
      h += `<text x="${getX(i)}" y="${getY(d.focus)-10}" fill="${lineColor}" font-size="9" text-anchor="middle" font-family="Pretendard,sans-serif" font-weight="700">● 현재</text>`;
    }
  });
  svg.innerHTML = svg.innerHTML + h;
}

/**
 * drawReportChart — 오전/오후 그래프 2개 분리 렌더링
 */
function drawReportChart() {
  const period   = document.getElementById('report-period-select')?.value || 'last_1_week';
  const useDummy = USE_DUMMY_TREND && (period === 'last_1_month' || period === 'all_term');

  // 기간별 시간대 더미 데이터 (오전/오후 평균)
  const DUMMY_AMPM = {
    last_1_month: {
      am: [{ time:'09:00', focus:84 },{ time:'10:00', focus:88 },{ time:'11:00', focus:80 }],
      pm: [{ time:'13:00', focus:73 },{ time:'14:00', focus:77 },{ time:'15:00', focus:71 },{ time:'16:00', focus:75 },{ time:'17:00', focus:70 }],
    },
    all_term: {
      am: [{ time:'09:00', focus:81 },{ time:'10:00', focus:85 },{ time:'11:00', focus:77 }],
      pm: [{ time:'13:00', focus:68 },{ time:'14:00', focus:73 },{ time:'15:00', focus:69 },{ time:'16:00', focus:72 },{ time:'17:00', focus:66 }],
    },
  };

  let amData, pmData;
  if (useDummy) {
    amData = DUMMY_AMPM[period].am;
    pmData = DUMMY_AMPM[period].pm;
  } else {
    const allData = buildChartData();
    amData = allData.filter(d => parseInt(d.time) < 12);
    pmData = allData.filter(d => parseInt(d.time) >= 13);
  }

  const svgAM = document.getElementById('report-chart-am');
  if (svgAM) {
    svgAM.innerHTML = `<defs><linearGradient id="reportGradAM" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#FF7B00" stop-opacity="0.18"/><stop offset="100%" stop-color="#FF7B00" stop-opacity="0"/></linearGradient></defs>`;
    drawSimpleChart('report-chart-am', amData, '#FF7710', 'reportGradAM');
  }

  const svgPM = document.getElementById('report-chart-pm');
  if (svgPM) {
    svgPM.innerHTML = `<defs><linearGradient id="reportGradPM" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#FF7B00" stop-opacity="0.18"/><stop offset="100%" stop-color="#FF7B00" stop-opacity="0"/></linearGradient></defs>`;
    if (!useDummy && new Date().getHours() < 12 && Object.keys(realtimeFocusMap).length > 0) {
      const W=400, H=160;
      svgPM.innerHTML += `<text x="${W/2}" y="${H/2}" fill="#d1d5db" font-size="13" text-anchor="middle" font-family="Pretendard,sans-serif">오후 수업 진행 예정</text>`;
    } else {
      drawSimpleChart('report-chart-pm', pmData, '#FF7710', 'reportGradPM');
    }
  }

  renderAmPmInsight([...amData, ...pmData]);
}

/**
 * drawFocusChart — 대시보드 오전/오후 분리 SVG 렌더링
 * focus-chart-am / focus-chart-pm 각각에 그림
 */
function drawFocusChart() {
  // 날짜 확인: 과거 날짜(3/30 더미 제외) 또는 미래 날짜면 차트 그리지 않음
  const nowDate  = new Date();
  const todayStr = `${nowDate.getFullYear()}-${String(nowDate.getMonth()+1).padStart(2,'0')}-${String(nowDate.getDate()).padStart(2,'0')}`;
  const sessDate = selectedSession?.date || '';
  const isPast   = sessDate !== '' && sessDate < todayStr;
  const isFuture = sessDate !== '' && sessDate > todayStr;
  // 과거 날짜 or 미래 날짜 → 빈 차트
  if (isPast || isFuture) {
    const msgText = isFuture ? '수업 예정일 — 데이터 없음' : '해당 날짜의 차트 데이터가 없습니다';
    ['focus-chart-am','focus-chart-pm'].forEach(id => {
      const svg = document.getElementById(id);
      if (svg) svg.innerHTML = `<text x="230" y="90" fill="#d1d5db" font-size="13" text-anchor="middle" font-family="Pretendard,sans-serif">${msgText}</text>`;
    });
    const badge = document.getElementById('dashboard-ampm-badge');
    if (badge) badge.innerHTML = '';
    return;
  }

  const allData = buildChartData();
  const amData  = allData.filter(d => parseInt(d.time) < 12);
  const pmData  = allData.filter(d => parseInt(d.time) >= 13);
  const nowHour = new Date().getHours();

  // 오전 차트
  _drawSplitChart('focus-chart-am', amData, '#6366f1', 'focusGradAM', '#FF7710', 'sleepGradAM', true);
  // 오후 차트 — 현재 오전이면 "오후 수업 진행 예정" 텍스트
  if (nowHour < 12 && Object.keys(realtimeFocusMap).length > 0) {
    const svg = document.getElementById('focus-chart-pm');
    if (svg) {
      svg.innerHTML = svg.innerHTML + `
        <text x="230" y="90" fill="#d1d5db" font-size="14" text-anchor="middle" font-family="Pretendard,sans-serif" font-weight="600">오후 수업 진행 예정</text>
        <text x="230" y="112" fill="#e5e7eb" font-size="11" text-anchor="middle" font-family="Pretendard,sans-serif">13:00 ~ 17:00</text>`;
    }
  } else {
    _drawSplitChart('focus-chart-pm', pmData, '#6366f1', 'focusGradPM', '#FF7710', 'sleepGradPM', true);
  }

  // 진행중 뱃지 (현재 오후 수업 시간이면 표시)
  const liveBadge = document.getElementById('dashboard-pm-live-badge');
  if (liveBadge) liveBadge.style.display = (nowHour >= 13 && nowHour < 18 && Object.keys(realtimeFocusMap).length > 0) ? 'inline-block' : 'none';

  // 오전/오후 평균 비교 뱃지
  const amAvg = amData.length ? Math.round(amData.reduce((a,b)=>a+b.focus,0)/amData.length) : 0;
  const pmAvg = pmData.length ? Math.round(pmData.reduce((a,b)=>a+b.focus,0)/pmData.length) : 0;
  const diff  = pmAvg - amAvg;
  const badgeEl = document.getElementById('dashboard-ampm-badge');
  if (badgeEl) {
    badgeEl.innerHTML = `
      <div class="ampm-badge am" style="flex:1;padding:10px 14px;border-radius:10px;background:#eff6ff;border:1px solid #bfdbfe;display:flex;align-items:center;justify-content:space-between;">
        <div><div style="font-size:11px;font-weight:700;color:#6b7280;">☀️ 오전 평균</div><div style="font-size:20px;font-weight:900;color:#2563eb;">${amAvg}%</div></div>
        <div style="font-size:11px;font-weight:600;color:${diff>=0?'#059669':'#dc2626'};">${diff>=0?'오후 대비 +':'오후 대비 '}${Math.abs(diff)}%p</div>
      </div>
      <div class="ampm-badge pm" style="flex:1;padding:10px 14px;border-radius:10px;background:#fff7ed;border:1px solid #fed7aa;display:flex;align-items:center;justify-content:space-between;">
        <div><div style="font-size:11px;font-weight:700;color:#6b7280;">🌆 오후 평균</div><div style="font-size:20px;font-weight:900;color:#ea580c;">${pmAvg}%</div></div>
        <div style="font-size:11px;font-weight:600;color:${diff<=0?'#dc2626':'#059669'};">${diff<=0?'⚠️ 오전 대비 하락':'✅ 오전 대비 상승'}</div>
      </div>`;
  }
}

/**
 * _drawSplitChart — 오전 또는 오후 단일 구간 차트 공통 함수
 */
function _drawSplitChart(svgId, data, focusColor, focusGrad, sleepColor, sleepGrad, showDots) {
  const svg = document.getElementById(svgId);
  if (!svg || !data.length) return;
  const W=460, H=180, PX=38, PY=18;
  const n = data.length;
  const getX = i => PX + i * ((W-PX*2) / Math.max(n-1,1));
  const getY = v => H - PY - (v/100)*(H-PY*2);
  let h = '';
  [0,25,50,75,100].forEach(v => {
    const y = getY(v);
    h += `<line x1="${PX}" y1="${y}" x2="${W-PX}" y2="${y}" stroke="#f0f0f0" stroke-dasharray="3 3" stroke-width="1"/>`;
    h += `<text x="${PX-6}" y="${y+4}" fill="#d1d5db" font-size="10" text-anchor="end" font-family="Pretendard,sans-serif">${v}%</text>`;
  });
  data.forEach((d, i) => {
    h += `<text x="${getX(i)}" y="${H-2}" fill="#b0b7c3" font-size="10" text-anchor="middle" font-family="Pretendard,sans-serif">${d.time}</text>`;
  });
  // 집중도 선
  const lp = data.map((d,i)=>`${i===0?'M':'L'} ${getX(i)} ${getY(d.focus)}`).join(' ');
  const ap = `${lp} L ${getX(n-1)} ${H-PY} L ${getX(0)} ${H-PY} Z`;
  h += `<path d="${ap}" fill="url(#${focusGrad})"/>`;
  h += `<path d="${lp}" fill="none" stroke="${focusColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (showDots) data.forEach((d,i) => {
    const isRealtime = !!realtimeFocusMap[d.time];
    h += `<circle cx="${getX(i)}" cy="${getY(d.focus)}" r="${isRealtime?6:4.5}" fill="${isRealtime?focusColor:'#fff'}" stroke="${focusColor}" stroke-width="2"/>`;
    if (isRealtime) h += `<text x="${getX(i)}" y="${getY(d.focus)-10}" fill="${focusColor}" font-size="9" text-anchor="middle" font-family="Pretendard,sans-serif" font-weight="700">NOW</text>`;
  });
  // 졸음 빈도 선
  const slp = data.map((d,i)=>`${i===0?'M':'L'} ${getX(i)} ${getY(d.sleep)}`).join(' ');
  h += `<path d="${slp}" fill="none" stroke="${sleepColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  data.forEach((d,i) => { h += `<circle cx="${getX(i)}" cy="${getY(d.sleep)}" r="3.5" fill="#fff" stroke="${sleepColor}" stroke-width="1.8"/>`; });
  svg.innerHTML = svg.innerHTML + h;
}

/**
 * drawTrendChart — 리포트 탭 기간별 집중도 추이 차트
 * 수업 회차별(날짜별) 평균 집중도를 꺾은선으로 표시
 */
function drawTrendChart() {
  const svg = document.getElementById('trend-chart');
  if (!svg) return;
  svg.innerHTML = `<defs>
    <linearGradient id="trendGrad" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#6366f1" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#6366f1" stop-opacity="0"/>
    </linearGradient>
  </defs>`;

  const period   = document.getElementById('report-period-select')?.value || 'last_1_week';
  const useDummy = USE_DUMMY_TREND && (period === 'last_1_month' || period === 'all_term');

  // 기간별 더미 데이터 — 자연스러운 오르락 내리락 패턴
  const DUMMY_TREND = {
    last_1_month: {
      labels: ['1주차','2주차','3주차','4주차'],
      values: [82, 75, 70, 78],
    },
    all_term: {
      labels: ['1개월','2개월','3개월','4개월','5개월','6개월'],
      values: [72, 78, 74, 80, 76, 83],
    },
  };

  let trendData;

  if (useDummy) {
    const d = DUMMY_TREND[period];
    trendData = d.labels.map((t, i) => ({ time: t, focus: d.values[i] }));
  } else {
    // 최근 1주일: 실제 세션 데이터 (날짜 기준 최근 7회)
    const sorted = [...currentSessions]
      .sort((a,b) => (a.date||'').localeCompare(b.date||''))
      .slice(-7);
    if (sorted.length >= 2) {
      trendData = sorted.map((s, i) => ({
        time:  `${i+1}회`,
        focus: s.avg_focus || 0,
      }));
    } else {
      // 실제 데이터 부족 시 안내 메시지
      const W=1000, H=260;
      svg.innerHTML += `<text x="${W/2}" y="${H/2}" fill="#d1d5db" font-size="14" text-anchor="middle" font-family="Pretendard,sans-serif">수업 데이터가 2회 이상 쌓이면 추이가 표시됩니다</text>`;
      renderTrendInsight([]);
      return;
    }
  }

  const W=1000, H=260, PAD=44, n=trendData.length;
  const xStep = n > 1 ? (W-PAD*2)/(n-1) : 0;
  const getX = i => PAD + i * xStep;
  const getY = v => H - PAD - (v/100)*(H-PAD*2);

  let html = '';
  // Y축 그리드
  [0,25,50,75,100].forEach(v => {
    const y = getY(v);
    html += `<line x1="${PAD}" y1="${y}" x2="${W-PAD}" y2="${y}" stroke="#f3f4f6" stroke-dasharray="4 4" stroke-width="1"/>`;
    html += `<text x="${PAD-8}" y="${y+4}" fill="#9ca3af" font-size="11" text-anchor="end" font-family="Pretendard,sans-serif">${v}%</text>`;
  });
  // X축 라벨
  trendData.forEach((d, i) => {
    html += `<text x="${getX(i)}" y="${H-10}" fill="#9ca3af" font-size="11" text-anchor="middle" font-family="Pretendard,sans-serif">${d.time}</text>`;
  });

  // 영역 + 선 + 포인트
  const lp = trendData.map((d,i)=>`${i===0?'M':'L'} ${getX(i)} ${getY(d.focus)}`).join(' ');
  const ap = `${lp} L ${getX(n-1)} ${H-PAD} L ${getX(0)} ${H-PAD} Z`;
  html += `<path d="${ap}" fill="url(#trendGrad)"/>`;
  html += `<path d="${lp}" fill="none" stroke="#6366f1" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
  trendData.forEach((d,i) => {
    // 포인트 위에 값 표시
    html += `<text x="${getX(i)}" y="${getY(d.focus)-10}" fill="#6366f1" font-size="11" text-anchor="middle" font-family="Pretendard,sans-serif" font-weight="700">${d.focus}%</text>`;
    html += `<circle cx="${getX(i)}" cy="${getY(d.focus)}" r="5" fill="#fff" stroke="#6366f1" stroke-width="2.5"/>`;
  });

  svg.innerHTML += html;
  renderTrendInsight(trendData);
}

/** 오전/오후 집중도 비교 인사이트 뱃지 */
function renderAmPmInsight(data) {
  const el = document.getElementById('report-ampm-insight');
  if (!el) return;
  const amSlots = data.filter(d => parseInt(d.time) < 12);
  const pmSlots = data.filter(d => parseInt(d.time) >= 13);
  const amAvg = amSlots.length ? Math.round(amSlots.reduce((a,b)=>a+b.focus,0)/amSlots.length) : 0;
  const pmAvg = pmSlots.length ? Math.round(pmSlots.reduce((a,b)=>a+b.focus,0)/pmSlots.length) : 0;
  const diff = pmAvg - amAvg;
  const diffStr = (diff >= 0 ? '+' : '') + diff + '%p';
  const diffColor = diff >= 0 ? '#059669' : '#dc2626';

  el.innerHTML = `
    <div class="ampm-badge am">
      <div>
        <div class="ampm-label">☀️ 오전 평균 집중도</div>
        <div class="ampm-val am">${amAvg}%</div>
      </div>
      <div class="ampm-diff" style="color:${diffColor}">오후 대비 ${diffStr}</div>
    </div>
    <div class="ampm-badge pm">
      <div>
        <div class="ampm-label">🌆 오후 평균 집중도</div>
        <div class="ampm-val pm">${pmAvg}%</div>
      </div>
      <div class="ampm-diff" style="color:${diff >= 0 ? '#059669' : '#dc2626'}">
        ${diff <= -10 ? '⚠️ 오후 집중도 하락 주의' : diff >= 5 ? '✅ 오후도 양호' : '➡️ 오전과 유사'}
      </div>
    </div>`;
}

/** 기간 추세 판정 뱃지 */
function renderTrendInsight(trendData) {
  const el = document.getElementById('trend-insight');
  if (!el || trendData.length < 3) return;
  const first = trendData.slice(0, Math.ceil(trendData.length/2));
  const last  = trendData.slice(Math.floor(trendData.length/2));
  const firstAvg = Math.round(first.reduce((a,b)=>a+b.focus,0)/first.length);
  const lastAvg  = Math.round(last.reduce((a,b)=>a+b.focus,0)/last.length);
  const diff = lastAvg - firstAvg;
  let cls, icon, msg, sub;
  if (diff >= 5)  { cls='up';   icon='📈'; msg='집중도 상승 추세'; sub=`강사 운영이 효과적입니다. (${firstAvg}% → ${lastAvg}%)`; }
  else if (diff <= -5) { cls='down'; icon='📉'; msg='집중도 하락 추세'; sub=`커리큘럼·운영 방식 개선을 권장합니다. (${firstAvg}% → ${lastAvg}%)`; }
  else           { cls='flat'; icon='➡️'; msg='집중도 유지 수준'; sub=`안정적으로 운영 중입니다. (초반 ${firstAvg}% / 최근 ${lastAvg}%)`; }
  el.innerHTML = `<div class="trend-badge ${cls}">${icon} ${msg}<span style="font-size:11px;font-weight:400;margin-left:8px;opacity:0.85;">${sub}</span></div>`;
}

// ── 리포트: 과정 목록 ─────────────────────────
async function loadCourses() {
  try {
    const res=await fetch(`${BACKEND_URL}/api/courses`);
    const courses=await res.json();
    const select=document.getElementById('report-course-select');
    if(!select) return;
    select.innerHTML='<option value="">수업을 선택해주세요</option>'
      +(Array.isArray(courses)?courses:[]).map(c=>`<option value="${c}" ${c===selectedCourse?'selected':''}>${c}</option>`).join('');
    if(selectedCourse) loadSessions(selectedCourse);
  } catch(e) { console.warn('[Admin] 과정 로드 실패:',e); }
}

function onReportCourseChange(course) {
  selectedCourse=course;
  if(course) loadSessions(course);
  else { document.getElementById('report-empty').style.display='flex'; document.getElementById('report-content').style.display='none'; }
}

async function loadSessions(courseName) {
  selectedCourse=courseName;
  if(!courseName) {
    document.getElementById('report-empty').style.display='flex';
    document.getElementById('report-content').style.display='none';
    const pdfBtn=document.getElementById('btn-open-pdf');
    if(pdfBtn) pdfBtn.style.display='none';
    const titleEl=document.getElementById('report-main-title');
    if(titleEl) titleEl.textContent='기간별 누적 리포트';
    return;
  }
  try {
    const url=`${BACKEND_URL}/api/sessions?course_name=${encodeURIComponent(courseName)}`;
    const res=await fetch(url);
    const data=await res.json();
    currentSessions=Array.isArray(data)?data:[];
    const titleEl=document.getElementById('report-main-title');
    if(titleEl) titleEl.textContent=`${courseName} 종합 리포트`;
    const emptyEl=document.getElementById('report-empty');
    if(emptyEl){emptyEl.style.transition='opacity 0.25s ease';emptyEl.style.opacity='0';setTimeout(()=>{emptyEl.style.display='none';emptyEl.style.opacity='1';},260);}
    const contentEl=document.getElementById('report-content');
    if(contentEl){contentEl.style.opacity='0';contentEl.style.transform='translateY(12px)';contentEl.style.display='flex';contentEl.style.flexDirection='column';contentEl.style.gap='20px';contentEl.style.transition='opacity 0.35s ease, transform 0.35s ease';setTimeout(()=>{contentEl.style.opacity='1';contentEl.style.transform='translateY(0)';},280);}
    const pdfBtn=document.getElementById('btn-open-pdf');
    if(pdfBtn){pdfBtn.style.opacity='0';pdfBtn.style.display='flex';pdfBtn.style.transition='opacity 0.3s ease';setTimeout(()=>{pdfBtn.style.opacity='1';},300);}
    renderReportStats(); renderSessionList(); renderRiskStudents(); drawReportChart(); drawTrendChart();

    // 기간 필터 변경 이벤트 — 최초 1회만 등록
    const periodSel = document.getElementById('report-period-select');
    if (periodSel && !periodSel._bound) {
      periodSel._bound = true;
      periodSel.addEventListener('change', () => {
        renderReportStats(); drawReportChart(); drawTrendChart();
      });
    }
  } catch(e) { console.warn('[Admin] 세션 로드 실패:',e); }
}

function renderReportStats() {
  const period = document.getElementById('report-period-select')?.value || 'last_1_week';

  // 최근 1주일: 실제 데이터 사용
  // 최근 1개월 / 과정 전체: USE_DUMMY_TREND=true면 더미 고정
  const useDummy = USE_DUMMY_TREND && (period === 'last_1_month' || period === 'all_term');

  const total         = currentSessions.length;
  const avgFocus      = total > 0 ? Math.round(currentSessions.reduce((a,s)=>a+(s.avg_focus||0),0)/total) : 0;
  const totalDrowsy   = currentSessions.reduce((a,s)=>a+(s.drowsy_count||0),0);
  const totalStudents = currentSessions.reduce((a,s)=>a+(s.student_count||0),0);
  const totalAbsent   = currentSessions.reduce((a,s)=>a+(s.absent_count||0),0);
  const absentRate    = totalStudents > 0 ? Math.round(totalAbsent/totalStudents*100) : 0;

  // 기간별 더미 값
  const DUMMY_BY_PERIOD = {
    last_1_month: { att:'93.7%', focus:'78%', drowsy:47, absent:3 },
    all_term:     { att:'91.2%', focus:'75%', drowsy:128, absent:5 },
  };
  const d = useDummy ? DUMMY_BY_PERIOD[period] : null;

  const _att   = d ? d.att   : `${totalStudents>0?Math.round((1-totalAbsent/totalStudents)*100):0}%`;
  const _focus = d ? d.focus : `${avgFocus}%`;
  const _dr    = d ? d.drowsy : totalDrowsy;
  const _ab    = d ? d.absent : absentRate;

  document.getElementById('r-attendance').textContent = _att;
  document.getElementById('r-focus').textContent      = _focus;

  const drowsyEl = document.getElementById('r-drowsy-total');
  if (drowsyEl) drowsyEl.textContent = `${_dr}건`;
  const drowsyBadge = document.getElementById('r-drowsy-badge');
  if (drowsyBadge) {
    drowsyBadge.textContent = _dr > 10 ? '집중 상담 필요' : _dr > 0 ? '관리 요망' : '양호';
    drowsyBadge.className   = `stat-badge ${_dr > 10 ? 'red' : _dr > 0 ? 'orange' : 'green'}`;
  }

  const absentEl = document.getElementById('r-absent-rate');
  if (absentEl) absentEl.textContent = `${_ab}%`;
  const absentBadge = document.getElementById('r-absent-badge');
  if (absentBadge) {
    absentBadge.textContent = absentRate > 15 ? '이탈 빈발' : absentRate > 5 ? '관리 요망' : '양호';
    absentBadge.className   = `stat-badge ${absentRate > 15 ? 'red' : absentRate > 5 ? 'orange' : 'green'}`;
  }

  const badge = document.getElementById('r-focus-badge');
  if (badge) badge.textContent = '지난 달 대비 + 2.1%';
}

function renderSessionList() {
  const el=document.getElementById('session-list');
  if(!el) return;
  if(!currentSessions.length){el.innerHTML='<div class="empty-msg">수업 기록이 없습니다</div>';return;}
  el.innerHTML=currentSessions.map(s=>{
    const focus=s.avg_focus||0, color=focusColor(focus);
    const dur=s.duration_min?`${Math.floor(s.duration_min/60)}h ${Math.round(s.duration_min%60)}m`:'-';
    return `<div class="session-row-item">
      <div class="session-date-cell">${s.date||'-'}</div>
      <div><div class="session-info-name">${s.course_name||s.room_code}</div><div class="session-info-sub">강사: ${s.instructor||'-'} · ${dur}</div></div>
      <div class="session-focus-val" style="color:${color}">${focus}%</div>
      <div class="session-alert-val">${s.alert_count||0}</div>
      <div class="session-bar-bg"><div class="session-bar-fill" style="width:${focus}%;background:${color}"></div></div>
    </div>`;
  }).join('');
}

/**
 * renderRiskStudents — 수강 이탈 위험군 자동 감지
 * 결석률 + 집중도 하락 추세를 복합 분석해 위험 등급 산정
 * - 고위험(high):   결석 3회↑ + 집중도 50% 미만
 * - 주의(medium):   결석 2회↑ 또는 집중도 60% 미만
 * - 관찰(low):      집중도 70% 미만 또는 졸음 반복
 */
function renderRiskStudents() {
  const el = document.getElementById('risk-student-list');
  if (!el) return;

  // 실제 학생 데이터: _endedStudentsList 우선
  const rawList = (window._endedStudentsList && window._endedStudentsList.length)
    ? window._endedStudentsList
    : [];

  // 위험 점수 계산 함수
  function calcRiskScore(s) {
    const absencePenalty = (s.absence_total || 0) * 20;
    const focusPenalty   = Math.max(0, 70 - (s.focus_pct || calcFocus(s))) * 0.8;
    const drowsyPenalty  = (s.drowsy_cnt || 0) * 5;
    return Math.min(100, absencePenalty + focusPenalty + drowsyPenalty);
  }

  function getRiskLevel(s) {
    const absence = s.absence_total || 0;
    const focus   = s.focus_pct !== undefined ? s.focus_pct : calcFocus(s);
    if (absence >= 3 || (absence >= 2 && focus < 50)) return 'high';
    if (absence >= 2 || focus < 60) return 'medium';
    if (focus < 70 || (s.drowsy_cnt || 0) >= 3)      return 'low';
    return null;
  }

  let riskList = rawList
    .map(s => ({ ...s, _risk: getRiskLevel(s), _score: calcRiskScore(s) }))
    .filter(s => s._risk !== null)
    .sort((a,b) => b._score - a._score);

  // 실제 데이터가 없으면 더미로 대체
  if (!riskList.length) {
    riskList = [
      { name:'김OO', student_id:'kim', _risk:'high',   _score:85, absence_total:4, focus_pct:42, drowsy_cnt:5, _tags:['잦은 결석','심한 졸음'], _action:'즉시 상담' },
      { name:'이OO', student_id:'lee', _risk:'high',   _score:72, absence_total:3, focus_pct:48, drowsy_cnt:3, _tags:['결석 반복','집중도 하락'], _action:'즉시 상담' },
      { name:'박OO', student_id:'pak', _risk:'medium', _score:55, absence_total:2, focus_pct:58, drowsy_cnt:2, _tags:['집중도 저하'], _action:'주의 관찰' },
      { name:'최OO', student_id:'cho', _risk:'medium', _score:48, absence_total:1, focus_pct:55, drowsy_cnt:4, _tags:['졸음 반복'], _action:'주의 관찰' },
      { name:'정OO', student_id:'jun', _risk:'low',    _score:30, absence_total:0, focus_pct:65, drowsy_cnt:2, _tags:['집중도 평균 이하'], _action:'관찰 유지' },
    ];
  }

  if (!riskList.length) {
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;padding:20px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;">
        <span style="font-size:28px;">🎉</span>
        <div>
          <div style="font-size:14px;font-weight:700;color:#059669;">수강 이탈 위험군 없음</div>
          <div style="font-size:12px;color:#6b7280;margin-top:2px;">모든 수강생이 안정적인 참여 상태를 유지하고 있습니다.</div>
        </div>
      </div>`;
    return;
  }

  const LEVEL_CFG = {
    high:   { dot:'🔴', bg:'#fecaca', label:'고위험', btnTxt:'즉시 상담' },
    medium: { dot:'🟠', bg:'#fed7aa', label:'주의',   btnTxt:'주의 관찰' },
    low:    { dot:'🟡', bg:'#fde68a', label:'관찰',   btnTxt:'경과 확인' },
  };

  el.innerHTML = riskList.map(s => {
    const cfg     = LEVEL_CFG[s._risk];
    const focus   = s.focus_pct !== undefined ? s.focus_pct : calcFocus(s);
    const absence = s.absence_total || 0;
    const drowsy  = s.drowsy_cnt || 0;
    const tags    = s._tags || [
      ...(absence >= 2 ? [`결석 ${absence}회`] : []),
      ...(focus < 60   ? [`집중도 ${focus}%`]  : []),
      ...(drowsy >= 3  ? [`졸음 ${drowsy}회`]  : []),
    ];
    const tagColors = { 'high':'#dc2626', 'medium':'#c2410c', 'low':'#92400e' };
    const tagBg     = { 'high':'#fee2e2', 'medium':'#ffedd5', 'low':'#fef9c3' };

    return `
    <div class="risk-row ${s._risk}">
      <div class="risk-dot" style="background:${cfg.bg};">${cfg.dot}</div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <div class="risk-name">${s.name || s.student_id}</div>
          <span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;background:${tagBg[s._risk]};color:${tagColors[s._risk]};">${cfg.label}</span>
        </div>
        <div class="risk-tags">
          ${tags.map(t=>`<span class="risk-tag" style="background:${tagBg[s._risk]};color:${tagColors[s._risk]};">${t}</span>`).join('')}
        </div>
      </div>
      <div class="risk-score-wrap">
        <div class="risk-score" style="color:${tagColors[s._risk]};">${Math.round(s._score)}</div>
        <div class="risk-score-label">위험 점수</div>
      </div>
      <button class="risk-action-btn ${s._risk}" onclick="if(typeof showToast==='function') showToast('${s.name||s.student_id} 학생 — ${cfg.btnTxt} 기록됨')">
        ${s._action || cfg.btnTxt}
      </button>
    </div>`;
  }).join('');
}

function exportCSV() {
  if(!currentSessions.length){showToast('내보낼 데이터가 없습니다.');return;}
  const rows=['날짜,과정명,강사,시작,종료,시간(분),학생수,평균집중도,경고횟수',
    ...currentSessions.map(s=>`${s.date||''},${s.course_name||''},${s.instructor||''},${s.started_at||''},${s.ended_at||''},${s.duration_min||0},${s.student_count||0},${s.avg_focus||0}%,${s.alert_count||0}`)
  ].join('\n');
  const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob(['\uFEFF'+rows],{type:'text/csv;charset=utf-8;'})),download:`sleep2wake_report_${selectedCourse||'전체'}.csv`});
  a.click();
}

// ── 초기화 ───────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const adminName=sessionStorage.getItem('userName')||'관리자';
  document.querySelectorAll('#admin-name, #profile-name-text').forEach(el=>{if(el) el.textContent=adminName;});

  document.querySelectorAll('#sidebar-nav .nav-item[data-tab]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const tab=btn.dataset.tab;
      document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      if(tab==='dashboard') document.getElementById('view-dashboard-list').classList.add('active');
      else { document.getElementById('view-'+tab)?.classList.add('active'); if(tab==='report') loadCourses(); }
    });
  });

  document.getElementById('nav-signout')?.addEventListener('click', doLogout);
  document.getElementById('btn-back-list')?.addEventListener('click', goBackToCourseList);

  const datePicker=document.getElementById('btn-date-picker');
  const dateInput=document.getElementById('detail-date-input');
  datePicker?.addEventListener('click',()=>{try{dateInput.showPicker();}catch(e){dateInput.click();}});
  dateInput?.addEventListener('change',(e)=>{if(e.target.value) loadSessionByDate(e.target.value);});

  document.getElementById('report-course-select')?.addEventListener('change',(e)=>loadSessions(e.target.value));
  document.getElementById('btn-open-pdf')?.addEventListener('click', openPdfPreview);

  document.getElementById('btn-pdf-prev')?.addEventListener('click',()=>{if(pdfPage>1){pdfPage--;updatePdfPage();}});
  document.getElementById('btn-pdf-next')?.addEventListener('click',()=>{if(pdfPage<2){pdfPage++;updatePdfPage();}});
  document.getElementById('btn-pdf-save')?.addEventListener('click', savePdf);
  document.getElementById('btn-pdf-close')?.addEventListener('click',()=>{document.getElementById('pdf-preview-modal').style.display='none';});
  document.getElementById('pdf-preview-modal')?.addEventListener('click',(e)=>{if(e.target.id==='pdf-preview-modal') e.target.style.display='none';});

  document.getElementById('btn-clear-cache')?.addEventListener('click',()=>{localStorage.clear();if(typeof showToast==='function') showToast('캐시가 초기화되었습니다.');});
  ['toggle-absent','toggle-drowsy','toggle-report','toggle-sound','toggle-autosave'].forEach(id=>{document.getElementById(id)?.addEventListener('click',function(){this.classList.toggle('on');});});
  document.getElementById('dark-mode-toggle')?.addEventListener('click',function(){toggleDarkMode(this);});
  document.getElementById('drowsy-range')?.addEventListener('input',(e)=>updateDrowsyLabel(e.target.value));
  document.getElementById('gaze-range')?.addEventListener('input',(e)=>updateGazeLabel(e.target.value));
  document.getElementById('absent-range')?.addEventListener('input',(e)=>{const el=document.getElementById('absent-val-label');if(el) el.textContent=`${e.target.value}초`;});
  document.getElementById('poll-interval-select')?.addEventListener('change',(e)=>{clearInterval(pollInterval);pollInterval=setInterval(pollActiveSessions,parseInt(e.target.value));if(typeof showToast==='function') showToast(`새로고침 주기: ${e.target.value/1000}초`);});

  document.getElementById('btn-edit-avatar')?.addEventListener('click',()=>document.getElementById('profile-img-input')?.click());
  document.getElementById('btn-profile-edit')?.addEventListener('click',()=>document.getElementById('profile-img-input')?.click());
  document.getElementById('profile-img-input')?.addEventListener('change',function(){onProfileImgChange(this);});

  if(localStorage.getItem('darkMode')==='1'){document.body.classList.add('dark-mode');document.getElementById('dark-mode-toggle')?.classList.add('on');}
  const savedImg=localStorage.getItem('profileImg');
  if(savedImg){const img=document.getElementById('profile-big-img');const hi=document.getElementById('header-avatar');if(img) img.src=savedImg;if(hi) hi.src=savedImg;}

  document.getElementById('btn-back-from-all-students')?.addEventListener('click', closeAllStudents);
  document.getElementById('btn-back-from-student-report')?.addEventListener('click',()=>{
    // 전체학생 뷰 거치지 않고 바로 대시보드 상세로
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    document.getElementById('view-dashboard-detail')?.classList.add('active');
  });

  const srDateBtn=document.getElementById('sr-date-btn');
  const srDateInput=document.getElementById('sr-date-input');
  if(srDateBtn&&srDateInput){
    srDateBtn.addEventListener('click',()=>srDateInput.showPicker?.() || srDateInput.click());
    srDateInput.addEventListener('change',(e)=>{
      const val=e.target.value;
      _srSelectedDate=val;
      const now=new Date();
      const todayStr=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
      document.getElementById('sr-date-label').textContent=val===todayStr?'오늘':val;
      if(_currentReportStudent) renderStudentReportBody(_currentReportStudent);
    });
  }

  document.getElementById('sr-pdf-btn')?.addEventListener('click', exportStudentPdf);
  document.getElementById('sr-pdf-save-btn')?.addEventListener('click', saveStudentPdf);
  document.getElementById('sr-pdf-close-btn')?.addEventListener('click',()=>{document.getElementById('sr-pdf-modal').style.display='none';});
  document.getElementById('sr-pdf-modal')?.addEventListener('click',(e)=>{if(e.target.id==='sr-pdf-modal') e.target.style.display='none';});

  connectWS();
  pollActiveSessions();
  pollInterval = setInterval(pollActiveSessions, 2000); // 2초 폴링
});

// ── 종합 리포트 PDF 미리보기 ─────────────────
let pdfPage=1;

function openPdfPreview() {
  const modal = document.getElementById('pdf-preview-modal');
  if (!modal) { console.warn('PDF 모달 없음'); return; }

  const courseName  = selectedCourse || '전체';
  const today       = new Date();
  const dateStr     = `${today.getFullYear()}. ${today.getMonth()+1}. ${today.getDate()}.`;
  const total       = currentSessions.length;
  const avgFocus    = total > 0 ? Math.round(currentSessions.reduce((a,s)=>a+(s.avg_focus||0),0)/total) : 0;
  const totalDrowsy = currentSessions.reduce((a,s)=>a+(s.drowsy_count||0),0);
  const totalStudents = currentSessions.reduce((a,s)=>a+(s.student_count||0),0);
  const totalAbsent   = currentSessions.reduce((a,s)=>a+(s.absent_count||0),0);
  const absentRate    = totalStudents > 0 ? Math.round(totalAbsent/totalStudents*100) : 0;

  // 오전/오후 집중도 (buildChartData 기반)
  const allData   = buildChartData();
  const amData    = allData.filter(d => parseInt(d.time) < 12);
  const pmData    = allData.filter(d => parseInt(d.time) >= 13);
  const amAvg     = amData.length ? Math.round(amData.reduce((a,b)=>a+b.focus,0)/amData.length) : 0;
  const pmAvg     = pmData.length ? Math.round(pmData.reduce((a,b)=>a+b.focus,0)/pmData.length) : 0;
  const amPmDiff  = pmAvg - amAvg;
  const fColor    = c => c >= 70 ? '#059669' : c >= 50 ? '#d97706' : '#dc2626';

  // 위험군 — USE_DUMMY_TREND=true면 더미, false면 실제 데이터 사용
  const riskDummy = USE_DUMMY_TREND ? [
    {name:'김OO', level:'🔴 고위험', tag:'잦은 결석+졸음', action:'즉시 상담', score:85},
    {name:'이OO', level:'🟠 주의',   tag:'집중도 하락 추세', action:'주의 관찰', score:55},
    {name:'최OO', level:'🟡 관찰',   tag:'졸음 반복',       action:'경과 확인', score:32},
  ] : (window._endedStudentsList || []).slice(0, 3).map(s => ({
    name:   s.name || s.student_id,
    level:  s.focus_pct < 50 ? '🔴 고위험' : s.focus_pct < 65 ? '🟠 주의' : '🟡 관찰',
    tag:    s.drowsy_cnt > 2 ? '졸음 반복' : s.absent_cnt > 1 ? '자리 이탈 빈발' : '집중도 하락',
    action: s.focus_pct < 50 ? '즉시 상담' : '주의 관찰',
    score:  Math.round((1 - s.focus_pct/100) * 100),
  }));

  // SVG 오전 차트 인라인 생성 (PDF용 소형)
  function makeMiniSvg(data, color) {
    if (!data.length) return '<svg viewBox="0 0 300 80"></svg>';
    const W=300,H=80,PX=20,PY=10;
    const n=data.length;
    const getX = i => PX + i*((W-PX*2)/Math.max(n-1,1));
    const getY = v => H - PY - (v/100)*(H-PY*2);
    let h='';
    [0,50,100].forEach(v=>{
      h+=`<line x1="${PX}" y1="${getY(v)}" x2="${W-PX}" y2="${getY(v)}" stroke="#f3f4f6" stroke-dasharray="2 2" stroke-width="1"/>`;
      h+=`<text x="${PX-2}" y="${getY(v)+3}" fill="#d1d5db" font-size="7" text-anchor="end" font-family="Pretendard,sans-serif">${v}%</text>`;
    });
    data.forEach((d,i)=>{
      h+=`<text x="${getX(i)}" y="${H-1}" fill="#c4c9d4" font-size="7" text-anchor="middle" font-family="Pretendard,sans-serif">${d.time}</text>`;
    });
    const lp=data.map((d,i)=>`${i===0?'M':'L'} ${getX(i)} ${getY(d.focus)}`).join(' ');
    const ap=`${lp} L ${getX(n-1)} ${H-PY} L ${getX(0)} ${H-PY} Z`;
    h+=`<defs><linearGradient id="mg" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity="0.2"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>`;
    h+=`<path d="${ap}" fill="url(#mg)"/>`;
    h+=`<path d="${lp}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    data.forEach((d,i)=>{ h+=`<circle cx="${getX(i)}" cy="${getY(d.focus)}" r="3" fill="#fff" stroke="${color}" stroke-width="1.5"/>`; });
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:100%;" preserveAspectRatio="none">${h}</svg>`;
  }

  // 기간별 추이 SVG
  function makeTrendSvg() {
    const labels = currentSessions.length >= 2
      ? [...currentSessions].sort((a,b)=>(a.date||'').localeCompare(b.date||'')).slice(-8).map((s,i)=>`${i+1}회`)
      : ['1주','2주','3주','4주','5주','6주','7주','8주'];
    const values = currentSessions.length >= 2
      ? [...currentSessions].sort((a,b)=>(a.date||'').localeCompare(b.date||'')).slice(-8).map(s=>s.avg_focus||0)
      : [82,78,71,65,70,75,73,77];
    const W=580,H=100,PX=24,PY=12;
    const n=labels.length;
    const getX = i => PX + i*((W-PX*2)/Math.max(n-1,1));
    const getY = v => H - PY - (v/100)*(H-PY*2);
    let h='';
    [0,50,100].forEach(v=>{
      h+=`<line x1="${PX}" y1="${getY(v)}" x2="${W-PX}" y2="${getY(v)}" stroke="#f3f4f6" stroke-dasharray="2 2" stroke-width="1"/>`;
      h+=`<text x="${PX-2}" y="${getY(v)+3}" fill="#d1d5db" font-size="7" text-anchor="end" font-family="Pretendard,sans-serif">${v}%</text>`;
    });
    labels.forEach((l,i)=>{
      h+=`<text x="${getX(i)}" y="${H-1}" fill="#c4c9d4" font-size="7" text-anchor="middle" font-family="Pretendard,sans-serif">${l}</text>`;
    });
    const lp=values.map((v,i)=>`${i===0?'M':'L'} ${getX(i)} ${getY(v)}`).join(' ');
    const ap=`${lp} L ${getX(n-1)} ${H-PY} L ${getX(0)} ${H-PY} Z`;
    h+=`<defs><linearGradient id="tg" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#6366f1" stop-opacity="0.15"/><stop offset="100%" stop-color="#6366f1" stop-opacity="0"/></linearGradient></defs>`;
    h+=`<path d="${ap}" fill="url(#tg)"/>`;
    h+=`<path d="${lp}" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    values.forEach((v,i)=>{ h+=`<circle cx="${getX(i)}" cy="${getY(v)}" r="3" fill="#fff" stroke="#6366f1" stroke-width="1.5"/>`; });
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:100%;" preserveAspectRatio="none">${h}</svg>`;
  }

  // ── 페이지 1 ──
  document.getElementById('pdf-content-1').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #FF7710;padding-bottom:16px;margin-bottom:20px;">
      <div>
        <div style="font-size:20px;font-weight:900;color:#111827;margin-bottom:4px;">교육 성취도 종합 리포트</div>
        <div style="font-size:13px;font-weight:600;color:#6b7280;">${courseName}</div>
      </div>
      <div style="text-align:right;">
        <div style="color:#FF7710;font-weight:800;font-size:14px;">🦁 LIKELION</div>
        <div style="font-size:10px;color:#9ca3af;margin-top:3px;">작성일: ${dateStr}</div>
      </div>
    </div>

    <!-- 1. 요약 지표 4개 -->
    <div style="margin-bottom:18px;">
      <div style="font-size:12px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:8px;margin-bottom:10px;">1. 기간 내 요약 지표</div>
      <div style="display:flex;gap:8px;">
        ${[['✅ 평균 출석률','#059669','93.7%'],['📊 평균 집중도','#FF7710',avgFocus+'%'],['😴 졸음 확정',totalDrowsy>5?'#dc2626':'#d97706',totalDrowsy+'건'],['🚶 자리 이탈률',absentRate>15?'#dc2626':'#d97706',absentRate+'%']].map(([l,c,v])=>`
        <div style="flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px;text-align:center;">
          <div style="font-size:9px;color:#6b7280;margin-bottom:4px;">${l}</div>
          <div style="font-size:20px;font-weight:800;color:${c};">${v}</div>
        </div>`).join('')}
      </div>
    </div>

    <!-- 2. 시간대별 집중도 오전/오후 -->
    <div style="margin-bottom:18px;">
      <div style="font-size:12px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:8px;margin-bottom:10px;">2. 시간대별 평균 집중도 (오전/오후)</div>
      <div style="display:flex;gap:10px;">
        <div style="flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px;">
          <div style="font-size:9px;font-weight:700;color:#2563eb;margin-bottom:6px;">☀️ 오전 평균: <strong>${amAvg}%</strong></div>
          <div style="height:80px;">${makeMiniSvg(amData,'#FF7710')}</div>
        </div>
        <div style="flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px;">
          <div style="font-size:9px;font-weight:700;color:#ea580c;margin-bottom:6px;">🌆 오후 평균: <strong>${pmAvg}%</strong> <span style="color:${amPmDiff>=0?'#059669':'#dc2626'}">(${amPmDiff>=0?'+':''}${amPmDiff}%p)</span></div>
          <div style="height:80px;">${makeMiniSvg(pmData,'#FF7710')}</div>
        </div>
      </div>
    </div>

    <!-- 3. 기간별 추이 -->
    <div style="margin-bottom:18px;">
      <div style="font-size:12px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:8px;margin-bottom:10px;">3. 부트캠프 기간별 집중도 추이</div>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px;height:110px;">
        ${makeTrendSvg()}
      </div>
    </div>

    <!-- 4. 수업 기록 요약 -->
    <div>
      <div style="font-size:12px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:8px;margin-bottom:10px;">4. 수업 기록 요약</div>
      ${currentSessions.length > 0 ? `
      <table style="width:100%;border-collapse:collapse;font-size:10px;">
        <thead><tr style="background:#f3f4f6;">
          <th style="padding:7px 10px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">날짜</th>
          <th style="padding:7px 10px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">강사</th>
          <th style="padding:7px 10px;text-align:center;font-weight:700;border-bottom:2px solid #e5e7eb;">학생수</th>
          <th style="padding:7px 10px;text-align:center;font-weight:700;border-bottom:2px solid #e5e7eb;">평균 집중도</th>
          <th style="padding:7px 10px;text-align:center;font-weight:700;border-bottom:2px solid #e5e7eb;">졸음 확정</th>
        </tr></thead>
        <tbody>
          ${currentSessions.slice(0,7).map(s=>`
          <tr>
            <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;">${s.date||'-'}</td>
            <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;">${s.instructor||'-'}</td>
            <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:center;">${s.student_count||0}명</td>
            <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:center;color:${fColor(s.avg_focus||0)};font-weight:700;">${s.avg_focus||0}%</td>
            <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:center;color:#ef4444;">${s.drowsy_count||0}건</td>
          </tr>`).join('')}
        </tbody>
      </table>` : '<div style="color:#9ca3af;text-align:center;padding:16px;font-size:11px;">수업 기록이 없습니다</div>'}
    </div>

    <div style="text-align:center;font-size:9px;color:#9ca3af;padding-top:16px;border-top:1px solid #e5e7eb;margin-top:20px;">
      본 리포트는 멋쟁이사자처럼 Sleep2Wake AI 수강생 태도 분석 시스템에 의해 자동으로 생성되었습니다. — 1 / 2 —
    </div>`;

  // ── 페이지 2 ──
  document.getElementById('pdf-content-2').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #FF7710;padding-bottom:14px;margin-bottom:20px;">
      <div style="font-size:13px;font-weight:700;color:#6b7280;">${courseName} — 종합 리포트 (계속)</div>
      <div style="color:#FF7710;font-weight:800;font-size:13px;">🦁 LIKELION</div>
    </div>

    <!-- 5. 수강 이탈 위험군 -->
    <div style="margin-bottom:22px;">
      <div style="font-size:12px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:8px;margin-bottom:6px;">5. 수강 이탈 위험군 <span style="font-size:9px;font-weight:600;color:#ef4444;background:#fee2e2;padding:2px 6px;border-radius:3px;margin-left:4px;">복합 지표 자동 감지</span></div>
      <div style="font-size:9px;color:#9ca3af;margin-bottom:10px;">결석률 + 집중도 하락 추세 복합 분석 기반 / 위험 점수 = 결석×20 + max(0, 70-집중도)×0.8 + 졸음×5</div>
      <table style="width:100%;border-collapse:collapse;font-size:11px;">
        <thead><tr style="background:#f3f4f6;">
          <th style="padding:8px 10px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">학생명</th>
          <th style="padding:8px 10px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">위험 등급</th>
          <th style="padding:8px 10px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">감지 항목</th>
          <th style="padding:8px 10px;text-align:center;font-weight:700;border-bottom:2px solid #e5e7eb;">위험 점수</th>
          <th style="padding:8px 10px;text-align:left;font-weight:700;border-bottom:2px solid #e5e7eb;">권장 조치</th>
        </tr></thead>
        <tbody>
          ${riskDummy.map(r=>`
          <tr>
            <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;font-weight:700;">${r.name}</td>
            <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;">${r.level}</td>
            <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;color:#6b7280;">${r.tag}</td>
            <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;text-align:center;font-weight:800;color:${r.score>70?'#dc2626':r.score>50?'#d97706':'#92400e'};">${r.score}점</td>
            <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;color:#6366f1;font-weight:700;">${r.action}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <!-- 6. 인사이트 -->
    <div style="margin-bottom:22px;">
      <div style="font-size:12px;font-weight:700;color:#111827;border-left:4px solid #FF7710;padding-left:8px;margin-bottom:12px;">6. 운영 인사이트</div>
      <div style="display:flex;gap:10px;margin-bottom:10px;">
        <div style="flex:1;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px;">
          <div style="font-size:10px;font-weight:700;color:#1d4ed8;margin-bottom:4px;">☀️ 오전 평균 집중도</div>
          <div style="font-size:18px;font-weight:900;color:#1d4ed8;">${amAvg}%</div>
        </div>
        <div style="flex:1;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:12px;">
          <div style="font-size:10px;font-weight:700;color:#c2410c;margin-bottom:4px;">🌆 오후 평균 집중도</div>
          <div style="font-size:18px;font-weight:900;color:#c2410c;">${pmAvg}%</div>
        </div>
        <div style="flex:1;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:8px;padding:12px;">
          <div style="font-size:10px;font-weight:700;color:#374151;margin-bottom:4px;">오전→오후 변화</div>
          <div style="font-size:18px;font-weight:900;color:${amPmDiff>=0?'#059669':'#dc2626'};">${amPmDiff>=0?'+':''}${amPmDiff}%p</div>
        </div>
      </div>
      ${amPmDiff <= -10 ? `
      <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:12px;margin-bottom:8px;">
        <div style="font-weight:700;color:#c2410c;margin-bottom:3px;font-size:11px;">⚠️ 오후 집중도 저하 주의</div>
        <div style="font-size:10px;color:#6b7280;">오후 평균 집중도가 오전 대비 ${Math.abs(amPmDiff)}%p 낮습니다. 오후 실습 위주 커리큘럼 또는 짧은 브레이크를 권장합니다.</div>
      </div>` : `
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px;margin-bottom:8px;">
        <div style="font-weight:700;color:#059669;margin-bottom:3px;font-size:11px;">✅ 오전/오후 집중도 안정적</div>
        <div style="font-size:10px;color:#6b7280;">오전과 오후의 집중도 차이가 크지 않아 전반적으로 안정적인 수업 운영 상태입니다.</div>
      </div>`}
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px;">
        <div style="font-weight:700;color:#059669;margin-bottom:3px;font-size:11px;">✅ 안정적인 출석 유지율</div>
        <div style="font-size:10px;color:#6b7280;">과정 초반 대비 출석률 저하가 발생하지 않았습니다. 우수한 관리 상태입니다.</div>
      </div>
    </div>

    <div style="text-align:center;font-size:9px;color:#9ca3af;padding-top:16px;border-top:1px solid #e5e7eb;margin-top:20px;">
      본 리포트는 멋쟁이사자처럼 Sleep2Wake AI 수강생 태도 분석 시스템에 의해 자동으로 생성되었습니다. — 2 / 2 —
    </div>`;

  pdfPage = 1;
  updatePdfPage();
  modal.style.display = 'flex';
}

function updatePdfPage() {
  document.getElementById('pdf-page-1').style.display=pdfPage===1?'block':'none';
  document.getElementById('pdf-page-2').style.display=pdfPage===2?'block':'none';
  document.getElementById('pdf-page-indicator').textContent=`${pdfPage} / 2`;
  const prev=document.getElementById('btn-pdf-prev'), next=document.getElementById('btn-pdf-next');
  if(prev) prev.disabled=pdfPage===1;
  if(next) next.disabled=pdfPage===2;
}

async function savePdf() {
  const btn=document.getElementById('btn-pdf-save');
  if(btn){btn.textContent='저장 중...';btn.disabled=true;}
  try {
    if(!window.jspdf){await new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';s.onload=res;s.onerror=rej;document.head.appendChild(s);});}
    if(!window.html2canvas){await new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';s.onload=res;s.onerror=rej;document.head.appendChild(s);});}
    const {jsPDF}=window.jspdf;
    const pdf=new jsPDF({orientation:'portrait',unit:'mm',format:'a4'});
    document.getElementById('pdf-page-1').style.display='block';
    document.getElementById('pdf-page-2').style.display='none';
    const c1=await html2canvas(document.getElementById('pdf-page-1'),{scale:2,useCORS:true,backgroundColor:'#fff'});
    pdf.addImage(c1.toDataURL('image/jpeg',0.95),'JPEG',0,0,210,297);
    pdf.addPage();
    document.getElementById('pdf-page-1').style.display='none';
    document.getElementById('pdf-page-2').style.display='block';
    const c2=await html2canvas(document.getElementById('pdf-page-2'),{scale:2,useCORS:true,backgroundColor:'#fff'});
    pdf.addImage(c2.toDataURL('image/jpeg',0.95),'JPEG',0,0,210,297);
    pdf.save(`Sleep2Wake_${selectedCourse||'리포트'}.pdf`);
  } catch(e){
    console.error('PDF 저장 실패:',e);
    if(typeof showToast==='function') showToast('PDF 저장 실패. 다시 시도해주세요.');
  } finally {
    updatePdfPage();
    if(btn){btn.textContent='💾 PDF 저장';btn.disabled=false;}
  }
}

window.addEventListener('beforeunload',()=>{clearInterval(pollInterval);ws?.close();});

function updateDrowsyLabel(val) {
  const el=document.getElementById('drowsy-val-label');
  if(!el) return;
  const labels={'1':'여유 (Loose)','2':'보통 (Standard)','3':'엄격 (Strict)'};
  el.textContent=labels[val]||'보통 (Standard)';
}

function updateGazeLabel(val) {
  const el=document.getElementById('gaze-val-label');
  if(!el) return;
  el.textContent=`${val}초`;
}

function toggleDarkMode(btn) {
  btn.classList.toggle('on');
  document.body.classList.toggle('dark-mode');
  localStorage.setItem('darkMode',document.body.classList.contains('dark-mode')?'1':'0');
}

function onProfileImgChange(input) {
  if(!input.files||!input.files[0]) return;
  const reader=new FileReader();
  reader.onload=(e)=>{
    const img=document.getElementById('profile-big-img');
    const headerImg=document.querySelector('.profile-avatar');
    if(img) img.src=e.target.result;
    if(headerImg) headerImg.src=e.target.result;
    localStorage.setItem('profileImg',e.target.result);
  };
  reader.readAsDataURL(input.files[0]);
}