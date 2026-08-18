from __future__ import annotations

import base64
import os
import tempfile

import pyttsx3
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Local Inference (TTS)")


class TTSRequest(BaseModel):
    text: str
    language: str = "en-US"


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/tts")
async def tts_endpoint(request: TTSRequest) -> dict[str, str]:
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    output_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as output_file:
            output_path = output_file.name

        engine = pyttsx3.init()
        engine.save_to_file(text, output_path)
        engine.runAndWait()
        engine.stop()

        with open(output_path, "rb") as audio_file:
            audio_b64 = base64.b64encode(audio_file.read()).decode("ascii")
        return {"audio": f"data:audio/wav;base64,{audio_b64}"}
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Local TTS failed: {error}") from error
    finally:
        if output_path and os.path.exists(output_path):
            os.remove(output_path)
