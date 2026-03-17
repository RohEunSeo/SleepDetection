"""
sensors.py - FocusRoom 지표 계산 전담 모듈

[역할]
  - 눈/입/머리 관련 원시 지표 계산
  - 바운딩박스 시각화
  - 수정 거의 필요 없는 안정적인 부분

[출처]
  - get_landmarks, rot_mat_to_euler, EyeDetector
      → e-candeloro/Driver-State-Detection (원본 로직 동일 유지)
  - HeadPose (solvePnP 6점 방식)
      → pose_estimation.py 참고, face_geometry.py 의존성 제거
  - calculate_mar, draw_mouth_box
      → test2.py (팀원 코드) 참고
  - draw_eye_boxes (Open/Tired/Closed)
      → danielsousaoliveira 방식 참고하여 새로 작성
"""

import math

import cv2
import numpy as np
from numpy import linalg as LA

# ════════════════════════════════════════════════════════════════
# 랜드마크 인덱스 상수
# ════════════════════════════════════════════════════════════════

# 눈 (EAR 계산용) - e-candeloro eye_detector.py 동일
LEFT_EYE_IDX  = [33,  133, 160, 144, 158, 153]
RIGHT_EYE_IDX = [362, 263, 385, 380, 387, 373]
LEFT_IRIS     = 468
RIGHT_IRIS    = 473

# 입 (MAR 계산용) - 입술 최대 개구점 기준
MOUTH_IDX     = [0, 17, 61, 291, 13, 14]

# Head Pose 6점 (solvePnP) - face_geometry.py 대체
POSE_LMS_IDX  = [1, 152, 33, 263, 61, 291]

# Head Pose 3D 모델 좌표 (단위: mm, 표준 얼굴 모델)
POSE_3D_MODEL = np.array([
    [0.0,    0.0,    0.0  ],   # 코끝     (1번)
    [0.0,   -330.0, -65.0 ],   # 턱       (152번)
    [-225.0, 170.0, -135.0],   # 왼쪽 눈  (33번)
    [225.0,  170.0, -135.0],   # 오른쪽 눈(263번)
    [-150.0,-150.0, -125.0],   # 왼쪽 입  (61번)
    [150.0, -150.0, -125.0],   # 오른쪽 입(291번)
], dtype=np.float64)

# EAR 유효 범위 (이상값 필터링)
EAR_VALID_MIN = 0.05
EAR_VALID_MAX = 0.50

# 캘리브레이션 상수 (main.py에서 import)
EAR_CALIB_FRAMES = 90
EAR_CALIB_RATIO  = 0.75

# MAR 임계값 (바운딩박스 색상 판단용)
MAR_THRESH_VIZ = 0.70


# ════════════════════════════════════════════════════════════════
# 유틸 함수
# 출처: e-candeloro utils.py (동일 유지)
# ════════════════════════════════════════════════════════════════

def get_landmarks(lms):
    """
    MediaPipe landmark list → numpy array (N, 3)
    여러 얼굴 중 가장 큰 얼굴만 반환
    출처: e-candeloro utils.py (동일 유지)
    """
    surface = 0
    biggest = None
    for lms0 in lms:
        arr = np.array([[p.x, p.y, p.z] for p in lms0.landmark])
        arr[:, 0] = np.clip(arr[:, 0], 0.0, 1.0)
        arr[:, 1] = np.clip(arr[:, 1], 0.0, 1.0)
        dx = arr[:, 0].max() - arr[:, 0].min()
        dy = arr[:, 1].max() - arr[:, 1].min()
        s  = dx * dy
        if s > surface:
            surface = s
            biggest = arr
    return biggest


def rot_mat_to_euler(rmat):
    """
    회전 행렬 → 오일러 각도 (도 단위)
    출처: e-candeloro utils.py (동일 유지)
    """
    rtr        = np.transpose(rmat)
    r_identity = np.matmul(rtr, rmat)
    I          = np.identity(3, dtype=rmat.dtype)
    if np.linalg.norm(r_identity - I) >= 1e-6:
        return None
    sy       = (rmat[:2, 0] ** 2).sum() ** 0.5
    singular = sy < 1e-6
    if not singular:
        x = np.arctan2(rmat[2, 1], rmat[2, 2])
        y = np.arctan2(-rmat[2, 0], sy)
        z = np.arctan2(rmat[1, 0], rmat[0, 0])
    else:
        x = np.arctan2(-rmat[1, 2], rmat[1, 1])
        y = np.arctan2(-rmat[2, 0], sy)
        z = 0
    x = np.pi - x if x > 0 else -(np.pi + x)
    z = np.pi - z if z > 0 else -(np.pi + z)
    return (np.array([x, y, z]) * 180.0 / np.pi).round(2)


# ════════════════════════════════════════════════════════════════
# EyeDetector 클래스
# 출처: e-candeloro eye_detector.py (동일 유지)
# ════════════════════════════════════════════════════════════════

class EyeDetector:
    """
    EAR + Gaze Score + 홍채 시각화
    e-candeloro eye_detector.py 로직 완전 동일 유지
    """

    def __init__(self):
        self.L_IRIS = LEFT_IRIS
        self.R_IRIS = RIGHT_IRIS

    @staticmethod
    def _calc_ear(eye_pts):
        """단일 눈 EAR 계산 (6점 방식)"""
        return (
            LA.norm(eye_pts[2] - eye_pts[3]) +
            LA.norm(eye_pts[4] - eye_pts[5])
        ) / (2 * LA.norm(eye_pts[0] - eye_pts[1]) + 1e-6)

    def get_EAR(self, landmarks):
        """양쪽 눈 EAR 평균 반환"""
        l = np.array([landmarks[i, :2] for i in LEFT_EYE_IDX])
        r = np.array([landmarks[i, :2] for i in RIGHT_EYE_IDX])
        return (self._calc_ear(l) + self._calc_ear(r)) / 2

    def get_EAR_each(self, landmarks):
        """왼쪽/오른쪽 눈 EAR 개별 반환"""
        l = np.array([landmarks[i, :2] for i in LEFT_EYE_IDX])
        r = np.array([landmarks[i, :2] for i in RIGHT_EYE_IDX])
        return self._calc_ear(l), self._calc_ear(r)

    def get_Gaze_Score(self, landmarks, frame_size):
        """홍채-눈중심 L2 거리 기반 시선 이탈 점수"""
        scores = []
        for lms_idx, iris_idx in [
            (LEFT_EYE_IDX,  self.L_IRIS),
            (RIGHT_EYE_IDX, self.R_IRIS),
        ]:
            iris       = landmarks[iris_idx, :2]
            xs         = landmarks[lms_idx, 0]
            ys         = landmarks[lms_idx, 1]
            eye_center = np.array([(xs.min()+xs.max())/2,
                                   (ys.min()+ys.max())/2])
            score      = LA.norm(iris - eye_center) / (eye_center[0] + 1e-6)
            scores.append(score)
        return float(np.mean(scores))

    def show_iris(self, frame, landmarks, frame_size):
        """홍채 위치에 흰점 표시"""
        fw, fh = frame_size
        for idx in [self.L_IRIS, self.R_IRIS]:
            cx = int(landmarks[idx, 0] * fw)
            cy = int(landmarks[idx, 1] * fh)
            cv2.circle(frame, (cx, cy), 3, (255, 255, 255), cv2.FILLED)


# ════════════════════════════════════════════════════════════════
# HeadPose 클래스
# 출처: pose_estimation.py 참고, face_geometry.py 의존성 제거
# ════════════════════════════════════════════════════════════════

class HeadPose:
    """
    MediaPipe 6점 랜드마크 기반 Roll/Pitch/Yaw 계산
    face_geometry.py(3039줄) 의존성 완전 제거
    """

    def __init__(self):
        self.camera_matrix = None
        self.dist_coeffs   = None
        self._initialized  = False

    def _init_camera(self, frame_size):
        """프레임 크기 기반 카메라 파라미터 자동 추정"""
        fw, fh = frame_size
        fl     = fw
        self.camera_matrix = np.array([
            [fl, 0,  fw / 2],
            [0,  fl, fh / 2],
            [0,  0,  1     ],
        ], dtype="double")
        self.dist_coeffs  = np.zeros((5, 1))
        self._initialized = True

    def get_pose(self, landmarks, frame_size):
        """
        Roll/Pitch/Yaw 반환 (단위: 도)
        실패 시 (None, None, None) 반환
        """
        if not self._initialized:
            self._init_camera(frame_size)

        fw, fh = frame_size
        face2d = np.array([
            [landmarks[i, 0] * fw, landmarks[i, 1] * fh]
            for i in POSE_LMS_IDX
        ], dtype=np.float64)

        ok, rvec, tvec = cv2.solvePnP(
            POSE_3D_MODEL, face2d,
            self.camera_matrix, self.dist_coeffs,
            flags=cv2.SOLVEPNP_ITERATIVE
        )
        if not ok:
            return None, None, None

        rmat, _ = cv2.Rodrigues(rvec)
        eulers  = rot_mat_to_euler(rmat)
        if eulers is None:
            return None, None, None

        # e-candeloro pose_estimation.py와 동일한 축 재배치
        rvec1    = np.array([rvec[2, 0], rvec[0, 0], rvec[1, 0]]).reshape(3, 1)
        rmat2, _ = cv2.Rodrigues(rvec1)
        eulers2  = rot_mat_to_euler(rmat2)
        if eulers2 is None:
            return None, None, None

        return float(eulers2[0]), float(eulers2[1]), float(eulers2[2])


# ════════════════════════════════════════════════════════════════
# 지표 계산 함수
# ════════════════════════════════════════════════════════════════

def calculate_mar(lms_raw):
    """
    MAR (Mouth Aspect Ratio) 계산
    출처: test2.py calculate_mar (동일)
    """
    top    = lms_raw[0]
    bottom = lms_raw[17]
    left   = lms_raw[61]
    right  = lms_raw[291]
    h = math.hypot(left.x - right.x, left.y  - right.y)
    v = math.hypot(top.x  - bottom.x, top.y  - bottom.y)
    return v / h if h > 0 else 0.0


# ════════════════════════════════════════════════════════════════
# 바운딩박스 시각화 함수
# ════════════════════════════════════════════════════════════════

def draw_mouth_box(frame, lms_raw, frame_size, yawn_detected, mar):
    """
    입 바운딩박스 + Closed/Open/Yawn 표시
    Closed(초록) / Open(주황) / Yawn(빨강)
    """
    fw, fh = frame_size
    m_pts  = [lms_raw[i] for i in MOUTH_IDX]
    mxs    = [int(p.x * fw) for p in m_pts]
    mys    = [int(p.y * fh) for p in m_pts]

    if yawn_detected:
        color, label = (0, 0, 255),   "Yawn"
    elif mar > MAR_THRESH_VIZ:
        color, label = (0, 165, 255), "Open"
    else:
        color, label = (0, 255, 0),   "Closed"

    cv2.rectangle(frame,
                  (min(mxs)-5, min(mys)-5),
                  (max(mxs)+5, max(mys)+5), color, 2)
    cv2.putText(frame, label,
                (min(mxs)-5, min(mys)-10),
                cv2.FONT_HERSHEY_PLAIN, 1.2, color, 1)