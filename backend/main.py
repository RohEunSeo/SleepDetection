import json

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from caption_manager import caption_manager
from config import ALLOWED_ORIGINS
from routers import room, session
from session_store import store
from ws_manager import manager

app = FastAPI(title="Sleep2Wake API", version="1.0.0")
DEFAULT_CAPTION_CHANNEL = "GLOBAL"

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(room.router)
app.include_router(session.router)


@app.get("/")
def root():
    return {"service": "Sleep2Wake", "status": "running"}


@app.websocket("/ws/student/{student_id}")
async def student_ws(websocket: WebSocket, student_id: str, room_code: str = "LION-2025"):
    await manager.connect_student(websocket, student_id)
    try:
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)

            manager.update_state(student_id, data)
            store.add_event(room_code, data)

            await manager.broadcast_to_admins(
                {
                    "type": "student_update",
                    "data": data,
                }
            )
    except WebSocketDisconnect:
        manager.disconnect_student(student_id)
        await manager.broadcast_to_admins(
            {
                "type": "student_left",
                "student_id": student_id,
            }
        )


@app.websocket("/ws/admin")
async def admin_ws(websocket: WebSocket):
    await manager.connect_admin(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect_admin(websocket)


@app.websocket("/ws/caption-view/{room_code}")
async def caption_view_ws(websocket: WebSocket, room_code: str):
    # 학생/강사 화면은 이 viewer 채널을 통해 자막을 실시간으로 받는다.
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


@app.websocket("/ws/caption-text")
async def caption_text_default_ws(websocket: WebSocket, speaker: str = "강사"):
    # Web Speech API가 인식한 텍스트를 받아 강사/학생 화면에 그대로 중계한다.
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
