import time
from collections import deque

import cv2
import numpy as np
from numpy import linalg as LA

from sensors import (
    EyeDetector,
    HeadPose,
    get_landmarks,
    calculate_mar,
    draw_mouth_box,
    get_mouth_features,
    LEFT_EYE_IDX,
    RIGHT_EYE_IDX,
    MOUTH_IDX,
    EAR_VALID_MIN,
    EAR_VALID_MAX,
    EAR_CALIB_FRAMES,
    EAR_CALIB_RATIO,
)

EAR_DROWSY_SEC = 5.0
PERCLOS_WINDOW = 60
PERCLOS_WARNING = 0.20
PERCLOS_DROWSY = 0.30
DECAY_FACTOR = 0.9

MAR_THRESH = 0.85
MAR_FRAMES = 14
MOE_THRESH = 2.0
MOE_SEC = 3.0

YAW_THRESH = 20.0
YAW_ASSIST = 15.0
PITCH_THRESH = 28.0
ROLL_THRESH = 25.0
DISTRACTED_SEC = 3.0
HEADBANG_DELTA = 10.0
HEADBANG_COUNT = 3

GAZE_THRESH = 0.015
ABSENT_SEC = 3.0
FACE_MISSING_SLEEP_SEC = 0.5

WARNING_MAX_COUNT = 3
WARNING_WINDOW_MIN = 10


class AttentionScorer:
    def __init__(self, t_now, closure_thresh):
        self.closure_thresh = closure_thresh
        self.last_time = t_now
        self.closure_time = 0.0
        self.gaze_time = 0.0
        self.distracted_time = 0.0
        self.timestamps = np.empty((0,), dtype=np.float64)
        self.closed_flags = np.empty((0,), dtype=bool)

    def _update(self, val, cond, elapsed):
        return val + elapsed if cond else val * DECAY_FACTOR

    def eval_scores(self, t_now, ear, gaze, roll, pitch, yaw):
        elapsed = t_now - self.last_time
        self.last_time = t_now

        self.closure_time = self._update(
            self.closure_time,
            ear is not None and ear <= self.closure_thresh,
            elapsed,
        )
        
        self.gaze_time = self._update(
            self.gaze_time,
            gaze is not None and gaze > GAZE_THRESH,
            elapsed,
        )

        yaw_basic = yaw is not None and abs(yaw) > YAW_THRESH
        yaw_assist = (
            yaw is not None and abs(yaw) > YAW_ASSIST and
            gaze is not None and gaze > GAZE_THRESH
        )

        # 위로 너무 들거나, 아래로 너무 많이 숙이는 경우만 산만 처리
        pitch_cond = pitch is not None and (
            pitch > PITCH_THRESH or pitch < -35.0
        )

        roll_cond = roll is not None and abs(roll) > ROLL_THRESH
        head_cond = yaw_basic or yaw_assist or pitch_cond or roll_cond
        self.distracted_time = self._update(self.distracted_time, head_cond, elapsed)

        asleep = self.closure_time >= EAR_DROWSY_SEC
        looking_away = self.gaze_time >= DISTRACTED_SEC
        distracted = self.distracted_time >= DISTRACTED_SEC
        return asleep, looking_away, distracted

    def get_rolling_PERCLOS(self, t_now, ear):
        eye_closed = ear is not None and ear <= self.closure_thresh
        self.timestamps = np.concatenate((self.timestamps, [t_now]))
        self.closed_flags = np.concatenate((self.closed_flags, [eye_closed]))

        mask = self.timestamps >= (t_now - PERCLOS_WINDOW)
        self.timestamps = self.timestamps[mask]
        self.closed_flags = self.closed_flags[mask]

        total = self.timestamps.size
        return float(np.sum(self.closed_flags) / total) if total > 0 else 0.0

    def reset_tracking(self, t_now):
        self.last_time = t_now
        self.closure_time = 0.0
        self.gaze_time = 0.0
        self.distracted_time = 0.0
        self.timestamps = np.empty((0,), dtype=np.float64)
        self.closed_flags = np.empty((0,), dtype=bool)


class AlertManager:
    def __init__(self):
        self.current_status = "Normal"
        self.last_alert_time = None
        self.alert_cooldown = 5
        self.normal_threshold = 40
        self.warning_threshold = 80

    def calculate_score(self, eye_data, yawn_data, head_data, no_face=False):
        score = 0
        if eye_data["is_drowsy"]:
            score += 40
        elif eye_data["eyes_closed"]:
            score += 20
        if eye_data["closed_sec"] > 1.0:
            score += 20
        if yawn_data["yawn_detected"]:
            score += 25
        elif yawn_data["mouth_open"]:
            score += 10
        if head_data["head_distracted"]:
            score += 25
        elif head_data["head_warn"]:
            score += 10
        if no_face:
            score += 15
        return min(score, 100)

    def update(self, score):
        if score >= self.warning_threshold:
            status = "Alert"
        elif score >= self.normal_threshold:
            status = "Warning"
        else:
            status = "Normal"
        if status == "Alert":
            if self.last_alert_time is None or time.time() - self.last_alert_time >= self.alert_cooldown:
                self.last_alert_time = time.time()
        self.current_status = status
        return status, score


class DrowsinessDetector:
    def __init__(self, ear_thresh, t_now, baseline_ear=None):
        self.ear_thresh = ear_thresh
        self.baseline_ear = baseline_ear if baseline_ear is not None else ear_thresh / EAR_CALIB_RATIO
        # 일반 임계값보다 더 낮은, "진짜 감김" 판정용 임계값
        self.ear_close_thresh = self.ear_thresh * 0.78

        self.eye_det = EyeDetector()
        self.head_pose = HeadPose()
        self.scorer = AttentionScorer(t_now, self.ear_close_thresh)
        self.alert_mgr = AlertManager()


        self.mouth_frame_cnt = 0
        self.yawn_count = 0
        self.moe_timer = 0.0
        self.face_miss_start = None
        self.warning_times = deque()
        self.warning_count = 0
        self.prev_pitch = 0.0
        self.headbang_cnt = 0
        self.prev_ear = ear_thresh
        self.prev_roll = 0.0
        self.base_roll = 0.0
        self.base_roll_cnt = 0
        self.prev_state = "FOCUSED"
        self._was_warning = False
        # EAR smoothing (반사/노이즈 대응)
        self.ear_hist = deque(maxlen=5)
        
       # 시간 기반 상태 추적용
        self.drowsy_elapsed = 0.0     # 졸음 징후 누적 시간
        self.recovery_elapsed = 0.0   # 정상 회복 누적 시간
        self.WARNING_SEC = 15.0       # 15초 후 졸음 의심
        self.DROWSY_SEC = 30.0        # 30초 후 졸음 확정
        self.RECOVER_WARNING_SEC = 5.0   # 회복 시작 후 WARNING 유지
        self.RECOVER_FOCUSED_SEC = 10.0  # 정상 10초 유지 시 FOCUSED

    def reset_tracking(self, t_now):
        self.scorer.reset_tracking(t_now)
        self.mouth_frame_cnt = 0
        self.moe_timer = 0.0
        self.face_miss_start = None
        self.warning_times.clear()
        self.warning_count = 0
        self.prev_pitch = 0.0
        self.headbang_cnt = 0
        self.prev_state = "FOCUSED"
        self._was_warning = False
        self.ear_hist.clear()
        self.drowsy_elapsed = 0.0
        self.recovery_elapsed = 0.0

    def update(self, frame, lms, t_now):
        frame_size = (frame.shape[1], frame.shape[0])
        fw, fh = frame_size

        result = {
            "final_state": "FOCUSED",
            "ear": self.prev_ear,
            "ear_left": 0.0,
            "ear_right": 0.0,
            "perclos": 0.0,
            "gaze": 0.0,
            "mar": 0.0,
            "moe": 0.0,
            "roll": self.prev_roll,
            "pitch": 0.0,
            "yaw": 0.0,
            "drowsiness_score": 0,
            "yawn_count": self.yawn_count,
            "warning_count": self.warning_count,
            "face_detected": lms is not None,
            "absent_sec": 0.0,
            "bbox": {},
            "frame_w": fw,
            "frame_h": fh,
        }

        if not lms:
            if self.face_miss_start is None:
                self.face_miss_start = t_now
            absent_sec = t_now - self.face_miss_start
            result["absent_sec"] = absent_sec
            likely_drowsy = (
                self.prev_state in {"WARNING", "DROWSY"} or
                self.prev_ear < self.ear_thresh or
                abs(self.prev_roll) > ROLL_THRESH
            )
            if likely_drowsy and absent_sec >= FACE_MISSING_SLEEP_SEC:
                result["final_state"] = "ABSENT"
                self.prev_state = "ABSENT"
            elif absent_sec >= ABSENT_SEC:
                result["final_state"] = "ABSENT"
                self.prev_state = "ABSENT"
            return result

        self.face_miss_start = None
        landmarks = get_landmarks(lms)
        lms_raw = lms[0].landmark
        
        #좌/우 눈 EAR
        ear_l, ear_r = self.eye_det.get_EAR_each(landmarks)
        ear_mean = (ear_l + ear_r) / 2.0
        ear_raw = self.eye_det.get_EAR(landmarks)
        ear = ear_raw

        # 한쪽 눈 반사/가림에 너무 끌려가지 않도록 균형형 결합
        ear_raw = 0.5 * min(ear_l, ear_r) + 0.5 * ear_mean

        if not (EAR_VALID_MIN < ear_raw < EAR_VALID_MAX):
            result["ear"] = ear_raw
            return result
        
        # EAR smoothing 적용
        self.ear_hist.append(ear_raw)
        ear = float(np.median(self.ear_hist))   # 반사로 튀는 값 제거

        roll, pitch, yaw = self.head_pose.get_pose(landmarks, frame_size)

        gaze = self.eye_det.get_Gaze_Score(landmarks, frame_size)
        mouth_feat = get_mouth_features(lms_raw)
        mar = mouth_feat["mar"]
        mouth_width = mouth_feat["mouth_width"]
        mouth_height = mouth_feat["mouth_height"]

        moe = mar / (ear + 1e-6)
        
        elapsed = max(0.0, t_now - self.scorer.last_time)
        perclos = self.scorer.get_rolling_PERCLOS(t_now, ear)
        asleep, looking_away, distracted = self.scorer.eval_scores(t_now, ear, gaze, roll, pitch, yaw)

        self.prev_ear = ear
        if roll is not None:
            self.prev_roll = roll
            if self.base_roll_cnt < 60:
                self.base_roll_cnt += 1
                self.base_roll = (
                    (self.base_roll * (self.base_roll_cnt - 1) + roll) /
                    self.base_roll_cnt
                )

        ear_l, ear_r = self.eye_det.get_EAR_each(landmarks)
        ear_mean = (ear_l + ear_r) / 2.0
        ear_raw = 0.5 * min(ear_l, ear_r) + 0.5 * ear_mean

        yawn_candidate = (
            mar > MAR_THRESH and
            (moe > 2.0 or perclos >= 0.06)
            )
        
        if yawn_candidate:
            self.mouth_frame_cnt += 1
        else:
            if self.mouth_frame_cnt >= MAR_FRAMES:
                self.yawn_count += 1
            self.mouth_frame_cnt = 0

        yawn_detected = self.mouth_frame_cnt >= MAR_FRAMES

        if moe > MOE_THRESH:
            self.moe_timer += 1 / 30
        else:
            self.moe_timer = 0.0
        moe_alert = self.moe_timer >= MOE_SEC

        headbanging = False
        if pitch is not None:
            delta = abs(pitch - self.prev_pitch)
            if delta > HEADBANG_DELTA:
                self.headbang_cnt += 1
            else:
                self.headbang_cnt = max(0, self.headbang_cnt - 1)
            self.prev_pitch = pitch
            headbanging = self.headbang_cnt >= HEADBANG_COUNT and perclos >= PERCLOS_WARNING

        distr = distracted or (looking_away and yaw is not None and abs(yaw) > 12.0)
        eye_data = {
            "is_drowsy": asleep,
            "eyes_closed": (
                ear < self.ear_close_thresh and
                self.scorer.closure_time > 0.6
            ),
            "closed_sec": self.scorer.closure_time,
        }
        yawn_data = {
            "yawn_detected": yawn_detected,
            "mouth_open": mar > MAR_THRESH,
        }
        head_data = {
            "head_distracted": distr,
            "head_warn": (
                (roll is not None and abs(roll) > ROLL_THRESH * 0.7) or
                (pitch is not None and abs(pitch) > PITCH_THRESH * 0.7) or
                (yaw is not None and abs(yaw) > YAW_THRESH * 0.7)
            ),
        }
        _, drowsiness_score = self.alert_mgr.update(
            self.alert_mgr.calculate_score(eye_data, yawn_data, head_data, no_face=False)
        )

        cutoff = t_now - WARNING_WINDOW_MIN * 60
        while self.warning_times and self.warning_times[0] < cutoff:
             self.warning_times.popleft()
        self.warning_count = len(self.warning_times)
        # 현재 프레임 기준 강한 졸음
        drowsy_now = (
            asleep or
            perclos >= PERCLOS_DROWSY or
            headbanging
        )
        # 현재 프레임 기준 경고
        warning_now = (
            yawn_detected or
            PERCLOS_WARNING <= perclos < PERCLOS_DROWSY or
            moe_alert
        )
        # 누적 경고는 보조 판단으로만 사용
        warning_accumulated = self.warning_count >= WARNING_MAX_COUNT
        # 현재 프레임이 정상 범위인지
        normal_now = (
           (ear >= self.ear_close_thresh) and
           (perclos < PERCLOS_WARNING) and
           (not yawn_detected) and
           (not moe_alert) and
           (not distr) and
           (not asleep) and
           (not headbanging)
        )

        # 졸음 징후 누적 / 회복 누적
        fatigue_signal = drowsy_now or warning_now

        if fatigue_signal:
            self.drowsy_elapsed += elapsed
            self.recovery_elapsed = 0.0
        elif normal_now:
            self.recovery_elapsed += elapsed
            self.drowsy_elapsed = max(0.0, self.drowsy_elapsed - elapsed * 2.0)
        else:
            # 애매한 상태면 천천히 감소
            self.recovery_elapsed = 0.0
            self.drowsy_elapsed = max(0.0, self.drowsy_elapsed - elapsed * 0.5)

        # 최종 상태 결정
        if self.drowsy_elapsed >= self.DROWSY_SEC:
            final_state = "DROWSY"
        elif self.drowsy_elapsed >= self.WARNING_SEC:
            final_state = "WARNING"
        elif self.prev_state == "DROWSY" and self.recovery_elapsed < self.RECOVER_FOCUSED_SEC:
            # DROWSY에서 막 회복 중이면 바로 FOCUSED로 가지 않고 WARNING 유지
            final_state = "WARNING"
        elif distr:
            final_state = "DISTRACTED"
        else:
            final_state = "FOCUSED"

        # 충분히 회복하면 누적 초기화
        if final_state == "FOCUSED" and self.recovery_elapsed >= self.RECOVER_FOCUSED_SEC:
            self.drowsy_elapsed = 0.0
            self.warning_times.clear()
            self.warning_count = 0

        if final_state == "WARNING" and not self._was_warning:
            self.warning_times.append(t_now)
        self._was_warning = final_state == "WARNING"
        self.prev_state = final_state

        bbox = {}
        l_pts = [lms_raw[i] for i in LEFT_EYE_IDX]
        lxs = [int(p.x * fw) for p in l_pts]
        lys = [int(p.y * fh) for p in l_pts]
        bbox["eye_l"] = [min(lxs) - 5, min(lys) - 5, max(lxs) + 5, max(lys) + 5]

        r_pts = [lms_raw[i] for i in RIGHT_EYE_IDX]
        rxs = [int(p.x * fw) for p in r_pts]
        rys = [int(p.y * fh) for p in r_pts]
        bbox["eye_r"] = [min(rxs) - 5, min(rys) - 5, max(rxs) + 5, max(rys) + 5]

        m_pts = [lms_raw[i] for i in MOUTH_IDX]
        mxs = [int(p.x * fw) for p in m_pts]
        mys = [int(p.y * fh) for p in m_pts]
        bbox["mouth"] = [min(mxs) - 5, min(mys) - 5, max(mxs) + 5, max(mys) + 5]

        self.eye_det.show_iris(frame, landmarks, frame_size)
        self._draw_eye_boxes(frame, lms_raw, frame_size, roll=roll)
        draw_mouth_box(frame, lms_raw, frame_size, yawn_detected, mar)

        result.update({
            "final_state": final_state,
            "ear": round(ear, 3),
            "ear_left": round(ear_l, 3),
            "ear_right": round(ear_r, 3),
            "perclos": round(perclos, 3),
            "gaze": round(gaze, 3),
            "mar": round(mar, 3),
            "moe": round(moe, 2),
            "roll": round(roll, 1) if roll is not None else 0.0,
            "pitch": round(pitch, 1) if pitch is not None else 0.0,
            "yaw": round(yaw, 1) if yaw is not None else 0.0,
            "drowsiness_score": drowsiness_score,
            "yawn_count": self.yawn_count,
            "warning_count": self.warning_count,
            "face_detected": True,
            "absent_sec": 0.0,
            "bbox": bbox,
            "frame_w": fw,
            "frame_h": fh,
        })
        return result

    def _draw_eye_boxes(self, frame, lms_raw, frame_size, roll=None):
        fw, fh = frame_size
        closed_thresh = self.ear_close_thresh
        narrow_thresh = self.ear_thresh * 1.00

        for eye_idx in [LEFT_EYE_IDX, RIGHT_EYE_IDX]:
            pts = [lms_raw[j] for j in eye_idx]
            xs = [int(p.x * fw) for p in pts]
            ys = [int(p.y * fh) for p in pts]
            arr = np.array([[p.x, p.y] for p in pts])
            v1 = LA.norm(arr[2] - arr[3])
            v2 = LA.norm(arr[4] - arr[5])
            h_dist = LA.norm(arr[0] - arr[1]) + 1e-6
            # robust EAR
            v_small = min(v1, v2)
            v_mean = (v1 + v2) / 2.0
            e_ear = (0.7 * v_small + 0.3 * v_mean) / h_dist

            if e_ear < closed_thresh:
                color = (0, 0, 255) 
                label = "Closed"
            elif e_ear < narrow_thresh:
                color = (0, 165, 255)
                label = "Narrow"
            else:
                color = (0, 255, 0)
                label = "Open"
            cv2.rectangle(frame, (min(xs) - 5, min(ys) - 5), (max(xs) + 5, max(ys) + 5), color, 2)
            cv2.putText(frame, label, (min(xs) - 5, min(ys) - 10), cv2.FONT_HERSHEY_PLAIN, 1.2, color, 1)
