import cv2
import mediapipe as mp
import time
import math
import numpy as np

import pyttsx3
import threading

tts_engine = pyttsx3.init()
tts_engine.setProperty('rate', 150)
tts_engine.setProperty('volume', 1.0)

def speak(text):
    def run():
        tts_engine.say(text)
        tts_engine.runAndWait()
    threading.Thread(target=run, daemon=True).start()

# MediaPipe 초기화
mp_face_mesh = mp.solutions.face_mesh
mp_drawing = mp.solutions.drawing_utils
mp_drawing_styles = mp.solutions.drawing_styles

# 졸음 감지를 위한 눈 비율 계산 함수
def calculate_ear(landmarks, eye_indices):
    left_point = landmarks[eye_indices[0]]
    right_point = landmarks[eye_indices[3]]
    top_mid = ((landmarks[eye_indices[1]].x + landmarks[eye_indices[2]].x) / 2,
               (landmarks[eye_indices[1]].y + landmarks[eye_indices[2]].y) / 2)
    bottom_mid = ((landmarks[eye_indices[4]].x + landmarks[eye_indices[5]].x) / 2,
                  (landmarks[eye_indices[4]].y + landmarks[eye_indices[5]].y) / 2)
    
    horizontal_length = ((left_point.x - right_point.x) ** 2 + (left_point.y - right_point.y) ** 2) ** 0.5
    vertical_length = ((top_mid[0] - bottom_mid[0]) ** 2 + (top_mid[1] - bottom_mid[1]) ** 2) ** 0.5
    return vertical_length / horizontal_length

# 하품 감지를 위한 입 비율 계산 함수
def calculate_mar(landmarks, mouth_indices):
    top_mid = ((landmarks[mouth_indices[0]].x + landmarks[mouth_indices[1]].x) / 2,
               (landmarks[mouth_indices[0]].y + landmarks[mouth_indices[1]].y) / 2)
    bottom_mid = ((landmarks[mouth_indices[2]].x + landmarks[mouth_indices[3]].x) / 2,
                  (landmarks[mouth_indices[2]].y + landmarks[mouth_indices[3]].y) / 2)
    left_point = landmarks[mouth_indices[4]]
    right_point = landmarks[mouth_indices[5]]
    
    horizontal_length = ((left_point.x - right_point.x) ** 2 + (left_point.y - right_point.y) ** 2) ** 0.5
    vertical_length = ((top_mid[0] - bottom_mid[0]) ** 2 + (top_mid[1] - bottom_mid[1]) ** 2) ** 0.5
    return vertical_length / horizontal_length

# 고개 기울기 계산 함수
def calculate_head_tilt(landmarks):
    left_shoulder = landmarks[234] # 얼굴 왼쪽 외곽 랜드마크
    right_shoulder = landmarks[454] # 얼굴 오른쪽 외곽 랜드마크 
    
    dx = right_shoulder.x - left_shoulder.x
    dy = right_shoulder.y - left_shoulder.y
    angle = math.degrees(math.atan2(dy, dx))
    # 고개 똑바로 -> 수평 -> angle = 0 
    # 고개 기울면 -> angle 증가함
    return abs(angle)

# 웹캠 열기
cap = cv2.VideoCapture(0)

# 얼굴 메시 모델 초기화
with mp_face_mesh.FaceMesh(
        max_num_faces=1, 
        refine_landmarks=True,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5) as face_mesh:
    
    # ✅ 캘리브레이션 추가! (메인 루프 시작 전)
    # ----------------------------------------
    calibration_ears = []
    CALIBRATION_FRAMES = 90  # 3초 (30fps 기준)
    print("캘리브레이션 시작 - 카메라를 정면으로 바라봐주세요")

    while len(calibration_ears) < CALIBRATION_FRAMES:
        success, image = cap.read()
        if not success:
            break

        image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        results = face_mesh.process(image_rgb)
        image = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR)

        if results.multi_face_landmarks:
            for face_landmarks in results.multi_face_landmarks:
                landmarks = face_landmarks.landmark
                left_eye_indices = [362, 385, 387, 263, 373, 380]
                right_eye_indices = [33, 160, 158, 133, 153, 144]
                left_ear = calculate_ear(landmarks, left_eye_indices)
                right_ear = calculate_ear(landmarks, right_eye_indices)
                ear = (left_ear + right_ear) / 2.0
                calibration_ears.append(ear)  # 얼굴 감지됐을 때만 수집

        # 진행률 화면에 표시
        progress = len(calibration_ears) / CALIBRATION_FRAMES
        bar_width = 300
        cv2.rectangle(image, (50, 200), (50 + bar_width, 230), (50,50,50), -1)
        cv2.rectangle(image, (50, 200), (50 + int(bar_width * progress), 230), (0,255,100), -1)
        cv2.putText(image, "Calibrating... Look straight at camera", (50, 180), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255,255,255), 2)
        cv2.putText(image, f"{int(progress*100)}%", (50, 260), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0,255,100), 2)
        cv2.imshow('Drowsiness, Yawn, and Head Tilt Detection', image)
        cv2.waitKey(1)

    # 기준값으로 임계값 자동 설정
    baseline_ear = np.mean(calibration_ears)
    EAR_THRESHOLD = baseline_ear * 0.75  # 기준값의 75%
    print(f"캘리브레이션 완료! baseline EAR: {baseline_ear:.3f}, threshold: {EAR_THRESHOLD:.3f}")
    # ----------------------------------------
    
    closed_eyes_frame_count = 0
    open_mouth_frame_count = 0
    head_tilt_frame_count = 0
    # EAR_THRESHOLD = 0.2  # 눈 비율 임계값, 눈이 닫힌 것으로 간주하는 기준
    CLOSED_EYES_FRAMES = 30  # 졸음으로 판단할 프레임 수
    MAR_THRESHOLD = 0.7  # 입 비율 임계값, 하품으로 간주하는 기준
    OPEN_MOUTH_FRAMES = 60  # 하품으로 판단할 프레임 수 (약 1초 기준)
    HEAD_TILT_THRESHOLD = 15  # 고개 기울기 각도 임계값
    HEAD_TILT_FRAMES = 30  # 고개 기울기 판단할 프레임 수 (약 1초 기준)

    show_landmarks = True

    while cap.isOpened():
        success, image = cap.read()
        if not success:
            print("웹캠에서 영상을 읽을 수 없습니다.")
            break

        # BGR 이미지를 RGB로 변환
        image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        image.flags.writeable = False

        # 얼굴 메시 추론
        results = face_mesh.process(image)

        # 이미지를 다시 BGR로 변환
        image.flags.writeable = True
        image = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)

        alert = False

        if results.multi_face_landmarks:
            for face_landmarks in results.multi_face_landmarks:
                landmarks = face_landmarks.landmark

                # 왼쪽 및 오른쪽 눈의 인덱스 (좌표는 MediaPipe의 얼굴 랜드마크 참조)
                left_eye_indices = [362, 385, 387, 263, 373, 380]
                right_eye_indices = [33, 160, 158, 133, 153, 144]

                # 입의 인덱스 (좌표는 MediaPipe의 얼굴 랜드마크 참조)
                mouth_indices = [13, 14, 17, 18, 78, 308]

                # 눈 비율 계산
                left_ear = calculate_ear(landmarks, left_eye_indices)
                right_ear = calculate_ear(landmarks, right_eye_indices)
                ear = (left_ear + right_ear) / 2.0

                # 입 비율 계산
                mar = calculate_mar(landmarks, mouth_indices)

                # 고개 기울기 각도 계산
                head_tilt_angle = calculate_head_tilt(landmarks)

                # 눈 비율에 따른 졸음 감지
                if ear < EAR_THRESHOLD:
                    closed_eyes_frame_count += 1
                else:
                    closed_eyes_frame_count = 0

                # 입 비율에 따른 하품 감지 (고개 기울기와 관계없이 동작하도록 수정)
                if mar > MAR_THRESHOLD:
                    open_mouth_frame_count += 1
                else:
                    open_mouth_frame_count = 0

                # 고개 기울기에 따른 기울기 감지
                if head_tilt_angle > HEAD_TILT_THRESHOLD:
                    head_tilt_frame_count += 1
                else:
                    head_tilt_frame_count = 0

                # 경고 조건 (개별 조건에 따라 별도로 알림 설정)
                if closed_eyes_frame_count >= CLOSED_EYES_FRAMES:
                    alert = True
                elif open_mouth_frame_count >= OPEN_MOUTH_FRAMES:
                    alert = True
                elif head_tilt_frame_count >= HEAD_TILT_FRAMES:
                    alert = True

                # 경고 메시지 O/X 표시
                cv2.putText(image, f"Eye: {'O' if closed_eyes_frame_count >= CLOSED_EYES_FRAMES else 'X'}", (50, 50), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
                cv2.putText(image, f"Yawn:   {'O' if open_mouth_frame_count >= OPEN_MOUTH_FRAMES else 'X'}", (50, 100), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
                cv2.putText(image, f"Head Tilt:   {'O' if head_tilt_frame_count >= HEAD_TILT_FRAMES else 'X'}", (50, 150), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)


                # 얼굴 랜드마크 그리기
                if show_landmarks:
                    h, w = image.shape[:2]

                    # 👁️ 눈 상태 각각 따로 판단
                    left_eye_state = "Closed" if left_ear < EAR_THRESHOLD else "Open"
                    left_eye_color = (0, 0, 255) if left_ear < EAR_THRESHOLD else (0, 255, 0)

                    right_eye_state = "Closed" if right_ear < EAR_THRESHOLD else "Open"
                    right_eye_color = (0, 0, 255) if right_ear < EAR_THRESHOLD else (0, 255, 0)

                    # 👁️ 왼쪽 눈 바운딩 박스
                    left_eye_pts = [landmarks[i] for i in left_eye_indices]
                    lx = [int(p.x * w) for p in left_eye_pts]
                    ly = [int(p.y * h) for p in left_eye_pts]
                    cv2.rectangle(image, (min(lx)-5, min(ly)-5), (max(lx)+5, max(ly)+5), left_eye_color, 2)
                    cv2.putText(image, left_eye_state, (min(lx)-5, min(ly)-10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, left_eye_color, 1)

                    # 👁️ 오른쪽 눈 바운딩 박스
                    right_eye_pts = [landmarks[i] for i in right_eye_indices]
                    rx = [int(p.x * w) for p in right_eye_pts]
                    ry = [int(p.y * h) for p in right_eye_pts]
                    cv2.rectangle(image, (min(rx)-5, min(ry)-5), (max(rx)+5, max(ry)+5), right_eye_color, 2)
                    cv2.putText(image, right_eye_state, (min(rx)-5, min(ry)-10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, right_eye_color, 1)

                    # 👄 입 상태 판단 (3단계)
                    if open_mouth_frame_count >= OPEN_MOUTH_FRAMES:
                        mouth_state = "Yawn"
                        mouth_color = (0, 0, 255)      # 빨강
                    elif mar > MAR_THRESHOLD:
                        mouth_state = "Open"
                        mouth_color = (0, 165, 255)    # 주황
                    else:
                        mouth_state = "Closed"
                        mouth_color = (0, 255, 0)      # 초록

                    # 👄 입 바운딩 박스
                    mouth_pts = [landmarks[i] for i in mouth_indices]
                    mx = [int(p.x * w) for p in mouth_pts]
                    my = [int(p.y * h) for p in mouth_pts]
                    cv2.rectangle(image, (min(mx)-5, min(my)-5), (max(mx)+5, max(my)+5), mouth_color, 2)
                    cv2.putText(image, mouth_state, (min(mx)-5, min(my)-10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, mouth_color, 1)


        # 경고 화면 깜빡임 (붉은색 마스크 적용)
        if alert:
            mask = np.zeros_like(image, dtype=np.uint8)
            mask[:] = (0, 0, 255)
            image = cv2.addWeighted(image, 0.7, mask, 0.3, 0)

        # alert 플래그 설정
        if closed_eyes_frame_count >= CLOSED_EYES_FRAMES:
            alert = True
        elif open_mouth_frame_count >= OPEN_MOUTH_FRAMES:
            alert = True
        elif head_tilt_frame_count >= HEAD_TILT_FRAMES:
            alert = True

        # 빨간화면 뜨는 순간 딱 한 번만 음성 출력
        if closed_eyes_frame_count == CLOSED_EYES_FRAMES or \
        open_mouth_frame_count == OPEN_MOUTH_FRAMES or \
        head_tilt_frame_count == HEAD_TILT_FRAMES:
            speak("졸음이 감지되었습니다")

        # 결과 영상 출력
        cv2.imshow('Drowsiness, Yawn, and Head Tilt Detection', image)

        key = cv2.waitKey(5) & 0xFF
        if key == ord('q'):
            break
        elif key == ord('h'):
            show_landmarks = not show_landmarks

# 웹캠 해제 및 모든 창 닫기
cap.release()
cv2.destroyAllWindows()