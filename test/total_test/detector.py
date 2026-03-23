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
    LEFT_EYE_IDX,
    RIGHT_EYE_IDX,
    MOUTH_IDX,
    EAR_VALID_MIN,
    EAR_VALID_MAX,
    EAR_CALIB_FRAMES,
    EAR_CALIB_RATIO,
)

EAR_DROWSY_SEC = 4.0
PERCLOS_WINDOW = 60
PERCLOS_WARNING = 0.20
PERCLOS_DROWSY = 0.30
DECAY_FACTOR = 0.9

MAR_THRESH = 0.70
MAR_FRAMES = 20
MOE_THRESH = 2.0
MOE_SEC = 3.0

YAW_THRESH = 20.0
YAW_ASSIST = 15.0
PITCH_THRESH = 20.0
ROLL_THRESH = 20.0
DISTRACTED_SEC = 2.5
HEADBANG_DELTA = 10.0
HEADBANG_COUNT = 3

GAZE_THRESH = 0.015
ABSENT_SEC = 3.0
FACE_MISSING_SLEEP_SEC = 0.5

WARNING_MAX_COUNT = 3
WARNING_WINDOW_MIN = 10


class AttentionScorer:
    def __init__(self, t_now, ear_thresh):
        self.ear_thresh = ear_thresh
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
            ear is not None and ear <= self.ear_thresh,
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
        pitch_cond = pitch is not None and abs(pitch) > PITCH_THRESH
        roll_cond = roll is not None and abs(roll) > ROLL_THRESH
        head_cond = yaw_basic or yaw_assist or pitch_cond or roll_cond
        self.distracted_time = self._update(self.distracted_time, head_cond, elapsed)

        asleep = self.closure_time >= EAR_DROWSY_SEC
        looking_away = self.gaze_time >= DISTRACTED_SEC
        distracted = self.distracted_time >= DISTRACTED_SEC
        return asleep, looking_away, distracted

    def get_rolling_PERCLOS(self, t_now, ear):
        eye_closed = ear is not None and ear <= self.ear_thresh
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

        self.eye_det = EyeDetector()
        self.head_pose = HeadPose()
        self.scorer = AttentionScorer(t_now, ear_thresh)
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

        ear = self.eye_det.get_EAR(landmarks)
        if not (EAR_VALID_MIN < ear < EAR_VALID_MAX):
            result["ear"] = ear
            return result

        roll, pitch, yaw = self.head_pose.get_pose(landmarks, frame_size)
        if roll is not None and abs(roll - self.base_roll) > 6.0:
            ear = ear * (1 + abs(roll) / 15)

        gaze = self.eye_det.get_Gaze_Score(landmarks, frame_size)
        mar = calculate_mar(lms_raw)
        moe = mar / (ear + 1e-6)
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

        if mar > MAR_THRESH:
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

        distr = distracted or looking_away
        eye_data = {
            "is_drowsy": asleep,
            "eyes_closed": ear < self.ear_thresh,
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

        drowsy = (
            asleep or
            perclos >= PERCLOS_DROWSY or
            headbanging or
            self.warning_count >= WARNING_MAX_COUNT
        )
        warning = (
            yawn_detected or
            PERCLOS_WARNING <= perclos < PERCLOS_DROWSY or
            moe_alert
        )

        if drowsy:
            final_state = "DROWSY"
        elif warning:
            final_state = "WARNING"
        elif distr:
            final_state = "DISTRACTED"
        else:
            final_state = "FOCUSED"

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
        closed_thresh = self.ear_thresh * 0.9

        for eye_idx in [LEFT_EYE_IDX, RIGHT_EYE_IDX]:
            pts = [lms_raw[j] for j in eye_idx]
            xs = [int(p.x * fw) for p in pts]
            ys = [int(p.y * fh) for p in pts]
            arr = np.array([[p.x, p.y] for p in pts])
            v1 = LA.norm(arr[2] - arr[3])
            v2 = LA.norm(arr[4] - arr[5])
            h_dist = LA.norm(arr[0] - arr[1])
            e_ear = (v1 + v2) / (2.0 * h_dist + 1e-6)

            if roll is not None and abs(roll - self.base_roll) > 6.0:
                e_ear = e_ear * (1 + abs(roll) / 15)

            is_closed = e_ear < closed_thresh
            color = (0, 0, 255) if is_closed else (0, 255, 0)
            label = "Closed" if is_closed else "Open"
            cv2.rectangle(frame, (min(xs) - 5, min(ys) - 5), (max(xs) + 5, max(ys) + 5), color, 2)
            cv2.putText(frame, label, (min(xs) - 5, min(ys) - 10), cv2.FONT_HERSHEY_PLAIN, 1.2, color, 1)
