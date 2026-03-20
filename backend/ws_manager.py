# =============================================
# ws_manager.py — WebSocket 연결 관리
# =============================================

import json
from fastapi import WebSocket


class ConnectionManager:
    def __init__(self):
        # 학생 연결: { student_id: WebSocket }
        self.students: dict[str, WebSocket] = {}
        # 관리자/강사 연결 목록
        self.admins: list[WebSocket] = []
        # 학생 상태 캐시 (신규 admin 접속 시 현재 상태 즉시 전송)
        self.state: dict[str, dict] = {}

    # ── 연결 ────────────────────────────────
    async def connect_student(self, ws: WebSocket, student_id: str):
        await ws.accept()
        self.students[student_id] = ws

    async def connect_admin(self, ws: WebSocket):
        await ws.accept()
        self.admins.append(ws)
        # 현재 전체 상태 즉시 전송
        if self.state:
            await self._send(ws, {"type": "full_state", "data": self.state})

    # ── 연결 해제 ────────────────────────────
    def disconnect_student(self, student_id: str):
        self.students.pop(student_id, None)
        self.state.pop(student_id, None)

    def disconnect_admin(self, ws: WebSocket):
        if ws in self.admins:
            self.admins.remove(ws)

    # ── 상태 업데이트 ────────────────────────
    def update_state(self, student_id: str, data: dict):
        self.state[student_id] = data

    # ── broadcast ────────────────────────────
    async def broadcast_to_admins(self, message: dict):
        """모든 admin/강사에게 메시지 broadcast"""
        if not self.admins:
            return
        dead = []
        for ws in self.admins:
            try:
                await self._send(ws, message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.admins.remove(ws)

    # ── 내부 헬퍼 ───────────────────────────
    @staticmethod
    async def _send(ws: WebSocket, message: dict):
        await ws.send_text(json.dumps(message, ensure_ascii=False))


# 싱글톤 인스턴스
manager = ConnectionManager()