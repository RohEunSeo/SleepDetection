import argparse
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import mediapipe as mp
import numpy as np
import torch
from torchvision import models, transforms


LEFT_EYE_IDXS = [33, 160, 158, 133, 153, 144]
RIGHT_EYE_IDXS = [362, 385, 387, 263, 373, 380]
MOUTH_IDXS = [61, 13, 291, 14]
FACE_OVAL_IDXS = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
    378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
    162, 21, 54, 103, 67, 109,
]
HEAD_POSE_IDXS = [33, 263, 1, 61, 291, 199]


def build_eye_model(weight_path: Path, device: torch.device) -> torch.nn.Module:
    model = models.efficientnet_b0(weights=None)
    model.classifier[1] = torch.nn.Linear(model.classifier[1].in_features, 2)
    state_dict = torch.load(weight_path, map_location=device)
    model.load_state_dict(state_dict)
    model.to(device)
    model.eval()
    return model


def euclidean(p1: np.ndarray, p2: np.ndarray) -> float:
    return float(np.linalg.norm(p1 - p2))


def eye_aspect_ratio(points: np.ndarray) -> float:
    vertical_1 = euclidean(points[1], points[5])
    vertical_2 = euclidean(points[2], points[4])
    horizontal = euclidean(points[0], points[3]) + 1e-6
    return (vertical_1 + vertical_2) / (2.0 * horizontal)


def mouth_aspect_ratio(points: np.ndarray) -> float:
    horizontal = euclidean(points[0], points[2]) + 1e-6
    vertical = euclidean(points[1], points[3])
    return vertical / horizontal


def extract_landmarks(frame: np.ndarray, face_landmarks) -> Dict[int, np.ndarray]:
    h, w = frame.shape[:2]
    return {
        idx: np.array([lm.x * w, lm.y * h], dtype=np.float32)
        for idx, lm in enumerate(face_landmarks.landmark)
    }


def crop_region(frame: np.ndarray, points: np.ndarray, padding: float = 0.35) -> Optional[np.ndarray]:
    h, w = frame.shape[:2]
    min_xy = points.min(axis=0)
    max_xy = points.max(axis=0)
    size = max(max_xy[0] - min_xy[0], max_xy[1] - min_xy[1])
    center = (min_xy + max_xy) / 2.0
    half = (size * (1.0 + padding)) / 2.0

    x1 = max(int(center[0] - half), 0)
    y1 = max(int(center[1] - half), 0)
    x2 = min(int(center[0] + half), w)
    y2 = min(int(center[1] + half), h)

    if x2 <= x1 or y2 <= y1:
        return None
    return frame[y1:y2, x1:x2]


def estimate_head_pose(frame: np.ndarray, face_landmarks) -> Tuple[Optional[float], Optional[float]]:
    h, w = frame.shape[:2]
    face_2d: List[List[float]] = []
    face_3d: List[List[float]] = []

    for idx in HEAD_POSE_IDXS:
        lm = face_landmarks.landmark[idx]
        x, y = lm.x * w, lm.y * h
        face_2d.append([x, y])
        face_3d.append([x, y, lm.z * w])

    face_2d_np = np.array(face_2d, dtype=np.float64)
    face_3d_np = np.array(face_3d, dtype=np.float64)
    focal_length = w
    cam_matrix = np.array(
        [[focal_length, 0, w / 2], [0, focal_length, h / 2], [0, 0, 1]],
        dtype=np.float64,
    )
    dist_matrix = np.zeros((4, 1), dtype=np.float64)

    success, rot_vec, _ = cv2.solvePnP(
        face_3d_np,
        face_2d_np,
        cam_matrix,
        dist_matrix,
        flags=cv2.SOLVEPNP_ITERATIVE,
    )
    if not success:
        return None, None

    rotation_matrix, _ = cv2.Rodrigues(rot_vec)
    angles, *_ = cv2.RQDecomp3x3(rotation_matrix)
    pitch = float(angles[0] * 360)
    yaw = float(angles[1] * 360)
    return pitch, yaw


class SleepMonitor:
    def __init__(
        self,
        model_path: Path,
        label_order: str,
        camera_index: int,
        closed_seconds: float,
        absent_seconds: float,
        head_turn_deg: float,
        ear_threshold: float,
        mar_threshold: float,
    ) -> None:
        self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        self.model = build_eye_model(model_path, self.device)
        self.labels = [label.strip() for label in label_order.split(',')]
        if len(self.labels) != 2:
            raise ValueError('--labels must have exactly two labels, e.g. closed,open')

        self.transform = transforms.Compose(
            [
                transforms.ToPILImage(),
                transforms.Resize((224, 224)),
                transforms.ToTensor(),
                transforms.Normalize(
                    mean=[0.485, 0.456, 0.406],
                    std=[0.229, 0.224, 0.225],
                ),
            ]
        )
        self.camera_index = camera_index
        self.closed_seconds = closed_seconds
        self.absent_seconds = absent_seconds
        self.head_turn_deg = head_turn_deg
        self.ear_threshold = ear_threshold
        self.mar_threshold = mar_threshold

        self.face_mesh = mp.solutions.face_mesh.FaceMesh(
            static_image_mode=False,
            max_num_faces=1,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )
        self.drawing = mp.solutions.drawing_utils
        self.mesh_style = mp.solutions.drawing_styles
        self.closed_started_at: Optional[float] = None
        self.last_face_seen_at = time.time()

    def predict_eye_state(self, eye_crop: np.ndarray) -> Tuple[str, float]:
        rgb_crop = cv2.cvtColor(eye_crop, cv2.COLOR_BGR2RGB)
        tensor = self.transform(rgb_crop).unsqueeze(0).to(self.device)
        with torch.no_grad():
            logits = self.model(tensor)
            probs = torch.softmax(logits, dim=1)[0].cpu().numpy()
        idx = int(np.argmax(probs))
        return self.labels[idx], float(probs[idx])

    def blend_eye_predictions(self, frame: np.ndarray, landmarks: Dict[int, np.ndarray]) -> Tuple[str, float]:
        eye_preds: List[Tuple[str, float]] = []
        for eye_indices in (LEFT_EYE_IDXS, RIGHT_EYE_IDXS):
            points = np.array([landmarks[idx] for idx in eye_indices], dtype=np.float32)
            crop = crop_region(frame, points)
            if crop is None or crop.size == 0:
                continue
            eye_preds.append(self.predict_eye_state(crop))

        if not eye_preds:
            return 'unknown', 0.0

        score_map: Dict[str, List[float]] = {}
        for label, confidence in eye_preds:
            score_map.setdefault(label, []).append(confidence)

        best_label = max(score_map.items(), key=lambda item: np.mean(item[1]))[0]
        best_score = float(np.mean(score_map[best_label]))
        return best_label, best_score

    def draw_status(self, frame: np.ndarray, lines: List[Tuple[str, Tuple[int, int, int]]]) -> None:
        y = 30
        for text, color in lines:
            cv2.putText(frame, text, (20, y), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2, cv2.LINE_AA)
            y += 30

    def open_camera(self) -> cv2.VideoCapture:
        backends = []
        if hasattr(cv2, 'CAP_DSHOW'):
            backends.append(cv2.CAP_DSHOW)
        if hasattr(cv2, 'CAP_MSMF'):
            backends.append(cv2.CAP_MSMF)
        backends.append(None)

        for backend in backends:
            if backend is None:
                cap = cv2.VideoCapture(self.camera_index)
            else:
                cap = cv2.VideoCapture(self.camera_index, backend)
            if cap.isOpened():
                return cap
            cap.release()

        raise RuntimeError(
            f'Cannot open webcam index {self.camera_index}. '
            'Try closing Zoom/Meet, allow camera permission in Windows, or run with --camera 1.'
        )

    def run(self) -> None:
        cap = self.open_camera()

        while True:
            ok, frame = cap.read()
            if not ok:
                break

            frame = cv2.flip(frame, 1)
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = self.face_mesh.process(rgb)
            now = time.time()
            lines: List[Tuple[str, Tuple[int, int, int]]] = []

            if results.multi_face_landmarks:
                self.last_face_seen_at = now
                face_landmarks = results.multi_face_landmarks[0]
                self.drawing.draw_landmarks(
                    image=frame,
                    landmark_list=face_landmarks,
                    connections=mp.solutions.face_mesh.FACEMESH_CONTOURS,
                    landmark_drawing_spec=None,
                    connection_drawing_spec=self.mesh_style.get_default_face_mesh_contours_style(),
                )

                landmarks = extract_landmarks(frame, face_landmarks)
                left_eye = np.array([landmarks[idx] for idx in LEFT_EYE_IDXS], dtype=np.float32)
                right_eye = np.array([landmarks[idx] for idx in RIGHT_EYE_IDXS], dtype=np.float32)
                mouth = np.array([landmarks[idx] for idx in MOUTH_IDXS], dtype=np.float32)

                ear = (eye_aspect_ratio(left_eye) + eye_aspect_ratio(right_eye)) / 2.0
                mar = mouth_aspect_ratio(mouth)
                eye_label, eye_conf = self.blend_eye_predictions(frame, landmarks)
                pitch, yaw = estimate_head_pose(frame, face_landmarks)

                is_closed_by_model = eye_label.lower() == 'closed'
                is_closed_by_ear = ear < self.ear_threshold
                is_eyes_closed = is_closed_by_model or is_closed_by_ear

                if is_eyes_closed:
                    if self.closed_started_at is None:
                        self.closed_started_at = now
                else:
                    self.closed_started_at = None

                closed_duration = 0.0 if self.closed_started_at is None else now - self.closed_started_at
                drowsy = closed_duration >= self.closed_seconds
                is_yawning = mar > self.mar_threshold
                looking_away = yaw is not None and abs(yaw) > self.head_turn_deg
                nodding = pitch is not None and pitch > 15

                lines.append((f'Eye Model: {eye_label} ({eye_conf:.2f})', (0, 255, 255)))
                lines.append((f'EAR: {ear:.3f} / MAR: {mar:.3f}', (255, 255, 0)))

                if yaw is not None and pitch is not None:
                    lines.append((f'Head Pose - pitch: {pitch:.1f}, yaw: {yaw:.1f}', (255, 255, 255)))

                if drowsy:
                    lines.append(('ALERT: Drowsiness detected', (0, 0, 255)))
                elif is_yawning:
                    lines.append(('Warning: Possible yawn', (0, 165, 255)))
                else:
                    lines.append(('Status: Attending', (0, 255, 0)))

                if looking_away:
                    lines.append(('Warning: Looking away', (0, 165, 255)))
                if nodding:
                    lines.append(('Warning: Head nodding', (0, 165, 255)))

                face_outline = np.array([landmarks[idx] for idx in FACE_OVAL_IDXS], dtype=np.int32)
                cv2.polylines(frame, [face_outline], True, (80, 80, 80), 1, cv2.LINE_AA)
            else:
                self.closed_started_at = None
                missing_for = now - self.last_face_seen_at
                if missing_for >= self.absent_seconds:
                    lines.append(('ALERT: Seat absence detected', (0, 0, 255)))
                else:
                    lines.append(('Face not detected', (0, 165, 255)))

            self.draw_status(frame, lines)
            cv2.imshow('Sleep2 Monitor', frame)
            key = cv2.waitKey(1) & 0xFF
            if key in (27, ord('q')):
                break

        cap.release()
        cv2.destroyAllWindows()

if __name__ == '__main__':
    # 1. 학습된 모델 가중치(.pt 또는 .pth) 파일의 실제 경로를 지정해 주세요.
    # 예: 같은 폴더에 있다면 'eye_best.pt'
    MODEL_PATH = Path('eye_best.pt') 
    
    # 2. 파라미터 직접 입력 (Jupyter 방식)
    monitor = SleepMonitor(
        model_path=MODEL_PATH,
        label_order='closed,open', # 모델이 학습될 때의 클래스 순서 (중요!)
        camera_index=0,            # 노트북 기본 웹캠
        closed_seconds=1.5,
        absent_seconds=2.0,
        head_turn_deg=20.0,
        ear_threshold=0.20,
        mar_threshold=0.60
    )
    
    # 3. 모니터링 시작!
    monitor.run()
