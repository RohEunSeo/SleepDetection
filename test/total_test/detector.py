"""
detector.py - FocusRoom 상태 판단 전담 모듈

[역할]
  - 임계값 상수 (지속적으로 튜닝하는 부분)
  - AttentionScorer: PERCLOS, Decay Factor 누적
  - AlertManager: 종합 졸음 점수 계산
  - DrowsinessDetector: 상태 5단계 판단 (update() 매 프레임 호출)

[의존]
  - sensors.py: 지표 계산 전담 (EyeDetector, HeadPose, calculate_mar 등)

[논문 근거]
  - EAR threshold 0.75: Soukupová & Čech 2016
  - PERCLOS 0.15/0.30: NHTSA 권장값
  - 지속시간 3초: 졸음운전(2초) → 온라인 수업 여유 적용
"""

import time
from collections import deque

import cv2
import numpy as np
from numpy import linalg as LA

# ── sensors.py에서 지표 계산 클래스/함수 import ────────────────
from sensors import (
    EyeDetector, HeadPose,
    get_landmarks, calculate_mar, draw_mouth_box,
    LEFT_EYE_IDX, RIGHT_EYE_IDX, MOUTH_IDX,
    EAR_VALID_MIN, EAR_VALID_MAX,
    EAR_CALIB_FRAMES, EAR_CALIB_RATIO,
)


# ════════════════════════════════════════════════════════════════
# 임계값 상수 (논문 기반 - 튜닝 대상)
# ════════════════════════════════════════════════════════════════

# ── EAR 관련 ────────────────────────────────────────────────────
EAR_DROWSY_SEC     = 3.0    # 눈 감김 지속 시간 → DROWSY 확정
                             # 논문: 졸음운전 2초 → 온라인 수업 3초

# ── PERCLOS 관련 (NHTSA 권장값) ─────────────────────────────────
PERCLOS_WINDOW     = 30     # 슬라이딩 윈도우 (초)
PERCLOS_WARNING    = 0.15   # 졸음 의심 하한값
PERCLOS_DROWSY     = 0.30   # 졸음 확정값
DECAY_FACTOR       = 0.9    # e-candeloro 동일

# ── 하품/MOE 관련 ────────────────────────────────────────────────
MAR_THRESH         = 0.70   # 하품 MAR 임계값
MAR_FRAMES         = 20     # 하품 판정 프레임 수 (~1.5초)
MOE_THRESH         = 2.0    # MOE = MAR/EAR 임계값
MOE_SEC            = 3.0    # MOE 지속 시간

# ── Head Pose 관련 ───────────────────────────────────────────────
YAW_THRESH         = 25.0   # 주의산만 기본 조건 (Yaw)
YAW_ASSIST         = 15.0   # 보조 조건 (Yaw + Gaze 함께)
ROLL_THRESH        = 15.0   # Roll 보정 기준
DISTRACTED_SEC     = 3.0    # 주의산만 판정 지속 시간
HEADBANG_DELTA     = 10.0   # 헤드뱅잉 pitch 변화량 (도)
HEADBANG_COUNT     = 3      # 헤드뱅잉 판정 반복 횟수

# ── Gaze 관련 ───────────────────────────────────────────────────
GAZE_THRESH        = 0.015  # 시선 이탈 임계값

# ── ABSENT 관련 ──────────────────────────────────────────────────
ABSENT_SEC         = 3.0    # 얼굴 미감지 → ABSENT 확정 시간

# ── WARNING 누적 관련 ────────────────────────────────────────────
WARNING_MAX_COUNT  = 3      # WARNING N회 누적 → DROWSY 전환
WARNING_WINDOW_MIN = 10     # 누적 기준 시간 (분)


# ════════════════════════════════════════════════════════════════
# AttentionScorer 클래스
# 출처: e-candeloro attention_scorer.py (동일 유지)
# ════════════════════════════════════════════════════════════════

class AttentionScorer:
    """
    EAR/Gaze/HeadPose 시간 누적 기반 상태 판단
    Decay Factor: 조건 사라져도 서서히 감소 (즉각 리셋 방지)
    Rolling PERCLOS: NumPy 슬라이딩 윈도우 (30초)
    출처: e-candeloro attention_scorer.py (동일 유지)
    """

    def __init__(self, t_now, ear_thresh):
        self.ear_thresh      = ear_thresh
        self.last_time       = t_now
        self.closure_time    = 0.0
        self.gaze_time       = 0.0
        self.distracted_time = 0.0
        self.timestamps      = np.empty((0,), dtype=np.float64)
        self.closed_flags    = np.empty((0,), dtype=bool)

    def _update(self, val, cond, elapsed):
        return val + elapsed if cond else val * DECAY_FACTOR

    def eval_scores(self, t_now, ear, gaze, roll, pitch, yaw):
        """EAR/Gaze/HeadPose → asleep/looking_away/distracted 반환"""
        elapsed        = t_now - self.last_time
        self.last_time = t_now

        self.closure_time = self._update(
            self.closure_time,
            ear is not None and ear <= self.ear_thresh,
            elapsed)

        self.gaze_time = self._update(
            self.gaze_time,
            gaze is not None and gaze > GAZE_THRESH,
            elapsed)

        head_cond = False
        if yaw is not None:
            yaw_basic  = abs(yaw) > YAW_THRESH
            yaw_assist = (abs(yaw) > YAW_ASSIST and
                          gaze is not None and gaze > GAZE_THRESH)
            head_cond  = yaw_basic or yaw_assist
        self.distracted_time = self._update(
            self.distracted_time, head_cond, elapsed)

        asleep       = self.closure_time    >= EAR_DROWSY_SEC
        looking_away = self.gaze_time       >= DISTRACTED_SEC
        distracted   = self.distracted_time >= DISTRACTED_SEC
        return asleep, looking_away, distracted

    def get_rolling_PERCLOS(self, t_now, ear):
        """30초 슬라이딩 윈도우 PERCLOS 계산"""
        eye_closed        = ear is not None and ear <= self.ear_thresh
        self.timestamps   = np.concatenate((self.timestamps,   [t_now]))
        self.closed_flags = np.concatenate((self.closed_flags, [eye_closed]))

        mask              = self.timestamps >= (t_now - PERCLOS_WINDOW)
        self.timestamps   = self.timestamps[mask]
        self.closed_flags = self.closed_flags[mask]

        total   = self.timestamps.size
        perclos = float(np.sum(self.closed_flags) / total) if total > 0 else 0.0
        return perclos


# ════════════════════════════════════════════════════════════════
# AlertManager 클래스
# 출처: test2.py (팀원) - 동일 유지
# ════════════════════════════════════════════════════════════════

class AlertManager:
    """종합 졸음 점수 0~100 계산"""

    def __init__(self):
        self.current_status    = "Normal"
        self.last_alert_time   = None
        self.alert_cooldown    = 5
        self.normal_threshold  = 40
        self.warning_threshold = 80

    def calculate_score(self, eye_data, yawn_data, head_data, no_face=False):
        score = 0
        if eye_data["is_drowsy"]:         score += 40
        elif eye_data["eyes_closed"]:     score += 20
        if eye_data["closed_sec"] > 1.0:  score += 20
        if yawn_data["yawn_detected"]:    score += 25
        elif yawn_data["mouth_open"]:     score += 10
        if head_data["head_distracted"]:  score += 25
        elif head_data["head_warn"]:      score += 10
        if no_face:                       score += 15
        return min(score, 100)

    def update(self, score):
        if score >= self.warning_threshold:
            status = "Alert"
        elif score >= self.normal_threshold:
            status = "Warning"
        else:
            status = "Normal"
        if status == "Alert":
            if (self.last_alert_time is None or
                    time.time() - self.last_alert_time >= self.alert_cooldown):
                self.last_alert_time = time.time()
        self.current_status = status
        return status, score


# ════════════════════════════════════════════════════════════════
# DrowsinessDetector - 핵심 클래스
# 상태 5단계 판단 로직 전담 → 지속적으로 튜닝하는 부분
# ════════════════════════════════════════════════════════════════

class DrowsinessDetector:
    """
    FocusRoom 졸음/이탈 감지 통합 클래스

    상태 5단계:
      FOCUSED    - 모든 조건 정상
      DISTRACTED - 고개/시선 지속 이탈 (Yaw 기반)
      WARNING    - 졸음 초기 신호 (하품/PERCLOS 15~30%/MOE)
      DROWSY     - 졸음 확정 (기지개 미션 발동)
      ABSENT     - 얼굴 미감지 3초 이상
    """

    def __init__(self, ear_thresh, t_now, baseline_ear=None):
        self.ear_thresh   = ear_thresh
        self.baseline_ear = (baseline_ear if baseline_ear is not None
                             else ear_thresh / EAR_CALIB_RATIO)

        # ── 눈 상태 히스테리시스 (Open/Tired/Closed) ──────────
        self.tired_cnt_l = 0   # 0=Open, 1=Tired, 2=Closed
        self.tired_cnt_r = 0

        # ── 핵심 컴포넌트 (sensors.py에서 import) ─────────────
        self.eye_det   = EyeDetector()
        self.head_pose = HeadPose()
        self.scorer    = AttentionScorer(t_now, ear_thresh)
        self.alert_mgr = AlertManager()

        # ── 하품 관련 ─────────────────────────────────────────
        self.mouth_frame_cnt = 0
        self.yawn_count      = 0
        self.prev_yawn_status = False   # 하품 끝 시점 카운트용

        # ── MOE 관련 ──────────────────────────────────────────
        self.moe_timer       = 0.0

        # ── ABSENT 관련 ───────────────────────────────────────
        self.face_miss_start = None

        # ── WARNING 누적 관련 ─────────────────────────────────
        self.warning_times   = deque()
        self.warning_count   = 0

        # ── 헤드뱅잉 감지 ─────────────────────────────────────
        self.prev_pitch      = 0.0
        self.headbang_cnt    = 0

        # ── Roll 보정 기준값 (danielsousaoliveira) ────────────
        self.prev_ear        = ear_thresh
        self.prev_roll       = 0.0
        self.base_roll       = 0.0
        self.base_roll_cnt   = 0
        self.prev_state      = "FOCUSED"
        self._was_warning    = False

    def update(self, frame, lms, t_now):
        """
        매 프레임 호출 → 상태 딕셔너리 반환

        Parameters
        ----------
        frame : numpy array  - BGR 프레임
        lms   : mediapipe multi_face_landmarks (없으면 None)
        t_now : float        - time.perf_counter()

        Returns
        -------
        dict : final_state, ear, perclos, gaze, mar, moe,
               roll, pitch, yaw, drowsiness_score,
               yawn_count, warning_count, face_detected,
               absent_sec, bbox, frame_w, frame_h
        """
        frame_size = (frame.shape[1], frame.shape[0])
        fw, fh     = frame_size

        # ── 기본 반환값 ───────────────────────────────────────
        result = {
            "final_state":      "FOCUSED",
            "ear":              self.prev_ear,
            "ear_left":         0.0,
            "ear_right":        0.0,
            "perclos":          0.0,
            "gaze":             0.0,
            "mar":              0.0,
            "moe":              0.0,
            "roll":             self.prev_roll,
            "pitch":            0.0,
            "yaw":              0.0,
            "drowsiness_score": 0,
            "yawn_count":       self.yawn_count,
            "warning_count":    self.warning_count,
            "face_detected":    lms is not None,
            "absent_sec":       0.0,
            "bbox":             {},
            "frame_w":          fw,
            "frame_h":          fh,
        }

        # ════════════════════════════════════════════════════
        # ABSENT 처리 (얼굴 미감지)
        # ════════════════════════════════════════════════════
        if not lms:
            if self.face_miss_start is None:
                self.face_miss_start = t_now
            absent_sec           = t_now - self.face_miss_start
            result["absent_sec"] = absent_sec
            if absent_sec >= ABSENT_SEC:
                result["final_state"] = "ABSENT"
                self.prev_state       = "ABSENT"
            return result

        self.face_miss_start = None

        # ════════════════════════════════════════════════════
        # 지표 계산 (sensors.py 클래스/함수 사용)
        # ════════════════════════════════════════════════════
        landmarks = get_landmarks(lms)
        lms_raw   = lms[0].landmark

        # EAR
        ear = self.eye_det.get_EAR(landmarks)
        if not (EAR_VALID_MIN < ear < EAR_VALID_MAX):
            result["ear"] = ear
            return result

        # Head Pose
        roll, pitch, yaw = self.head_pose.get_pose(landmarks, frame_size)

        # Roll 보정 (danielsousaoliveira 방식)
        if roll is not None and abs(roll - self.base_roll) > 6.0:
            ear = ear * (1 + abs(roll) / 15)

        # Gaze, MAR, MOE
        gaze    = self.eye_det.get_Gaze_Score(landmarks, frame_size)
        mar     = calculate_mar(lms_raw)
        moe     = mar / (ear + 1e-6)
        perclos = self.scorer.get_rolling_PERCLOS(t_now, ear)

        # eval_scores
        asleep, looking_away, distracted = self.scorer.eval_scores(
            t_now, ear, gaze, roll, pitch, yaw)

        # base_roll 수렴 (초기 60프레임)
        self.prev_ear = ear
        if roll is not None:
            self.prev_roll = roll
            if self.base_roll_cnt < 60:
                self.base_roll_cnt += 1
                self.base_roll = (
                    (self.base_roll * (self.base_roll_cnt - 1) + roll)
                    / self.base_roll_cnt
                )

        # 개별 눈 EAR
        ear_l, ear_r = self.eye_det.get_EAR_each(landmarks)

        # ════════════════════════════════════════════════════
        # 하품 판정 (끝 시점 카운트 - danielsousaoliveira 방식)
        # True → False 전환 순간에만 yawn_count 증가
        # ════════════════════════════════════════════════════
        cur_yawn_status = mar > MAR_THRESH
        if self.prev_yawn_status and not cur_yawn_status:
            self.yawn_count += 1   # 하품 끝나는 순간 카운트
        self.prev_yawn_status = cur_yawn_status
        yawn_detected         = cur_yawn_status

        # ── MOE 지속 시간 누적 ────────────────────────────────
        if moe > MOE_THRESH:
            self.moe_timer += 1 / 30
        else:
            self.moe_timer = 0.0
        moe_alert = self.moe_timer >= MOE_SEC

        # ── 헤드뱅잉 감지 ─────────────────────────────────────
        headbanging = False
        if pitch is not None:
            delta = abs(pitch - self.prev_pitch)
            if delta > HEADBANG_DELTA:
                self.headbang_cnt += 1
            else:
                self.headbang_cnt = max(0, self.headbang_cnt - 1)
            self.prev_pitch = pitch
            headbanging = (self.headbang_cnt >= HEADBANG_COUNT and
                           perclos >= PERCLOS_WARNING)

        # ── AlertManager 점수 ─────────────────────────────────
        eye_data  = {"is_drowsy":     asleep,
                     "eyes_closed":   ear < self.ear_thresh,
                     "closed_sec":    self.scorer.closure_time}
        yawn_data = {"yawn_detected": yawn_detected,
                     "mouth_open":    mar > MAR_THRESH}
        head_data = {"head_distracted": distracted,
                     "head_warn": (roll is not None and
                                   abs(roll) > ROLL_THRESH * 0.7)}
        score = self.alert_mgr.calculate_score(
            eye_data, yawn_data, head_data, no_face=False)
        _, drowsiness_score = self.alert_mgr.update(score)

        # ════════════════════════════════════════════════════
        # 최종 상태 5단계 판정
        # ════════════════════════════════════════════════════

        # WARNING 누적 카운터 (10분 윈도우)
        cutoff = t_now - WARNING_WINDOW_MIN * 60
        while self.warning_times and self.warning_times[0] < cutoff:
            self.warning_times.popleft()
        self.warning_count = len(self.warning_times)

        # 1순위: DROWSY
        drowsy = (
            asleep or
            (perclos >= PERCLOS_DROWSY) or
            headbanging or
            (self.warning_count >= WARNING_MAX_COUNT)
        )

        # 2순위: WARNING
        warning = (
            yawn_detected or
            PERCLOS_WARNING <= perclos < PERCLOS_DROWSY or
            moe_alert
        )

        # 3순위: DISTRACTED
        distr = distracted

        # 최종 상태 결정
        if drowsy:
            final_state = "DROWSY"
        elif warning:
            final_state = "WARNING"
        elif distr:
            final_state = "DISTRACTED"
        else:
            final_state = "FOCUSED"

        # WARNING 진입 시 타임스탬프 기록
        if final_state == "WARNING" and not self._was_warning:
            self.warning_times.append(t_now)
        self._was_warning = (final_state == "WARNING")
        self.prev_state   = final_state

        # ── 바운딩박스 좌표 계산 (데이터 수집용) ─────────────
        bbox = {}
        l_pts = [lms_raw[i] for i in LEFT_EYE_IDX]
        lxs   = [int(p.x * fw) for p in l_pts]
        lys   = [int(p.y * fh) for p in l_pts]
        bbox["eye_l"] = [min(lxs)-5, min(lys)-5, max(lxs)+5, max(lys)+5]

        r_pts = [lms_raw[i] for i in RIGHT_EYE_IDX]
        rxs   = [int(p.x * fw) for p in r_pts]
        rys   = [int(p.y * fh) for p in r_pts]
        bbox["eye_r"] = [min(rxs)-5, min(rys)-5, max(rxs)+5, max(rys)+5]

        m_pts = [lms_raw[i] for i in MOUTH_IDX]
        mxs   = [int(p.x * fw) for p in m_pts]
        mys   = [int(p.y * fh) for p in m_pts]
        bbox["mouth"] = [min(mxs)-5, min(mys)-5, max(mxs)+5, max(mys)+5]

        # ── 시각화 ────────────────────────────────────────────
        self.eye_det.show_iris(frame, landmarks, frame_size)
        self._draw_eye_boxes(frame, lms_raw, frame_size, roll=roll)
        draw_mouth_box(frame, lms_raw, frame_size, yawn_detected, mar)

        # ── 결과 반환 ─────────────────────────────────────────
        result.update({
            "final_state":      final_state,
            "ear":              round(ear,     3),
            "ear_left":         round(ear_l,   3),
            "ear_right":        round(ear_r,   3),
            "perclos":          round(perclos, 3),
            "gaze":             round(gaze,    3),
            "mar":              round(mar,     3),
            "moe":              round(moe,     2),
            "roll":   round(roll,  1) if roll  is not None else 0.0,
            "pitch":  round(pitch, 1) if pitch is not None else 0.0,
            "yaw":    round(yaw,   1) if yaw   is not None else 0.0,
            "drowsiness_score": drowsiness_score,
            "yawn_count":       self.yawn_count,
            "warning_count":    self.warning_count,
            "face_detected":    True,
            "absent_sec":       0.0,
            "bbox":             bbox,
            "frame_w":          fw,
            "frame_h":          fh,
        })
        return result

    def _draw_eye_boxes(self, frame, lms_raw, frame_size, roll=None):
        """
        눈 바운딩박스 + Open/Tired/Closed 3단계 표시

        [양쪽 눈 상태 동기화]
        - Open + Tired  → 둘 다 Open  (한쪽만 Open이면 사실상 Open)
        - Tired + Closed → 둘 다 Tired (한쪽 Tired면 Closed보다 완화)
        - Open + Closed → 그대로 유지  (명확히 비대칭인 경우만)

        [danielsousaoliveira 방식]
        - Roll 보정 EAR: baseR 기준 6도 이상 벗어나면 EAR 보정
        - 히스테리시스: Open↔Tired 경계 버벅거림 방지
        """
        fw, fh      = frame_size
        tired_enter = self.baseline_ear * 0.95
        open_enter  = self.baseline_ear * 1.05

        states = []   # 왼쪽, 오른쪽 눈 상태 (0=Open, 1=Tired, 2=Closed)

        for i, eye_idx in enumerate([LEFT_EYE_IDX, RIGHT_EYE_IDX]):
            pts   = [lms_raw[j] for j in eye_idx]
            xs    = [int(p.x * fw) for p in pts]
            ys    = [int(p.y * fh) for p in pts]
            arr   = np.array([[p.x, p.y] for p in pts])
            v1    = LA.norm(arr[2] - arr[3])
            v2    = LA.norm(arr[4] - arr[5])
            h_    = LA.norm(arr[0] - arr[1])
            e_ear = (v1 + v2) / (2.0 * h_ + 1e-6)

            # Roll 보정 (baseR 기준 6도 이상 벗어나면)
            if roll is not None and abs(roll - self.base_roll) > 6.0:
                e_ear = e_ear * (1 + abs(roll) / 15)

            # 히스테리시스 상태 전환
            cur = self.tired_cnt_l if i == 0 else self.tired_cnt_r

            if e_ear < self.ear_thresh:
                cur = 2
            elif cur == 2 and e_ear < tired_enter:
                cur = 1
            elif cur == 2 and e_ear >= open_enter:
                cur = 0
            elif cur == 1 and e_ear >= open_enter:
                cur = 0
            elif cur == 0 and e_ear < tired_enter:
                cur = 1

            if i == 0:
                self.tired_cnt_l = cur
            else:
                self.tired_cnt_r = cur

            states.append((cur, xs, ys))

        # ── 양쪽 눈 상태 동기화 ──────────────────────────────
        s_l, s_r = states[0][0], states[1][0]

        # Open + Tired → 둘 다 Open
        if (s_l == 0 and s_r == 1) or (s_l == 1 and s_r == 0):
            s_l = s_r = 0

        # Tired + Closed → 둘 다 Tired
        elif (s_l == 1 and s_r == 2) or (s_l == 2 and s_r == 1):
            s_l = s_r = 1

        # 나머지 (Open+Closed, 둘 다 동일) → 그대로 유지
        final_states = [s_l, s_r]

        # ── 바운딩박스 그리기 ─────────────────────────────────
        COLOR_MAP = {
            0: ((0, 255, 0),   "Open"),
            1: ((0, 165, 255), "Tired"),
            2: ((0, 0, 255),   "Closed"),
        }

        for i, (_, xs, ys) in enumerate(states):
            color, label = COLOR_MAP[final_states[i]]
            cv2.rectangle(frame,
                          (min(xs)-5, min(ys)-5),
                          (max(xs)+5, max(ys)+5), color, 2)
            cv2.putText(frame, label,
                        (min(xs)-5, min(ys)-10),
                        cv2.FONT_HERSHEY_PLAIN, 1.2, color, 1)