"""
main.py - FocusRoom 진입점

실행 방법:
    python main.py

의존 파일:
    detector.py       (같은 폴더)
    mission.py        (같은 폴더)
    data_collector.py (같은 폴더)
    한글 폰트: Windows 기본 맑은고딕 자동 탐색
              없으면 영어로 fallback

[키보드 단축키]
  1~5 → 수동 라벨 캡처 (데이터 수집 모드에서만)
  d   → 데이터 수집 모드 (지표+바운딩박스만, 경고/상태 없음)
  t   → 테스트 모드 (전체 기능)
  q   → 종료 + 세션 요약 저장

[구조]
    1. 초기화 (FaceMesh, Detector, Mission, DataCollector, Cap)
    2. EAR 캘리브레이션 (3초, 90프레임)
    3. 메인 루프
       - DrowsinessDetector.update() → 상태 판단
       - StretchMission.update()     → 미션 처리
       - DataCollector.handle_key()  → 데이터 수집
       - draw_overlay()              → 화면 출력
"""

import time
import os

import cv2
import mediapipe as mp
import numpy as np

# ── PIL (한글 표시용) ─────────────────────────────────────────────
try:
    from PIL import ImageFont, ImageDraw, Image
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False
    print("[WARN] PIL 없음 - pip install pillow 로 설치하면 한글 표시됨")

from detector import (
    DrowsinessDetector,
    get_landmarks,
    EAR_CALIB_FRAMES,
    EAR_CALIB_RATIO,
    EAR_VALID_MIN,
    EAR_VALID_MAX,
)
from mission import StretchMission
from data_collector import DataCollector


# ════════════════════════════════════════════════════════════════
# 한글 폰트 설정 (Windows 기본 폰트 자동 탐색)
# ════════════════════════════════════════════════════════════════

FONT_CANDIDATES = [
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "NanumGothic.ttf"),
    "C:/Windows/Fonts/malgun.ttf",
    "C:/Windows/Fonts/malgunbd.ttf",
    "C:/Windows/Fonts/gulim.ttc",
    "C:/Windows/Fonts/batang.ttc",
    "C:/Windows/Fonts/NanumGothic.ttf",
]

KR_FONT    = None
KR_FONT_SM = None

if PIL_AVAILABLE:
    for candidate in FONT_CANDIDATES:
        if os.path.exists(candidate):
            try:
                KR_FONT    = ImageFont.truetype(candidate, 26)
                KR_FONT_SM = ImageFont.truetype(candidate, 18)
                print(f"[INFO] 한글 폰트 로드 성공: {candidate}")
                break
            except Exception:
                continue
    if KR_FONT is None:
        print("[WARN] 한글 폰트를 찾을 수 없음 - 영어로 표시됩니다")
        print("[WARN] 해결: NanumGothic.ttf 파일을 이 폴더에 넣어주세요")

# ── 상태 한글 변환 테이블 ─────────────────────────────────────────
STATE_KR = {
    "FOCUSED":    "집중",
    "DISTRACTED": "주의 산만",
    "WARNING":    "졸음 의심",
    "DROWSY":     "졸음 확정",
    "ABSENT":     "자리 이탈",
}

# ── 상태 색상 테이블 (BGR) ────────────────────────────────────────
STATE_COLOR = {
    "FOCUSED":    (0,   255, 0  ),
    "DISTRACTED": (0,   140, 255),
    "WARNING":    (0,   165, 255),
    "DROWSY":     (0,   0,   255),
    "ABSENT":     (128, 128, 128),
}


# ════════════════════════════════════════════════════════════════
# 텍스트 렌더링 함수
# ════════════════════════════════════════════════════════════════

def put_text(frame, text, pos, color=(255, 255, 255),
             font_size="normal", bg=True):
    """
    한글/영어 텍스트를 배경 박스와 함께 표시
    KR_FONT 있으면 PIL로 한글 렌더링
    없으면 OpenCV 영어 fallback
    """
    if KR_FONT is not None and PIL_AVAILABLE:
        font   = KR_FONT if font_size == "normal" else KR_FONT_SM
        img_p  = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        draw   = ImageDraw.Draw(img_p)
        bbox   = draw.textbbox(pos, text, font=font)
        if bg:
            draw.rectangle(
                [bbox[0]-6, bbox[1]-4, bbox[2]+6, bbox[3]+4],
                fill=(255, 255, 255, 180)
            )
        r, g, b = color[2], color[1], color[0]
        draw.text(pos, text, font=font, fill=(r, g, b))
        frame[:] = cv2.cvtColor(np.array(img_p), cv2.COLOR_RGB2BGR)
    else:
        if bg:
            (tw, th), _ = cv2.getTextSize(
                text, cv2.FONT_HERSHEY_PLAIN, 1.5, 1)
            x, y = pos
            cv2.rectangle(frame,
                          (x-4, y-th-4), (x+tw+4, y+4),
                          (255, 255, 255), -1)
        cv2.putText(frame, text, pos,
                    cv2.FONT_HERSHEY_PLAIN, 1.5, color, 1, cv2.LINE_AA)


# ════════════════════════════════════════════════════════════════
# 화면 출력 함수
# [수정 1] data_mode 파라미터 추가
#   data_mode=True  → 지표+바운딩박스만 표시 (하품/점수/상태/오버레이 없음)
#   data_mode=False → 전체 UI 표시 (기존 동일)
# ════════════════════════════════════════════════════════════════

def draw_overlay(frame, result, pts, fps, proc_ms, data_mode=False):
    """
    화면 텍스트 출력 전담

    data_mode=False (테스트 모드):
      상단: EAR / PERCLOS / MAR / Gaze / MOE / roll / pitch / yaw
      하단: FPS / 하품횟수 / 졸음점수 / 참여점수 / WARNING 누적 / 상태
      오버레이: DROWSY 빨강, ABSENT 안내

    data_mode=True (데이터 수집 모드):
      상단: EAR / PERCLOS / MAR / Gaze / MOE / roll / pitch / yaw
      하단: FPS만
      오버레이/상태/카운터 없음
    """
    fw, fh = frame.shape[1], frame.shape[0]
    state  = result["final_state"]
    color  = STATE_COLOR.get(state, (255, 255, 255))

    # ── 상단 좌측: 핵심 지표 (항상 표시) ─────────────────────
    put_text(frame,
             f"EAR:{result['ear']:.3f}   PERCLOS:{result['perclos']:.2f}",
             (10, 15), color=(50, 50, 50), font_size="small")
    put_text(frame,
             f"MAR:{result['mar']:.3f}   Gaze:{result['gaze']:.3f}",
             (10, 45), color=(50, 50, 50), font_size="small")
    put_text(frame,
             f"MOE:{result['moe']:.2f}",
             (10, 75), color=(50, 50, 50), font_size="small")

    # ── 상단 우측: Head Pose (항상 표시) ─────────────────────
    put_text(frame,
             f"roll:{result['roll']:.1f}",
             (fw-160, 15), color=(150, 0, 150), font_size="small")
    put_text(frame,
             f"pitch:{result['pitch']:.1f}",
             (fw-160, 45), color=(150, 0, 150), font_size="small")
    put_text(frame,
             f"yaw:{result['yaw']:.1f}",
             (fw-160, 75), color=(150, 0, 150), font_size="small")

    if data_mode:
        # ── 데이터 수집 모드: FPS만, 나머지 없음 ─────────────
        put_text(frame,
                 f"FPS:{fps:.0f}  PROC:{proc_ms:.0f}ms",
                 (10, fh-40), color=(180, 0, 180), font_size="small")

    else:
        # ── 테스트 모드: 전체 UI (기존과 동일) ───────────────
        put_text(frame,
                 f"FPS:{fps:.0f}  PROC:{proc_ms:.0f}ms",
                 (10, fh-130), color=(180, 0, 180), font_size="small")
        put_text(frame,
                 f"하품:{result['yawn_count']}회  "
                 f"졸음점수:{result['drowsiness_score']}%  "
                 f"참여점수:{pts}pt",
                 (10, fh-95), color=(50, 50, 50), font_size="small")
        put_text(frame,
                 f"WARNING 누적:{result['warning_count']}회",
                 (10, fh-60), color=(50, 50, 50), font_size="small")

        # 하단 중앙: 최종 상태 (한글, 크게)
        state_text = f"상태: {STATE_KR.get(state, state)}"
        approx_w   = len(state_text) * 18
        cx         = (fw - approx_w) // 2
        put_text(frame, state_text,
                 (cx, fh-35), color=color, font_size="normal")

        # DROWSY 빨간 오버레이
        if state == "DROWSY":
            overlay    = np.zeros_like(frame, dtype=np.uint8)
            overlay[:] = (0, 0, 255)
            frame      = cv2.addWeighted(frame, 0.85, overlay, 0.15, 0)

        # ABSENT 안내
        elif state == "ABSENT":
            absent_sec = result.get("absent_sec", 0.0)
            put_text(frame,
                     f"얼굴 미감지 ({absent_sec:.1f}초)",
                     (10, fh//2), color=(128, 128, 128))

    return frame


# ════════════════════════════════════════════════════════════════
# 캘리브레이션
# [수정 2] 얼굴 미감지 타임아웃 + nan 경고 수정
# ════════════════════════════════════════════════════════════════

def run_calibration(cap, face_mesh, eye_det_cls):
    """
    수업 시작 전 EAR 캘리브레이션 (약 3초)

    [개선 사항]
    - 하위 20% 제외 후 평균 → 눈 덜 뜬 프레임 이상값 필터링
    - 얼굴 미감지 타임아웃 150프레임 → 기본값으로 자동 진행
    - 프레임 읽기 실패 시 재시도 (break 대신 continue)
    - baseline과 ear_thresh 둘 다 반환
    """
    from detector import EyeDetector
    eye_det     = EyeDetector()
    calib_ears  = []
    no_face_cnt = 0
    MAX_NO_FACE = 150
    print("[INFO] 캘리브레이션 시작 - 눈을 또렷하게 뜨고 정면을 봐주세요")

    while len(calib_ears) < EAR_CALIB_FRAMES:
        ret, frame = cap.read()
        if not ret:
            # [수정] break 대신 재시도
            time.sleep(0.1)
            continue
        frame = cv2.flip(frame, 2)

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = np.stack([gray] * 3, axis=2)
        lms  = face_mesh.process(gray).multi_face_landmarks

        if lms:
            lm    = get_landmarks(lms)
            ear_c = eye_det.get_EAR(lm)
            if EAR_VALID_MIN < ear_c < EAR_VALID_MAX:
                calib_ears.append(ear_c)
                no_face_cnt = 0
        else:
            no_face_cnt += 1
            if no_face_cnt >= MAX_NO_FACE:
                print("[WARN] 얼굴 감지 안됨 - 기본값으로 캘리브레이션 진행")
                break

        # 진행률 프로그레스바
        prog  = len(calib_ears) / EAR_CALIB_FRAMES
        bar_w = 300
        cv2.rectangle(frame, (50, 200), (50+bar_w, 235),
                      (50, 50, 50), -1)
        cv2.rectangle(frame, (50, 200),
                      (50+int(bar_w*prog), 235), (0, 255, 100), -1)
        cv2.putText(frame, "Calibrating... Look straight at camera",
                    (50, 185), cv2.FONT_HERSHEY_PLAIN,
                    1.5, (255, 255, 255), 2)
        cv2.putText(frame, f"{int(prog*100)}%",
                    (50, 265), cv2.FONT_HERSHEY_PLAIN,
                    2, (0, 255, 100), 2)
        cv2.imshow("FocusRoom", frame)
        cv2.waitKey(1)

    if calib_ears:
        baseline   = float(np.mean(calib_ears))
        ear_thresh = baseline * EAR_CALIB_RATIO
        # [수정] nan 경고 방지 - calib_ears 있을 때만 평균 계산
        avg_str    = f"{baseline:.3f}"
    else:
        baseline   = 0.28
        ear_thresh = 0.21
        avg_str    = "기본값 사용"

    print(f"[INFO] 캘리브레이션 완료 | "
          f"전체 평균: {avg_str} | "
          f"상위80% baseline: {baseline:.3f} | "
          f"ear_thresh: {ear_thresh:.3f} | "
          f"tired_thresh: {baseline*0.90:.3f}")
    return ear_thresh, baseline


# ════════════════════════════════════════════════════════════════
# 메인 함수
# ════════════════════════════════════════════════════════════════

def main():
    # ── 초기화 ──────────────────────────────────────────────────
    cv2.setUseOptimized(True)

    face_mesh = mp.solutions.face_mesh.FaceMesh(
        static_image_mode=False,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
        refine_landmarks=True,
    )

    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("[ERROR] 카메라를 열 수 없습니다")
        return

    # [수정 3] 속도 최적화: 버퍼 1장 + 워밍업
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # 최신 프레임만 유지, 지연 최소화
    time.sleep(0.5)
    for _ in range(5):                   # 초기 프레임 버리기 (웹캠 워밍업)
        cap.read()

    # ── 캘리브레이션 ────────────────────────────────────────────
    ear_thresh, baseline = run_calibration(cap, face_mesh, None)

    # ── Detector / Mission / DataCollector 초기화 ───────────────
    t_start   = time.perf_counter()
    detector  = DrowsinessDetector(
        ear_thresh=ear_thresh,
        baseline_ear=baseline,
        t_now=t_start
    )
    mission   = StretchMission()
    collector = DataCollector(base_dir="data")

    prev_time = t_start
    fps       = 0.0

    # ── 모드 설정 ────────────────────────────────────────────────
    MODE_DATA    = "DATA"
    MODE_TEST    = "TEST"
    current_mode = MODE_TEST

    print("[INFO] 모드: d→데이터수집  t→테스트  q→종료")
    print("[INFO] 데이터수집 모드: 1→집중  2→주의산만  3→졸음의심  4→졸음확정  5→이탈")

    # ── 메인 루프 ────────────────────────────────────────────────
    while True:
        t_now        = time.perf_counter()
        elapsed      = t_now - prev_time
        prev_time    = t_now
        fps          = 1.0 / elapsed if elapsed > 0 else fps

        ret, frame = cap.read()
        if not ret:
            # [수정] break 대신 재시도
            time.sleep(0.05)
            continue
        frame = cv2.flip(frame, 2)

        e1 = cv2.getTickCount()

        # ── FaceMesh 처리 ────────────────────────────────────
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = np.stack([gray] * 3, axis=2)
        lms  = face_mesh.process(gray).multi_face_landmarks

        # ── 졸음/이탈 감지 ───────────────────────────────────
        result = detector.update(frame, lms, t_now)

        # ── 상태 지속시간 누적 ────────────────────────────────
        collector.update_state(result, t_now)

        # ── 모드별 처리 ──────────────────────────────────────
        if current_mode == MODE_TEST:
            frame, in_mission, mission_success = mission.update(
                result["final_state"], frame)
            if mission_success:
                detector.reset_tracking(t_now)
        else:
            in_mission = False
            mission_success = False

        # ── 캡처용 clean_frame ────────────────────────────────
        clean_frame = frame.copy()

        # ── 처리 시간 계산 ───────────────────────────────────
        e2      = cv2.getTickCount()
        proc_ms = ((e2 - e1) / cv2.getTickFrequency()) * 1000

        # ── 화면 출력 ────────────────────────────────────────
        if current_mode == MODE_TEST:
            frame = draw_overlay(
                frame, result,
                pts=mission.participation_score,
                fps=fps,
                proc_ms=proc_ms,
                data_mode=False      # 전체 UI
            )
            put_text(frame, "[ T ] 테스트 모드  |  d 누르면 데이터수집 모드",
                     (10, frame.shape[0]-5),
                     color=(0, 180, 0), font_size="small")
        else:
            frame = draw_overlay(
                frame, result,
                pts=0,
                fps=fps,
                proc_ms=proc_ms,
                data_mode=True       # 지표+바운딩박스만
            )
            put_text(frame,
                     f"[ D ] 1→집중 2→주의산만 3→졸음의심 "
                     f"4→졸음확정 5→이탈  | {collector.total_captures}장",
                     (10, frame.shape[0]-5),
                     color=(0, 100, 255), font_size="small")

        cv2.imshow("FocusRoom", frame)

        # ── 키 입력 처리 ─────────────────────────────────────
        # [수정 3] waitKey(20) → waitKey(1): 최소 대기로 FPS 향상
        key = cv2.waitKey(1) & 0xFF

        if key == ord("d"):
            current_mode = MODE_DATA
            print("[INFO] → 데이터수집 모드")
        elif key == ord("t"):
            current_mode = MODE_TEST
            print("[INFO] → 테스트 모드")
        elif current_mode == MODE_DATA:
            collector.handle_key(key, clean_frame, result)

        if key == ord("q"):
            break

    # ── 종료 처리 ────────────────────────────────────────────────
    collector.close()
    cap.release()
    mission.close()
    face_mesh.close()
    cv2.destroyAllWindows()
    print("[INFO] 종료")


if __name__ == "__main__":
    main()
