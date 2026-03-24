import time

import cv2
import mediapipe as mp
import numpy as np

STATE_MONITORING = "MONITORING"
STATE_COUNTDOWN = "COUNTDOWN"
STATE_STRETCHING = "STRETCHING"
STATE_REWARD = "REWARD"

COUNTDOWN_SEC = 3
MISSION_SEC = 15
REWARD_SEC = 3
HOLD_SEC = 3.0
ARM_ANGLE_THRESH = 150


def calculate_angle(a, b, c):
    a = np.array(a)
    b = np.array(b)
    c = np.array(c)
    radians = np.arctan2(c[1] - b[1], c[0] - b[0]) - np.arctan2(a[1] - b[1], a[0] - b[0])
    angle = np.abs(radians * 180.0 / np.pi)
    if angle > 180.0:
        angle = 360 - angle
    return angle


class StretchMission:
    def __init__(self):
        self.mp_pose = mp.solutions.pose
        self.mp_drawing = mp.solutions.drawing_utils
        self.pose_model = self.mp_pose.Pose(
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )

        self.state = STATE_MONITORING
        self.state_start_time = 0.0
        self.stretch_hold_start = None
        self.participation_score = 0
        self.last_mission_time = 0.0
        self.mission_cooldown = 60.0

    def update(self, final_state, frame):
        now = time.time()
        mission_success = False

        if self.state == STATE_MONITORING:
            if final_state == "DROWSY" and now - self.last_mission_time >= self.mission_cooldown:
                self.state = STATE_COUNTDOWN
                self.state_start_time = now

        elif self.state == STATE_COUNTDOWN:
            elapsed = now - self.state_start_time
            remain = COUNTDOWN_SEC - int(elapsed)

            overlay = np.zeros_like(frame, dtype=np.uint8)
            overlay[:] = (0, 165, 255)
            frame = cv2.addWeighted(frame, 0.6, overlay, 0.4, 0)
            cv2.putText(frame, "Drowsiness Detected!", (50, 180), cv2.FONT_HERSHEY_PLAIN, 2.5, (255, 255, 255), 3)
            cv2.putText(frame, f"Stretch mission in {remain}...", (50, 230), cv2.FONT_HERSHEY_PLAIN, 2, (255, 255, 255), 2)

            if elapsed >= COUNTDOWN_SEC:
                self.state = STATE_STRETCHING
                self.state_start_time = now
                self.stretch_hold_start = None

        elif self.state == STATE_STRETCHING:
            elapsed = now - self.state_start_time
            time_left = MISSION_SEC - int(elapsed)
            cv2.putText(frame, f"Mission: {time_left}s left", (10, 80), cv2.FONT_HERSHEY_PLAIN, 2, (0, 0, 255), 2)

            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            pose_result = self.pose_model.process(frame_rgb)

            if pose_result.pose_landmarks:
                upper_conns = [c for c in self.mp_pose.POSE_CONNECTIONS if c[0] > 10 and c[1] > 10]
                self.mp_drawing.draw_landmarks(
                    frame,
                    pose_result.pose_landmarks,
                    upper_conns,
                    self.mp_drawing.DrawingSpec(color=(0, 255, 255), thickness=2, circle_radius=0),
                    self.mp_drawing.DrawingSpec(color=(0, 200, 200), thickness=2),
                )

                plm = pose_result.pose_landmarks.landmark
                pl = self.mp_pose.PoseLandmark

                nose_y = plm[pl.NOSE.value].y
                lw_y = plm[pl.LEFT_WRIST.value].y
                rw_y = plm[pl.RIGHT_WRIST.value].y

                l_s = [plm[pl.LEFT_SHOULDER.value].x, plm[pl.LEFT_SHOULDER.value].y]
                l_e = [plm[pl.LEFT_ELBOW.value].x, plm[pl.LEFT_ELBOW.value].y]
                l_w = [plm[pl.LEFT_WRIST.value].x, plm[pl.LEFT_WRIST.value].y]

                r_s = [plm[pl.RIGHT_SHOULDER.value].x, plm[pl.RIGHT_SHOULDER.value].y]
                r_e = [plm[pl.RIGHT_ELBOW.value].x, plm[pl.RIGHT_ELBOW.value].y]
                r_w = [plm[pl.RIGHT_WRIST.value].x, plm[pl.RIGHT_WRIST.value].y]

                l_ang = calculate_angle(l_s, l_e, l_w)
                r_ang = calculate_angle(r_s, r_e, r_w)
                arms_ok = l_ang > ARM_ANGLE_THRESH and r_ang > ARM_ANGLE_THRESH
                hands_up = lw_y < nose_y and rw_y < nose_y

                if arms_ok and hands_up:
                    if self.stretch_hold_start is None:
                        self.stretch_hold_start = now
                    held = now - self.stretch_hold_start
                    cv2.putText(frame, f"HOLD! {held:.1f} / {HOLD_SEC}s", (50, 150), cv2.FONT_HERSHEY_PLAIN, 2, (0, 255, 0), 3)
                    if held >= HOLD_SEC:
                        self.participation_score += 10
                        self.state = STATE_REWARD
                        self.state_start_time = now
                        self.last_mission_time = now
                        mission_success = True
                else:
                    self.stretch_hold_start = None
                    cv2.putText(frame, "Raise both arms straight up!", (30, 150), cv2.FONT_HERSHEY_PLAIN, 1.5, (0, 0, 255), 2)

            if elapsed >= MISSION_SEC:
                self.state = STATE_MONITORING
                self.last_mission_time = now

        elif self.state == STATE_REWARD:
            elapsed = now - self.state_start_time
            overlay = np.zeros_like(frame, dtype=np.uint8)
            overlay[:] = (0, 255, 0)
            frame = cv2.addWeighted(frame, 0.6, overlay, 0.4, 0)
            cv2.putText(frame, f"PERFECT! +10pts (Total: {self.participation_score})", (30, 250), cv2.FONT_HERSHEY_PLAIN, 2, (255, 255, 255), 3)
            if elapsed >= REWARD_SEC:
                self.state = STATE_MONITORING

        in_mission = self.state != STATE_MONITORING
        return frame, in_mission, mission_success

    def close(self):
        self.pose_model.close()
