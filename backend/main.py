# =============================================
# main.py — Sleep2Wake 백엔드 진입점
# FastAPI 앱 생성 + 라우터 연결 + WebSocket
# =============================================

import json
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from config import ALLOWED_ORIGINS
from ws_manager import manager
from session_store import store
from routers import room, session

app = FastAPI(title="Sleep2Wake API", version="1.0.0")

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