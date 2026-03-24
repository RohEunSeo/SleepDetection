import json
import time
from collections import defaultdict

from fastapi import WebSocket


class CaptionManager:
    def __init__(self):
        # room_code 별로 자막 시청자를 관리한다.
        self.viewers: dict[str, list[WebSocket]] = defaultdict(list)
        self.latest: dict[str, dict] = {}
        self._recent_text: dict[str, tuple[str, float]] = {}

    async def connect_viewer(self, room_code: str, websocket: WebSocket):
        await websocket.accept()
        self.viewers[room_code].append(websocket)
        latest = self.latest.get(room_code)
        if latest:
            await self._send(websocket, latest)

    def disconnect_viewer(self, room_code: str, websocket: WebSocket):
        viewers = self.viewers.get(room_code, [])
        if websocket in viewers:
            viewers.remove(websocket)
        if not viewers and room_code in self.viewers:
            self.viewers.pop(room_code, None)

    async def broadcast(self, room_code: str, payload: dict):
        # 같은 문장이 너무 빠르게 반복 전송되면 화면이 지저분해져서 짧게 중복을 막는다.
        text = str(payload.get("text", "")).strip()
        if text:
            prev_text, prev_at = self._recent_text.get(room_code, ("", 0.0))
            now = time.time()
            if text == prev_text and now - prev_at < 2.0:
                return
            self._recent_text[room_code] = (text, now)

        self.latest[room_code] = payload
        viewers = self.viewers.get(room_code, [])
        if not viewers:
            return

        dead = []
        for websocket in viewers:
            try:
                await self._send(websocket, payload)
            except Exception:
                dead.append(websocket)

        for websocket in dead:
            self.disconnect_viewer(room_code, websocket)

    @staticmethod
    async def _send(websocket: WebSocket, payload: dict):
        await websocket.send_text(json.dumps(payload, ensure_ascii=False))


caption_manager = CaptionManager()
