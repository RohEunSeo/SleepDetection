# =============================================
# session_store.py — 수업 세션 및 감지 이벤트 저장
# 메모리 기반 (서버 재시작 시 초기화)
# =============================================

from dataclasses import dataclass, field
from datetime import datetime
import csv
import io


@dataclass
class DetectionEvent:
    """학생 1회 감지 이벤트"""
    student_id:  str
    name:        str
    status:      str        # focused / warning / drowsy / absent
    ear:         float | None
    drowsy_cnt:  int
    yawn_cnt:    int
    head_cnt:    int
    timestamp:   int        # epoch ms


@dataclass
class Session:
    """수업 1개 세션"""
    session_id:   str
    room_code:    str
    instructor:   str
    started_at:   datetime = field(default_factory=datetime.now)
    ended_at:     datetime | None = None
    events:       list[DetectionEvent] = field(default_factory=list)

    def is_active(self) -> bool:
        return self.ended_at is None

    def end(self):
        self.ended_at = datetime.now()

    def add_event(self, event: DetectionEvent):
        self.events.append(event)

    def summary(self) -> dict:
        """세션 요약 통계"""
        if not self.events:
            return {}
        students = {}
        for e in self.events:
            if e.student_id not in students:
                students[e.student_id] = {"name": e.name, "drowsy": 0, "yawn": 0, "head": 0, "absent": 0}
            if e.status == "drowsy":  students[e.student_id]["drowsy"] += 1
            if e.status == "absent":  students[e.student_id]["absent"] += 1
            if e.yawn_cnt > 0:        students[e.student_id]["yawn"]   += 1

        total    = len(students)
        duration = (self.ended_at or datetime.now()) - self.started_at

        return {
            "session_id":  self.session_id,
            "room_code":   self.room_code,
            "instructor":  self.instructor,
            "started_at":  self.started_at.isoformat(),
            "ended_at":    self.ended_at.isoformat() if self.ended_at else None,
            "duration_min": round(duration.total_seconds() / 60, 1),
            "total_students": total,
            "students": students,
        }

    def to_csv(self) -> str:
        """CSV 문자열로 변환"""
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow([
            "학생ID", "이름", "상태", "EAR", "졸음횟수", "하품횟수", "고개떨굼횟수", "타임스탬프"
        ])
        for e in self.events:
            writer.writerow([
                e.student_id, e.name, e.status,
                round(e.ear, 3) if e.ear else "",
                e.drowsy_cnt, e.yawn_cnt, e.head_cnt,
                datetime.fromtimestamp(e.timestamp / 1000).strftime("%H:%M:%S"),
            ])
        return output.getvalue()


class SessionStore:
    """수업 세션 저장소 (메모리)"""

    def __init__(self):
        self._sessions: dict[str, Session] = {}

    def create(self, room_code: str, instructor: str) -> Session:
        session_id = f"{room_code}-{datetime.now().strftime('%Y%m%d%H%M%S')}"
        session    = Session(
            session_id=session_id,
            room_code=room_code,
            instructor=instructor,
        )
        self._sessions[session_id] = session
        return session

    def get(self, session_id: str) -> Session | None:
        return self._sessions.get(session_id)

    def get_active(self, room_code: str) -> Session | None:
        """특정 방의 활성 세션 반환"""
        for s in self._sessions.values():
            if s.room_code == room_code and s.is_active():
                return s
        return None

    def get_all(self) -> list[Session]:
        return sorted(self._sessions.values(), key=lambda s: s.started_at, reverse=True)

    def add_event(self, room_code: str, event_data: dict):
        """활성 세션에 감지 이벤트 추가"""
        session = self.get_active(room_code)
        if not session:
            return
        session.add_event(DetectionEvent(
            student_id = event_data.get("student_id", ""),
            name       = event_data.get("name", ""),
            status     = event_data.get("status", "focused"),
            ear        = event_data.get("ear"),
            drowsy_cnt = event_data.get("drowsy_cnt", 0),
            yawn_cnt   = event_data.get("yawn_cnt", 0),
            head_cnt   = event_data.get("head_cnt", 0),
            timestamp  = event_data.get("timestamp", 0),
        ))


# 싱글톤 인스턴스
store = SessionStore()