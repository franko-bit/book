#!/bin/bash

# Create models directory
mkdir -p hf_models

# Download OCR model
python3 -c "
from transformers import AutoProcessor, AutoModelForVision2Seq
model_name = 'zenosai/MonkeyOCRv2-B'
save_path = 'hf_models/zenosai/MonkeyOCRv2-B'
processor = AutoProcessor.from_pretrained(model_name)
model = AutoModelForVision2Seq.from_pretrained(model_name)
processor.save_pretrained(save_path)
model.save_pretrained(save_path)
print(f'✅ Downloaded {model_name} to {save_path}')
"

# Download TTS model
python3 -c "
from transformers import AutoTokenizer, AutoModelForTextToWaveform
model_name = 'myshell-ai/MeloTTS-English-v2'
save_path = 'hf_models/myshell-ai/MeloTTS-English-v2'
tokenizer = AutoTokenizer.from_pretrained(model_name)
model = AutoModelForTextToWaveform.from_pretrained(model_name)
tokenizer.save_pretrained(save_path)
model.save_pretrained(save_path)
print(f'✅ Downloaded {model_name} to {save_path}')
"
