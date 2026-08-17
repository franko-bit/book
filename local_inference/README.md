# Local inference scaffold

This lightweight FastAPI scaffold provides two endpoints used by `server.js` when you prefer local models:

- `POST /api/ocr` — body `{ "image": "data:image/png;base64,..." }` returns `{ "text": "..." }`
- `POST /api/tts` — body `{ "text": "Hello" }` returns `{ "audio": "data:audio/wav;base64,..." }`

It tries the following in order:

- OCR: `easyocr` (preferred) → `pytesseract` fallback
- TTS: `pyttsx3` offline TTS

Install and run:

```bash
python -m venv .venv
source .venv/bin/activate   # or ".venv\Scripts\activate" on Windows
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```

Notes:
- If you want to use Hugging Face model files with `transformers`/`torch`, install those packages and modify `app.py` to load the specific OCR/TTS model from the local path.
- `pytesseract` requires Tesseract installed on your system. On Windows, install Tesseract and ensure it's on PATH.
- `pyttsx3` uses platform TTS drivers (SAPI on Windows). It's not as high-quality as neural vocoders but works offline.
