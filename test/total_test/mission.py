"""
mission.py - FocusRoom 기지개 미션 전담 모듈

[출처 및 참고]
- calculate_angle, 상태머신 4단계, 3초 유지 로직
    → mission_pose.py (팀원 코드) 동일 유지
- Pose 시각화 (상반신만, 얼굴 제외)
    → 얼굴 랜드마크(0~10) 제외, circle_radius=0으로 점 숨김
"""

import time
import cv2
import numpy as np
import mediapipe as mp

# ════════════════════════════════════════════════════════════════
# 상태 머신 상수 (mission_pose.py 동일)
# ════════════════════════════════════════════════════════════════
STATE_MONITORING = "MONITORING"   # 감지 중
STATE_COUNTDOWN  = "COUNTDOWN"    # 카운트다운 (3초)
STATE_STRETCHING = "STRETCHING"   # 기지개 미션 (15초)
STATE_REWARD     = "REWARD"       # 성공 보상 (3초)

# ── 미션 설정값 ──────────────────────────────────────────────────
COUNTDOWN_SEC    = 3    # 카운트다운 시간
MISSION_SEC      = 15   # 미션 제한 시간
REWARD_SEC       = 3    # 보상 표시 시간
HOLD_SEC         = 3.0  # 성공 인정 자세 유지 시간
ARM_ANGLE_THRESH = 150  # 팔 쫙 폈는지 판단 각도 (도)


# ════════════════════════════════════════════════════════════════
# 보조 함수
# ════════════════════════════════════════════════════════════════

def calculate_angle(a, b, c):
    """
    세 관절의 각도 계산 (팔꿈치 각도 판단용)
    출처: mission_pose.py calculate_angle (동일)

    Parameters
    ----------
    a : [x, y] - 시작점 (어깨)
    b : [x, y] - 중간점 (팔꿈치)
    c : [x, y] - 끝점   (손목)
    """
    a = np.array(a)
    b = np.array(b)
    c = np.array(c)
    radians = (np.arctan2(c[1]-b[1], c[0]-b[0]) -
               np.arctan2(a[1]-b[1], a[0]-b[0]))
    angle = np.abs(radians * 180.0 / np.pi)
    if angle > 180.0:
        angle = 360 - angle
    return angle


# ════════════════════════════════════════════════════════════════
# StretchMission 클래스
# 출처: mission_pose.py 리팩토링 (클래스화, 로직 동일)
# ════════════════════════════════════════════════════════════════

class StretchMission:
    """
    DROWSY 감지 시 자동 발동되는 기지개 미션

    상태 흐름:
      MONITORING → (DROWSY 감지) → COUNTDOWN → STRETCHING → REWARD → MONITORING

    성공 조건:
      팔꿈치 각도 > 150도 (팔 쫙 펴짐)
      AND 손목이 코보다 높이 위치
      AND 3초 이상 유지
    """

    def __init__(self):
        # MediaPipe Pose 초기화
        self.mp_pose    = mp.solutions.pose
        self.mp_drawing = mp.solutions.drawing_utils
        self.pose_model = self.mp_pose.Pose(
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5
        )

        # 상태 머신 변수
        self.state            = STATE_MONITORING
        self.state_start_time = 0.0
        self.stretch_hold_start = None  # 성공 자세 유지 시작 시간
        self.participation_score = 0    # 누적 참여 점수

        # DROWSY 연속 발동 방지 쿨다운
        self.last_mission_time = 0.0
        self.mission_cooldown  = 60.0  # 60초 쿨다운

    def update(self, final_state, frame):
        """
        매 프레임 호출 → 미션 상태 업데이트 + 프레임에 시각화

        Parameters
        ----------
        final_state : str  - DrowsinessDetector.update() 반환 상태
        frame       : numpy array - BGR 프레임 (in-place 수정)

        Returns
        -------
        frame : 시각화가 적용된 프레임
        in_mission : bool - 미션 진행 중 여부 (main.py 참고용)
        """
        now = time.time()

        # ── MONITORING: DROWSY 감지 시 COUNTDOWN 진입 ────────
        if self.state == STATE_MONITORING:
            if (final_state == "DROWSY" and
                    now - self.last_mission_time >= self.mission_cooldown):
                self.state            = STATE_COUNTDOWN
                self.state_start_time = now

        # ── COUNTDOWN: 3초 카운트다운 ─────────────────────────
        elif self.state == STATE_COUNTDOWN:
            elapsed = now - self.state_start_time
            remain  = COUNTDOWN_SEC - int(elapsed)

            # 주황색 오버레이
            overlay    = np.zeros_like(frame, dtype=np.uint8)
            overlay[:] = (0, 165, 255)
            frame      = cv2.addWeighted(frame, 0.6, overlay, 0.4, 0)

            cv2.putText(frame, "Drowsiness Detected!",
                        (50, 180), cv2.FONT_HERSHEY_PLAIN,
                        2.5, (255, 255, 255), 3)
            cv2.putText(frame, f"Stretch mission in {remain}...",
                        (50, 230), cv2.FONT_HERSHEY_PLAIN,
                        2, (255, 255, 255), 2)

            if elapsed >= COUNTDOWN_SEC:
                self.state              = STATE_STRETCHING
                self.state_start_time   = now
                self.stretch_hold_start = None

        # ── STRETCHING: 기지개 미션 (15초) ───────────────────
        elif self.state == STATE_STRETCHING:
            elapsed   = now - self.state_start_time
            time_left = MISSION_SEC - int(elapsed)

            cv2.putText(frame, f"Mission: {time_left}s left",
                        (10, 80), cv2.FONT_HERSHEY_PLAIN,
                        2, (0, 0, 255), 2)

            # Pose 감지 및 시각화
            frame_rgb   = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            pose_result = self.pose_model.process(frame_rgb)

            if pose_result.pose_landmarks:
                # ── 상반신만 시각화 (얼굴 랜드마크 0~10 제외) ──
                # 출처: main.py 수정 내용 적용
                upper_conns = [
                    c for c in self.mp_pose.POSE_CONNECTIONS
                    if c[0] > 10 and c[1] > 10
                ]
                self.mp_drawing.draw_landmarks(
                    frame,
                    pose_result.pose_landmarks,
                    upper_conns,
                    # circle_radius=0 → 관절 점 숨김, 연결선만 표시
                    self.mp_drawing.DrawingSpec(
                        color=(0, 255, 255), thickness=2, circle_radius=0),
                    self.mp_drawing.DrawingSpec(
                        color=(0, 200, 200), thickness=2)
                )

                # ── 자세 판단 ────────────────────────────────
                plm    = pose_result.pose_landmarks.landmark
                PL     = self.mp_pose.PoseLandmark

                nose_y = plm[PL.NOSE.value].y
                lw_y   = plm[PL.LEFT_WRIST.value].y
                rw_y   = plm[PL.RIGHT_WRIST.value].y

                # 왼팔 좌표
                l_s = [plm[PL.LEFT_SHOULDER.value].x,
                       plm[PL.LEFT_SHOULDER.value].y]
                l_e = [plm[PL.LEFT_ELBOW.value].x,
                       plm[PL.LEFT_ELBOW.value].y]
                l_w = [plm[PL.LEFT_WRIST.value].x,
                       plm[PL.LEFT_WRIST.value].y]

                # 오른팔 좌표
                r_s = [plm[PL.RIGHT_SHOULDER.value].x,
                       plm[PL.RIGHT_SHOULDER.value].y]
                r_e = [plm[PL.RIGHT_ELBOW.value].x,
                       plm[PL.RIGHT_ELBOW.value].y]
                r_w = [plm[PL.RIGHT_WRIST.value].x,
                       plm[PL.RIGHT_WRIST.value].y]

                # 조건 1: 팔 쫙 폈는지 (팔꿈치 각도 > 150도)
                l_ang     = calculate_angle(l_s, l_e, l_w)
                r_ang     = calculate_angle(r_s, r_e, r_w)
                arms_ok   = l_ang > ARM_ANGLE_THRESH and r_ang > ARM_ANGLE_THRESH

                # 조건 2: 손목이 코보다 높이 있는지 (y좌표 작을수록 높음)
                hands_up  = lw_y < nose_y and rw_y < nose_y

                if arms_ok and hands_up:
                    # 성공 자세 유지 시간 측정
                    if self.stretch_hold_start is None:
                        self.stretch_hold_start = now
                    held = now - self.stretch_hold_start

                    cv2.putText(frame, f"HOLD! {held:.1f} / {HOLD_SEC}s",
                                (50, 150), cv2.FONT_HERSHEY_PLAIN,
                                2, (0, 255, 0), 3)

                    # 3초 유지 → 성공
                    if held >= HOLD_SEC:
                        self.participation_score += 10
                        self.state               = STATE_REWARD
                        self.state_start_time    = now
                        self.last_mission_time   = now
                else:
                    # 자세 흐트러지면 유지 타이머 리셋
                    self.stretch_hold_start = None
                    cv2.putText(frame, "Raise both arms straight up!",
                                (30, 150), cv2.FONT_HERSHEY_PLAIN,
                                1.5, (0, 0, 255), 2)

            # 15초 초과 → 실패, MONITORING으로 복귀
            if elapsed >= MISSION_SEC:
                self.state             = STATE_MONITORING
                self.last_mission_time = now

        # ── REWARD: 성공 보상 (3초) ──────────────────────────
        elif self.state == STATE_REWARD:
            elapsed = now - self.state_start_time

            # 초록 오버레이
            overlay    = np.zeros_like(frame, dtype=np.uint8)
            overlay[:] = (0, 255, 0)
            frame      = cv2.addWeighted(frame, 0.6, overlay, 0.4, 0)

            cv2.putText(frame,
                        f"PERFECT! +10pts (Total: {self.participation_score})",
                        (30, 250), cv2.FONT_HERSHEY_PLAIN,
                        2, (255, 255, 255), 3)

            if elapsed >= REWARD_SEC:
                self.state = STATE_MONITORING

        in_mission = self.state != STATE_MONITORING
        return frame, in_mission

    def close(self):
        """MediaPipe Pose 리소스 해제"""
        self.pose_model.close()