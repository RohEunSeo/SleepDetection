# =============================================
# config.py — 환경변수 및 상수 관리
# =============================================

import os
from dotenv import load_dotenv

load_dotenv()

# ── Daily.co ────────────────────────────────
DAILY_API_KEY  = os.getenv("DAILY_API_KEY", "")
DAILY_BASE_URL = "https://api.daily.co/v1"
DAILY_DOMAIN   = "sleep2wake"  # sleep2wake.daily.co

# ── 서버 ────────────────────────────────────
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*").split(",")

# ── 방 설정 ─────────────────────────────────
ROOM_MAX_PARTICIPANTS = 20
ROOM_TOKEN_EXPIRE_SEC = 60 * 60 * 4  # 4시간