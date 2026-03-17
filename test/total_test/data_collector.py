"""
data_collector.py - FocusRoom 데이터 수집 및 자동 라벨링 모듈

[키보드 단축키]
  1 → FOCUSED    (집중)
  2 → DISTRACTED (주의 산만)
  3 → WARNING    (졸음 의심)
  4 → DROWSY     (졸음 확정)
  5 → ABSENT     (자리 이탈)
  q → 세션 종료

[저장 구조]
  data/
  ├── FOCUSED/
  │   ├── images/
  │   │   ├── 001_20240317_143001.jpg
  │   │   └── 002_20240317_143045.jpg
  │   └── labels/
  │       ├── 001_20240317_143001.json   ← 이미지별 JSON
  │       └── 002_20240317_143045.json
  ├── DISTRACTED/  images/ + labels/
  ├── WARNING/     images/ + labels/
  ├── DROWSY/      images/ + labels/
  ├── ABSENT/      images/ + labels/
  ├── summary.csv            ← 모든 클래스 통합 CSV (시각화/통계용)
  └── session_summary.json   ← 세션 전체 요약
"""

import csv
import json
import os
import time
from datetime import datetime


# ── 라벨 번호 매핑 ────────────────────────────────────────────────
KEY_LABEL_MAP = {
    ord("1"): "FOCUSED",
    ord("2"): "DISTRACTED",
    ord("3"): "WARNING",
    ord("4"): "DROWSY",
    ord("5"): "ABSENT",
}

ALL_CLASSES = ["FOCUSED", "DISTRACTED", "WARNING", "DROWSY", "ABSENT"]

# ── 클래스 → 실제 폴더명 매핑 ────────────────────────────────────
CLASS_DIR_MAP = {
    "FOCUSED":    "01_FOCUSED",
    "DISTRACTED": "02_DISTRACTED",
    "WARNING":    "03_WARNING",
    "DROWSY":     "04_DROWSY",
    "ABSENT":     "05_ABSENT",
}

# ── summary.csv 헤더 (JSON과 동일한 구조) ─────────────────────────
SUMMARY_HEADER = [
    "id", "timestamp", "label",
    # 핵심 지표
    "ear", "ear_left", "ear_right", "perclos",
    "mar", "moe", "gaze",
    "roll", "pitch", "yaw",
    "drowsiness_score", "yawn_count",
    # 바운딩박스 픽셀 좌표
    "eye_l_x1", "eye_l_y1", "eye_l_x2", "eye_l_y2",
    "eye_r_x1", "eye_r_y1", "eye_r_x2", "eye_r_y2",
    "mouth_x1", "mouth_y1", "mouth_x2", "mouth_y2",
    # 정규화 좌표 (YOLO 변환용)
    "eye_l_cx_norm", "eye_l_cy_norm", "eye_l_w_norm", "eye_l_h_norm",
    "eye_r_cx_norm", "eye_r_cy_norm", "eye_r_w_norm", "eye_r_h_norm",
    "mouth_cx_norm", "mouth_cy_norm", "mouth_w_norm", "mouth_h_norm",
    # 프레임 크기
    "frame_w", "frame_h",
    # 파일 경로
    "image_path", "json_path",
]


class DataCollector:
    """
    클래스별 폴더 구조로 데이터 수집 및 라벨링

    저장:
      - 이미지: data/{CLASS}/images/{id}_{timestamp}.jpg
      - JSON:   data/{CLASS}/labels/{id}_{timestamp}.json
      - CSV:    data/summary.csv (모든 클래스 통합)
    """

    def __init__(self, base_dir="data"):
        self.base_dir = base_dir

        # ── 클래스별 폴더 생성 ────────────────────────────────────
        self.images_dirs = {}
        self.labels_dirs = {}

        for cls in ALL_CLASSES:
            dir_name  = CLASS_DIR_MAP[cls]           # 예: "01_FOCUSED"
            img_dir   = os.path.join(base_dir, dir_name, "images")
            label_dir = os.path.join(base_dir, dir_name, "labels")
            os.makedirs(img_dir,   exist_ok=True)
            os.makedirs(label_dir, exist_ok=True)
            self.images_dirs[cls] = img_dir
            self.labels_dirs[cls] = label_dir

        # ── summary.csv 초기화 (모든 클래스 통합) ─────────────────
        summary_csv_path = os.path.join(base_dir, "summary.csv")
        is_new_csv       = not os.path.exists(summary_csv_path)
        self.summary_csv = open(
            summary_csv_path, "a", newline="", encoding="utf-8")
        self.summary_writer = csv.DictWriter(
            self.summary_csv, fieldnames=SUMMARY_HEADER)
        if is_new_csv:
            self.summary_writer.writeheader()

        # ── 클래스별 캡처 순번 (기존 파일 이어서 카운트) ──────────
        self.capture_counts = {}
        for cls in ALL_CLASSES:
            existing = len([
                f for f in os.listdir(self.images_dirs[cls])
                if f.endswith(".jpg")
            ])
            self.capture_counts[cls] = existing

        # ── 세션 통계 ─────────────────────────────────────────────
        self.session_start   = datetime.now()
        self.label_counts    = {k: 0 for k in ALL_CLASSES}
        self.state_durations = {k: 0.0 for k in ALL_CLASSES}
        self.prev_state      = "FOCUSED"
        self.prev_state_time = time.perf_counter()
        self.events          = []
        self.total_captures  = sum(self.capture_counts.values())

        print(f"[DataCollector] 저장 경로: {os.path.abspath(base_dir)}")
        existing_total = sum(self.capture_counts.values())
        if existing_total > 0:
            print(f"[DataCollector] 기존 누적: "
                  f"{ {k:v for k,v in self.capture_counts.items() if v>0} }")
        print("[DataCollector] 1→집중  2→주의산만  3→졸음의심  "
              "4→졸음확정  5→이탈  q→종료")

    def handle_key(self, key, frame, result):
        """
        키 입력 처리 → 해당 클래스 폴더에 저장

        Parameters
        ----------
        key    : int   - cv2.waitKey() 반환값
        frame  : numpy - clean_frame (UI 없는 프레임)
        result : dict  - DrowsinessDetector.update() 반환값
        """
        if key not in KEY_LABEL_MAP:
            return False
        self._save_capture(frame, result, KEY_LABEL_MAP[key])
        return True

    def update_state(self, result, t_now):
        """매 프레임 호출 → 상태 지속시간 누적 + 이벤트 기록"""
        current_state = result.get("final_state", "FOCUSED")

        if current_state != self.prev_state:
            duration = t_now - self.prev_state_time
            if self.prev_state in self.state_durations:
                self.state_durations[self.prev_state] += duration

            self.events.append({
                "timestamp":    datetime.now().isoformat(),
                "from_state":   self.prev_state,
                "to_state":     current_state,
                "duration_sec": round(duration, 2),
                "ear":          result.get("ear",     0),
                "perclos":      result.get("perclos", 0),
                "mar":          result.get("mar",     0),
                "moe":          result.get("moe",     0),
            })

            self.prev_state      = current_state
            self.prev_state_time = t_now

    def _save_capture(self, frame, result, label):
        """이미지 + JSON(labels/) + summary.csv 저장"""
        import cv2

        # ── 파일명 결정 ───────────────────────────────────────────
        self.capture_counts[label] += 1
        self.total_captures        += 1
        cnt      = self.capture_counts[label]
        now      = datetime.now()
        ts_str   = now.strftime("%Y%m%d_%H%M%S")
        basename = f"{cnt:03d}_{ts_str}"   # 확장자 없는 공통 이름

        img_file  = f"{basename}.jpg"
        json_file = f"{basename}.json"

        img_path  = os.path.join(self.images_dirs[label], img_file)
        json_path = os.path.join(self.labels_dirs[label], json_file)

        # 상대 경로 (summary.csv image_path / json_path 컬럼용)
        img_rel  = os.path.join(CLASS_DIR_MAP[label], "images", img_file)
        json_rel = os.path.join(CLASS_DIR_MAP[label], "labels", json_file)

        # ── 이미지 저장 ───────────────────────────────────────────
        cv2.imwrite(img_path, frame)

        # ── bbox 좌표 + 정규화 좌표 계산 ─────────────────────────
        bbox   = result.get("bbox", {})
        eye_l  = bbox.get("eye_l",  [0, 0, 0, 0])
        eye_r  = bbox.get("eye_r",  [0, 0, 0, 0])
        mouth  = bbox.get("mouth",  [0, 0, 0, 0])
        fw     = max(result.get("frame_w", 1), 1)
        fh     = max(result.get("frame_h", 1), 1)

        def norm_box(box):
            """픽셀 bbox → 정규화 cx, cy, w, h"""
            return {
                "cx_norm": round((box[0]+box[2]) / 2 / fw, 4),
                "cy_norm": round((box[1]+box[3]) / 2 / fh, 4),
                "w_norm":  round((box[2]-box[0])     / fw, 4),
                "h_norm":  round((box[3]-box[1])     / fh, 4),
            }

        el_norm = norm_box(eye_l)
        er_norm = norm_box(eye_r)
        mo_norm = norm_box(mouth)

        # ── JSON 저장 (data/{CLASS}/labels/{basename}.json) ───────
        label_json = {
            "id":        cnt,
            "timestamp": now.strftime("%Y-%m-%d %H:%M:%S"),
            "label":     label,
            "image":     img_file,

            "metrics": {
                "ear":              result.get("ear",              0),
                "ear_left":         result.get("ear_left",         0),
                "ear_right":        result.get("ear_right",        0),
                "perclos":          result.get("perclos",          0),
                "mar":              result.get("mar",              0),
                "moe":              result.get("moe",              0),
                "gaze":             result.get("gaze",             0),
                "roll":             result.get("roll",             0),
                "pitch":            result.get("pitch",            0),
                "yaw":              result.get("yaw",              0),
                "drowsiness_score": result.get("drowsiness_score", 0),
                "yawn_count":       result.get("yawn_count",       0),
            },

            "bboxes": {
                "eye_left": {
                    "x1": eye_l[0], "y1": eye_l[1],
                    "x2": eye_l[2], "y2": eye_l[3],
                    **el_norm,
                },
                "eye_right": {
                    "x1": eye_r[0], "y1": eye_r[1],
                    "x2": eye_r[2], "y2": eye_r[3],
                    **er_norm,
                },
                "mouth": {
                    "x1": mouth[0], "y1": mouth[1],
                    "x2": mouth[2], "y2": mouth[3],
                    **mo_norm,
                },
            },

            "frame_w": result.get("frame_w", 0),
            "frame_h": result.get("frame_h", 0),
        }

        with open(json_path, "w", encoding="utf-8") as jf:
            json.dump(label_json, jf, ensure_ascii=False, indent=2)

        # ── summary.csv 저장 (모든 클래스 통합) ──────────────────
        self.summary_writer.writerow({
            "id":               cnt,
            "timestamp":        now.strftime("%Y-%m-%d %H:%M:%S"),
            "label":            label,
            "ear":              result.get("ear",              0),
            "ear_left":         result.get("ear_left",         0),
            "ear_right":        result.get("ear_right",        0),
            "perclos":          result.get("perclos",          0),
            "mar":              result.get("mar",              0),
            "moe":              result.get("moe",              0),
            "gaze":             result.get("gaze",             0),
            "roll":             result.get("roll",             0),
            "pitch":            result.get("pitch",            0),
            "yaw":              result.get("yaw",              0),
            "drowsiness_score": result.get("drowsiness_score", 0),
            "yawn_count":       result.get("yawn_count",       0),
            # 픽셀 bbox
            "eye_l_x1": eye_l[0], "eye_l_y1": eye_l[1],
            "eye_l_x2": eye_l[2], "eye_l_y2": eye_l[3],
            "eye_r_x1": eye_r[0], "eye_r_y1": eye_r[1],
            "eye_r_x2": eye_r[2], "eye_r_y2": eye_r[3],
            "mouth_x1": mouth[0], "mouth_y1": mouth[1],
            "mouth_x2": mouth[2], "mouth_y2": mouth[3],
            # 정규화 bbox
            "eye_l_cx_norm": el_norm["cx_norm"],
            "eye_l_cy_norm": el_norm["cy_norm"],
            "eye_l_w_norm":  el_norm["w_norm"],
            "eye_l_h_norm":  el_norm["h_norm"],
            "eye_r_cx_norm": er_norm["cx_norm"],
            "eye_r_cy_norm": er_norm["cy_norm"],
            "eye_r_w_norm":  er_norm["w_norm"],
            "eye_r_h_norm":  er_norm["h_norm"],
            "mouth_cx_norm": mo_norm["cx_norm"],
            "mouth_cy_norm": mo_norm["cy_norm"],
            "mouth_w_norm":  mo_norm["w_norm"],
            "mouth_h_norm":  mo_norm["h_norm"],
            "frame_w":       result.get("frame_w", 0),
            "frame_h":       result.get("frame_h", 0),
            "image_path":    img_rel,
            "json_path":     json_rel,
        })
        self.summary_csv.flush()
        self.label_counts[label] += 1

        print(f"[캡처] {label:12s} #{cnt:03d} | "
              f"EAR:{result.get('ear',0):.3f}  "
              f"PERCLOS:{result.get('perclos',0):.2f}  "
              f"MAR:{result.get('mar',0):.3f}")

    def close(self):
        """세션 종료 → CSV 닫기 + session_summary.json 저장"""
        session_end = datetime.now()
        total_sec   = (session_end - self.session_start).total_seconds()

        last_dur = time.perf_counter() - self.prev_state_time
        if self.prev_state in self.state_durations:
            self.state_durations[self.prev_state] += last_dur

        self.summary_csv.close()

        summary = {
            "session_start":   self.session_start.strftime("%Y-%m-%d %H:%M:%S"),
            "session_end":     session_end.strftime("%Y-%m-%d %H:%M:%S"),
            "total_sec":       round(total_sec, 1),
            "state_durations_sec": {
                k: round(v, 1) for k, v in self.state_durations.items()
            },
            "state_ratios_pct": {
                k: round(v / total_sec * 100, 1) if total_sec > 0 else 0
                for k, v in self.state_durations.items()
            },
            "this_session_captures": self.label_counts,
            "total_captures_in_dir": self.capture_counts,
            "events": self.events,
        }

        with open(os.path.join(self.base_dir, "session_summary.json"),
                  "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False, indent=2)

        print("\n" + "="*55)
        print("[DataCollector] 세션 종료")
        print(f"  총 시간: {total_sec:.0f}초")
        print(f"  이번 세션 캡처:")
        for k, v in self.label_counts.items():
            if v > 0:
                print(f"    {k:12s}: {v}장")
        print(f"  전체 누적:")
        for k, v in self.capture_counts.items():
            print(f"    {k:12s}: {v}장")
        print(f"  저장: {os.path.abspath(self.base_dir)}")
        print("="*55)