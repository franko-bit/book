import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Readable } from 'node:stream';
import dotenv from 'dotenv';
import cloudinary from 'cloudinary';
import multer from 'multer';
import crypto from 'crypto';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

cloudinary.v2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'your_cloud_name',
  api_key: process.env.CLOUDINARY_API_KEY || '',
  api_secret: process.env.CLOUDINARY_API_SECRET || ''
});

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Parse JSON bodies from the frontend
app.use(express.json({ limit: '5mb' }));

// Groq API endpoint (proxied)
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_GROQ_MODEL = 'qwen/qwen3.6-27b';

// API key rotation for rate limiting
let currentApiKeyIndex = 0;
function getGroqApiKeys() {
  const primary = process.env.GROQ_API_KEY;
  const backup = process.env.GROQ_API_KEY_BACKUP;
  return [primary, backup].filter(Boolean);
}

function rotateGroqApiKey() {
  const keys = getGroqApiKeys();
  currentApiKeyIndex = (currentApiKeyIndex + 1) % keys.length;
  return keys[currentApiKeyIndex];
}

function getCurrentGroqApiKey() {
  const keys = getGroqApiKeys();
  return keys[currentApiKeyIndex] || keys[0];
}

const UNSUPPORTED_GROQ_MODELS = new Set([
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'llama-3.1-70b-versatile',
  'mixtral-8x7b-32768',
  'llama-3.3-70b-specdec',
  'meta-llama/llama-3.3-70b-versatile',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'deepseek-r1-distill-llama-70b'
]);

function sanitizeGroqText(rawText) {
  return String(rawText || '')
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<\s*\/\s*think\s*>/gi, '')
    .replace(/```json|```/gi, '')
    .trim();
}

function getGroqModelCandidates(requestedModel) {
  const normalized = String(requestedModel || '').trim();
  const placeholderValues = ['replace_with_supported_model', 'REPLACE_WITH_SUPPORTED_MODEL'];
  const candidates = [];

  if (normalized && !placeholderValues.includes(normalized)) {
    candidates.push(normalized);
  }

  if (!candidates.length || UNSUPPORTED_GROQ_MODELS.has(normalized)) {
    candidates.push(DEFAULT_GROQ_MODEL);
  }

  return [...new Set(candidates)];
}

app.post('/api/groq', async (req, res) => {
  const apiKeys = getGroqApiKeys();
  if (!apiKeys.length) return res.status(500).json({ error: 'No GROQ_API_KEY configured on server' });

  const body = { ...req.body };
  const modelCandidates = getGroqModelCandidates(body.model);
  let lastError = null;
  let lastStatus = null;
  const maxRetries = Math.min(3, modelCandidates.length + 1);
  const timeoutMs = 20000;
  let apiKeyAttempts = 0;
  const maxApiKeyAttempts = apiKeys.length;

  while (apiKeyAttempts < maxApiKeyAttempts) {
    apiKeyAttempts++;
    const currentApiKey = getCurrentGroqApiKey();
    const modelCandidatesCopy = [...modelCandidates];

    console.log(`🔑 Using Groq API key index: ${currentApiKeyIndex} (attempt ${apiKeyAttempts}/${maxApiKeyAttempts})`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const currentModel = modelCandidatesCopy.shift();
      if (!currentModel) break;

      const payload = { ...body, model: currentModel };

      try {
        console.log(`📤 Proxying to Groq (attempt ${attempt}/${maxRetries}): model=${currentModel}, messages=${payload.messages?.length || 0}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const resp = await fetch(GROQ_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${currentApiKey}`
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        clearTimeout(timeoutId);
        console.log(`📥 Groq response: ${resp.status}`);

        const contentType = resp.headers.get('content-type') || 'application/json';
        const text = await resp.text();

        if (!resp.ok) {
          lastStatus = resp.status;
          const errorText = text.substring(0, 200);
          console.error(`❌ Groq error (${resp.status}):`, errorText);

          // If rate limited (429), switch to backup API key
          if (resp.status === 429 && apiKeyAttempts < maxApiKeyAttempts) {
            console.warn(`⚠️ Rate limited (429). Rotating to backup API key...`);
            rotateGroqApiKey();
            break; // Break inner loop, try again with backup key
          }

          // If bad request or not found with more models available, try next model
          if ((resp.status === 400 || resp.status === 404) && modelCandidatesCopy.length > 0) {
            console.warn(`🔁 Retrying with Groq fallback model: ${modelCandidatesCopy[0]}`);
            continue;
          }
        }

        res.status(resp.status).type(contentType).send(text);
        return;

      } catch (err) {
        lastError = err;
        console.error(`⚠️ Attempt ${attempt} failed:`, err.message);

        if (attempt < maxRetries && modelCandidatesCopy.length > 0) {
          const delay = attempt * 1000;
          console.log(`⏳ Waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
  }

  console.error('💥 Groq proxy failed after all retries and API key rotations');
  res.status(lastStatus || 502).json({
    error: 'Unable to reach Groq API',
    details: lastError?.message || 'All API keys exhausted or rate limited'
  });
});

// ElevenLabs TTS API endpoint (proxied with retry and chunked response)
const ELEVENLABS_URL_TEMPLATE = 'https://api.elevenlabs.io/v1/text-to-speech/{voice_id}';

app.post('/api/tts', async (req, res) => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not set on server' });
  
  const { text, voice_id } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  const selectedVoiceId = voice_id || process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
  const url = ELEVENLABS_URL_TEMPLATE.replace('{voice_id}', selectedVoiceId);
  const payload = {
    text,
    model_id: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75
    }
  };

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`🔊 TTS (${voice_id}) attempt ${attempt}/2: "${text.slice(0, 50)}..."`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 100)}`);
      }

      // Stream audio response
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Transfer-Encoding', 'chunked');
      Readable.fromWeb(response.body).pipe(res);
      return;
      
    } catch (err) {
      lastError = err;
      console.error(`⚠️ TTS attempt ${attempt} failed:`, err.message);
      
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  console.error('💥 TTS failed:', lastError?.message);
  res.status(502).json({ error: 'Text-to-speech failed', details: lastError?.message });
});

// Translation endpoint
app.post('/api/translate', async (req, res) => {
  const apiKeys = getGroqApiKeys();
  if (!apiKeys.length) return res.status(500).json({ error: 'No GROQ_API_KEY configured on server' });

  const { text, target_language, targetLang } = req.body;
  const resolvedTargetLanguage = (target_language || targetLang || '').trim();

  if (!text) return res.status(400).json({ error: 'text is required' });
  if (!resolvedTargetLanguage) return res.status(400).json({ error: 'target language is required' });

  let lastError = null;
  let lastStatus = null;
  let apiKeyAttempts = 0;
  const maxApiKeyAttempts = apiKeys.length;

  while (apiKeyAttempts < maxApiKeyAttempts) {
    apiKeyAttempts++;
    const currentApiKey = getCurrentGroqApiKey();

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`🌐 Translating to ${resolvedTargetLanguage} (attempt ${attempt}/2, API key ${apiKeyAttempts}/${maxApiKeyAttempts}): ${text.slice(0, 50)}...`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);

        const response = await fetch(GROQ_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${currentApiKey}`
          },
          body: JSON.stringify({
            model: DEFAULT_GROQ_MODEL,
            messages: [
              {
                role: 'user',
                content: `Translate the following text to ${resolvedTargetLanguage}. Return ONLY the translated text, with no explanations or metadata.\n\n${text}`
              }
            ],
            temperature: 0.2
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          lastStatus = response.status;
          const errorText = await response.text();
          
          // If rate limited (429), switch to backup API key
          if (response.status === 429 && apiKeyAttempts < maxApiKeyAttempts) {
            console.warn(`⚠️ Rate limited (429). Rotating to backup API key...`);
            rotateGroqApiKey();
            throw new Error('ROTATE_API_KEY'); // Signal to break inner loop
          }
          
          throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 200)}`);
        }

        const result = await response.json();
        const translated = sanitizeGroqText(result.choices?.[0]?.message?.content || '');
        return res.json({ translated });

      } catch (err) {
        // If we need to rotate API key, break inner loop
        if (err.message === 'ROTATE_API_KEY') {
          break;
        }
        
        lastError = err;
        console.error(`⚠️ Translation attempt ${attempt} failed:`, err.message);

        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }

  console.error('💥 Translation failed:', lastError?.message);
  res.status(lastStatus || 502).json({ error: 'Translation failed', details: lastError?.message });
});

function isPdfBuffer(buffer) {
  if (!buffer || buffer.length < 5) return false;
  return buffer.slice(0, 5).toString('ascii') === '%PDF-';
}

app.post('/api/upload-book', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided' });
  }

  const fileName = req.file.originalname || 'document.pdf';
  const isPdfByName = /\.pdf$/i.test(fileName);
  const isPdfByContent = isPdfBuffer(req.file.buffer);

  if (!isPdfByName && !isPdfByContent) {
    return res.status(400).json({ error: 'Only PDF files are allowed' });
  }
  const safeBaseName = fileName
    .replace(/\.pdf$/i, '')
    .replace(/[^a-zA-Z0-9-_]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'book';

  console.log(`📚 Uploading book: ${fileName} as ${safeBaseName}`);

  try {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.v2.uploader.upload_stream(
        {
          resource_type: 'auto',
          folder: 'book',
          access_mode: 'public',
          public_id: safeBaseName,
          format: 'pdf',
          use_filename: true,
          unique_filename: false,
          overwrite: true,
          type: 'upload'
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    console.log(`✅ Book uploaded to Cloudinary: ${result.public_id} (${result.format || 'pdf'})`);

    const localName = `${Date.now()}-${fileName}`;
    const localPath = path.join(uploadsDir, localName);
    fs.writeFileSync(localPath, req.file.buffer);
    console.log(`💾 Book saved locally: ${localName}`);

    const cloudinaryUrl = result.secure_url;

    return res.json({
      secure_url: cloudinaryUrl || `/api/files/${encodeURIComponent(localName)}`,
      public_id: result.public_id || safeBaseName,
      resource_type: result.resource_type || 'pdf',
      local_url: `/api/files/${encodeURIComponent(localName)}`
    });
  } catch (err) {
    console.error('❌ Upload error:', err);
    return res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

app.use('/api/files', express.static(uploadsDir));

const PORT = process.env.PORT || 3000;

// Serve static frontend files from project root
app.use(express.static(path.join(__dirname)));

// Serve main frontend file at root (file is named indx.html)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'indx.html'));
});

// Simple health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Environment debug (returns whether GROQ API key is loaded; value masked)
app.get('/api/env', (req, res) => {
  const key = process.env.GROQ_API_KEY || '';
  const cloudKey = process.env.CLOUDINARY_CLOUD_NAME || '';
  res.json({ 
    groq_key_set: !!key,
    cloudinary_configured: cloudKey && cloudKey !== 'your_cloud_name'
  });
});

// ===== CLOUDINARY BOOKS LIST =====
function getLocalBooks() {
  try {
    return fs.readdirSync(uploadsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.pdf$/i.test(entry.name))
      .map((entry) => ({
        title: entry.name.replace(/^\d+-/, '').replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ') || 'Untitled',
        author: 'Local library',
        resource_type: 'local',
        format: 'pdf',
        url: `/api/files/${encodeURIComponent(entry.name)}`
      }));
  } catch (err) {
    console.warn('Could not read local book library:', err.message);
    return [];
  }
}

app.get('/api/cloudinary-books', async (req, res) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || '';
  const apiKey = process.env.CLOUDINARY_API_KEY || '';
  const apiSecret = process.env.CLOUDINARY_API_SECRET || '';

  if (!cloudName || cloudName === 'your_cloud_name' || !apiKey || !apiSecret) {
    console.warn('⚠️ Cloudinary not configured; returning empty library list.');
    return res.json({ books: getLocalBooks(), warning: 'Cloudinary not configured' });
  }

  try {
    let result = null;
    const expressions = ['folder="book"', 'folder:"book"', 'resource_type:pdf AND folder:"book"', 'folder:"book" AND format:pdf'];
    let lastErr = null;

    for (const expression of expressions) {
      try {
        result = await cloudinary.v2.search
          .expression(expression)
          .max_results(100)
          .execute();
        if (result) break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (!result) {
      throw lastErr || new Error('Cloudinary search returned no result');
    }

    const validBooks = (result.resources || []).filter(file => {
      const resourceType = file.resource_type || 'image';
      const format = (file.format || '').toLowerCase();
      const secureUrl = file.secure_url || '';
      const publicId = file.public_id || '';
      const isPdf = format === 'pdf' || /\.pdf$/i.test(secureUrl) || /\.pdf$/i.test(publicId);
      const notStale = !!publicId && !!secureUrl && (resourceType === 'image' || resourceType === 'raw' || resourceType === 'document');
      return isPdf && notStale;
    });

    console.log(`📚 Found ${validBooks.length} valid PDFs in Cloudinary`);

    const books = validBooks.map(file => {
      const resourceType = file.resource_type || 'image';
      const format = file.format || 'pdf';
      const publicId = file.public_id || 'book/untitled';

      return {
        title: publicId.split('/').pop() || 'Untitled',
        author: 'Cloudinary',
        public_id: publicId,
        resource_type: resourceType,
        format,
        url: `/api/cloudinary-file/${encodeURIComponent(publicId)}/${encodeURIComponent(resourceType)}`,
        secure_url: file.secure_url
      };
    });

    res.json({ books: [...books, ...getLocalBooks()] });
  } catch (err) {
    const detail = err?.error?.message || err?.message || JSON.stringify(err || {});
    console.error('❌ Cloudinary books fetch error:', detail);
    res.status(200).json({ books: getLocalBooks(), warning: 'Cloudinary search unavailable', details: detail });
  }
});

// ===== IMPROVED CLOUDINARY FILE PROXY WITH MULTIPLE STRATEGIES =====
app.get('/api/cloudinary-file/:publicId/:resourceType?', async (req, res) => {
  try {
    const publicId = decodeURIComponent(req.params.publicId);
    const resourceTypeParam = req.params.resourceType ? decodeURIComponent(req.params.resourceType) : null;
    console.log(`\n📄 [Cloudinary File Proxy] Fetching: ${publicId} (resourceType: ${resourceTypeParam || 'auto'})`);

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || cloudName === 'your_cloud_name') {
      console.error('❌ CLOUDINARY_CLOUD_NAME not configured');
      return res.status(500).json({
        error: 'Cloudinary not configured on server',
        hint: 'Set CLOUDINARY_CLOUD_NAME environment variable'
      });
    }

    const resourceTypes = Array.from(new Set([resourceTypeParam, 'image', 'raw', 'document', 'auto'].filter(Boolean)));
    const normalizedPublicIds = Array.from(new Set([
      publicId,
      publicId.replace(/\.[^.]+$/i, ''),
      publicId.endsWith('.pdf') ? publicId : `${publicId}.pdf`,
      publicId.endsWith('.pdf') ? publicId.replace(/\.pdf$/i, '') : publicId
    ].filter(Boolean)));

    const sendBuffer = async (buffer, source) => {
      console.log(`  ✅ ${source} succeeded! (${buffer.length} bytes)`);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Accept-Ranges', 'bytes');
      return res.send(buffer);
    };

    let resource = null;
    if (apiKey && apiSecret) {
      try {
        resource = await cloudinary.v2.api.resource(publicId, { type: 'upload' });
      } catch (err) {
        console.warn(`  ⚠️ Lookup by publicId failed: ${err.message}`);
      }
    }

    const downloadType = resource?.resource_type || resourceTypeParam || 'image';
    const signedUrl = cloudinary.v2.utils.private_download_url(publicId, 'pdf', {
      resource_type: downloadType,
      type: 'upload',
      secure: true
    });

    const candidateUrls = [signedUrl];
    if (resource?.secure_url) {
      candidateUrls.push(resource.secure_url);
    }
    for (const resourceType of resourceTypes) {
      for (const publicPath of normalizedPublicIds) {
        candidateUrls.push(`https://res.cloudinary.com/${cloudName}/${resourceType}/upload/${publicPath}`);
      }
    }
    const uniqueUrls = Array.from(new Set(candidateUrls));

    for (const url of uniqueUrls) {
      try {
        console.log(`  📍 Fetching candidate URL: ${url.substring(0, 120)}...`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (Book Reader)' }
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const sourceLabel = url === signedUrl ? 'Signed Cloudinary URL' : 'Direct Cloudinary URL';
          return await sendBuffer(buffer, sourceLabel);
        }

        console.warn(`  ⚠️ Candidate failed: HTTP ${response.status} for ${url.substring(0, 100)}`);
      } catch (err) {
        console.warn(`  ⚠️ Candidate error: ${err.message}`);
      }
    }

    console.error(`\n❌ ALL STRATEGIES FAILED for ${publicId}`);
    return res.status(502).json({
      error: 'Unable to fetch file from Cloudinary',
      hint: 'The file exists but cannot be downloaded. Try re-uploading the PDF.',
      publicId,
      resourceTypesTried: resourceTypes,
      candidateCount: uniqueUrls.length
    });
  } catch (err) {
    console.error('💥 Cloudinary file fetch error:', err.message);
    res.status(500).json({
      error: 'Server error fetching from Cloudinary',
      details: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Server listening on http://localhost:${PORT}`);
  console.log(`\n✅ Configuration Check:`);
  console.log(`   - GROQ_API_KEY: ${process.env.GROQ_API_KEY ? '✓ Set' : '✗ Not set'}`);
  console.log(`   - CLOUDINARY_CLOUD_NAME: ${process.env.CLOUDINARY_CLOUD_NAME ? '✓ Set' : '✗ Not set'}`);
  console.log(`   - CLOUDINARY_API_KEY: ${process.env.CLOUDINARY_API_KEY ? '✓ Set' : '✗ Not set'}`);
  console.log(`   - CLOUDINARY_API_SECRET: ${process.env.CLOUDINARY_API_SECRET ? '✓ Set' : '✗ Not set'}\n`);
});
