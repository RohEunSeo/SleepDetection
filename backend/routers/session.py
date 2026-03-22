# =============================================
# routers/session.py — 세션 조회 / 종료 / CSV API
# =============================================

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
import io

from session_store import store

router = APIRouter(prefix="/api", tags=["session"])


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


@router.get("/sessions")
async def list_sessions():
    """
    전체 세션 목록 조회 (리포트 탭용)
    GET /api/sessions
    """
    return [s.summary() for s in store.get_all()]


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