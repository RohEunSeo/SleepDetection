# Sleep2Wake

> 온라인 수업 중 학생의 졸음, 시선 이탈, 자리 이탈을 실시간으로 감지하고  
> 강사와 관리자가 즉시 대응할 수 있도록 돕는 AI 기반 학습 모니터링 플랫폼

## Overview

**Sleep2Wake**는 비대면 수업 환경에서 학생의 집중 저하를 실시간으로 파악하기 위해 만든 웹 기반 서비스입니다.  
학생 웹캠 영상에서 얼굴 랜드마크를 분석해 상태를 판정하고, 그 결과를 강사 화면과 관리자 대시보드에 실시간으로 반영합니다.

단순 졸음 탐지를 넘어서 실제 수업 상황에서 자주 발생하는 **필기, 잠깐 아래 보기, 얼굴 미감지, 자리 이탈** 같은 맥락까지 고려해 보다 자연스러운 상태 판정을 목표로 했습니다.

## Key Features

### Student
- 웹캠 기반 상태 판정
- 집중 / 시선 이탈 / 상태 판독 중 / 졸음 의심 / 졸음 확정 / 얼굴 미감지 / 자리 이탈 표시
- 눈 감김 / 자리 이탈 누적 타이머 제공
- 강사 자막 표시 및 자막 On/Off
- 마이크 / 카메라 제어
- 스트레칭 / 쉬는 시간 오버레이 수신

### Instructor
- 학생 상태 실시간 모니터링
- 학생 비디오 피드 확인
- 마이크 / 카메라 / 화면 공유
- 스트레칭 / 쉬는 시간 수동 전송
- 수업 종료 후 관리자 대시보드 이동

### Admin
- 진행 중인 세션 및 학생 상태 확인
- 세션별 / 과정별 데이터 조회
- 실시간 모니터링 및 리포트 확장 가능 구조

## Tech Stack

- **Frontend**: HTML, CSS, Vanilla JavaScript
- **AI / Vision**: MediaPipe Face Mesh
- **Realtime**: WebSocket, Daily.co WebRTC
- **Backend**: FastAPI, Uvicorn, HTTPX
- **Database**: Supabase

## Project Structure

```bash
SleepDetection/
├─ backend/
│  ├─ main.py
│  ├─ daily_service.py
│  ├─ session_store.py
│  ├─ ws_manager.py
│  └─ routers/
│     ├─ room.py
│     └─ session.py
│
├─ frontend/
│  ├─ index.html
│  ├─ student.html
│  ├─ instructor.html
│  ├─ admin.html
│  ├─ report.html
│  ├─ css/
│  ├─ js/
│  └─ assets/
│
└─ requirements.txt
```

## How to Run
1. Backend
cd backend
pip install -r requirements.txt
uvicorn main:app --reload

2. Frontend
cd frontend
python -m http.server 5500
