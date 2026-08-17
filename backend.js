import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
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

app.post('/api/groq', async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not set on server' });
  
  // Use model provided in the request body. Do not require a server-side GROQ_MODEL.
  const body = { ...req.body };
  const model = body.model;
  const placeholderValues = ['replace_with_supported_model', 'REPLACE_WITH_SUPPORTED_MODEL'];

  if (!model || placeholderValues.includes(String(model))) {
    return res.status(400).json({
      error: 'Model not specified or uses placeholder. Include a valid Groq model name in the request body as `model`, e.g. { "model": "llama-3.3-70b-versatile", ... }'
    });
  }
  
  // Retry logic for Groq API calls
  let lastError = null;
  const maxRetries = 2;
  const timeoutMs = 20000; // 20 second timeout (increased from default 10s)
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`📤 Proxying to Groq (attempt ${attempt}/${maxRetries}): model=${model}, messages=${body.messages?.length || 0}`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      
      const resp = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      console.log(`📥 Groq response: ${resp.status}`);
      
      if (!resp.ok) {
        const errorText = await resp.text();
        console.error(`❌ Groq error (${resp.status}):`, errorText.substring(0, 200));
      }
      
      const contentType = resp.headers.get('content-type') || 'application/json';
      const text = await resp.text();
      res.status(resp.status).type(contentType).send(text);
      return;
      
    } catch (err) {
      lastError = err;
      console.error(`⚠️ Attempt ${attempt} failed:`, err.message);
      
      if (attempt < maxRetries) {
        const delay = attempt * 1000; // 1s, then 2s
        console.log(`⏳ Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  // All retries exhausted
  console.error('💥 Groq proxy failed after all retries:', lastError?.message);
  res.status(502).json({ 
    error: 'Unable to reach Groq API',
    details: lastError?.message || 'Connection timeout'
  });
});

// ElevenLabs TTS API endpoint (proxied with retry and chunked response)
const ELEVENLABS_URL_TEMPLATE = 'https://api.elevenlabs.io/v1/text-to-speech/{voice_id}';

app.post('/api/tts', async (req, res) => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not set on server' });
  
  const { text, voice_id } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  const url = ELEVENLABS_URL_TEMPLATE.replace('{voice_id}', voice_id || 'EXAVITQu4vr4xnSDxMaL');
  const payload = {
    text,
    model_id: 'eleven_monolingual_v1',
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
      response.body.pipe(res);
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
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not set on server' });

  const { text, target_language, targetLang } = req.body;
  const resolvedTargetLanguage = (target_language || targetLang || '').trim();

  if (!text) return res.status(400).json({ error: 'text is required' });
  if (!resolvedTargetLanguage) return res.status(400).json({ error: 'target language is required' });

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`🌐 Translating to ${resolvedTargetLanguage} (attempt ${attempt}/2): ${text.slice(0, 50)}...`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);

      const response = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
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
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 200)}`);
      }

      const result = await response.json();
      const translated = result.choices?.[0]?.message?.content || '';
      return res.json({ translated });

    } catch (err) {
      lastError = err;
      console.error(`⚠️ Translation attempt ${attempt} failed:`, err.message);

      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  console.error('💥 Translation failed:', lastError?.message);
  res.status(502).json({ error: 'Translation failed', details: lastError?.message });
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
app.get('/api/cloudinary-books', async (req, res) => {
  try {
    const result = await cloudinary.v2.search
      .expression(`folder="book"`)
      .max_results(100)
      .execute();

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

    res.json({ books });
  } catch (err) {
    console.error('❌ Cloudinary books fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch books from Cloudinary', details: err.message });
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
