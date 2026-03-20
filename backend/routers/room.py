# =============================================
# routers/room.py — 방 생성 / 토큰 발급 API
# =============================================

from fastapi import APIRouter, HTTPException
from config import DAILY_API_KEY
from daily_service import generate_room_code, ensure_room, create_meeting_token
from session_store import store

router = APIRouter(prefix="/api", tags=["room"])


@router.post("/create-room")
async def create_room(instructor_name: str = "강사"):
    """
    강사 전용 — 새 방 코드 생성 + Daily.co 방 개설
    POST /api/create-room?instructor_name=김강사
    """
    if not DAILY_API_KEY:
        raise HTTPException(status_code=500, detail="DAILY_API_KEY 미설정")

    room_code = generate_room_code()
    room      = await ensure_room(room_code)
    token     = await create_meeting_token(
        user_name=instructor_name,
        room_code=room_code,
        is_owner=True,
    )

    # 세션 자동 시작
    session = store.create(room_code=room_code, instructor=instructor_name)

    return {
        "room_code":  room_code,
        "room_url":   room.get("url", ""),
        "token":      token,
        "session_id": session.session_id,
    }


@router.get("/room-token")
async def get_room_token(
    user_name:  str,
    room_code:  str = "LION-2025",
    role:       str = "student",
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