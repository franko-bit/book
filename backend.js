import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Readable } from 'node:stream';
import dotenv from 'dotenv';
import cloudinary from 'cloudinary';
import multer from 'multer';
import crypto from 'crypto';
import { PDFParse } from 'pdf-parse';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, 'uploads');
const introductionsDir = path.join(__dirname, 'introductions');
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(introductionsDir, { recursive: true });

cloudinary.v2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'your_cloud_name',
  api_key: process.env.CLOUDINARY_API_KEY || '',
  api_secret: process.env.CLOUDINARY_API_SECRET || ''
});

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const cloudinaryEnabled = String(process.env.CLOUDINARY_ENABLED || 'true').toLowerCase() !== 'false';

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
  let text = String(rawText || '');

  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  text = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
  text = text.replace(/<\s*\/?think[^>]*>/gi, '');
  text = text.replace(/```[\s\S]*?```/gi, '');
  text = text.replace(/```json|```/gi, '');

  const sourceAppendix = text.search(/\n\s*2\s*\n\s*crime-and-punishment\b/i);
  if (sourceAppendix >= 0) {
    text = text.slice(0, sourceAppendix).trim();
  }

  const combinedTranslations = [...text.matchAll(/\bCombine(?:d)?\s*:\s*([\s\S]*?)(?=\n\s*(?:-\s*|Actually|Let's|Wait|$))/gi)];
  if (combinedTranslations.length) {
    text = combinedTranslations[combinedTranslations.length - 1][1].trim();
  }

  const assembledTranslation = text.match(/Assemble and Refine(?:\s*\([^)]*\))?\s*:\s*([\s\S]*?)(?=\bCheck accuracy and tone\b)/i);
  if (assembledTranslation) {
    text = assembledTranslation[1].trim();
  }

  const finalTranslation = text.match(/(?:Refine Translation|Final Translation|Translation)\s*(?:\([^)]*\))?\s*\*{0,2}\s*:\s*\*{0,2}\s*["“']?([\s\S]*?)(?=\n?\s*(?:Check accuracy|Double-check|Ready|$))/i);
  if (finalTranslation) {
    text = finalTranslation[1].trim();
  }

  const reasoningPattern = /Here's\s+a\s+thinking\s+process|Draft Translation|Mental Draft|Mental Refinement|Final check|Self-Correction|Output Generation|All constraints met|Double-check constraints|One minor adjustment|Ready[.!]?✅?|Proceed[s]?\.?✅|Matches request exactly/i;
  if (reasoningPattern.test(text)) {
    const labels = [...text.matchAll(/(?:Final|Output|Translation|Text)\s*:/gi)];
    if (labels.length) {
      text = text.slice(labels[labels.length - 1].index + labels[labels.length - 1][0].length);
    } else {
      text = text.replace(/^.*?(?:Here's\s+a\s+thinking\s+process\s*:)/is, '');
    }
    text = text.split(/\b(?:Matches request exactly|All constraints met|Output matches|Self-Correction|Double-check constraints|One minor adjustment|Ready[.!]?✅?|Proceed[s]?\.?✅)\b/i)[0];
  }

  text = text.replace(/^\s*(?:Final|Output|Translation|Text)\s*:\s*/i, '');
  text = text.replace(/^\s*[*_"“']+|[*_"”']+\s*$/g, '');
  text = text.replace(/\[.*?\]/g, '');
  text = text.replace(/\(Note:.*?\)/gi, '');
  text = text.replace(/<[^>]*>/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
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

const TRANSLATION_LANGUAGE_CODES = new Set(['es', 'fr', 'de', 'it', 'pt', 'ru', 'zh', 'sw', 'rw']);
const introductionJobs = new Set();
const cloudinaryIntroductionJobs = new Set();
const INTRODUCTION_PROMPT_VERSION = 10;

function cleanIntroductionText(rawText) {
  let intro = String(rawText || '')
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:text|markdown)?/gi, '')
    .replace(/```/g, '')
    .replace(/^\s*(?:Introduction|INTRODUCTION|Final answer|FINAL ANSWER)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const draftMarkers = /\b(?:mental draft|draft translation|evaluate constraints|book title\s*:|opening pages\s*:|let'?s refine|combine(?:d)?\s*:|check accuracy|double-check|response must|system prompt|as an ai)\b|^[-*]\s|->/i;
  const quoteCount = (intro.match(/["“”]/g) || []).length;
  if (!intro || intro.length > 500 || draftMarkers.test(intro) || quoteCount % 2 !== 0) return '';
  return intro;
}

function getBookIdFromBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function removeBookBoilerplate(text) {
  return String(text || '')
    .replace(/Download free eBooks?[^.?!]*(?:[.?!]|$)/gi, '')
    .replace(/Subscribe to (?:our|the) free eBooks? blog[^.?!]*(?:[.?!]|$)/gi, '')
    .replace(/(?:free eBooks? blog|email newsletter|newsletter via email)[^.?!]*(?:[.?!]|$)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function extractIntroductionSource(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText({ first: 6, itemJoiner: ' ' });
    const info = await parser.getInfo();
    return {
      text: removeBookBoilerplate((result.pages || []).map(page => page.text || '').join('\n\n')),
      title: info.info?.Title || '',
      author: info.info?.Author || ''
    };
  } finally {
    await parser.destroy();
  }
}

function inferBookIdentity(bookTitle, sourceText) {
  const text = String(sourceText || '').replace(/\s+/g, ' ').trim();
  const authorMatch = text.match(/(?:written|著|by|author(?:\s+is)?|translated\s+by)\s*[:,-]?\s+([A-Z][A-Za-zÀ-ÿ' .-]{2,80})/i);
  const author = authorMatch?.[1]?.replace(/\s+(?:and|with|from)\s+.*$/i, '').trim() || '';
  return { title: String(bookTitle || '').replace(/[_-]+/g, ' ').trim(), author };
}

async function researchBookOnline(title, author) {
  if (!title || !author) return null;
  const titleNeedle = title.toLowerCase();
  const authorNeedle = author.toLowerCase();
  const authorTokens = authorNeedle.split(/[^a-z0-9]+/i).filter(token => token.length > 2);
  const authorMatches = candidate => {
    const normalizedCandidate = String(candidate || '').toLowerCase();
    return normalizedCandidate.includes(authorNeedle)
      || authorNeedle.includes(normalizedCandidate)
      || (authorTokens.length > 0 && authorTokens.every(token => normalizedCandidate.includes(token)));
  };

  try {
    const googleQuery = encodeURIComponent(`intitle:${title} inauthor:${author}`);
    const googleResponse = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${googleQuery}&maxResults=10`, {
      headers: { 'User-Agent': 'BookReader/1.0 (book metadata research)' }
    });
    if (googleResponse.ok) {
      const googleResult = await googleResponse.json();
      const googleMatch = (googleResult.items || []).map(item => item.volumeInfo || {}).find(info =>
        String(info.title || '').toLowerCase().includes(titleNeedle)
        && (info.authors || []).some(authorMatches)
      );
      if (googleMatch) {
        return {
          source: 'Google Books',
          title: googleMatch.title,
          authors: googleMatch.authors?.slice(0, 3) || [],
          published_date: googleMatch.publishedDate || null,
          description: String(googleMatch.description || '').slice(0, 1200),
          categories: googleMatch.categories?.slice(0, 8) || [],
          url: googleMatch.infoLink || 'https://books.google.com/'
        };
      }
    }

    const query = new URLSearchParams({ title, author }).toString();
    const response = await fetch(`https://openlibrary.org/search.json?${query}&limit=5`, {
      headers: { 'User-Agent': 'BookReader/1.0 (book metadata research)' }
    });
    if (!response.ok) return null;
    const result = await response.json();
    const match = (result.docs || []).find(doc =>
      String(doc.title || '').toLowerCase().includes(titleNeedle)
      && (doc.author_name || []).some(authorMatches)
    );
    if (!match) return null;
    return {
      source: 'Open Library',
      title: match.title,
      authors: match.author_name?.slice(0, 3) || [],
      first_publish_year: match.first_publish_year || null,
      subjects: match.subject?.slice(0, 8) || [],
      description: Array.isArray(match.first_sentence) ? String(match.first_sentence[0] || '') : String(match.first_sentence || ''),
      edition_count: match.edition_count || null,
      url: match.key ? `https://openlibrary.org${match.key}` : 'https://openlibrary.org/'
    };
  } catch (error) {
    console.warn('Online book research unavailable:', error.message);
    return null;
  }
}

app.get('/api/book-research', async (req, res) => {
  const title = String(req.query.title || '').trim();
  const author = String(req.query.author || '').trim();
  if (!title || !author) {
    return res.status(400).json({ error: 'title and author are required' });
  }

  const research = await researchBookOnline(title, author);
  res.json({
    query: { title, author },
    google_url: `https://www.google.com/search?q=${encodeURIComponent(`"${title}" "${author}"`)}`,
    research
  });
});

function getIntroductionPath(bookId) {
  const safeBookId = String(bookId || '').replace(/[^a-f0-9]/gi, '').toLowerCase();
  return safeBookId ? path.join(introductionsDir, `${safeBookId}.json`) : null;
}

async function generateAndSaveIntroduction({ bookId, bookTitle, bookAuthor = '', sourceText }) {
  const outputPath = getIntroductionPath(bookId);
  if (!outputPath || !sourceText?.trim() || !getGroqApiKeys().length) return;

  try {
    const inferredIdentity = inferBookIdentity(bookTitle, sourceText);
    const identity = {
      title: inferredIdentity.title,
      author: bookAuthor || inferredIdentity.author
    };
    const onlineResearch = await researchBookOnline(identity.title, identity.author);
    const researchContext = onlineResearch
      ? `Reliable online research match:\n${JSON.stringify(onlineResearch)}`
      : 'No reliable online match was found using the title and author. Use only the six supplied pages.';

    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getCurrentGroqApiKey()}`
      },
      body: JSON.stringify({
        model: getGroqModelCandidates(process.env.GROQ_MODEL)[0],
        messages: [
          {
            role: 'system',
            content: 'Write only a polished, professional spoken introduction for a literary audiobook. Use 3 or 4 concise, well-formed sentences in a calm, confident, human narrator voice. Establish the book identity when supported, then explain its central purpose, deeper message, lasting significance, and the value it offers the reader. Tell the listener what kind of understanding or reflection they may gain. Do not list themes, retell the six pages, quote the book, or make unsupported claims. Combine reliable online research with the six supplied opening pages when a title-and-author match is provided; otherwise rely entirely on the six pages. Do not mention research, pages, instructions, or labels.'
          },
          {
            role: 'user',
            content: `Book title: ${identity.title || 'this book'}\nAuthor identified from the title/opening pages: ${identity.author || 'unknown'}\n\n${researchContext}\n\nSix opening pages (the complete text available for page analysis):\n${sourceText.slice(0, 14000)}\n\nWrite a professional introduction centered on the book's purpose, central message, deeper value, significance, and reader takeaway. Capture its essence rather than summarizing or listing the pages.`
          }
        ],
        temperature: 0.4,
        max_tokens: 180,
        reasoning_effort: 'none'
      })
    });
    if (!response.ok) throw new Error(`Groq introduction failed: ${response.status}`);

    const result = await response.json();
    const intro = cleanIntroductionText(result.choices?.[0]?.message?.content || '');
    if (!intro) throw new Error('Groq returned an invalid introduction');

    fs.writeFileSync(outputPath, JSON.stringify({
      book_id: bookId,
      language: 'en',
      intro,
      pages_used: [1, 2, 3, 4, 5, 6],
      online_research: onlineResearch?.source || null,
      prompt_version: INTRODUCTION_PROMPT_VERSION,
      created_at: new Date().toISOString()
    }, null, 2));
    console.log(`✅ Saved book introduction: ${bookId}`);
  } catch (error) {
    console.warn(`⚠️ Introduction generation failed for ${bookId}:`, error.message);
  }
}

async function queueIntroductionForPdf(buffer, bookTitle) {
  const bookId = getBookIdFromBuffer(buffer);
  const outputPath = getIntroductionPath(bookId);
  let isCurrent = false;
  if (outputPath && fs.existsSync(outputPath)) {
    try {
      isCurrent = JSON.parse(fs.readFileSync(outputPath, 'utf8')).prompt_version === INTRODUCTION_PROMPT_VERSION;
    } catch (_) {}
  }
  if (!outputPath || isCurrent || introductionJobs.has(bookId)) return bookId;

  introductionJobs.add(bookId);
  try {
    const extracted = await extractIntroductionSource(buffer);
    if (extracted?.text) {
      await generateAndSaveIntroduction({
        bookId,
        bookTitle: extracted.title || bookTitle,
        bookAuthor: extracted.author,
        sourceText: extracted.text
      });
    }
  } catch (error) {
    console.warn(`⚠️ Could not extract introduction source for ${bookId}:`, error.message);
  } finally {
    introductionJobs.delete(bookId);
  }
  return bookId;
}

function queueCloudinaryBookIntroduction(book) {
  if (!book?.secure_url || !book.public_id) {
    console.warn(`⚠️ Cannot queue introduction for ${book?.title || 'Cloudinary book'}: missing file URL`);
    return;
  }
  if (cloudinaryIntroductionJobs.has(book.public_id)) return;
  cloudinaryIntroductionJobs.add(book.public_id);

  void (async () => {
    try {
      const signedUrl = cloudinary.v2.utils.private_download_url(book.public_id, 'pdf', {
        resource_type: book.resource_type || 'image',
        type: 'upload',
        secure: true
      });
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      try {
        const response = await fetch(signedUrl, { signal: controller.signal });
        if (!response.ok) throw new Error(`Cloudinary returned ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        await queueIntroductionForPdf(buffer, book.title);
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      console.warn(`⚠️ Could not queue introduction for ${book.title}:`, error.message);
    } finally {
      cloudinaryIntroductionJobs.delete(book.public_id);
    }
  })();
}

app.get('/api/introductions/:bookId', (req, res) => {
  const introductionPath = getIntroductionPath(req.params.bookId);
  if (!introductionPath || !fs.existsSync(introductionPath)) {
    return res.status(404).json({ error: 'Introduction not found' });
  }
  try {
    const introduction = JSON.parse(fs.readFileSync(introductionPath, 'utf8'));
    if (introduction.prompt_version !== INTRODUCTION_PROMPT_VERSION) {
      return res.status(404).json({ error: 'Introduction requires regeneration' });
    }
    return res.json(introduction);
  } catch (error) {
    return res.status(500).json({ error: 'Introduction cache is invalid' });
  }
});

app.post('/api/introductions', express.json({ limit: '100kb' }), (req, res) => {
  const { book_id: bookId, book_title: bookTitle, source_text: sourceText } = req.body || {};
  const introductionPath = getIntroductionPath(bookId);
  if (!introductionPath || !sourceText?.trim()) {
    return res.status(400).json({ error: 'book_id and source_text are required' });
  }
  if (fs.existsSync(introductionPath)) {
    return res.json({ status: 'ready', book_id: bookId });
  }
  generateAndSaveIntroduction({ bookId, bookTitle, sourceText });
  return res.status(202).json({ status: 'processing', book_id: bookId });
});

async function tryLibreTranslate(text, targetLanguage) {
  const target = String(targetLanguage || '').toLowerCase().split(/[-_]/)[0];
  if (!TRANSLATION_LANGUAGE_CODES.has(target)) return null;

  try {
    const response = await fetch('https://libretranslate.com/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: 'en', target, format: 'text' })
    });
    if (!response.ok) return null;
    const result = await response.json();
    const translated = String(result.translatedText || '').trim();
    return translated || null;
  } catch (error) {
    console.warn('LibreTranslate fallback unavailable:', error.message);
    return null;
  }
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
const LOCAL_TTS_URL = process.env.LOCAL_TTS_URL
  || ((process.env.PIPER_HOSTPORT || (process.env.PIPER_HOST
    ? `${process.env.PIPER_HOST}:${process.env.PIPER_PORT || '10000'}`
    : ''))
    ? `http://${process.env.PIPER_HOSTPORT || `${process.env.PIPER_HOST}:${process.env.PIPER_PORT || '10000'}`}/api/tts`
    : '');
const DEFAULT_LOCAL_SAMPLE_PATH = process.env.LOCAL_TTS_VOICE_SAMPLE || '';
const LOCAL_TTS_SAMPLE_PATH = DEFAULT_LOCAL_SAMPLE_PATH;

async function tryLocalTtsFallback({ text, language = 'en-US' }) {
  const localUrl = LOCAL_TTS_URL || 'http://localhost:8000/api/tts';
  if (!localUrl) return null;

  try {
    const sampleVoicePath = process.env.LOCAL_TTS_VOICE_SAMPLE || DEFAULT_LOCAL_SAMPLE_PATH;
    const response = await fetch(localUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        language,
        voice_sample: sampleVoicePath,
        use_sample_voice: fs.existsSync(sampleVoicePath)
      })
    });

    if (!response.ok) {
      const textBody = await response.text();
      throw new Error(`Local TTS fallback failed: ${response.status} ${textBody.slice(0, 150)}`);
    }

    const contentType = response.headers.get('content-type') || 'audio/wav';
    if (contentType.includes('application/json')) {
      const data = await response.json();
      if (data?.audio && typeof data.audio === 'string') {
        const match = data.audio.match(/^data:(audio\/[a-z0-9.+-]+);base64,(.*)$/i);
        if (!match) throw new Error('Local TTS response did not include a valid audio/data URL');
        return {
          contentType: match[1] || 'audio/wav',
          audioBuffer: Buffer.from(match[2], 'base64')
        };
      }
      throw new Error('Local TTS returned JSON but no audio payload');
    }

    return {
      contentType,
      audioBuffer: Buffer.from(await response.arrayBuffer())
    };
  } catch (err) {
    console.warn('⚠️ Local TTS fallback unavailable:', err.message);
    return null;
  }
}

app.post('/api/tts', async (req, res) => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const ttsProvider = String(process.env.TTS_PROVIDER || 'piper').toLowerCase();
  const isElevenLabsPaused = !apiKey || String(apiKey).trim() === '' || String(apiKey).toLowerCase() === 'paused';
  const { text, voice_id, language = 'en-US' } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  if (ttsProvider === 'piper' || ttsProvider === 'local') {
    const localAudio = await tryLocalTtsFallback({ text, language });
    if (localAudio) {
      res.setHeader('Content-Type', localAudio.contentType || 'audio/wav');
      res.send(localAudio.audioBuffer);
      return;
    }
    console.warn(`Piper unavailable for ${language}; trying ElevenLabs fallback.`);
  }

  if (isElevenLabsPaused) {
    console.warn('⚠️ ELEVENLABS_API_KEY paused/blank; using local TTS fallback.');
    const fallbackAudio = await tryLocalTtsFallback({ text, language });
    if (fallbackAudio) {
      res.setHeader('Content-Type', fallbackAudio.contentType || 'audio/wav');
      res.send(fallbackAudio.audioBuffer);
      return;
    }
    return res.status(500).json({ error: 'ElevenLabs is paused and local TTS fallback unavailable' });
  } else {
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
          if (response.status === 401 && errorText.includes('quota_exceeded')) {
            throw new Error('ElevenLabs quota exceeded; using local TTS fallback');
          }
          throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 100)}`);
        }

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

    console.warn('⚠️ ElevenLabs failed; trying local TTS fallback...');
    const fallbackAudio = await tryLocalTtsFallback({ text, language });
    if (fallbackAudio) {
      res.setHeader('Content-Type', fallbackAudio.contentType || 'audio/wav');
      res.send(fallbackAudio.audioBuffer);
      return;
    }

    console.error('💥 TTS failed:', lastError?.message);
    return res.status(502).json({ error: 'Text-to-speech failed', details: lastError?.message || 'ElevenLabs and local fallback unavailable' });
  }

  const fallbackAudio = await tryLocalTtsFallback({ text, language });
  if (fallbackAudio) {
    res.setHeader('Content-Type', fallbackAudio.contentType || 'audio/wav');
    res.send(fallbackAudio.audioBuffer);
    return;
  }

  res.status(500).json({ error: 'ELEVENLABS_API_KEY not set and local TTS fallback unavailable' });
});

// Translation endpoint
app.post('/api/translate', async (req, res) => {
  const apiKeys = getGroqApiKeys();
  if (!apiKeys.length) return res.status(500).json({ error: 'No GROQ_API_KEY configured on server' });

  const { text, texts, target_language, targetLang } = req.body;
  const batchTexts = Array.isArray(texts)
    ? texts.map(item => String(item || '').trim()).filter(Boolean)
    : null;
  const resolvedTargetLanguage = (target_language || targetLang || '').trim();

  if (!text && !batchTexts?.length) return res.status(400).json({ error: 'text is required' });
  if (!resolvedTargetLanguage) return res.status(400).json({ error: 'target language is required' });

  const isBatch = Boolean(batchTexts);
  const sourceText = isBatch ? batchTexts.join('\n') : text;

  let lastError = null;
  let lastStatus = null;
  let retryAfter = null;
  let apiKeyAttempts = 0;
  const maxApiKeyAttempts = apiKeys.length;

  while (apiKeyAttempts < maxApiKeyAttempts) {
    apiKeyAttempts++;
    const currentApiKey = getCurrentGroqApiKey();

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`🌐 Translating to ${resolvedTargetLanguage} (attempt ${attempt}/2, API key ${apiKeyAttempts}/${maxApiKeyAttempts}): ${sourceText.slice(0, 50)}...`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);

        const response = await fetch(GROQ_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${currentApiKey}`
          },
          body: JSON.stringify({
                model: getGroqModelCandidates(process.env.GROQ_MODEL)[0],
            messages: [
              {
                role: 'system',
                content: isBatch
                  ? `You are a translation engine. Translate each item into ${resolvedTargetLanguage}. Return ONLY a valid JSON array of ${batchTexts.length} translated strings in the same order. Never reveal analysis, reasoning, drafts, labels, notes, or metadata.`
                  : `You are a translation engine. Translate into ${resolvedTargetLanguage}. Output only the final translation. Never reveal analysis, reasoning, drafts, labels, notes, or metadata.`
              },
              {
                role: 'user',
                content: isBatch ? JSON.stringify(batchTexts) : text
              }
            ],
            temperature: 0,
              max_tokens: 1024
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        console.log(`🌐 Groq translation response: ${response.status} ${response.statusText}`);

        if (!response.ok) {
          lastStatus = response.status;
          const errorText = await response.text();
          console.error(`🌐 Groq translation error body: ${errorText.slice(0, 300)}`);

          if (response.status === 429) {
            retryAfter = response.headers.get('retry-after');
          }
          
          // Give the configured backup key a chance after rate limits or rejected credentials.
          if ((response.status === 401 || response.status === 429) && apiKeyAttempts < maxApiKeyAttempts) {
            console.warn(`⚠️ Groq returned ${response.status}. Rotating to backup API key...`);
            rotateGroqApiKey();
            throw new Error('ROTATE_API_KEY'); // Signal to break inner loop
          }

          // Retrying the same key immediately only increases Groq's rate-window pressure.
          if (response.status === 429) {
            throw new Error(`HTTP 429: ${errorText.slice(0, 200)}`);
          }
          
          throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 200)}`);
        }

        const result = await response.json();
        let translated = result.choices?.[0]?.message?.content || '';

        if (!isBatch) {
          try {
            const parsed = JSON.parse(translated.replace(/^```json\s*|\s*```$/gi, '').trim());
            translated = parsed.translation || parsed.translated || '';
          } catch (_) {
            // Keep the text for the sanitizer fallback below.
          }
        }

        if (isBatch) {
          let translations;
          try {
            const parsed = JSON.parse(translated.replace(/^```json\s*|\s*```$/gi, '').trim());
            if (Array.isArray(parsed)) translations = parsed.map(item => String(item || '').trim());
          } catch (_) {
            translations = null;
          }
          if (!translations || translations.length !== batchTexts.length || translations.some(item => !item)) {
            throw new Error('Groq returned an invalid batch translation');
          }
          return res.json({ translations });
        }
        
        // First pass: aggressive cleaning of thinking blocks and metadata
        translated = sanitizeGroqText(translated);
        
        // Second pass: if still contains suspicious patterns, extract just the translation
          // Keep the complete translation. Selecting a single line can silently
          // discard sentences when the provider returns wrapped or multi-line text.
          if (!translated) {
            throw new Error('Groq returned an empty translation');
          }
        
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

  if (lastStatus === 429) {
    const fallbackTranslation = isBatch ? null : await tryLibreTranslate(text, resolvedTargetLanguage);
    if (fallbackTranslation) {
      console.warn(`🌐 Used LibreTranslate fallback for ${resolvedTargetLanguage} after Groq rate limit.`);
      return res.json({ translated: fallbackTranslation, provider: 'libretranslate' });
    }
    res.setHeader('Retry-After', '10');
    if (retryAfter) res.setHeader('Retry-After', retryAfter);
  }

  console.error('💥 Translation failed:', lastError?.message);
  res.status(lastStatus || 502).json({
    error: lastStatus === 429 ? 'Translation rate limit reached. Please try again shortly.' : 'Translation failed',
    details: lastError?.message || 'All translation providers are unavailable'
  });
});

function isPdfBuffer(buffer) {
  if (!buffer || buffer.length < 5) return false;
  return buffer.slice(0, 5).toString('ascii') === '%PDF-';
}

app.post('/api/upload-book', upload.single('file'), async (req, res) => {
  if (!cloudinaryEnabled) {
    return res.status(503).json({ error: 'Cloudinary is temporarily disabled' });
  }
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
    const bookId = getBookIdFromBuffer(req.file.buffer);
    void queueIntroductionForPdf(req.file.buffer, fileName);

    const cloudinaryUrl = result.secure_url;

    return res.json({
      secure_url: cloudinaryUrl || `/api/files/${encodeURIComponent(localName)}`,
      public_id: result.public_id || safeBaseName,
      book_id: bookId,
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

function decodeXmlText(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

let standardEbooksCatalogCache = { expiresAt: 0, books: [] };
let gutenbergCatalogCache = { expiresAt: 0, books: [] };

async function fetchPublicCatalog(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(20000)
      });
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
      lastError = new Error(`Catalog returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 1000));
  }
  throw lastError || new Error('Catalog request failed');
}

function getBookCategories(title, tags = [], source = '') {
  const text = `${title} ${tags.join(' ')}`.toLowerCase();
  const categories = [];
  const rules = [
    ['Biography', /biograph|memoir|life of/],
    ['Autobiography', /autobiograph|my life|confession/],
    ['Romance', /romance|love story|courtship/],
    ['Mystery', /detective|mystery|crime fiction|whodunit/],
    ['Fantasy', /fantasy|fairy|magic|wizard|mytholog/],
    ['Science Fiction', /science fiction|sci-fi|space opera|dystopia/],
    ['Adventure', /adventure|exploration|voyage|western/],
    ['History', /history|historical|ancient|war and conflict/],
    ['Philosophy', /philosoph|ethic|metaphysic/],
    ['Psychology', /psycholog|psychiatr|mind and behavior/],
    ['Self-Help', /self-help|personal development|success|improvement/],
    ['Business', /business|commerce|management|leadership|finance/],
    ['Religion & Spirituality', /religion|spiritual|bible|christian|theology/],
    ['Poetry', /poetry|poems|verse/],
    ['Drama', /drama|plays|theater|theatre/],
    ['Essays', /essay|criticism/],
    ['Short Stories', /short stor|tales|antholog/],
    ['Children', /children|juvenile|nursery|young readers/],
    ['Education', /education|school|teaching|textbook/],
    ['Science', /science|biology|chemistry|physics|mathematics|nature/],
    ['Technology', /technology|engineering|computer/],
    ['Travel', /travel|tour|guidebook/],
    ['Health & Wellness', /health|medicine|wellness|diet/],
    ['Politics', /politic|government|democracy/],
    ['Sociology', /sociolog|society|social conditions/],
    ['Art & Culture', /art|music|culture|architecture/],
    ['Thriller', /thriller|suspense|horror/],
    ['Fiction', /fiction|novel|literature/]
  ];
  rules.forEach(([category, pattern]) => {
    if (pattern.test(text)) categories.push(category);
  });
  const nonfictionCategories = ['Biography', 'Autobiography', 'History', 'Philosophy', 'Psychology', 'Self-Help', 'Business', 'Religion & Spirituality', 'Essays', 'Education', 'Science', 'Technology', 'Travel', 'Health & Wellness', 'Politics', 'Sociology', 'Art & Culture'];
  if (categories.some(category => nonfictionCategories.includes(category)) && !categories.includes('Fiction')) {
    categories.push('Non-Fiction');
  }
  if (!categories.length && source === 'Standard Ebooks') categories.push('Classics');
  return categories.length ? categories : ['Other'];
}

async function getStandardEbooksBooks() {
  if (standardEbooksCatalogCache.expiresAt > Date.now()) return standardEbooksCatalogCache.books;

  const firstPageResponse = await fetchPublicCatalog('https://standardebooks.org/ebooks?per-page=48&page=1', {
    headers: { 'User-Agent': 'BookReader/1.0 (public catalog)' }
  });
  if (!firstPageResponse.ok) throw new Error(`Standard Ebooks returned ${firstPageResponse.status}`);
  const firstPage = await firstPageResponse.text();
  const pageNumbers = [...firstPage.matchAll(/\/ebooks\?[^"']*page=(\d+)/g)].map(match => Number(match[1]));
  const lastPage = Math.min(32, Math.max(1, ...pageNumbers));
  const pages = [firstPage];

  if (lastPage > 1) {
    for (let pageNumber = 2; pageNumber <= lastPage; pageNumber += 4) {
      const responses = await Promise.all(Array.from({ length: Math.min(4, lastPage - pageNumber + 1) }, (_, index) =>
        fetchPublicCatalog(`https://standardebooks.org/ebooks?per-page=48&page=${pageNumber + index}`, {
          headers: { 'User-Agent': 'BookReader/1.0 (public catalog)' }
        })
      ));
      for (const response of responses) {
        if (response.ok) pages.push(await response.text());
      }
    }
  }

  const books = pages.flatMap(page => [...page.matchAll(/<li[^>]+typeof="schema:Book"[\s\S]*?<\/li>/g)].map(match => {
    const card = match[0];
    const pathName = card.match(/about="(\/ebooks\/[^"]+)"/)?.[1] || '';
    const title = decodeXmlText(card.match(/property="schema:name">([\s\S]*?)<\/span>/)?.[1]).replace(/<[^>]+>/g, '').trim();
    const author = decodeXmlText(card.match(/property="schema:author"[\s\S]*?property="schema:name">([\s\S]*?)<\/span>/)?.[1]).replace(/<[^>]+>/g, '').trim();
    if (!pathName || !title) return null;
    const textUrl = `https://standardebooks.org${pathName}/text/single-page`;
    return {
      title,
      author: author || 'Standard Ebooks',
      source: 'Standard Ebooks',
      format: 'xhtml',
      categories: getBookCategories(title, [], 'Standard Ebooks'),
      source_url: `https://standardebooks.org${pathName}`,
      cover_url: `https://standardebooks.org${pathName}/downloads/cover-thumbnail.jpg`,
      url: `/api/standardebooks-file?url=${encodeURIComponent(textUrl)}`
    };
  }).filter(Boolean));

  const uniqueBooks = [...new Map(books.map(book => [book.source_url, book])).values()];
  standardEbooksCatalogCache = { expiresAt: Date.now() + 15 * 60 * 1000, books: uniqueBooks };
  console.log(`📚 Loaded ${uniqueBooks.length} books from Standard Ebooks`);
  return uniqueBooks;
}

async function getGutenbergBooks() {
  if (gutenbergCatalogCache.expiresAt > Date.now()) return gutenbergCatalogCache.books;

  const responses = await Promise.all([1, 2, 3].map(page =>
    fetchPublicCatalog(`https://gutendex.com/books/?page=${page}`, {
      headers: { 'User-Agent': 'BookReader/1.0 (public catalog)' }
    })
  ));
  const books = [];
  for (const response of responses) {
    if (!response.ok) continue;
    const data = await response.json();
    for (const book of data.results || []) {
      const textUrl = book.formats?.['text/plain; charset=utf-8'] || book.formats?.['text/plain'];
      if (!textUrl || !book.id || !book.title) continue;
      books.push({
        title: book.title,
        author: book.authors?.[0]?.name || 'Project Gutenberg',
        summary: book.summaries?.[0] || '',
        source: 'Project Gutenberg',
        format: 'text',
        categories: getBookCategories(book.title, [...(book.bookshelves || []), ...(book.subjects || [])], 'Project Gutenberg'),
        source_url: `https://www.gutenberg.org/ebooks/${book.id}`,
        cover_url: book.formats?.['image/jpeg'] || `https://www.gutenberg.org/cache/epub/${book.id}/pg${book.id}.cover.medium.jpg`,
        url: `/api/gutenberg-file?url=${encodeURIComponent(textUrl)}`
      });
    }
  }

  gutenbergCatalogCache = {
    expiresAt: Date.now() + 15 * 60 * 1000,
    books: [...new Map(books.map(book => [book.source_url, book])).values()]
  };
  console.log(`📚 Loaded ${gutenbergCatalogCache.books.length} books from Project Gutenberg`);
  return gutenbergCatalogCache.books;
}

async function getExternalBooks() {
  const [standardEbooks, gutenberg] = await Promise.all([
    getStandardEbooksBooks().catch(error => {
      console.warn('⚠️ Standard Ebooks unavailable:', error.message);
      return [];
    }),
    getGutenbergBooks().catch(error => {
      console.warn('⚠️ Project Gutenberg unavailable:', error.message);
      return [];
    })
  ]);
  return [...standardEbooks, ...gutenberg];
}

app.get('/api/cloudinary-books', async (req, res) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || '';
  const apiKey = process.env.CLOUDINARY_API_KEY || '';
  const apiSecret = process.env.CLOUDINARY_API_SECRET || '';

  if (!cloudinaryEnabled || !cloudName || cloudName === 'your_cloud_name' || !apiKey || !apiSecret) {
    console.warn('⚠️ Cloudinary not configured; returning empty library list.');
    const externalBooks = await getExternalBooks();
    return res.json({ books: [...externalBooks, ...getLocalBooks()], warning: 'Cloudinary not configured' });
  }

  try {
    let result = null;
    const expressions = ['folder="book"', 'folder:"book"', 'resource_type:pdf AND folder:"book"', 'folder:"book" AND format:pdf'];
    let lastErr = null;

    for (const expression of expressions) {
      try {
        result = await cloudinary.v2.search
          .expression(expression)
          .max_results(500)
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

    books.forEach(queueCloudinaryBookIntroduction);

    const externalBooks = await getExternalBooks();
    res.json({ books: [...books, ...externalBooks, ...getLocalBooks()] });
  } catch (err) {
    const detail = err?.error?.message || err?.message || JSON.stringify(err || {});
    console.error('❌ Cloudinary books fetch error:', detail);
    const externalBooks = await getExternalBooks();
    res.status(200).json({ books: [...externalBooks, ...getLocalBooks()], warning: 'Cloudinary search unavailable', details: detail });
  }
});

app.get('/api/standardebooks-file', async (req, res) => {
  try {
    const targetUrl = new URL(String(req.query.url || ''));
    if (targetUrl.protocol !== 'https:' || targetUrl.hostname !== 'standardebooks.org') {
      return res.status(400).json({ error: 'Only Standard Ebooks URLs are allowed' });
    }
    const response = await fetch(targetUrl, { headers: { 'User-Agent': 'BookReader/1.0' } });
    if (!response.ok) return res.status(response.status).json({ error: `Standard Ebooks returned ${response.status}` });
    res.type('application/xhtml+xml').send(await response.text());
  } catch (error) {
    res.status(502).json({ error: 'Unable to fetch Standard Ebooks text', details: error.message });
  }
});

app.get('/api/gutenberg-file', async (req, res) => {
  try {
    const targetUrl = new URL(String(req.query.url || ''));
    if (targetUrl.protocol !== 'https:' || !['gutenberg.org', 'www.gutenberg.org'].includes(targetUrl.hostname)) {
      return res.status(400).json({ error: 'Only Project Gutenberg URLs are allowed' });
    }
    const response = await fetch(targetUrl, { headers: { 'User-Agent': 'BookReader/1.0' } });
    if (!response.ok) return res.status(response.status).json({ error: `Project Gutenberg returned ${response.status}` });
    res.type('text/plain').send(await response.text());
  } catch (error) {
    res.status(502).json({ error: 'Unable to fetch Project Gutenberg text', details: error.message });
  }
});

// ===== IMPROVED CLOUDINARY FILE PROXY WITH MULTIPLE STRATEGIES =====
app.get('/api/cloudinary-file/:publicId/:resourceType?', async (req, res) => {
  if (!cloudinaryEnabled) {
    return res.status(503).json({ error: 'Cloudinary is temporarily disabled' });
  }
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
