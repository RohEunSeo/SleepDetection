# =============================================
# routers/session.py — 세션 조회 / 종료 / CSV API
# =============================================

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
import io

from session_store import store

router = APIRouter(prefix="/api", tags=["session"])


@router.get("/courses")
async def list_courses():
    """
    등록된 과정명 목록 조회 (관리자 드롭다운용)
    GET /api/courses
    """
    return store.get_courses()


@router.post("/session/end")
async def end_session(room_code: str):
    """
    수업 종료 — 활성 세션 마감
    POST /api/session/end?room_code=LION-2025
    """
    session = store.get_active(room_code)
    if not session:
        raise HTTPException(status_code=404, detail="진행 중인 세션 없음")
    session.end()
    return {"session_id": session.session_id, "summary": session.summary()}


# ★ /sessions/active 가 /sessions/{session_id} 보다 반드시 위에 있어야 함
@router.get("/sessions/active")
async def list_active_sessions():
    """
    현재 진행 중인 세션 목록 (관리자 대시보드 실시간용)
    GET /api/sessions/active
    """
    return store.get_active_sessions()


@router.get("/sessions")
async def list_sessions(course_name: str | None = None, date: str | None = None):
    """
    세션 목록 조회
    GET /api/sessions                          → 전체
    GET /api/sessions?course_name=AI엔지니어링 → 과정별 필터
    GET /api/sessions?date=2026-03-30          → 날짜별 필터 (관리자 대시보드용)
    """
    return store.get_all(course_name=course_name, date=date)


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """
    세션 삭제 (관리자 대시보드 카드 삭제용)
    DELETE /api/sessions/{session_id}
    """
    try:
        from session_store import supabase
        supabase.table("student_events").delete().eq("session_id", session_id).execute()
        supabase.table("sessions").delete().eq("session_id", session_id).execute()
        return {"status": "deleted", "session_id": session_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sessions/{session_id}")
async def get_session(session_id: str):
    """특정 세션 상세 조회"""
    session = store.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="세션 없음")
    return session.summary()


@router.get("/sessions/{session_id}/csv")
async def download_csv(session_id: str):
    """
    특정 세션 CSV 다운로드
    GET /api/sessions/{session_id}/csv
    """
    session = store.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="세션 없음")

    csv_content = session.to_csv()
    filename    = f"sleep2wake_{session.room_code}_{session.started_at.strftime('%Y%m%d')}.csv"

    return StreamingResponse(
        io.StringIO(csv_content),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )