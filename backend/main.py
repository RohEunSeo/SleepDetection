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


# [수정] 수업 종료 엔드포인트 — 모든 학생에게 room_closed 신호 broadcast
@app.post("/api/room/close")
async def close_room(room_code: str = "LION-2025"):
    await manager.broadcast_to_students(
        {
            "type": "room_closed",
            "room_code": room_code,
        }
    )
    store.end_session(room_code)
    return {"status": "closed", "room_code": room_code}


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


@app.websocket("/ws/caption-text")
async def caption_text_default_ws(websocket: WebSocket, speaker: str = "강사", room_code: str = "GLOBAL"):
    await websocket.accept()
    channel = room_code if room_code != "GLOBAL" else DEFAULT_CAPTION_CHANNEL
    try:
        while True:
            raw = await websocket.receive_text()
            payload = json.loads(raw)
            text = str(payload.get("text", "")).strip()
            if not text:
                continue

            await caption_manager.broadcast(
                channel,
                {
                    "type": "caption",
                    "room_code": channel,
                    "speaker": payload.get("speaker") or speaker,
                    "text": text,
                    "final": bool(payload.get("final", False)),
                },
            )
    except (WebSocketDisconnect, RuntimeError):
        return