# =============================================
# routers/room.py — 방 생성 / 토큰 발급 API
# =============================================

from fastapi import APIRouter, HTTPException
from config import DAILY_API_KEY
from daily_service import generate_room_code, ensure_room, create_meeting_token
from session_store import store

router = APIRouter(prefix="/api", tags=["room"])


@router.post("/create-room")
async def create_room(
    instructor_name: str = "강사",
    course_name:     str = "",
):
    """
    강사 전용 — 새 방 코드 생성 + Daily.co 방 개설
    POST /api/create-room?instructor_name=노은서&course_name=AI엔지니어링과정
    """
    if not DAILY_API_KEY:
        raise HTTPException(status_code=500, detail="DAILY_API_KEY 미설정")

    from datetime import datetime
    from session_store import supabase as _supa

    today = datetime.now().strftime("%Y-%m-%d")

    # ── 1. 오늘 날짜 + 같은 과정명 세션 있으면 재사용 (종료됐어도) ──
    if course_name:
        try:
            res = _supa.table("sessions").select("room_code, session_id") \
                .eq("course_name", course_name) \
                .eq("date", today) \
                .order("started_at", desc=False) \
                .limit(1) \
                .execute()
            if res.data:
                room_code  = res.data[0]["room_code"]
                session_id = res.data[0]["session_id"]
                print(f"[Room] 기존 세션 재사용: {room_code} / 과정: {course_name}")
                # 세션 재활성화 (수업 종료 후 다시 입장해도 같은 코드 유지)
                _supa.table("sessions").update({
                    "is_active":  True,
                    "ended_at":   None,
                    "instructor": instructor_name,
                }).eq("room_code", room_code).eq("date", today).execute()
                room  = await ensure_room(room_code)
                token = await create_meeting_token(
                    user_name=instructor_name,
                    room_code=room_code,
                    is_owner=True,
                )
                return {
                    "room_code":  room_code,
                    "room_url":   room.get("url", ""),
                    "token":      token,
                    "session_id": session_id,
                }
        except Exception as e:
            print(f"[Room] 기존 세션 조회 실패, 새로 생성: {e}")

    # ── 2. 없으면 랜덤 코드로 새 세션 생성 ──
    room_code = generate_room_code()
    room      = await ensure_room(room_code)
    token     = await create_meeting_token(
        user_name=instructor_name,
        room_code=room_code,
        is_owner=True,
    )
    session = store.create(
        room_code   = room_code,
        instructor  = instructor_name,
        course_name = course_name,
    )
    return {
        "room_code":  room_code,
        "room_url":   room.get("url", ""),
        "token":      token,
        "session_id": session.session_id,
    }


@router.get("/room-token")
async def get_room_token(
    user_name: str,
    room_code: str = "LION-2025",
    role:      str = "student",
):
    """
    학생/강사 입장 토큰 발급
    GET /api/room-token?user_name=노은서&room_code=LION-2025&role=student
    """
    if not DAILY_API_KEY:
        raise HTTPException(status_code=500, detail="DAILY_API_KEY 미설정")

    room  = await ensure_room(room_code)
    token = await create_meeting_token(
        user_name=user_name,
        room_code=room_code,
        is_owner=(role == "instructor"),
    )

    return {
        "token":     token,
        "room_code": room_code,
        "room_url":  room.get("url", ""),
    }