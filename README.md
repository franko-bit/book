# Reader AI Stack Setup

This project uses the following core technologies:

- `PDF.js` for PDF rendering and text extraction
- `MonkeyOCRv2` for scanned/image-only PDF OCR
- `Piper` for local text-to-speech playback

## Download / Integration

### PDF.js

You can include PDF.js from a CDN or download it locally.

CDN example:
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.6.172/pdf.min.js"></script>
<script>pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.6.172/pdf.worker.min.js';</script>
```

If you want a local copy, download the PDF.js distribution from https://mozilla.github.io/pdf.js/getting_started/ and place the files in your project.

### MonkeyOCRv2

`MonkeyOCRv2` is an OCR model/service. The model weights and inference code can be downloaded from the Hugging Face model hub at `https://huggingface.co/models`.

Example workflow:
- Render the PDF page to a canvas with `PDF.js`
- Export the image using `canvas.toDataURL()` or `canvas.toBlob()`
- Send the image to `MonkeyOCRv2` for OCR
- Store the returned text by page

Typical download approach:
```bash
pip install huggingface_hub
huggingface-cli login
huggingface-cli repo clone <MODEL_ID>
```

If the model is not a repo, use the `huggingface_hub` Python client to fetch weights or inference files.

### Piper TTS

Piper uses a pretrained ONNX voice locally. The supported audiobook presets are `lessac` (medium/high), `ryan` (medium/high), and `amy` (medium). Review the voice model card before commercial use.

Install the Python dependencies and start the local service:

```bash
pip install -r local_inference/requirements.txt
python download_piper_voice.py --voice lessac --quality high
uvicorn local_inference.app:app --host 127.0.0.1 --port 8000
```

To choose another voice, use `--voice ryan --quality high` or `--voice amy --quality medium`. The default model path is `local_inference/voices/reader01/en_US-lessac-high.onnx`; set `PIPER_MODEL` before starting Uvicorn if you download to another location. The matching JSON file is downloaded beside the model.

Check the service with `http://127.0.0.1:8000/health`, then start the Node backend in a second terminal:

```bash
npm install
npm start
```

The existing Node `/api/tts` endpoint uses Piper by default (`TTS_PROVIDER=piper`) and forwards the generated WAV to the reader. Generated WAV files are cached in `local_inference/generated/` by voice model and text hash. Set `TTS_PROVIDER=elevenlabs` only when you explicitly want the cloud provider.

The default Piper settings are tuned for calm reading: `PIPER_LENGTH_SCALE=1.08` slows the narration slightly, while the noise settings preserve natural variation. Adjust `PIPER_LENGTH_SCALE` between `1.0` and `1.2` if you want faster or more relaxed pacing. Restart the Python service after changing these values.

## Deploy to Render

The included `render.yaml` creates two services:

- `book-reader`: the public Node reader
- `piper-tts`: the private Python Piper service

Create a new Render Blueprint from this repository. Render will build the Piper service, download Lessac High, and connect the Node service to Piper through `LOCAL_TTS_URL`. Add `GROQ_API_KEY` and the Cloudinary values as secret environment variables in Render; `.env` is not uploaded automatically.

The free plan has limited CPU and services can spin down when idle, so first audio may take longer. Its filesystem is ephemeral, meaning generated audio cache can be lost after a redeploy. Use a paid persistent disk or external object storage when you need durable audiobook caching.

## Groq API

This project uses Groq for AI question answering. The API key is stored in `.env`.

To start the backend server:
```bash
npm install
npm start
```

The frontend calls `/api/groq` and the backend forwards requests to Groq with the key.

## Notes

- `PDF.js` is the only actual downloaded JavaScript library included in the frontend.
- `MonkeyOCRv2` is an external OCR model and requires model integration; Piper runs locally through `local_inference/app.py`.
- The project already separates core logic into `reader.js`, so the frontend and backend hooks are not in one file.
