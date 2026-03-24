# =============================================
# main.py — Sleep2Wake 백엔드 진입점
# FastAPI 앱 생성 + 라우터 연결 + WebSocket
# =============================================

import asyncio
import json
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from caption_manager import caption_manager
from config import ALLOWED_ORIGINS
from stt_service import stt_service
from ws_manager import manager
from session_store import store
from routers import room, session

app = FastAPI(title="Sleep2Wake API", version="1.0.0")
DEFAULT_CAPTION_CHANNEL = "GLOBAL"

# ── CORS ────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── 라우터 연결 ──────────────────────────────
app.include_router(room.router)
app.include_router(session.router)


# ── 헬스체크 ─────────────────────────────────
@app.get("/")
def root():
    return {"service": "Sleep2Wake", "status": "running"}


# ══════════════════════════════════════════════
# WebSocket — 학생 감지 데이터 수신
# ══════════════════════════════════════════════

@app.websocket("/ws/student/{student_id}")
async def student_ws(websocket: WebSocket, student_id: str, room_code: str = "LION-2025"):
    """
    학생 브라우저 → 서버
    감지 이벤트 수신 → 상태 캐시 + admin broadcast + 세션 저장
    """
    await manager.connect_student(websocket, student_id)
    try:
        while True:
            raw  = await websocket.receive_text()
            data = json.loads(raw)

            # 상태 캐시 업데이트
            manager.update_state(student_id, data)

            # 세션에 이벤트 저장
            store.add_event(room_code, data)

            # admin 전체에 broadcast
            await manager.broadcast_to_admins({
                "type": "student_update",
                "data": data,
            })

    except WebSocketDisconnect:
        manager.disconnect_student(student_id)
        await manager.broadcast_to_admins({
            "type": "student_left",
            "student_id": student_id,
        })


# ══════════════════════════════════════════════
# WebSocket — 관리자/강사 수신
# ══════════════════════════════════════════════

@app.websocket("/ws/admin")
async def admin_ws(websocket: WebSocket):
    """
    서버 → 관리자/강사 브라우저
    학생 상태 실시간 수신 (admin은 데이터 전송 없음)
    """
    await manager.connect_admin(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect_admin(websocket)


@app.websocket("/ws/caption-view/{room_code}")
async def caption_view_ws(websocket: WebSocket, room_code: str):
    await caption_manager.connect_viewer(room_code, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        caption_manager.disconnect_viewer(room_code, websocket)


@app.websocket("/ws/caption-view")
async def caption_view_default_ws(websocket: WebSocket):
    await caption_manager.connect_viewer(DEFAULT_CAPTION_CHANNEL, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        caption_manager.disconnect_viewer(DEFAULT_CAPTION_CHANNEL, websocket)


@app.websocket("/ws/caption-stream/{room_code}")
async def caption_stream_ws(
    websocket: WebSocket,
    room_code: str,
    speaker: str = "강사",
    ext: str = "webm",
):
    await websocket.accept()
    try:
        while True:
            message = await websocket.receive()
            audio_bytes = message.get("bytes")
            if not audio_bytes:
                continue

            suffix = f".{ext.lstrip('.')}" if ext else ".webm"
            text = await asyncio.to_thread(stt_service.transcribe_bytes, audio_bytes, suffix)
            if not text:
                continue

            await caption_manager.broadcast(
                room_code,
                {
                    "type": "caption",
                    "room_code": room_code,
                    "speaker": speaker,
                    "text": text,
                },
            )
    except (WebSocketDisconnect, RuntimeError):
        return


@app.websocket("/ws/caption-stream")
async def caption_stream_default_ws(
    websocket: WebSocket,
    speaker: str = "강사",
    ext: str = "webm",
):
    await websocket.accept()
    try:
        while True:
            message = await websocket.receive()
            audio_bytes = message.get("bytes")
            if not audio_bytes:
                continue

            suffix = f".{ext.lstrip('.')}" if ext else ".webm"
            text = await asyncio.to_thread(stt_service.transcribe_bytes, audio_bytes, suffix)
            if not text:
                continue

            await caption_manager.broadcast(
                DEFAULT_CAPTION_CHANNEL,
                {
                    "type": "caption",
                    "room_code": DEFAULT_CAPTION_CHANNEL,
                    "speaker": speaker,
                    "text": text,
                },
            )
    except (WebSocketDisconnect, RuntimeError):
        return


@app.websocket("/ws/caption-text")
async def caption_text_default_ws(
    websocket: WebSocket,
    speaker: str = "강사",
):
    await websocket.accept()
    try:
        while True:
            raw = await websocket.receive_text()
            payload = json.loads(raw)
            text = str(payload.get("text", "")).strip()
            if not text:
                continue

            await caption_manager.broadcast(
                DEFAULT_CAPTION_CHANNEL,
                {
                    "type": "caption",
                    "room_code": DEFAULT_CAPTION_CHANNEL,
                    "speaker": payload.get("speaker") or speaker,
                    "text": text,
                    "final": bool(payload.get("final", False)),
                },
            )
    except (WebSocketDisconnect, RuntimeError):
        return
