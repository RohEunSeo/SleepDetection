<div align="center">

# 😴 Sleep2Wake

**온라인 수업 중 학생의 졸음 · 시선 이탈 · 자리 이탈을 실시간으로 감지하고 강사와 관리자가**<br>
**즉시 대응할 수 있도록 돕는 AI 기반 학습 모니터링 플랫폼**


![HTML](https://img.shields.io/badge/HTML-E34F26?style=flat-square&logo=html5&logoColor=white)
![CSS](https://img.shields.io/badge/CSS-1572B6?style=flat-square&logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=flat-square&logo=supabase&logoColor=white)
![Vercel](https://img.shields.io/badge/Vercel-000000?style=flat-square&logo=vercel&logoColor=white)
![Railway](https://img.shields.io/badge/Railway-0B0D0E?style=flat-square&logo=railway&logoColor=white)

<img width="1207" height="675" alt="image" src="https://github.com/user-attachments/assets/e5db6abd-055a-4b7c-b3a2-4867726c9b29" />

<br>

🔗 **[sleep2wake.vercel.app](https://sleep2wake.vercel.app)**

</div>

---

## 📌 Overview

**Sleep2Wake**는 비대면 수업 환경에서 학생의 집중 저하를 실시간으로 파악하기 위해 만든 웹 기반 서비스입니다.

학생 웹캠 영상에서 얼굴 랜드마크를 분석해 상태를 판정하고, 그 결과를 강사 화면과 관리자 대시보드에 실시간으로 반영합니다.

단순 졸음 탐지를 넘어서 실제 수업 상황에서 자주 발생하는 **필기, 잠깐 아래 보기, 얼굴 미감지, 자리 이탈** 같은 맥락까지 고려해 보다 자연스러운 상태 판정을 목표로 했습니다.

---

## ✨ Key Features

### 🧑‍💻 Student
- 웹캠 기반 5단계 실시간 상태 판정 (`FOCUSED` / `DISTRACTED` / `WARNING` / `DROWSY` / `ABSENT`)
- 배터리 UI 형태의 집중도 시각화
- 눈 감김 / 자리 이탈 누적 타이머 제공
- 강사 실시간 자막 표시 및 On/Off 제어
- 마이크 · 카메라 제어
- 스트레칭 / 쉬는 시간 오버레이 수신

### 🎓 Instructor
- 학생 상태 실시간 모니터링
- 학생 비디오 피드 확인
- 마이크 · 카메라 · 화면 공유 제어
- 스트레칭 / 쉬는 시간 수동 전송
- 수업 종료 후 관리자 대시보드 이동

### 🖥️ Admin
- 진행 중인 세션 및 학생 상태 실시간 확인
- 세션별 / 과정별 누적 데이터 조회
- 기간별 집중도 리포트 (주차별 추이 · 시간대별 분석)
- 수강 이탈 위험군 자동 감지 (고위험 / 주의 / 관찰 3단계)
- PDF 리포트 출력

---

## 🛠 Tech Stack

| 구분 | 기술 |
|------|------|
| Frontend | HTML · CSS · Vanilla JavaScript |
| AI / Vision | MediaPipe Face Mesh (브라우저 엣지 추론) |
| Realtime | WebSocket · Daily.co WebRTC |
| Backend | FastAPI · Uvicorn · HTTPX |
| Database | Supabase |
| Deploy | Vercel (Frontend) · Railway (Backend) |

---

## 🗂 Project Structure

```bash
SleepDetection/
├─ backend/
│  ├─ main.py               # FastAPI 앱 진입점 (StaticFiles 마지막 마운트)
│  ├─ ws_manager.py         # WebSocket 허브 · broadcast 관리
│  ├─ session_store.py      # 방 코드 재사용 로직 · KST 시간대 처리
│  ├─ daily_service.py      # Daily.co API 연동
│  └─ routers/
│     ├─ room.py            # room_opened / closed 이벤트
│     └─ session.py
│
├─ frontend/
│  ├─ index.html            # 로그인 · 역할 선택
│  ├─ student.html          # 학생 수업 화면
│  ├─ instructor.html       # 강사 강의실 화면
│  ├─ admin.html            # 매니저 대시보드
│  ├─ report.html           # 기간별 누적 리포트
│  ├─ css/                  # 페이지별 스타일 + common.css
│  ├─ js/                   # 페이지별 로직 + detection.js + common.js
│  └─ assets/
│
└─ requirements.txt         # mediapipe==0.10.9 고정
```

---

## 🚀 How to Run

### 1. Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

### 2. Frontend

```bash
cd frontend
python -m http.server 5500
```

> 로컬 실행 시 `http://localhost:5500` 접속  
> 카메라 권한은 **HTTPS 환경**에서만 정상 동작합니다

---

## 👥 Team

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/RohEunSeo">
        <img src="https://github.com/RohEunSeo.png" width="80" height="80" style="border-radius:50%"/><br/>
        <sub><b>노은서</b></sub>
      </a><br/>
    </td>
    <td align="center">
      <a href="https://github.com/최현우hyeonwooCH">
        <img src="https://github.com/hyeonwooCH.png" width="80" height="80" style="border-radius:50%"/><br/>
        <sub><b>최현우</b></sub>
      </a><br/>
    </td>
    <td align="center">
      <a href="https://github.com/c62245137-ship-it">
        <img src="https://github.com/c62245137-ship-it.png" width="80" height="80" style="border-radius:50%"/><br/>
        <sub><b>이채현</b></sub>
      </a><br/>
    </td>
  </tr>
</table>

<div align="center">

**멋쟁이사자처럼 AXP 인턴십 프로젝트** · 2026

</div>
