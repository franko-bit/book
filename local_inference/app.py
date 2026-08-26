from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import threading
import wave
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv
from piper import PiperVoice
from piper.config import SynthesisConfig

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR.parent / ".env")

app = FastAPI(title="Local Inference (TTS)")

DEFAULT_VOICE_MODEL = Path(os.getenv("PIPER_MODEL", str(BASE_DIR / "voices" / "reader01" / "en_US-lessac-high.onnx")))
VOICE_MODELS = {
    "en": DEFAULT_VOICE_MODEL,
    "es": Path(os.getenv("PIPER_MODEL_ES", str(BASE_DIR / "voices" / "reader01" / "es_ES-davefx-medium.onnx"))),
    "fr": Path(os.getenv("PIPER_MODEL_FR", str(BASE_DIR / "voices" / "reader01" / "fr_FR-siwis-medium.onnx"))),
    "de": Path(os.getenv("PIPER_MODEL_DE", str(BASE_DIR / "voices" / "reader01" / "de_DE-thorsten-medium.onnx"))),
    "it": Path(os.getenv("PIPER_MODEL_IT", str(BASE_DIR / "voices" / "reader01" / "it_IT-paola-medium.onnx"))),
    "pt": Path(os.getenv("PIPER_MODEL_PT", str(BASE_DIR / "voices" / "reader01" / "pt_BR-faber-medium.onnx"))),
    "ru": Path(os.getenv("PIPER_MODEL_RU", str(BASE_DIR / "voices" / "reader01" / "ru_RU-denis-medium.onnx"))),
    "zh": Path(os.getenv("PIPER_MODEL_ZH", str(BASE_DIR / "voices" / "reader01" / "zh_CN-huayan-medium.onnx"))),
    "sw": Path(os.getenv("PIPER_MODEL_SW", str(BASE_DIR / "voices" / "reader01" / "sw_CD-lanfrica-medium.onnx"))),
    "rw": Path(os.getenv("PIPER_MODEL_RW", str(BASE_DIR / "voices" / "reader01" / "rw_RW-medium.onnx"))),
}
PIPER_EXECUTABLE = os.getenv("PIPER_EXECUTABLE", "piper")
PIPER_LENGTH_SCALE = os.getenv("PIPER_LENGTH_SCALE", "1.08")
PIPER_NOISE_SCALE = os.getenv("PIPER_NOISE_SCALE", "0.667")
PIPER_NOISE_W_SCALE = os.getenv("PIPER_NOISE_W_SCALE", "0.8")
CACHE_DIR = Path(os.getenv("TTS_CACHE_DIR", str(BASE_DIR / "generated")))
CACHE_DIR.mkdir(parents=True, exist_ok=True)
_voices: dict[str, PiperVoice] = {}
_voice_lock = threading.Lock()


def get_voice(model_path: Path) -> PiperVoice:
    key = str(model_path.resolve())
    if key not in _voices:
        with _voice_lock:
            if key not in _voices:
                _voices[key] = PiperVoice.load(model_path)
    return _voices[key]


def synthesize_to_file(text: str, output_path: Path, model_path: Path) -> None:
    voice = get_voice(model_path)
    synthesis_config = SynthesisConfig(
        length_scale=float(PIPER_LENGTH_SCALE),
        noise_scale=float(PIPER_NOISE_SCALE),
        noise_w_scale=float(PIPER_NOISE_W_SCALE),
    )
    with wave.open(str(output_path), "wb") as wav_file:
        voice.synthesize_wav(text, wav_file, syn_config=synthesis_config)


class TTSRequest(BaseModel):
    text: str
    language: str = "en-US"


def get_model_for_language(language: str) -> Path:
    language_key = (language or "en").lower().replace("_", "-").split("-")[0]
    return VOICE_MODELS.get(language_key, DEFAULT_VOICE_MODEL)


@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok" if DEFAULT_VOICE_MODEL.is_file() else "degraded",
        "provider": "piper",
        "model": str(DEFAULT_VOICE_MODEL),
        "model_available": str(DEFAULT_VOICE_MODEL.is_file()).lower(),
    }


@app.post("/api/tts")
async def tts_endpoint(request: TTSRequest) -> dict[str, str]:
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    voice_model = get_model_for_language(request.language)
    if not voice_model.is_file():
        raise HTTPException(
            status_code=503,
            detail=f"Piper model not found for {request.language}: {voice_model}. Set its PIPER_MODEL_* variable or install the voice file.",
        )

    cache_key = hashlib.sha256(
        f"{voice_model.resolve()}\0{PIPER_LENGTH_SCALE}\0{PIPER_NOISE_SCALE}\0{PIPER_NOISE_W_SCALE}\0{text}".encode("utf-8")
    ).hexdigest()
    output_path = CACHE_DIR / f"{cache_key}.wav"
    try:
        if not output_path.is_file():
            await asyncio.to_thread(synthesize_to_file, text, output_path, voice_model)

        with open(output_path, "rb") as audio_file:
            audio_b64 = base64.b64encode(audio_file.read()).decode("ascii")
        return {
            "audio": f"data:audio/wav;base64,{audio_b64}",
            "cache_key": cache_key,
            "provider": "piper",
            "language": request.language,
            "model": str(voice_model),
        }
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Local TTS failed: {error}") from error
