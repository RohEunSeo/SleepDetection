# =============================================
# session_store.py — 수업 세션 및 감지 이벤트 저장
# Supabase 기반 영속화 (서버 재시작 후에도 유지)
# =============================================

from dataclasses import dataclass, field
from datetime import datetime
import csv
import io
import os

from supabase import create_client, Client

# ── Supabase 클라이언트 초기화 ────────────────
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


@dataclass
class DetectionEvent:
    """학생 1회 감지 이벤트"""
    student_id:     str
    name:           str
    status:         str
    ear:            float | None
    drowsy_cnt:     int
    yawn_cnt:       int
    head_cnt:       int
    distracted_cnt: int = 0
    warning_cnt:    int = 0
    timestamp:      int = 0


@dataclass
class Session:
    """수업 1개 세션 (메모리 캐시용)"""
    session_id:   str
    room_code:    str
    course_name:  str
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
        students = {}
        for e in self.events:
            if e.student_id not in students:
                students[e.student_id] = {
                    "name": e.name, "drowsy": 0, "yawn": 0,
                    "head": 0, "absent": 0, "distracted": 0,
                    "warning": 0, "focus_pct": 100,
                }
            s = students[e.student_id]
            if e.status == "drowsy":     s["drowsy"]     += 1
            if e.status == "absent":     s["absent"]     += 1
            if e.status == "distracted": s["distracted"] += 1
            if e.status == "warning":    s["warning"]    += 1
            if e.yawn_cnt > 0:           s["yawn"]       += 1
            if e.head_cnt > 0:           s["head"]       += 1

        for s in students.values():
            penalty = (s["drowsy"]*10 + s["absent"]*15 +
                       s["warning"]*5 + s["yawn"]*3 + s["head"]*3)
            s["focus_pct"] = max(0, 100 - penalty)

        total     = len(students)
        duration  = (self.ended_at or datetime.now()) - self.started_at
        avg_focus = round(
            sum(s["focus_pct"] for s in students.values()) / total
        ) if total > 0 else 0

        return {
            "session_id":       self.session_id,
            "room_code":        self.room_code,
            "course_name":      self.course_name,
            "instructor":       self.instructor,
            "date":             self.started_at.strftime("%Y-%m-%d"),
            "started_at":       self.started_at.strftime("%H:%M"),
            "ended_at":         self.ended_at.strftime("%H:%M") if self.ended_at else None,
            "duration_min":     round(duration.total_seconds() / 60, 1),
            "student_count":    total,
            "avg_focus":        avg_focus,
            "alert_count":      sum(s["drowsy"]+s["absent"] for s in students.values()),
            "drowsy_count":     sum(s["drowsy"]     for s in students.values()),
            "absent_count":     sum(s["absent"]     for s in students.values()),
            "distracted_count": sum(s["distracted"] for s in students.values()),
            "warning_count":    sum(s["warning"]    for s in students.values()),
            "students":         students,
            "is_active":        self.is_active(),
        }

    def to_csv(self) -> str:
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow([
            "학생ID","이름","상태","EAR",
            "졸음횟수","하품횟수","고개떨굼횟수",
            "시선이탈횟수","경고횟수","타임스탬프"
        ])
        for e in self.events:
            writer.writerow([
                e.student_id, e.name, e.status,
                round(e.ear, 3) if e.ear else "",
                e.drowsy_cnt, e.yawn_cnt, e.head_cnt,
                e.distracted_cnt, e.warning_cnt,
                datetime.fromtimestamp(e.timestamp/1000).strftime("%H:%M:%S"),
            ])
        return output.getvalue()


class SessionStore:
    """수업 세션 저장소 (메모리 캐시 + Supabase 영속화)"""

    def __init__(self):
        self._sessions: dict[str, Session] = {}

    def create(self, room_code: str, instructor: str, course_name: str = "") -> Session:
        session_id = f"{room_code}-{datetime.now().strftime('%Y%m%d%H%M%S')}"
        session = Session(
            session_id  = session_id,
            room_code   = room_code,
            course_name = course_name,
            instructor  = instructor,
        )
        self._sessions[session_id] = session

        try:
            supabase.table("sessions").insert({
                "session_id":  session_id,
                "room_code":   room_code,
                "course_name": course_name,
                "instructor":  instructor,
                "date":        session.started_at.strftime("%Y-%m-%d"),
                "started_at":  session.started_at.isoformat(),
                "is_active":   True,
            }).execute()
            print(f"[Supabase] 세션 생성 완료: {session_id} / 과정: {course_name}")
        except Exception as e:
            print(f"[Supabase] 세션 생성 실패: {e}")

        return session

    def get(self, session_id: str) -> Session | None:
        if session_id in self._sessions:
            return self._sessions[session_id]
        try:
            # .single() 제거 → 0 rows 에러 방지
            res = supabase.table("sessions").select("*").eq("session_id", session_id).execute()
            if res.data and len(res.data) > 0:
                return self._row_to_session(res.data[0])
        except Exception as e:
            print(f"[Supabase] 세션 조회 실패: {e}")
        return None

    def get_active(self, room_code: str) -> Session | None:
        # 1. 메모리 캐시 우선
        for s in self._sessions.values():
            if s.room_code == room_code and s.is_active():
                return s
        # 2. 없으면 Supabase에서 복원 (서버 재시작 후에도 동작)
        try:
            res = supabase.table("sessions").select("*") \
                .eq("room_code", room_code) \
                .eq("is_active", True) \
                .execute()
            if res.data and len(res.data) > 0:
                session = self._row_to_session(res.data[0])
                self._sessions[session.session_id] = session
                print(f"[Supabase] 메모리 복원: {session.session_id}")
                return session
        except Exception as e:
            print(f"[Supabase] get_active 조회 실패: {e}")
        return None

    def get_all(self, course_name: str | None = None) -> list[dict]:
        try:
            query = supabase.table("sessions").select("*").order("started_at", desc=True)
            if course_name:
                query = query.eq("course_name", course_name)
            res = query.execute()
            return res.data or []
        except Exception as e:
            print(f"[Supabase] 세션 목록 조회 실패: {e}")
            return []

    def get_courses(self) -> list[str]:
        try:
            res = supabase.table("sessions").select("course_name").execute()
            seen, result = set(), []
            for row in (res.data or []):
                name = row.get("course_name", "")
                if name and name not in seen:
                    seen.add(name)
                    result.append(name)
            return result
        except Exception as e:
            print(f"[Supabase] 과정 목록 조회 실패: {e}")
            return []

    def get_active_sessions(self) -> list[dict]:
        try:
            res = supabase.table("sessions").select("*").eq("is_active", True).execute()
            return res.data or []
        except Exception as e:
            print(f"[Supabase] 활성 세션 조회 실패: {e}")
            return []

    def add_event(self, room_code: str, event_data: dict):
        session = self.get_active(room_code)
        if not session:
            return
        session.add_event(DetectionEvent(
            student_id     = event_data.get("student_id", ""),
            name           = event_data.get("name", ""),
            status         = event_data.get("status", "focused"),
            ear            = event_data.get("ear"),
            drowsy_cnt     = event_data.get("drowsy_cnt", 0),
            yawn_cnt       = event_data.get("yawn_cnt", 0),
            head_cnt       = event_data.get("head_cnt", 0),
            distracted_cnt = event_data.get("distracted_cnt", 0),
            warning_cnt    = event_data.get("warning_cnt", 0),
            timestamp      = event_data.get("timestamp", 0),
        ))

    def end_session(self, room_code: str):
        session = self.get_active(room_code)

        if session:
            session.end()
            summary = session.summary()

            try:
                supabase.table("sessions").update({
                    "ended_at":         session.ended_at.isoformat(),
                    "duration_min":     summary["duration_min"],
                    "student_count":    summary["student_count"],
                    "avg_focus":        summary["avg_focus"],
                    "alert_count":      summary["alert_count"],
                    "drowsy_count":     summary["drowsy_count"],
                    "absent_count":     summary["absent_count"],
                    "distracted_count": summary["distracted_count"],
                    "warning_count":    summary["warning_count"],
                    "is_active":        False,
                }).eq("session_id", session.session_id).execute()
                print(f"[Supabase] 세션 종료 완료: {session.session_id}")
            except Exception as e:
                print(f"[Supabase] 세션 종료 업데이트 실패: {e}")

            try:
                events_data = [
                    {
                        "session_id":     session.session_id,
                        "student_id":     e.student_id,
                        "name":           e.name,
                        "status":         e.status,
                        "ear":            e.ear,
                        "drowsy_cnt":     e.drowsy_cnt,
                        "yawn_cnt":       e.yawn_cnt,
                        "head_cnt":       e.head_cnt,
                        "distracted_cnt": e.distracted_cnt,
                        "warning_cnt":    e.warning_cnt,
                        "timestamp":      e.timestamp,
                    }
                    for e in session.events
                ]
                if events_data:
                    for i in range(0, len(events_data), 1000):
                        supabase.table("student_events").insert(
                            events_data[i:i+1000]
                        ).execute()
            except Exception as e:
                print(f"[Supabase] 이벤트 저장 실패: {e}")

            self._sessions.pop(session.session_id, None)

        else:
            # 메모리에 없는 경우 → Supabase에서 room_code로 직접 종료
            print(f"[Supabase] 메모리 세션 없음, DB 직접 종료: {room_code}")
            try:
                supabase.table("sessions").update({
                    "ended_at":  datetime.now().isoformat(),
                    "is_active": False,
                }).eq("room_code", room_code).eq("is_active", True).execute()
                print(f"[Supabase] DB 직접 종료 완료: {room_code}")
            except Exception as e:
                print(f"[Supabase] DB 직접 종료 실패: {e}")

    def _row_to_session(self, row: dict) -> Session:
        return Session(
            session_id  = row["session_id"],
            room_code   = row["room_code"],
            course_name = row.get("course_name", ""),
            instructor  = row.get("instructor", ""),
            started_at  = datetime.fromisoformat(row["started_at"]),
            ended_at    = datetime.fromisoformat(row["ended_at"]) if row.get("ended_at") else None,
        )


# 싱글톤 인스턴스
store = SessionStore()