# Reader AI Stack Setup

This project uses the following core technologies:

- `PDF.js` for PDF rendering and text extraction
- `MonkeyOCRv2` for scanned/image-only PDF OCR
- `MeloTTS` for text-to-speech playback

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

### MeloTTS

`MeloTTS` is a text-to-speech model. Download the model from Hugging Face and use it through your backend or a local inference service.

Example workflow:
- Send selected text to the MeloTTS model/service
- Receive an audio URL or audio blob
- Play it in an HTML `<audio>` element

Typical download approach:
```bash
pip install huggingface_hub
huggingface-cli login
huggingface-cli repo clone <MODEL_ID>
```

For both OCR and TTS, use the Hugging Face model search page:
- https://huggingface.co/models?search=MonkeyOCRv2
- https://huggingface.co/models?search=MeloTTS

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
- `MonkeyOCRv2` and `MeloTTS` are external AI services / APIs and require API integration.
- The project already separates core logic into `reader.js`, so the frontend and backend hooks are not in one file.
