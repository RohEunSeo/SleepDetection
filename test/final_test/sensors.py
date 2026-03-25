import math

import cv2
import numpy as np
from numpy import linalg as LA
from pose_estimation import HeadPoseEstimator

LEFT_EYE_IDX = [33, 133, 160, 144, 158, 153]
RIGHT_EYE_IDX = [362, 263, 385, 380, 387, 373]
LEFT_IRIS = 468
RIGHT_IRIS = 473

MOUTH_IDX = [13, 14, 17, 18, 78, 308]
POSE_LMS_IDX = [1, 152, 33, 263, 61, 291]

POSE_3D_MODEL = np.array([
    [0.0, 0.0, 0.0],
    [0.0, -330.0, -65.0],
    [-225.0, 170.0, -135.0],
    [225.0, 170.0, -135.0],
    [-150.0, -150.0, -125.0],
    [150.0, -150.0, -125.0],
], dtype=np.float64)

EAR_VALID_MIN = 0.05
EAR_VALID_MAX = 0.50
EAR_CALIB_FRAMES = 90
EAR_CALIB_RATIO = 0.75
MAR_THRESH_VIZ = 0.70


def get_landmarks(lms):
    surface = 0.0
    biggest = None
    for lms0 in lms:
        arr = np.array([[p.x, p.y, p.z] for p in lms0.landmark])
        arr[:, 0] = np.clip(arr[:, 0], 0.0, 1.0)
        arr[:, 1] = np.clip(arr[:, 1], 0.0, 1.0)
        dx = arr[:, 0].max() - arr[:, 0].min()
        dy = arr[:, 1].max() - arr[:, 1].min()
        surface_now = dx * dy
        if surface_now > surface:
            surface = surface_now
            biggest = arr
    return biggest


def rot_mat_to_euler(rmat):
    rtr = np.transpose(rmat)
    r_identity = np.matmul(rtr, rmat)
    identity = np.identity(3, dtype=rmat.dtype)
    if np.linalg.norm(r_identity - identity) >= 1e-6:
        return None

    sy = (rmat[:2, 0] ** 2).sum() ** 0.5
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


class EyeDetector:
    def __init__(self):
        self.L_IRIS = LEFT_IRIS
        self.R_IRIS = RIGHT_IRIS

    @staticmethod
    def _calc_ear(eye_pts):
         v1 = LA.norm(eye_pts[2] - eye_pts[3])
         v2 = LA.norm(eye_pts[4] - eye_pts[5])
         h = LA.norm(eye_pts[0] - eye_pts[1]) + 1e-6
        # 안경 반사/랜드마크 튐 대응:
        # 더 작은 세로거리 쪽을 더 신뢰해서 EAR를 계산
         v_small = min(v1, v2)
         v_mean = (v1 + v2) / 2.0
         v_robust = 0.7 * v_small + 0.3 * v_mean
        
         return v_robust / h

    def get_EAR(self, landmarks):
        left = np.array([landmarks[i, :2] for i in LEFT_EYE_IDX])
        right = np.array([landmarks[i, :2] for i in RIGHT_EYE_IDX])
        left_ear = self._calc_ear(left)
        right_ear = self._calc_ear(right)
        # 작은 쪽(더 감긴 쪽)을 더 반영
        return 0.7 * min(left_ear, right_ear) + 0.3 * ((left_ear + right_ear) / 2.0)

    def get_EAR_each(self, landmarks):
        left = np.array([landmarks[i, :2] for i in LEFT_EYE_IDX])
        right = np.array([landmarks[i, :2] for i in RIGHT_EYE_IDX])
        return self._calc_ear(left), self._calc_ear(right)

    def get_Gaze_Score(self, landmarks, frame_size):
        del frame_size
        scores = []
        for lms_idx, iris_idx in [
            (LEFT_EYE_IDX, self.L_IRIS),
            (RIGHT_EYE_IDX, self.R_IRIS),
        ]:
            iris = landmarks[iris_idx, :2]
            xs = landmarks[lms_idx, 0]
            ys = landmarks[lms_idx, 1]
            eye_center = np.array([(xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2])
            score = LA.norm(iris - eye_center) / (eye_center[0] + 1e-6)
            scores.append(score)
        return float(np.mean(scores))

    def show_iris(self, frame, landmarks, frame_size):
        fw, fh = frame_size
        for idx in [self.L_IRIS, self.R_IRIS]:
            cx = int(landmarks[idx, 0] * fw)
            cy = int(landmarks[idx, 1] * fh)
            cv2.circle(frame, (cx, cy), 3, (255, 255, 255), cv2.FILLED)


class HeadPose:
    def __init__(self):
        self.estimator = HeadPoseEstimator(show_axis=False)

    def get_pose(self, landmarks, frame_size):
        blank = np.zeros((frame_size[1], frame_size[0], 3), dtype=np.uint8)
        return self.estimator.get_pose(blank, landmarks, frame_size)


def calculate_mar(lms_raw):
    top_mid = (
        (lms_raw[13].x + lms_raw[14].x) / 2,
        (lms_raw[13].y + lms_raw[14].y) / 2,
    )
    bottom_mid = (
        (lms_raw[17].x + lms_raw[18].x) / 2,
        (lms_raw[17].y + lms_raw[18].y) / 2,
    )
    left = lms_raw[78]
    right = lms_raw[308]
    h = math.hypot(left.x - right.x, left.y - right.y)
    v = math.hypot(top_mid[0] - bottom_mid[0], top_mid[1] - bottom_mid[1])
    return v / h if h > 0 else 0.0

def get_mouth_features(lms_raw):
    top_mid = (
        (lms_raw[13].x + lms_raw[14].x) / 2,
        (lms_raw[13].y + lms_raw[14].y) / 2,
    )
    bottom_mid = (
        (lms_raw[17].x + lms_raw[18].x) / 2,
        (lms_raw[17].y + lms_raw[18].y) / 2,
    )
    left = lms_raw[78]
    right = lms_raw[308]

    width = math.hypot(left.x - right.x, left.y - right.y)
    height = math.hypot(top_mid[0] - bottom_mid[0], top_mid[1] - bottom_mid[1])

    mar = height / width if width > 0 else 0.0

    return {
        "mouth_width": width,
        "mouth_height": height,
        "mar": mar,
    }


def draw_mouth_box(frame, lms_raw, frame_size, yawn_detected, mar):
    fw, fh = frame_size
    m_pts = [lms_raw[i] for i in MOUTH_IDX]
    mxs = [int(p.x * fw) for p in m_pts]
    mys = [int(p.y * fh) for p in m_pts]

    if yawn_detected:
        color, label = (0, 0, 255), "Yawn"
    elif mar > MAR_THRESH_VIZ:
        color, label = (0, 165, 255), "Open"
    else:
        color, label = (0, 255, 0), "Closed"

    cv2.rectangle(
        frame,
        (min(mxs) - 5, min(mys) - 5),
        (max(mxs) + 5, max(mys) + 5),
        color,
        2,
    )
    cv2.putText(
        frame,
        label,
        (min(mxs) - 5, min(mys) - 10),
        cv2.FONT_HERSHEY_PLAIN,
        1.2,
        color,
        1,
    )
