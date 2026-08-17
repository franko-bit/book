from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import base64
from io import BytesIO
from PIL import Image
import tempfile
import os
import logging

app = FastAPI(title='Local Inference (OCR/TTS)')
logger = logging.getLogger('local_inference')


class OCRRequest(BaseModel):
    image: str


class TTSRequest(BaseModel):
    text: str


def decode_image(data_url: str) -> Image.Image:
    if ',' in data_url:
        header, b64 = data_url.split(',', 1)
    else:
        b64 = data_url
    raw = base64.b64decode(b64)
    return Image.open(BytesIO(raw)).convert('RGB')


# Attempt to load HF models from local folders if present
USE_GPU = os.getenv('USE_GPU', '0') == '1'
device = None
hf_ocr_processor = None
hf_ocr_model = None
hf_tts_tokenizer = None
hf_tts_model = None

try:
    import torch
    import numpy as np
    device = torch.device('cuda' if USE_GPU and torch.cuda.is_available() else 'cpu')
    logger.info(f'Using device: {device}')
    # OCR model
    HF_OCR_MODEL = os.getenv('HF_OCR_MODEL', 'hf_models/zenosai/MonkeyOCRv2-B')
    if os.path.exists(HF_OCR_MODEL):
        try:
            from transformers import AutoProcessor, AutoModelForVision2Seq
            hf_ocr_processor = AutoProcessor.from_pretrained(HF_OCR_MODEL, local_files_only=True)
            hf_ocr_model = AutoModelForVision2Seq.from_pretrained(HF_OCR_MODEL, local_files_only=True).to(device)
            logger.info(f'Loaded local OCR model from {HF_OCR_MODEL}')
        except Exception as e:
            logger.warning(f'Could not load local OCR HF model: {e}')

    # TTS model
    HF_TTS_MODEL = os.getenv('HF_TTS_MODEL', 'hf_models/myshell-ai/MeloTTS-English-v2')
    if os.path.exists(HF_TTS_MODEL):
        try:
            from transformers import AutoTokenizer, AutoModelForTextToWaveform
            hf_tts_tokenizer = AutoTokenizer.from_pretrained(HF_TTS_MODEL, local_files_only=True)
            hf_tts_model = AutoModelForTextToWaveform.from_pretrained(HF_TTS_MODEL, local_files_only=True).to(device)
            logger.info(f'Loaded local TTS model from {HF_TTS_MODEL}')
        except Exception as e:
            logger.warning(f'Could not load local TTS HF model: {e}')
except Exception as e:
    # torch/numpy may not be installed; we'll fallback to easyocr/pytesseract/pyttsx3
    logger.warning('torch/numpy not available, will use lightweight fallbacks')


@app.post('/api/ocr')
async def ocr_endpoint(req: OCRRequest):
    img = decode_image(req.image)

    # If HF OCR model loaded, try it first
    if hf_ocr_model and hf_ocr_processor:
        try:
            # Processor expects PIL image or list
            inputs = hf_ocr_processor(images=img, return_tensors='pt')
            # move tensors to device
            for k, v in inputs.items():
                try:
                    inputs[k] = v.to(device)
                except Exception:
                    pass
            generated = hf_ocr_model.generate(**inputs)
            # try to decode
            try:
                text = hf_ocr_processor.batch_decode(generated, skip_special_tokens=True)[0]
            except Exception:
                # fallback: decode with tokenizer if available
                text = str(generated.tolist())
            return {'text': text}
        except Exception as e:
            logger.warning(f'HF OCR generation failed, falling back: {e}')

    # Try EasyOCR
    try:
        import easyocr
        reader = easyocr.Reader(['en'], gpu=False)
        results = reader.readtext(np.array(img))
        text = '\n'.join([r[1] for r in results])
        return {'text': text}
    except Exception:
        pass

    # Fallback: pytesseract
    try:
        import pytesseract
        text = pytesseract.image_to_string(img)
        return {'text': text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'OCR not available: {e}')


@app.post('/api/tts')
async def tts_endpoint(req: TTSRequest):
    text = req.text

    # If HF TTS is loaded, try to generate waveform
    if hf_tts_model and hf_tts_tokenizer:
        try:
            inputs = hf_tts_tokenizer(text, return_tensors='pt')
            for k, v in inputs.items():
                try:
                    inputs[k] = v.to(device)
                except Exception:
                    pass
            # Many TTS HF models expose generate()
            generated = hf_tts_model.generate(**inputs)
            # generated may be waveform tensor
            try:
                if hasattr(generated, 'cpu'):
                    audio = generated.cpu().numpy()
                    # convert float32 PCM to bytes (assumes -1..1)
                    import soundfile as sf
                    with tempfile.NamedTemporaryFile(delete=False, suffix='.wav') as f:
                        sf.write(f.name, audio, 22050)
                        out_path = f.name
                    with open(out_path, 'rb') as fh:
                        audio_b64 = base64.b64encode(fh.read()).decode('utf-8')
                    os.remove(out_path)
                    return {'audio': f'data:audio/wav;base64,{audio_b64}'}
            except Exception:
                pass
        except Exception as e:
            logger.warning(f'HF TTS generation failed, falling back: {e}')

    # Try pyttsx3 for local offline TTS
    try:
        import pyttsx3
        engine = pyttsx3.init()
        with tempfile.NamedTemporaryFile(delete=False, suffix='.wav') as f:
            out_path = f.name
        engine.save_to_file(text, out_path)
        engine.runAndWait()
        with open(out_path, 'rb') as fh:
            audio_b64 = base64.b64encode(fh.read()).decode('utf-8')
        os.remove(out_path)
        return {'audio': f'data:audio/wav;base64,{audio_b64}'}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'TTS not available: {e}')

