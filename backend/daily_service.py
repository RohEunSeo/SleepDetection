# =============================================
# daily_service.py — Daily.co API 관련 함수
# =============================================

import random
import string
from datetime import datetime

import httpx
from fastapi import HTTPException

from config import (
    DAILY_API_KEY,
    DAILY_BASE_URL,
    ROOM_MAX_PARTICIPANTS,
    ROOM_TOKEN_EXPIRE_SEC,
)


def generate_room_code() -> str:
    """LION-XXXX 형식 방 코드 생성"""
    suffix = "".join(random.choices(string.ascii_uppercase + string.digits, k=4))
    return f"LION-{suffix}"


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {DAILY_API_KEY}",
        "Content-Type": "application/json",
    }


async def ensure_room(room_code: str) -> dict:
    """
    방이 없으면 생성, 있으면 그대로 반환
    - 모든 참여자 영상/음성 송출 가능
    - 화면 공유는 강사(owner)만 가능
    """
    room_name = room_code.lower()

    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{DAILY_BASE_URL}/rooms/{room_name}",
            headers=_headers()
        )
        if r.status_code == 200:
            return r.json()

        r = await client.post(
            f"{DAILY_BASE_URL}/rooms",
            headers=_headers(),
            json={
                "name": room_name,
                "properties": {
                    "max_participants":     ROOM_MAX_PARTICIPANTS,
                    "enable_chat":          True,
                    "enable_screenshare":   True,
                    "owner_only_broadcast": False,  # [수정] 학생도 영상/음성 송출 가능
                    "start_video_off":      False,
                    "start_audio_off":      True,   # 마이크는 기본 꺼짐 (졸음 감지 서비스 특성상)
                },
            },
        )
        if r.status_code not in (200, 201):
            raise HTTPException(status_code=500, detail=f"방 생성 실패: {r.text}")
        return r.json()


async def create_meeting_token(
    user_name: str,
    room_code: str,
    is_owner: bool = False,
) -> str:
    """
    Daily.co 입장 토큰 발급
    - is_owner=True (강사): 화면 공유 가능
    - is_owner=False (학생): 영상 송출 가능, 화면 공유 불가
    """
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{DAILY_BASE_URL}/meeting-tokens",
            headers=_headers(),
            json={
                "properties": {
                    "room_name":          room_code.lower(),
                    "user_name":          user_name,
                    "is_owner":           is_owner,
                    "enable_screenshare": is_owner,  # 강사만 화면 공유 허용
                    "exp": int(datetime.now().timestamp()) + ROOM_TOKEN_EXPIRE_SEC,
                }
            },
        )
        if r.status_code != 200:
            raise HTTPException(status_code=500, detail=f"토큰 발급 실패: {r.text}")
        return r.json()["token"]