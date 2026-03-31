# =============================================
# routers/session.py — 세션 조회 / 종료 API
# =============================================

from fastapi import APIRouter, HTTPException
from session_store import store, supabase

router = APIRouter(prefix="/api", tags=["session"])


@router.get("/courses")
async def list_courses():
    """과정명 목록 조회 (관리자 드롭다운용)"""
    return store.get_courses()


@router.post("/session/end")
async def end_session(room_code: str):
    """수업 종료 — 활성 세션 마감 + Supabase 저장"""
    session = store.get_active(room_code)
    if not session:
        raise HTTPException(status_code=404, detail="진행 중인 세션 없음")
    summary = session.summary()
    store.end_session(room_code)
    return {"status": "ended", "room_code": room_code, "summary": summary}


# ★ /sessions/active 가 /sessions/{session_id} 보다 반드시 위에 있어야 함
@router.get("/sessions/active")
async def list_active_sessions():
    """진행 중인 세션 목록 (관리자 실시간용)"""
    return store.get_active_sessions()


@router.get("/sessions")
async def list_sessions(course_name: str | None = None, date: str | None = None):
    """세션 목록 조회 — 전체 / 과정별 / 날짜별 필터"""
    return store.get_all(course_name=course_name, date=date)


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """세션 삭제 (관리자 카드 삭제용)"""
    try:
        supabase.table("student_events").delete().eq("session_id", session_id).execute()
        supabase.table("sessions").delete().eq("session_id", session_id).execute()
        return {"status": "deleted", "session_id": session_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sessions/{session_id}/students")
async def get_session_students(session_id: str):
    """
    세션별 학생 집계 데이터 조회 (개별 리포트용)
    ⑬ 졸음 75건 버그 수정: drowsy_cnt 누적값 → 상태 전환 횟수 기반으로 계산
    ㉑ 하품=졸음확정 버그 수정: yawn은 별도 집계
    """
    try:
        events = supabase.table("student_events") \
            .select("*").eq("session_id", session_id) \
            .order("timestamp", desc=False) \
            .execute().data or []

        students: dict = {}
        for e in events:
            sid = e.get("student_id", "")
            if not sid:
                continue
            s = students.setdefault(sid, {
                "student_id":     sid,
                "name":           e.get("name", sid),
                "drowsy_cnt":     0,
                "yawn_cnt":       0,
                "head_cnt":       0,
                "absent_cnt":     0,
                "distracted_cnt": 0,
                "warning_cnt":    0,
                "total_events":   0,
                # 내부 추적용
                "_prev_status":   None,
                "_max_yawn":      0,
                "_max_head":      0,
            })
            s["total_events"] += 1
            st = e.get("status", "")

            # 상태 전환 횟수 기반 카운트 (이전 상태와 다를 때만 카운트)
            if st != s["_prev_status"]:
                if st == "drowsy":     s["drowsy_cnt"]     += 1
                if st == "absent":     s["absent_cnt"]     += 1
                if st == "distracted": s["distracted_cnt"] += 1
                if st == "warning":    s["warning_cnt"]    += 1
            s["_prev_status"] = st

            # yawn/head는 누적값의 최대치만 사용 (중복 합산 방지)
            raw_yawn = e.get("yawn_cnt", 0)
            raw_head = e.get("head_cnt", 0)
            if raw_yawn > s["_max_yawn"]:
                s["yawn_cnt"]  = raw_yawn
                s["_max_yawn"] = raw_yawn
            if raw_head > s["_max_head"]:
                s["head_cnt"]  = raw_head
                s["_max_head"] = raw_head

        result = []
        for s in students.values():
            # 내부 추적 키 제거
            for k in ["_prev_status", "_max_yawn", "_max_head"]:
                s.pop(k, None)
            # 집중도 계산
            penalty = (s["drowsy_cnt"]*10 + s["absent_cnt"]*15 +
                       s["warning_cnt"]*5  + s["yawn_cnt"]*3 +
                       s["head_cnt"]*3)
            s["focus_pct"] = max(0, 100 - penalty)
            result.append(s)

        return sorted(result, key=lambda x: x["focus_pct"])

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sessions/{session_id}")
async def get_session(session_id: str):
    """특정 세션 상세 조회"""
    session = store.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="세션 없음")
    return session.summary()