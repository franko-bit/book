// ================================================================
// ADVANCED BOOK READER - Complete Edition
// WITH LITERARY GUIDE PERSONA UPGRADE
// ================================================================

// ==================== CONFIGURATION ====================
const CONFIG = {
  GROQ_API_KEY: window.GROQ_API_KEY || 'YOUR_GROQ_API_KEY',
  GROQ_URL: 'https://api.groq.com/openai/v1/chat/completions',
  MAX_PODCAST_DURATION: 120000,
  RECOGNITION_DEBOUNCE: 600,
  MAX_TOAST_DURATION: 3000,
  MAX_CONVO_LOG: 50,
};

// ==================== CHAPTER DATA ====================
const chapters = [
  { num: 1, title: "The Other Minister" },
  { num: 2, title: "Spinner's End" },
  { num: 3, title: "Will and Won't" },
  { num: 4, title: "Horace Slughorn" },
  { num: 5, title: "An Excess of Phlegm" },
  { num: 6, title: "Draco's Detour" },
  { num: 7, title: "The Slug Club" },
  { num: 8, title: "Snape Victorious" },
  { num: 9, title: "The Half-Blood Prince" },
  { num: 10, title: "The House of Gaunt" },
  { num: 11, title: "Hermione's Helping Hand" },
  { num: 12, title: "Silver and Opals" },
];

// ==================== STATE MANAGEMENT ====================
const state = {
  // Reading state
  currentChapter: 6,
  selectedText: '',
  pdfDocument: null,
  pdfTitle: '',
  pageTextByPage: [],
  pageHtmlByPage: [],
  currentPdfPage: 1,
  notes: [],
  bookmarks: [],
  highlights: [],
  readingHistory: [],
  translationTargets: [],
  originalContent: '',
  
  // Audio state
  currentAudio: null,
  
  // Recording state
  isRecording: false,
  mediaRecorder: null,
  recordedChunks: [],
  recordingTimer: null,
  
  // Podcast state
  podcastActive: false,
  podcastPaused: false,
  podcastRecognition: null,
  microphoneStream: null,
  podcastAudio: null,
  podcastStartTime: null,
  podcastHistory: [],
  podcastRecognitionRetryTimeout: null,
  podcastRecognitionEndTimeout: null,
  isListening: false,
  lastRecognitionTime: 0,
};

// ==================== DOM REFERENCES ====================
const dom = {
  readerArea: document.getElementById('readerArea'),
  textContent: document.getElementById('textContent'),
  chapterHeader: document.querySelector('.chapter-header'),
  chapterMeta: document.getElementById('chapterMeta'),
  progressSpine: document.getElementById('progressSpine'),
  chapterList: document.getElementById('chapterList'),
  pdfInput: document.getElementById('pdfInput'),
  pdfStatus: document.getElementById('pdfStatus'),
  pageCount: document.getElementById('pageCount'),
  timeLeft: document.getElementById('timeLeft'),
  noteCount: document.getElementById('noteCount'),
  toolbar: document.getElementById('selectionToolbar'),
  translateControls: document.getElementById('translateControls'),
  selectedTextPreview: document.getElementById('selectedTextPreview'),
  langSelect: document.getElementById('langSelect'),
  thumbnailPreview: document.getElementById('thumbnailPreview'),
  recordToggleBtn: document.getElementById('recordToggleBtn'),
  recordStatusBadge: document.getElementById('recordStatusBadge'),
  promptChapterNum: document.getElementById('promptChapterNum'),
  toast: document.getElementById('toast'),
  convoLog: document.getElementById('convoLog'),
  promptStartBtn: document.getElementById('promptStartBtn'),
};

// ==================== UTILITY FUNCTIONS ====================
function getApiUrl(endpoint) {
  const isHttp = window.location.protocol === 'http:' || window.location.protocol === 'https:';
  const origin = isHttp ? window.location.origin : 'http://localhost:5173';
  return `${origin}${endpoint}`;
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function dataURLToBlob(dataURL) {
  const [header, base64] = dataURL.split(',');
  const mime = header.match(/:(.*?);/)[1];
  const binary = atob(base64);
  const array = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    array[i] = binary.charCodeAt(i);
  }
  return new Blob([array], { type: mime });
}

function getCurrentPage() {
  return isPdfLoaded() ? state.currentPdfPage : state.currentChapter;
}

function getPageContext() {
  if (isPdfLoaded() && state.pageTextByPage[state.currentPdfPage - 1]) {
    return state.pageTextByPage[state.currentPdfPage - 1];
  }
  return dom.textContent.textContent || '';
}

// ==================== TOAST NOTIFICATIONS ====================
function showToast(message, type = 'info', duration = CONFIG.MAX_TOAST_DURATION) {
  dom.toast.textContent = message;
  dom.toast.className = `toast ${type}`;
  dom.toast.classList.add('show');
  
  clearTimeout(dom.toast._timeout);
  dom.toast._timeout = setTimeout(() => {
    dom.toast.classList.remove('show');
  }, duration);
}

// ==================== LITERARY GUIDE SYSTEM PROMPT ====================
const LITERARY_GUIDE_SYSTEM_PROMPT = `You are a professional literary guide. Your tone is calm, measured, and reverent toward texts. You do not perform cleverness; you perform clarity and respect.

When a user asks about a book, chapter, or passage, you follow this structure:

1. OPEN WITH PRECISION — State the book's full title and author immediately. Name the specific chapter or section if known.

2. FRAME THE EMOTIONAL THESIS — In 1–2 sentences, state what the passage grapples with—not plot summary, but a human tension. Name the stakes.

3. SET THE SCENE — If there is a speaker, a question, or dramatic context, briefly establish it in 1–2 sentences.

4. PRESENT THE TEXT — Quote verbatim. Do not interrupt with commentary. Trust the author's words.

5. END WITH OPEN SILENCE — Offer one quiet, reflective observation (max 2 sentences). Then stop. Do not over-analyze.

6. TONAL RULES — Authoritative but not arrogant. Warm but not casual. Never say "I think." Speak as if the text is the authority; you are its herald. Keep responses concise (2-4 sentences for conversation, 6-8 when quoting).

7. EXPAND ONLY ON FOLLOW-UP — Stay close to the text's language. Never substitute your interpretation for the reader's experience.`;

const LITERARY_GUIDE_SHORT_PROMPT = `You are a literary guide. Speak with warmth, precision, and reverence for texts. Never say "I think." Quote briefly when helpful. End with a quiet observation, not a conclusion. Respond in 2-3 sentences.`;

// ==================== GROQ API ====================
async function askGroq(prompt, useShortVersion = false) {
  if (!CONFIG.GROQ_API_KEY || CONFIG.GROQ_API_KEY === 'YOUR_GROQ_API_KEY') {
    return "⚠️ Please set your Groq API key. Use window.GROQ_API_KEY or replace 'YOUR_GROQ_API_KEY' in the script.";
  }
  
  try {
    const systemContent = useShortVersion ? LITERARY_GUIDE_SHORT_PROMPT : LITERARY_GUIDE_SYSTEM_PROMPT;
    
    const resp = await fetch(CONFIG.GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'qwen/qwen3.6-27b',
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: useShortVersion ? 150 : 300
      })
    });
    
    if (!resp.ok) {
      const err = await resp.text();
      return `❌ API error (${resp.status})`;
    }
    
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '🤷 No response';
  } catch (e) {
    return `⚠️ Error: ${e.message}`;
  }
}

// ==================== TEXT-TO-SPEECH ====================
function speakText(text) {
  if (!window.speechSynthesis) return;
  
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = 0.92;
  utterance.pitch = 1.05;
  utterance.volume = 1;
  window.speechSynthesis.speak(utterance);
}

async function textToSpeech(text) {
  if (!text) return null;
  
  try {
    const response = await fetch(getApiUrl('/api/tts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    if (!response.ok) throw new Error('TTS failed');
    
    const data = await response.json();
    return data.audio;
  } catch (err) {
    console.error('TTS error:', err);
    return null;
  }
}

// ==================== SPEECH RECOGNITION ====================
function startSpeechRecognition(onResult, onEnd, onError) {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    console.error('Speech recognition not supported');
    showToast('⚠️ Speech recognition not supported.', 'error');
    return null;
  }
  
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = new SR();
  recognition.lang = 'en-US';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  // Track state
  let ended = false;
  let gotResult = false;
  let soundStarted = false;

  recognition.onstart = () => {
    console.log('🎙️ Speech Recognition started - listening for audio');
  };

  recognition.onaudiostart = () => {
    console.log('🔊 Audio input detected from microphone');
    soundStarted = true;
  };

  recognition.onresult = (event) => {
    const isFinal = event.results[event.results.length - 1].isFinal;
    const transcript = event.results[event.results.length - 1]?.[0]?.transcript?.trim();
    const confidence = event.results[event.results.length - 1]?.[0]?.confidence || 0;
    
    if (transcript) {
      console.log(`📝 [${isFinal ? 'FINAL' : 'interim'}] "${transcript}" (confidence: ${(confidence*100).toFixed(0)}%)`);
      gotResult = true;
      if (isFinal && onResult) {
        console.log('✅ Final transcript received, calling onResult');
        onResult(transcript);
      }
    }
  };

  recognition.onerror = (event) => {
    console.warn(`❌ Speech Recognition error: "${event.error}"`);
    if (event.error === 'aborted') {
      console.log('(Aborted - normal cleanup)');
      return;
    }
    if (onError) onError(event.error);
  };

  recognition.onend = () => {
    if (ended) return;
    ended = true;
    console.log(`🏁 Speech Recognition ended (Audio: ${soundStarted ? 'YES' : 'NO'}, Result: ${gotResult ? 'YES' : 'NO'})`);
    if (onEnd) onEnd();
  };

  try {
    recognition.start();
    console.log('✓ recognition.start() successful');
    return recognition;
  } catch (err) {
    console.error('Error starting recognition:', err);
    if (onError) onError(err.message || 'start-failed');
    return null;
  }
}

// ==================== PDF HANDLING ====================
function isPdfLoaded() {
  return state.pdfDocument !== null;
}

function getRecordedStorageKey(pageNum) {
  return `recordedVideo_${pageNum}`;
}

async function handlePdfFile(file) {
  showToast('📄 Loading PDF...', 'info');
  try {
    const arrayBuffer = await file.arrayBuffer();
    state.pdfDocument = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    state.pdfTitle = file.name;
    state.pageTextByPage = new Array(state.pdfDocument.numPages).fill('');
    state.pageHtmlByPage = new Array(state.pdfDocument.numPages).fill('');
    state.currentPdfPage = 1;
    
    await loadPdfPage(state.currentPdfPage);
    loadRecordedVideo(getCurrentPage());
    updateStats();
    showToast(`✅ PDF loaded: ${state.pdfDocument.numPages} pages`, 'success');
  } catch (err) {
    console.error('PDF loading error:', err);
    showToast('❌ Failed to load PDF', 'error');
  }
}

async function loadPdfPage(pageNumber) {
  if (!state.pdfDocument) return;
  
  try {
    const page = await state.pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.2 });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.display = 'none';
    
    await page.render({ canvasContext: context, viewport }).promise;
    
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join(' ');
    
    if (pageText.trim().length > 20) {
      state.pageTextByPage[pageNumber - 1] = pageText;
      const structured = detectDocumentStructure(pageText);
      state.pageHtmlByPage[pageNumber - 1] = formatStructuredContent(structured);
      dom.pdfStatus.textContent = `Page ${pageNumber} ✓`;
    } else {
      dom.pdfStatus.textContent = `Page ${pageNumber} (limited text)`;
      state.pageTextByPage[pageNumber - 1] = pageText;
      state.pageHtmlByPage[pageNumber - 1] = `<p class="doc-paragraph">${escapeHtml(pageText || 'No text extracted from this page.')}</p>`;
    }
    
    renderPdfPage(pageNumber);
  } catch (err) {
    console.error('PDF page loading error:', err);
    showToast('❌ Failed to load PDF page', 'error');
  }
}

function renderPdfPage(pageNumber) {
  state.currentPdfPage = pageNumber;
  dom.chapterHeader.textContent = `Page ${pageNumber}`;
  dom.chapterMeta.innerHTML = `
    <span>📄 ${state.pdfTitle || 'Uploaded PDF'}</span>
    <span>📄 ${state.pdfDocument.numPages} pages</span>
  `;
  
  if (state.pageHtmlByPage[pageNumber - 1]) {
    dom.textContent.innerHTML = state.pageHtmlByPage[pageNumber - 1];
  } else {
    const pageText = getPageContext();
    if (!pageText) {
      dom.textContent.innerHTML = `<p class="loading-placeholder">Loading text for page ${pageNumber}...</p>`;
    } else {
      const structured = detectDocumentStructure(pageText);
      dom.textContent.innerHTML = formatStructuredContent(structured);
    }
  }
  
  updateStats();
  dom.promptChapterNum.textContent = pageNumber;
  saveReadingProgress();
}

// ==================== DOCUMENT STRUCTURE DETECTION ====================
function detectDocumentStructure(text) {
  const lines = text.split('\n').filter(line => line.trim());
  const structured = [];
  let i = 0;
  
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }
    
    if (line.match(/^(Table of Contents|CONTENTS|TABLE OF CONTENTS|TOC)/i)) {
      structured.push({ type: 'toc_title', content: line });
      i++;
      const tocEntries = [];
      while (i < lines.length && lines[i].trim()) {
        const entry = lines[i].trim();
        if (entry.match(/\.{2,}\s*\d+$/) || entry.match(/\d+$/) || entry.match(/^[A-Z]/)) {
          tocEntries.push(entry);
        } else break;
        i++;
      }
      if (tocEntries.length) structured.push({ type: 'toc_entries', content: tocEntries });
      continue;
    }
    
    if (line.match(/^CHAPTER\s+(\d+|[IVXLCDM]+)[\s:.-]+\s*(.+)/i)) {
      const match = line.match(/^CHAPTER\s+(\d+|[IVXLCDM]+)[\s:.-]+\s*(.+)/i);
      structured.push({ type: 'chapter_heading', content: line, chapterNum: match[1], title: match[2] });
      i++;
      continue;
    }
    
    if (line.match(/^[A-Z][A-Z\s]{4,}$/) || (line.match(/^[A-Z][a-z]+\s+[A-Z][a-z]+/) && line.length < 60)) {
      structured.push({ type: 'heading1', content: line });
      i++;
      continue;
    }
    
    if (line.match(/^[A-Z][a-z]{2,}\s+[A-Z][a-z]+/) && !line.match(/^CHAPTER/i) && line.length < 50) {
      structured.push({ type: 'heading2', content: line });
      i++;
      continue;
    }
    
    if (line.match(/^[•·\-*]\s+/) || line.match(/^\d+\.\s+/) || line.match(/^[a-z]\)\s+/)) {
      const items = [];
      while (i < lines.length && (lines[i].match(/^[•·\-*]\s+/) || lines[i].match(/^\d+\.\s+/) || lines[i].match(/^[a-z]\)\s+/))) {
        items.push(lines[i].trim());
        i++;
      }
      structured.push({ type: 'list', items });
      continue;
    }
    
    if (line.includes('|') || (line.includes('  ') && lines[i+1] && lines[i+1].includes('  '))) {
      const tableData = [];
      while (i < lines.length && lines[i].trim() && (lines[i].includes('|') || lines[i].includes('  '))) {
        const row = lines[i].split('|').map(cell => cell.trim()).filter(cell => cell);
        if (row.length > 1) tableData.push(row);
        i++;
      }
      if (tableData.length) structured.push({ type: 'table', data: tableData });
      continue;
    }
    
    let paragraph = line;
    i++;
    while (i < lines.length && lines[i].trim() && 
           !lines[i].match(/^[A-Z][A-Z\s]{4,}$/) &&
           !lines[i].match(/^CHAPTER\s+/i) &&
           !lines[i].match(/^[•·\-*]\s+/) &&
           !lines[i].match(/^\d+\.\s+/) &&
           !lines[i].includes('|')) {
      paragraph += ' ' + lines[i].trim();
      i++;
    }
    structured.push({ type: 'paragraph', content: paragraph });
  }
  
  return structured;
}

function formatStructuredContent(structured) {
  let html = '';
  
  structured.forEach(element => {
    switch (element.type) {
      case 'toc_title':
        html += `<h2 class="toc-title">${escapeHtml(element.content)}</h2>`;
        break;
      case 'toc_entries':
        html += `<div class="toc-entries">`;
        element.content.forEach(entry => {
          html += `<div class="toc-entry">${escapeHtml(entry)}</div>`;
        });
        html += `</div>`;
        break;
      case 'chapter_heading':
        html += `<h1 class="chapter-heading">${escapeHtml(element.content)}</h1>`;
        break;
      case 'heading1':
        html += `<h2 class="section-heading">${escapeHtml(element.content)}</h2>`;
        break;
      case 'heading2':
        html += `<h3 class="subsection-heading">${escapeHtml(element.content)}</h3>`;
        break;
      case 'paragraph':
        html += `<p class="doc-paragraph">${escapeHtml(element.content)}</p>`;
        break;
      case 'list':
        html += `<ul class="doc-list">`;
        element.items.forEach(item => {
          const cleanItem = item.replace(/^[•·\-*]\s+/, '').replace(/^\d+\.\s+/, '').replace(/^[a-z]\)\s+/, '');
          html += `<li>${escapeHtml(cleanItem)}</li>`;
        });
        html += `</ul>`;
        break;
      case 'table':
        html += `<table class="doc-table">`;
        element.data.forEach((row, idx) => {
          html += `<tr>`;
          row.forEach(cell => {
            const tag = idx === 0 ? 'th' : 'td';
            html += `<${tag}>${escapeHtml(cell)}</${tag}>`;
          });
          html += `</tr>`;
        });
        html += `</table>`;
        break;
      default:
        if (typeof element === 'string') {
          html += `<p class="doc-paragraph">${escapeHtml(element)}</p>`;
        }
    }
  });
  
  return html;
}

// ==================== NAVIGATION ====================
function goToChapter(num) {
  state.currentChapter = num;
  
  document.querySelectorAll('.spine-segment').forEach((seg, idx) => {
    seg.classList.toggle('active', idx === num - 1);
  });
  
  document.querySelectorAll('.modal-list li').forEach((li, idx) => {
    li.classList.toggle('active', idx === num - 1);
  });
  
  dom.promptChapterNum.textContent = num;
  saveReadingProgress();
  updateStats();
  resetAllTranslations();
  loadRecordedVideo(num);
  dom.readerArea.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateStats() {
  const total = isPdfLoaded() ? state.pdfDocument.numPages : chapters.length;
  const current = isPdfLoaded() ? state.currentPdfPage : state.currentChapter;
  const percent = Math.round((current / total) * 100);
  
  dom.pageCount.textContent = `${percent}%`;
  const timePerItem = isPdfLoaded() ? 5 : 10;
  const timeLeft = Math.ceil(((total - current) * timePerItem) / 60);
  dom.timeLeft.textContent = `${timeLeft}h`;
  dom.noteCount.textContent = state.notes.length;
}

function saveReadingProgress() {
  try {
    const progress = {
      chapter: state.currentChapter,
      pdfPage: state.currentPdfPage,
      pdfTitle: state.pdfTitle,
      timestamp: Date.now(),
    };
    localStorage.setItem('readingProgress', JSON.stringify(progress));
  } catch (e) {}
}

function loadReadingProgress() {
  try {
    const saved = localStorage.getItem('readingProgress');
    if (saved) {
      const progress = JSON.parse(saved);
      if (progress.chapter) goToChapter(progress.chapter);
    }
  } catch (e) {}
}

// ==================== RECORDING VIDEO ====================
function loadRecordedVideo(pageNum) {
  const stored = localStorage.getItem(getRecordedStorageKey(pageNum));
  dom.thumbnailPreview.innerHTML = '';
  
  if (!stored) {
    dom.thumbnailPreview.innerHTML = '<span class="placeholder">🎥</span>';
    dom.recordStatusBadge.textContent = 'No recording';
    return;
  }
  
  const blob = dataURLToBlob(stored);
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.preload = 'metadata';
  video.onclick = () => openVideoModal(url);
  video.play().catch(() => {});
  dom.thumbnailPreview.appendChild(video);
  dom.recordStatusBadge.textContent = '✓ Recorded';
}

function saveRecordedVideo(pageNum, blob) {
  const reader = new FileReader();
  reader.onloadend = () => {
    localStorage.setItem(getRecordedStorageKey(pageNum), reader.result);
    loadRecordedVideo(pageNum);
    showToast('✅ Recording saved!', 'success');
  };
  reader.readAsDataURL(blob);
}

function openVideoModal(url) {
  const modal = document.getElementById('videoPlaybackModal');
  const video = document.getElementById('playbackModalVideo');
  if (modal && video) {
    video.src = url;
    modal.classList.add('active');
    video.play();
  }
}

function closeVideoModal() {
  const modal = document.getElementById('videoPlaybackModal');
  const video = document.getElementById('playbackModalVideo');
  if (modal && video) {
    video.pause();
    video.src = '';
    modal.classList.remove('active');
  }
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    state.recordedChunks = [];
    state.mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp8' });
    
    state.mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) state.recordedChunks.push(e.data);
    };
    
    state.mediaRecorder.onstop = () => {
      const blob = new Blob(state.recordedChunks, { type: 'video/webm' });
      saveRecordedVideo(getCurrentPage(), blob);
      stream.getTracks().forEach(track => track.stop());
      dom.recordStatusBadge.textContent = '✓ Recorded';
      dom.recordToggleBtn.textContent = '🎙 Record';
      dom.recordToggleBtn.classList.remove('recording');
      state.isRecording = false;
      clearTimeout(state.recordingTimer);
      closeRecordingPrompt();
    };
    
    state.mediaRecorder.start();
    state.isRecording = true;
    dom.recordToggleBtn.textContent = '⏹ Stop';
    dom.recordToggleBtn.classList.add('recording');
    dom.recordStatusBadge.textContent = '🔴 Recording...';
    closeRecordingPrompt();
    
    state.recordingTimer = setTimeout(() => {
      if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
        state.mediaRecorder.stop();
        showToast('⏱ 1-minute recording limit reached', 'info');
      }
    }, 60000);
  } catch (err) {
    dom.recordStatusBadge.textContent = '❌ Camera denied';
    showToast('❌ Camera access denied', 'error');
    closeRecordingPrompt();
  }
}

function stopRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
    state.mediaRecorder.stop();
  }
}

// ==================== VOICE CONVERSATION (PODCAST) ====================

function openRecordingPrompt() {
  dom.promptChapterNum.textContent = getCurrentPage();
  document.getElementById('recordingPrompt').classList.add('active');
}

function closeRecordingPrompt() {
  document.getElementById('recordingPrompt').classList.remove('active');
}

async function ensureMicrophonePermission() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    return true;
  } catch (e) {
    return false;
  }
}

async function startAIPodcast() {
  if (state.podcastActive) return;
  
  try {
    // Request microphone
    if (!state.microphoneStream) {
      try {
        state.microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        console.error('Microphone error:', err);
        showToast('❌ Microphone access required.', 'error');
        dom.recordStatusBadge.textContent = '❌ Microphone denied';
        return;
      }
    }

    const pageContext = getPageContext();
    state.podcastActive = true;
    state.podcastPaused = false;
    state.podcastHistory = [];
    state.podcastStartTime = Date.now();
    
    dom.recordStatusBadge.textContent = '🎧 Podcast live';
    dom.recordToggleBtn.textContent = '⏹ Stop';
    dom.recordToggleBtn.classList.add('recording');
    dom.convoLog.classList.add('active');
    dom.convoLog.innerHTML = '';
    closeRecordingPrompt();
    
    // Welcome message - now in literary guide style
    const welcome = "Welcome. I'm your literary guide. Ask me about any passage, and I'll help you sit with it—not to explain it away, but to let it speak.";
    addConversationMessage('ai', welcome);
    speakText(welcome);
    
    showToast('🎤 Voice conversation started', 'success');
    
    // Start listening after a delay
    setTimeout(() => {
      if (state.podcastActive && !state.podcastPaused) {
        startPodcastListening();
      }
    }, 1500);
    
  } catch (err) {
    console.error('startAIPodcast error:', err);
    showToast('Could not start voice conversation.', 'error');
  }
}

function stopAIPodcast() {
  if (!state.podcastActive) return;
  
  state.podcastActive = false;
  state.podcastPaused = false;
  state.isListening = false; // Critical: stop listening flag
  
  // Stop recognition - use .stop() not .abort()
  if (state.podcastRecognition) {
    try {
      state.podcastRecognition.stop();
    } catch (e) {
      // If stop fails, try abort
      try {
        state.podcastRecognition.abort();
      } catch (e2) {}
    }
    state.podcastRecognition = null;
  }
  
  // Stop microphone
  if (state.microphoneStream) {
    state.microphoneStream.getTracks().forEach(t => t.stop());
    state.microphoneStream = null;
  }
  
  // Clear all timeouts
  clearTimeout(state.podcastRecognitionRetryTimeout);
  clearTimeout(state.podcastRecognitionEndTimeout);
  clearTimeout(state.recordingTimer);
  
  // Cancel any ongoing speech
  window.speechSynthesis.cancel();
  
  // Update UI
  dom.recordStatusBadge.textContent = 'Tap to start';
  dom.recordToggleBtn.textContent = '🎙 AI Podcast';
  dom.recordToggleBtn.classList.remove('recording');
  dom.convoLog.classList.remove('active');
  
  showToast('🎙️ Voice conversation ended', 'info');
}

function togglePausePodcast() {
  if (!state.podcastActive) return;
  
  state.podcastPaused = !state.podcastPaused;
  const pauseBtn = document.getElementById('podcastPauseBtn');
  
  if (state.podcastPaused) {
    if (pauseBtn) pauseBtn.textContent = 'Resume';
    // Stop listening cleanly
    if (state.podcastRecognition) {
      try { 
        state.podcastRecognition.stop(); 
      } catch (e) {}
      state.podcastRecognition = null;
    }
    state.isListening = false;
    if (state.podcastAudio && !state.podcastAudio.paused) {
      try { state.podcastAudio.pause(); } catch (e) {}
    }
    dom.recordStatusBadge.textContent = '⏸️ Paused';
  } else {
    if (pauseBtn) pauseBtn.textContent = 'Pause';
    if (state.podcastAudio && state.podcastAudio.paused) {
      try { state.podcastAudio.play(); } catch (e) {}
    } else {
      dom.recordStatusBadge.textContent = '🎤 Listening...';
      // Small delay before restarting
      setTimeout(() => {
        if (state.podcastActive && !state.podcastPaused && !state.isListening) {
          startPodcastListening();
        }
      }, 300);
    }
  }
}

// Call this before starting any new recognition session
function cleanupPodcastRecognition() {
  if (state.podcastRecognition) {
    try {
      state.podcastRecognition.stop();
    } catch (e) {}
    state.podcastRecognition = null;
  }
  state.isListening = false;
  clearTimeout(state.podcastRecognitionRetryTimeout);
  clearTimeout(state.podcastRecognitionEndTimeout);
}

function startPodcastListening() {
  // Guard conditions - prevent starting if already active or paused
  if (!state.podcastActive || state.podcastPaused || state.isListening) return;

  // Prevent rapid restart loops
  const now = Date.now();
  if (now - state.lastRecognitionTime < CONFIG.RECOGNITION_DEBOUNCE) {
    return;
  }
  state.lastRecognitionTime = now;

  // Clear any existing recognition instance first
  if (state.podcastRecognition) {
    try {
      // Use .stop() instead of .abort() when possible - it's cleaner
      state.podcastRecognition.stop();
    } catch (e) {
      // Ignore
    }
    state.podcastRecognition = null;
  }

  dom.recordStatusBadge.textContent = '🎤 Listening...';
  state.isListening = true;

  state.podcastRecognition = startSpeechRecognition(
    // onResult - user spoke
    async (transcript) => {
      console.log('🗣️ User transcript received:', transcript);
      addConversationMessage('user', transcript);
      dom.recordStatusBadge.textContent = '⏳ Thinking...';
      
      // Stop listening while processing
      state.isListening = false;
      if (state.podcastRecognition) {
        try {
          state.podcastRecognition.stop();
        } catch (e) {}
        state.podcastRecognition = null;
      }
      
      try {
        const pageContext = getPageContext();
        console.log('📚 Getting AI response...');
        const aiResponse = await getAIResponse(transcript, pageContext);
        
        console.log('✅ AI Response:', aiResponse?.substring(0, 100));
        if (aiResponse && aiResponse.length > 5) {
          addConversationMessage('ai', aiResponse);
          dom.recordStatusBadge.textContent = '🔊 Speaking...';
          console.log('🔊 Speaking AI response');
          speakText(aiResponse);
          
          // Resume listening after AI speaks
          setTimeout(() => {
            if (state.podcastActive && !state.podcastPaused && !state.isListening) {
              console.log('🔄 Resuming listening after AI response');
              startPodcastListening();
            }
          }, 1500);
        } else {
          console.warn('⚠️ Empty AI response, retrying...');
          dom.recordStatusBadge.textContent = '🎤 Listening...';
          state.isListening = false;
          if (state.podcastActive && !state.podcastPaused) {
            setTimeout(() => {
              if (state.podcastActive && !state.podcastPaused && !state.isListening) {
                startPodcastListening();
              }
            }, 500);
          }
        }
      } catch (err) {
        console.error('💥 Error in AI response processing:', err);
        addConversationMessage('ai', 'I encountered an error. Please try again.');
        dom.recordStatusBadge.textContent = '🎤 Listening...';
        state.isListening = false;
        if (state.podcastActive && !state.podcastPaused) {
          setTimeout(() => {
            if (state.podcastActive && !state.podcastPaused && !state.isListening) {
              startPodcastListening();
            }
          }, 800);
        }
      }
    },
    // onEnd - recognition ended
    () => {
      state.isListening = false;
      // Only restart if we're not in the middle of AI speaking
      if (state.podcastActive && !state.podcastPaused && dom.recordStatusBadge.textContent !== '🔊 Speaking...') {
        clearTimeout(state.podcastRecognitionEndTimeout);
        state.podcastRecognitionEndTimeout = setTimeout(() => {
          if (state.podcastActive && !state.podcastPaused && !state.isListening) {
            startPodcastListening();
          }
        }, 600); // Increased delay
      }
    },
    // onError
    (error) => {
      console.warn('Recognition error:', error);
      state.isListening = false;
      
      // Don't restart on 'aborted' - it's a normal cleanup event
      if (error === 'aborted') {
        return;
      }
      
      if (error === 'not-allowed' || error === 'service-not-allowed') {
        dom.recordStatusBadge.textContent = '❌ Microphone denied';
        showToast('❌ Please allow microphone access.', 'error');
        stopAIPodcast();
        return;
      }
      
      // Handle 'no-speech' - user didn't speak or was too quiet
      if (error === 'no-speech') {
        console.log('No speech detected, retrying...');
        dom.recordStatusBadge.textContent = '🎤 Listening... (try speaking)';
        if (state.podcastActive && !state.podcastPaused) {
          clearTimeout(state.podcastRecognitionRetryTimeout);
          state.podcastRecognitionRetryTimeout = setTimeout(() => {
            if (state.podcastActive && !state.podcastPaused && !state.isListening) {
              dom.recordStatusBadge.textContent = '🎤 Listening...';
              startPodcastListening();
            }
          }, 800);
        }
        return;
      }
      
      // For other errors, retry with longer delay
      if (state.podcastActive && !state.podcastPaused) {
        dom.recordStatusBadge.textContent = '🎤 Listening...';
        clearTimeout(state.podcastRecognitionRetryTimeout);
        state.podcastRecognitionRetryTimeout = setTimeout(() => {
          if (state.podcastActive && !state.podcastPaused && !state.isListening) {
            startPodcastListening();
          }
        }, 1000); // Increased from 500ms to 1000ms
      }
    }
  );
}

async function getAIResponse(userQuestion, pageContext) {
  // Uses the SHORT version of the literary guide prompt for voice responses
  const prompt = `You are a literary guide. The user is reading this text:

${pageContext || 'No specific page content available.'}

User question: "${userQuestion}"

Respond in 2-3 sentences. Be warm, precise, and reflective. If quoting, do so briefly. End with a quiet observation, not a conclusion. Never say "I think." Speak as if the text itself is speaking through you.`;

  // Retry logic for network transients
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`📞 AI Response attempt ${attempt}/3 for: "${userQuestion.substring(0, 50)}..."`);
      const response = await askGroq(prompt, true);
      
      // Check if response is an error indicator
      if (response?.includes('❌') || response?.includes('⚠️')) {
        console.warn(`API returned error on attempt ${attempt}:`, response);
        lastError = response;
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 500 * attempt)); // Exponential backoff
          continue;
        }
        return response;
      }
      
      if (!response || response.length < 5) {
        console.warn(`Empty or very short response on attempt ${attempt}`);
        lastError = 'No response';
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 500 * attempt));
          continue;
        }
      }
      
      console.log(`✅ AI Response received on attempt ${attempt}`);
      return response;
    } catch (err) {
      console.error(`❌ Attempt ${attempt} failed:`, err.message);
      lastError = err;
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
  }
  
  // All retries failed
  console.error('All AI response attempts failed. Last error:', lastError);
  return "I'm reflecting on what you said. Please ask again—sometimes silence is the deepest listening.";
}

function addConversationMessage(role, text) {
  state.podcastHistory.push({ role, text, timestamp: Date.now() });
  
  const div = document.createElement('div');
  div.className = role === 'ai' ? 'ai' : 'user';
  div.textContent = (role === 'ai' ? '📖 ' : '🧑 ') + text;
  dom.convoLog.appendChild(div);
  dom.convoLog.scrollTop = dom.convoLog.scrollHeight;
  
  while (dom.convoLog.children.length > CONFIG.MAX_CONVO_LOG) {
    dom.convoLog.removeChild(dom.convoLog.firstChild);
  }
}

// ==================== TRANSLATION ====================
async function translateText(text, targetLang) {
  const langMap = { es: 'es', fr: 'fr', de: 'de', it: 'it', pt: 'pt', ru: 'ru', zh: 'zh', ja: 'ja' };
  const target = langMap[targetLang] || 'es';

  try {
    const response = await fetch('https://libretranslate.com/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: 'en', target, format: 'text' })
    });
    
    if (response.ok) {
      const data = await response.json();
      return data.translatedText;
    }
  } catch (e) {}
  
  const langNames = { es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ru: 'Russian', zh: 'Chinese', ja: 'Japanese' };
  return `[${langNames[targetLang] || targetLang}] ${text}`;
}

function resetAllTranslations() {
  document.querySelectorAll('.translated-text').forEach(span => {
    const parent = span.parentElement;
    if (parent.dataset.original) {
      parent.innerHTML = parent.dataset.original;
      delete parent.dataset.original;
    }
  });
  state.translationTargets = [];
  dom.translateControls.classList.remove('active');
  state.selectedText = '';
  showToast('🔄 Translations reset', 'info');
}

async function translateSelectedText() {
  if (!state.selectedText) return;
  const lang = dom.langSelect.value;
  const translated = await translateText(state.selectedText, lang);
  
  const selection = window.getSelection();
  if (selection.rangeCount) {
    const range = selection.getRangeAt(0);
    const span = document.createElement('span');
    span.className = 'translated-text';
    span.textContent = translated;
    range.deleteContents();
    range.insertNode(span);
  }
  dom.translateControls.classList.remove('active');
  showToast(`✅ Translated to ${dom.langSelect.options[dom.langSelect.selectedIndex].text}`, 'success');
}

// ==================== LITERARY GUIDE - SPECIAL FEATURES ====================

// Generate a literary introduction for any chapter or passage
async function generateLiteraryIntro(text, title, author, chapter) {
  const prompt = `Provide a literary introduction for this passage from "${title}" by ${author}${chapter ? ', Chapter ' + chapter : ''}.

Text: "${text.substring(0, 1500)}"

Follow the literary guide structure:
1. Open with precision (name book, author, chapter)
2. Frame the emotional thesis (1-2 sentences on the human tension)
3. Set the scene (who speaks, what's happening)
4. Present the text (verbatim, no interruption)
5. End with a quiet observation

Keep it under 200 words. Speak with reverence and clarity. Never say "I think."`;

  try {
    return await askGroq(prompt, false);
  } catch (err) {
    console.error('Literary intro error:', err);
    return null;
  }
}

// Generate a reflective question about a passage
async function generateReflectiveQuestion(text, title) {
  const prompt = `Based on this passage from "${title}":

"${text.substring(0, 800)}"

Generate one quiet, open-ended question that invites the reader to sit with the text. The question should be reflective, not analytical. It should not have a right answer. It should feel like something you'd ask yourself while reading alone.

Example: "Notice how the wound and the crown are the same hand—what does that ask of you?"`;

  try {
    return await askGroq(prompt, true);
  } catch (err) {
    console.error('Reflective question error:', err);
    return null;
  }
}

// ==================== INITIALIZATION ====================
function initProgressSpine() {
  dom.progressSpine.innerHTML = '';
  chapters.forEach((ch, idx) => {
    const segment = document.createElement('button');
    segment.className = 'spine-segment' + (ch.num === state.currentChapter ? ' active' : '');
    segment.title = `Ch. ${ch.num}: ${ch.title}`;
    segment.onclick = () => goToChapter(ch.num);
    dom.progressSpine.appendChild(segment);
  });
}

function initChapterList() {
  dom.chapterList.innerHTML = '';
  chapters.forEach(ch => {
    const li = document.createElement('li');
    li.className = ch.num === state.currentChapter ? 'active' : '';
    li.innerHTML = `
      <span>${ch.title}</span>
      <span class="chapter-num">${String(ch.num).padStart(2, '0')}</span>
    `;
    li.onclick = () => {
      goToChapter(ch.num);
      closeChapterModal();
    };
    dom.chapterList.appendChild(li);
  });
}

function openChapterModal() {
  document.getElementById('chapterModal').classList.add('active');
}

function closeChapterModal() {
  document.getElementById('chapterModal').classList.remove('active');
}

// ==================== EVENT LISTENERS ====================
function init() {
  dom.originalContent = dom.textContent.innerHTML;
  initProgressSpine();
  initChapterList();
  updateStats();
  loadRecordedVideo(state.currentChapter);
  loadReadingProgress();
  
  setupEventListeners();
  
  showToast('📚 Welcome. I am your literary guide. Select text or tap "AI Podcast" to begin.', 'info', 5000);
}

function setupEventListeners() {
  // --- Voice Conversation ---
  dom.recordToggleBtn.addEventListener('click', () => {
    if (state.podcastActive) {
      stopAIPodcast();
    } else {
      openRecordingPrompt();
    }
  });

  dom.promptStartBtn.addEventListener('click', () => {
    closeRecordingPrompt();
    setTimeout(() => startAIPodcast(), 300);
  });

  // --- Dark Mode ---
  document.getElementById('darkModeToggle').addEventListener('click', () => {
    document.body.classList.toggle('dark');
    const isDark = document.body.classList.contains('dark');
    document.getElementById('darkModeToggle').textContent = isDark ? '☀️' : '🌙';
    showToast(isDark ? '🌙 Dark mode enabled' : '☀️ Light mode enabled', 'info');
  });

  // --- Navigation ---
  document.getElementById('prevBtn').addEventListener('click', () => {
    if (isPdfLoaded()) {
      const target = state.currentPdfPage - 1;
      if (target >= 1) { loadPdfPage(target); loadRecordedVideo(target); }
    } else if (state.currentChapter > 1) {
      goToChapter(state.currentChapter - 1);
    }
  });

  document.getElementById('nextBtn').addEventListener('click', () => {
    if (isPdfLoaded()) {
      const target = state.currentPdfPage + 1;
      if (target <= state.pdfDocument.numPages) { loadPdfPage(target); loadRecordedVideo(target); }
    } else if (state.currentChapter < chapters.length) {
      goToChapter(state.currentChapter + 1);
    }
  });

  document.getElementById('chapterBtn').addEventListener('click', openChapterModal);

  // --- PDF Upload ---
  dom.pdfInput.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (file) await handlePdfFile(file);
  });

  // --- Selection Toolbar ---
  document.addEventListener('mouseup', handleSelection);
  document.addEventListener('scroll', () => { dom.toolbar.style.display = 'none'; });
  document.addEventListener('mousedown', (e) => {
    if (!dom.toolbar.contains(e.target)) dom.toolbar.style.display = 'none';
  });

  // --- Toolbar Buttons ---
  document.getElementById('readAloudBtn').addEventListener('click', handleReadAloud);
  document.getElementById('askAiBtn').addEventListener('click', handleAskAI);
  document.getElementById('summarizeBtn').addEventListener('click', handleSummarize);
  document.getElementById('highlightBtn').addEventListener('click', handleHighlight);
  document.getElementById('noteBtn').addEventListener('click', handleNote);
  document.getElementById('translateBtn').addEventListener('click', handleTranslate);

  // --- Translation ---
  document.getElementById('applyTranslateBtn').addEventListener('click', translateSelectedText);
  document.getElementById('resetTranslateBtn').addEventListener('click', resetAllTranslations);

  // --- Modal Close ---
  document.querySelectorAll('.modal-overlay').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('active');
    });
  });

  document.getElementById('videoPlaybackModal').addEventListener('click', (e) => {
    if (e.target.id === 'videoPlaybackModal') closeVideoModal();
  });

  // --- Keyboard Shortcuts ---
  document.addEventListener('keydown', handleKeyboardShortcuts);
}

// ==================== SELECTION HANDLING ====================
function handleSelection(e) {
  const selection = window.getSelection();
  const text = selection.toString().trim();
  
  if (!text || !dom.textContent.contains(selection.anchorNode)) {
    dom.toolbar.style.display = 'none';
    return;
  }

  if (dom.textContent.contains(selection.anchorNode) && dom.textContent.contains(selection.focusNode)) {
    state.selectedText = text;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    
    dom.toolbar.style.display = 'flex';
    dom.toolbar.style.left = Math.max(16, rect.left + rect.width / 2 - dom.toolbar.offsetWidth / 2) + 'px';
    dom.toolbar.style.top = Math.max(16, rect.top - 56 + window.scrollY) + 'px';
  }
}

// ==================== TOOLBAR HANDLERS ====================
function handleReadAloud() {
  const text = state.selectedText || getPageContext();
  if (!text) {
    showToast('Please select some text first.', 'error');
    return;
  }
  speakText(text);
  dom.toolbar.style.display = 'none';
  showToast('🔊 Reading aloud...', 'info');
}

async function handleAskAI() {
  let question = state.selectedText;
  if (!question) question = prompt('Ask AI about this document:');
  if (!question) return;

  const answer = await askGroq(question, false);
  if (answer) {
    showAIModal(question, answer);
  }
  dom.toolbar.style.display = 'none';
}

function showAIModal(question, answer) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay active';
  modal.innerHTML = `
    <div class="modal" style="max-width: 600px;">
      <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
      <h2 class="modal-title">📖 Literary Guide</h2>
      <div style="margin: 20px 0; padding: 16px; background: #f5f2ed; border-radius: 8px; font-size: 14px;">
        <strong>Your question:</strong> ${escapeHtml(question)}
      </div>
      <div style="margin: 20px 0; padding: 16px; background: #edeae2; border: 1px solid #d9d3ca; border-radius: 8px; line-height: 1.8; max-height: 400px; overflow-y: auto; white-space: pre-wrap;">
        ${escapeHtml(answer)}
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
        <button class="control-btn" onclick="this.closest('.modal-overlay').remove()">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

function handleSummarize() {
  const text = state.selectedText || getPageContext();
  if (!text) {
    showToast('Please select text first.', 'error');
    return;
  }
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const summary = sentences.slice(0, 3).join(' ');
  showToast('📋 Summary generated', 'success');
  alert('📋 Summary:\n\n' + summary);
  dom.toolbar.style.display = 'none';
}

function handleHighlight() {
  const selection = window.getSelection();
  if (!selection.rangeCount || !selection.toString().trim()) {
    showToast('Please select text to highlight.', 'error');
    dom.toolbar.style.display = 'none';
    return;
  }
  try {
    const range = selection.getRangeAt(0);
    const span = document.createElement('span');
    span.className = 'highlighted-text';
    span.style.background = '#fff4b8';
    span.style.padding = '2px 4px';
    span.style.borderRadius = '2px';
    span.style.cursor = 'pointer';
    span.dataset.highlightId = Date.now().toString();
    
    span.onclick = function(e) {
      e.stopPropagation();
      if (confirm('Remove this highlight?')) {
        const parent = this.parentNode;
        const textNode = document.createTextNode(this.textContent);
        parent.replaceChild(textNode, this);
        parent.normalize();
        showToast('✨ Highlight removed', 'info');
      }
    };
    
    range.surroundContents(span);
    selection.removeAllRanges();
    state.highlights.push({ id: span.dataset.highlightId, text: span.textContent });
    showToast('✨ Text highlighted', 'success');
  } catch (error) {
    showToast('Try selecting a smaller section.', 'error');
  }
  dom.toolbar.style.display = 'none';
}

function handleNote() {
  const text = window.getSelection().toString().trim();
  if (!text) {
    showToast('Please select text first.', 'error');
    return;
  }
  const note = prompt('📝 Enter your note:', '');
  if (note !== null) {
    state.notes.push({ text, note, timestamp: new Date() });
    document.getElementById('noteCount').textContent = state.notes.length;
    showToast('✅ Note saved', 'success');
  }
  dom.toolbar.style.display = 'none';
}

function handleTranslate() {
  if (!state.selectedText) {
    showToast('Please select text first.', 'error');
    return;
  }
  dom.toolbar.style.display = 'none';
  dom.selectedTextPreview.textContent = `"${state.selectedText.substring(0, 60)}${state.selectedText.length > 60 ? '...' : ''}"`;
  dom.translateControls.classList.add('active');
  dom.translateControls.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ==================== KEYBOARD SHORTCUTS ====================
function handleKeyboardShortcuts(e) {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach(modal => {
      modal.classList.remove('active');
    });
    if (state.podcastActive) stopAIPodcast();
  }
  if (e.ctrlKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    document.getElementById('prevBtn').click();
  }
  if (e.ctrlKey && e.key === 'ArrowRight') {
    e.preventDefault();
    document.getElementById('nextBtn').click();
  }
  if (e.ctrlKey && e.key === 'm') {
    e.preventDefault();
    dom.recordToggleBtn.click();
  }
  if (e.ctrlKey && e.key === 'f') {
    e.preventDefault();
    const search = prompt('Search in document:');
    if (search) findInPage(search);
  }
}

function findInPage(searchText) {
  const content = dom.textContent.textContent;
  const index = content.toLowerCase().indexOf(searchText.toLowerCase());
  if (index === -1) {
    showToast(`🔍 "${searchText}" not found`, 'error');
    return;
  }
  
  const paragraphs = dom.textContent.querySelectorAll('p');
  let charCount = 0;
  for (const p of paragraphs) {
    if (charCount + p.textContent.length > index) {
      p.scrollIntoView({ behavior: 'smooth', block: 'center' });
      p.style.background = '#fff4b8';
      setTimeout(() => { p.style.background = ''; }, 2000);
      break;
    }
    charCount += p.textContent.length + 1;
  }
  showToast(`🔍 Found "${searchText}"`, 'success');
}

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', init);

// ==================== EXPOSE FOR DEBUGGING ====================
window.__debug = {
  state,
  dom,
  CONFIG,
  startAIPodcast,
  stopAIPodcast,
  speakText,
  askGroq,
  generateLiteraryIntro,
  generateReflectiveQuestion,
  LITERARY_GUIDE_SYSTEM_PROMPT,
};