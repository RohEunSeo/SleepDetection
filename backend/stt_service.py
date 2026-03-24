import os
import tempfile
import time
from threading import Lock


class STTService:
    def __init__(self):
        self._model = None
        self._model_error = None
        self._lock = Lock()
        self.model_size = os.getenv("STT_MODEL_SIZE", "small")
        self.device = os.getenv("STT_DEVICE", "cpu")
        self.compute_type = os.getenv("STT_COMPUTE_TYPE", "int8")
        self.language = os.getenv("STT_LANGUAGE", "ko")
        self.initial_prompt = os.getenv(
            "STT_INITIAL_PROMPT",
            "온라인 강의 자막입니다. 강사 발화를 한국어로 자연스럽게 받아쓰고, 멋쟁이사자처럼, Sleep2Wake, AI, 프론트엔드, 백엔드, 데이터, 웹소켓 같은 단어를 우선 정확히 인식합니다.",
        )
        self.hotwords = [
            word.strip()
            for word in os.getenv(
                "STT_HOTWORDS",
                "멋쟁이사자처럼,Sleep2Wake,AI,프론트엔드,백엔드,웹소켓,데이터,모델,집중도,졸음",
            ).split(",")
            if word.strip()
        ]
        self._recent_text = ""
        self._recent_at = 0.0

    def _get_model(self):
        if self._model is not None:
            return self._model
        if self._model_error is not None:
            raise RuntimeError(self._model_error)

        with self._lock:
            if self._model is not None:
                return self._model
            if self._model_error is not None:
                raise RuntimeError(self._model_error)

            try:
                from faster_whisper import WhisperModel

                self._model = WhisperModel(
                    self.model_size,
                    device=self.device,
                    compute_type=self.compute_type,
                )
                return self._model
            except Exception as exc:
                self._model_error = str(exc)
                raise RuntimeError(self._model_error) from exc

    def transcribe_bytes(self, audio_bytes: bytes, suffix: str = ".webm") -> str:
        if not audio_bytes:
            return ""

        model = self._get_model()
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
                temp_file.write(audio_bytes)
                temp_path = temp_file.name

            segments, _ = model.transcribe(
                temp_path,
                language=self.language,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 250, "speech_pad_ms": 120},
                beam_size=1,
                best_of=1,
                temperature=0.0,
                condition_on_previous_text=False,
                no_speech_threshold=0.6,
                initial_prompt=self.initial_prompt,
                hotwords=",".join(self.hotwords) if self.hotwords else None,
            )
            text = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
            if not text:
                return ""

            normalized = " ".join(text.split())
            now = time.time()
            if normalized == self._recent_text and now - self._recent_at < 1.5:
                return ""

            self._recent_text = normalized
            self._recent_at = now
            return normalized
        except Exception as exc:
            print(f"[STT] transcribe failed ({suffix}, {len(audio_bytes)} bytes): {exc}")
            return ""
        finally:
            if temp_path and os.path.exists(temp_path):
                os.remove(temp_path)


stt_service = STTService()
