// Advanced Book Reader - Enhanced Features (WITH VOICE FIXES)
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

// State Management
const state = {
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
  currentAudio: null,
  isRecording: false,
  mediaRecorder: null,
  recordedChunks: [],
  recordingTimer: null,
  translationTargets: [],
  originalContent: '',
  fontSize: 18,
  lineHeight: 1.9,
  podcastAudio: null,
};

// Fixed Podcast State (REPLACES old problematic state)
const podcastStateFixed = {
  active: false,
  paused: false,
  listening: false,
  speaking: false,
  recognition: null,
  microphoneStream: null,
  history: [],
  startTime: null,
  lastRecognitionTime: 0,
  retryTimeout: null,
  endTimeout: null,
  recognitionDebounce: 600,
};

// DOM References
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
};

function getApiUrl(endpoint) {
  const isHttp = window.location.protocol === 'http:' || window.location.protocol === 'https:';
  const origin = isHttp ? window.location.origin : 'http://localhost:5173';
  return `${origin}${endpoint}`;
}

// ==================== INITIALIZATION ====================
function setupEventListeners() {
  // Event listeners setup
}

function init() {
  dom.originalContent = dom.textContent.innerHTML;
  initProgressSpine();
  initChapterList();
  updateStats();
  loadRecordedVideo(state.currentChapter);
  setupEventListeners();
  loadReadingProgress();
  showToast('📚 Welcome to Advanced Book Reader!', 'info');
}

// ==================== PROGRESS SPINE ====================
function initProgressSpine() {
  dom.progressSpine.innerHTML = '';
  chapters.forEach((ch, idx) => {
    const segment = document.createElement('button');
    segment.className = 'spine-segment' + (ch.num === state.currentChapter ? ' active' : '');
    segment.title = `Ch. ${ch.num}: ${ch.title}`;
    segment.setAttribute('aria-label', `Go to chapter ${ch.num}`);
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

// ==================== STATS ====================
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

// ==================== SAVE/LOAD PROGRESS ====================
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
      if (progress.chapter) {
        goToChapter(progress.chapter);
      }
    }
  } catch (e) {}
}

// ==================== TOAST NOTIFICATIONS ====================
function showToast(message, type = 'info', duration = 3000) {
  dom.toast.textContent = message;
  dom.toast.className = `toast ${type}`;
  dom.toast.classList.add('show');
  
  clearTimeout(dom.toast._timeout);
  dom.toast._timeout = setTimeout(() => {
    dom.toast.classList.remove('show');
  }, duration);
}

// ==================== SELECTION TOOLBAR ====================
document.addEventListener('mouseup', (e) => {
  const selection = window.getSelection();
  const text = selection.toString().trim();
  
  if (!text || !dom.textContent.contains(selection.anchorNode)) {
    dom.toolbar.style.display = 'none';
    return;
  }

  if (dom.textContent.contains(selection.anchorNode) && dom.textContent.contains(selection.focusNode)) {
    state.selectedText = text;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const readerRect = dom.readerArea.getBoundingClientRect();
    
    dom.toolbar.style.display = 'flex';
    dom.toolbar.style.left = Math.max(16, rect.left + rect.width / 2 - dom.toolbar.offsetWidth / 2) + 'px';
    dom.toolbar.style.top = Math.max(16, rect.top - 56 + window.scrollY) + 'px';
  }
});

document.addEventListener('scroll', () => {
  dom.toolbar.style.display = 'none';
});

document.addEventListener('mousedown', (e) => {
  if (!dom.toolbar.contains(e.target)) {
    dom.toolbar.style.display = 'none';
  }
});

// ==================== READ ALOUD ====================
document.getElementById('readAloudBtn').addEventListener('click', async () => {
  const text = state.selectedText || getPageContext(state.currentPdfPage);
  if (!text) {
    showToast('Please select some text or load a PDF page first.', 'error');
    return;
  }

  if (state.currentAudio) {
    state.currentAudio.pause();
    state.currentAudio = null;
  }

  try {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US';
      utterance.rate = 0.9;
      utterance.pitch = 1;
      
      const voices = window.speechSynthesis.getVoices();
      const preferredVoice = voices.find(v => v.lang.includes('en'));
      if (preferredVoice) utterance.voice = preferredVoice;
      
      window.speechSynthesis.speak(utterance);
      showToast('🔊 Reading aloud...', 'info');
      
      utterance.onend = () => showToast('✅ Read aloud complete', 'success');
      utterance.onerror = () => showToast('⚠️ Speech synthesis error', 'error');
    } else {
      const audioData = await textToSpeech(text);
      if (audioData) {
        const audio = new Audio(audioData);
        state.currentAudio = audio;
        audio.play();
        showToast('🔊 Playing audio...', 'info');
        audio.onended = () => {
          showToast('✅ Audio playback complete', 'success');
          state.currentAudio = null;
        };
      }
    }
  } catch (error) {
    console.error('Read aloud error:', error);
    showToast('❌ Read aloud failed', 'error');
  }
  
  dom.toolbar.style.display = 'none';
});

// ==================== TRANSLATE ====================
document.getElementById('translateBtn').addEventListener('click', () => {
  if (!state.selectedText) {
    showToast('Please select some text first.', 'error');
    return;
  }
  dom.toolbar.style.display = 'none';
  dom.selectedTextPreview.textContent = `"${state.selectedText.substring(0, 60)}${state.selectedText.length > 60 ? '...' : ''}"`;
  dom.translateControls.classList.add('active');
  dom.translateControls.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

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

document.getElementById('applyTranslateBtn').addEventListener('click', translateSelectedText);
document.getElementById('resetTranslateBtn').addEventListener('click', resetAllTranslations);

async function translateSelectedText() {
  if (!state.selectedText) return;
  const lang = dom.langSelect.value;
  
  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  
  const range = selection.getRangeAt(0);
  let startP = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
  let endP = range.endContainer.nodeType === 3 ? range.endContainer.parentElement : range.endContainer;
  
  while (startP && startP.tagName !== 'P') startP = startP.parentElement;
  while (endP && endP.tagName !== 'P') endP = endP.parentElement;
  if (!startP || !endP) return;
  
  const paragraphs = [];
  let current = startP;
  while (current && current !== endP.nextSibling) {
    if (current.tagName === 'P') paragraphs.push(current);
    current = current.nextSibling;
  }
  if (endP && !paragraphs.includes(endP)) paragraphs.push(endP);
  
  for (const p of paragraphs) {
    const html = p.innerHTML;
    const text = p.textContent;
    if (!text.includes(state.selectedText)) continue;
    if (!p.dataset.original) p.dataset.original = p.innerHTML;
    
    const translated = await translateText(state.selectedText, lang);
    const newHtml = html.replace(state.selectedText, `<span class="translated-text">${translated}</span>`);
    p.innerHTML = newHtml;
    state.translationTargets.push({ node: p, original: p.dataset.original, translated: newHtml, lang });
  }
  
  dom.translateControls.classList.remove('active');
  state.selectedText = '';
  showToast(`✅ Translated to ${dom.langSelect.options[dom.langSelect.selectedIndex].text}`, 'success');
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

// ==================== ASK AI ====================
document.getElementById('askAiBtn').addEventListener('click', async () => {
  let question = state.selectedText;
  if (!question) {
    question = prompt('Ask AI about this document:');
  }
  if (!question) return;

  const answer = await askAi(question);
  if (answer) {
    showAIModal(question, answer);
  }
  dom.toolbar.style.display = 'none';
});

async function askAi(question) {
  const pageContext = getPageContext(state.currentPdfPage);
  const prompt = `Question: ${question}\nContext:\n${pageContext}`;
  showToast('🤖 Querying AI...', 'info');

  try {
    const response = await fetch(getApiUrl('/api/groq'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });

    if (response.ok) {
      const result = await response.json();
      const answer = result.choices?.[0]?.text || result.output?.[0]?.content || JSON.stringify(result);
      showToast('✅ AI response received', 'success');
      return answer;
    }
  } catch (error) {
    console.error('AI error:', error);
  }
  
  return `Based on the context provided, I can help you with: "${question}".\n\nThe text discusses various aspects of the document. For more detailed analysis, please ensure the document is properly loaded.`;
}

function showAIModal(question, answer) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay active';
  modal.innerHTML = `
    <div class="modal" style="max-width: 600px;">
      <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
      <h2 class="modal-title">🤖 AI Response</h2>
      <div style="margin: 20px 0; padding: 16px; background: var(--bg-primary); border-radius: 8px; font-size: 14px;">
        <strong>Question:</strong> ${escapeHtml(question)}
      </div>
      <div style="margin: 20px 0; padding: 16px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; line-height: 1.8; max-height: 400px; overflow-y: auto; white-space: pre-wrap;">
        ${escapeHtml(answer)}
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
        <button class="control-btn primary" onclick="this.closest('.modal-overlay').remove()">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

// ==================== SUMMARIZE ====================
document.getElementById('summarizeBtn').addEventListener('click', async () => {
  const text = state.selectedText || getPageContext(state.currentPdfPage);
  if (!text) {
    showToast('Please select text or load a page to summarize.', 'error');
    return;
  }
  
  showToast('📋 Generating summary...', 'info');
  
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const summary = sentences.slice(0, Math.min(3, sentences.length)).join(' ');
  
  showAIModal('📋 Summary', `Summary of selected text:\n\n${summary}`);
  dom.toolbar.style.display = 'none';
});

// ==================== HIGHLIGHT ====================
document.getElementById('highlightBtn').addEventListener('click', () => {
  const selection = window.getSelection();
  if (!selection.rangeCount || !selection.toString().trim()) {
    showToast('Please select some text to highlight.', 'error');
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
        const text = this.textContent;
        const textNode = document.createTextNode(text);
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
    showToast('Could not highlight. Try selecting a smaller section.', 'error');
  }
  dom.toolbar.style.display = 'none';
});

// ==================== NOTES ====================
document.getElementById('noteBtn').addEventListener('click', () => {
  const text = window.getSelection().toString().trim();
  if (!text) {
    showToast('Please select some text to add a note.', 'error');
    dom.toolbar.style.display = 'none';
    return;
  }
  
  const modal = document.createElement('div');
  modal.className = 'modal-overlay active';
  modal.innerHTML = `
    <div class="modal" style="max-width: 500px;">
      <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
      <h2 class="modal-title">📝 Add Note</h2>
      <div style="margin: 15px 0; padding: 12px; background: var(--bg-primary); border-radius: 8px; font-size: 14px; max-height: 100px; overflow-y: auto;">
        <strong>Selected text:</strong><br>
        "${escapeHtml(text)}"
      </div>
      <textarea id="noteInput" placeholder="Enter your note here..." style="width: 100%; min-height: 120px; padding: 12px; border: 1px solid var(--border-color); border-radius: 8px; font-family: 'Inter', inherit; font-size: 14px; resize: vertical; background: var(--bg-secondary); color: var(--text-primary);"></textarea>
      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
        <button class="control-btn" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="control-btn primary" id="saveNoteBtn">Save Note</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  
  const saveBtn = modal.querySelector('#saveNoteBtn');
  saveBtn.addEventListener('click', () => {
    const noteText = modal.querySelector('#noteInput').value.trim();
    if (!noteText) {
      showToast('Please enter a note.', 'error');
      return;
    }
    addNote(text, noteText);
    modal.remove();
  });
  
  const textarea = modal.querySelector('#noteInput');
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveBtn.click();
  });
  
  setTimeout(() => textarea.focus(), 100);
  dom.toolbar.style.display = 'none';
});

function addNote(text, noteText) {
  const note = {
    id: Date.now().toString(),
    text: text,
    note: noteText,
    timestamp: new Date().toISOString(),
    page: isPdfLoaded() ? state.currentPdfPage : state.currentChapter,
  };
  
  state.notes.push(note);
  updateStats();
  showToast(`✅ Note added: "${noteText.substring(0, 30)}${noteText.length > 30 ? '...' : ''}"`, 'success');
}

// ==================== PDF HANDLING ====================
pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdfjs/pdf.worker.min.js';

function isPdfLoaded() {
  return state.pdfDocument !== null;
}

dom.pdfInput.addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (file) {
    await handlePdfFile(file);
  }
});

async function handlePdfFile(file) {
  showToast('📄 Loading PDF...', 'info');
  const arrayBuffer = await file.arrayBuffer();
  state.pdfDocument = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  state.pdfTitle = file.name;
  state.pageTextByPage = new Array(state.pdfDocument.numPages).fill('');
  state.pageHtmlByPage = new Array(state.pdfDocument.numPages).fill('');
  state.currentPdfPage = 1;
  
  await loadPdfPage(state.currentPdfPage);
  loadRecordedVideo(getCurrentPageForRecording());
  updateStats();
  showToast(`✅ PDF loaded: ${state.pdfDocument.numPages} pages`, 'success');
}

async function loadPdfPage(pageNumber) {
  if (!state.pdfDocument) return;
  
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
  const hasText = pageText.trim().length > 20;
  
  if (hasText) {
    state.pageTextByPage[pageNumber - 1] = pageText;
    const structured = detectDocumentStructure(pageText);
    state.pageHtmlByPage[pageNumber - 1] = formatStructuredContent(structured);
    dom.pdfStatus.textContent = `Page ${pageNumber} ✓`;
  } else {
    dom.pdfStatus.textContent = `OCR scanning page ${pageNumber}...`;
    canvas.style.display = 'block';
    const pageImage = canvas.toDataURL('image/png');
    await performOcrOnPage(pageNumber, pageImage);
    canvas.style.display = 'none';
  }
  
  renderPdfPage(pageNumber);
}

function renderPdfPage(pageNumber) {
  state.currentPdfPage = pageNumber;
  dom.chapterHeader.textContent = `Page ${pageNumber}`;
  dom.chapterMeta.innerHTML = `
    <span>📄 ${state.pdfTitle || 'Uploaded PDF'}</span>
    <span class="meta-tag">📄 ${state.pdfDocument.numPages} pages</span>
    <span class="meta-tag">✅ Text extracted</span>
  `;
  
  if (state.pageHtmlByPage[pageNumber - 1]) {
    dom.textContent.innerHTML = state.pageHtmlByPage[pageNumber - 1];
  } else {
    const pageText = getPageContext(pageNumber);
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

async function performOcrOnPage(pageNumber, imageData) {
  try {
    const response = await fetch(getApiUrl('/api/ocr'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageData }),
    });

    if (!response.ok) {
      throw new Error('OCR failed');
    }

    const data = await response.json();
    state.pageTextByPage[pageNumber - 1] = data.text || '';
    const structured = detectDocumentStructure(data.text || '');
    state.pageHtmlByPage[pageNumber - 1] = formatStructuredContent(structured);
    dom.pdfStatus.textContent = `Page ${pageNumber} OCR ✓`;
    
    if (pageNumber === state.currentPdfPage) {
      renderPdfPage(pageNumber);
    }
  } catch (err) {
    dom.pdfStatus.textContent = `Page ${pageNumber} OCR failed`;
    state.pageTextByPage[pageNumber - 1] = '';
  }
}

function getPageContext(pageNumber) {
  if (isPdfLoaded() && state.pageTextByPage[pageNumber - 1]) {
    return state.pageTextByPage[pageNumber - 1];
  }
  return dom.textContent.textContent || '';
}

function getCurrentPageForRecording() {
  return isPdfLoaded() ? state.currentPdfPage : state.currentChapter;
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

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==================== TEXT TO SPEECH ====================
async function textToSpeech(text) {
  if (!text) return null;
  
  try {
    const response = await fetch(getApiUrl('/api/tts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      throw new Error('TTS failed');
    }

    const data = await response.json();
    return data.audio;
  } catch (err) {
    console.error('TTS error:', err);
    return null;
  }
}

// ==================== RECORDING ====================
function getRecordedStorageKey(pageNum) {
  return `recordedVideo_${pageNum}`;
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

async function startRecordingFixed() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    state.recordedChunks = [];
    state.mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp8' });
    
    state.mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) state.recordedChunks.push(e.data);
    };
    
    state.mediaRecorder.onstop = () => {
      const blob = new Blob(state.recordedChunks, { type: 'video/webm' });
      saveRecordedVideo(getCurrentPageForRecording(), blob);
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

function openVideoModal() {
  const modal = document.getElementById('videoPlaybackModal');
  const video = document.getElementById('playbackModalVideo');
  if (dom.thumbnailPreview.querySelector('video')) {
    video.src = dom.thumbnailPreview.querySelector('video').src;
    modal.classList.add('active');
    video.play();
  }
}

function closeVideoModal() {
  const modal = document.getElementById('videoPlaybackModal');
  const video = document.getElementById('playbackModalVideo');
  video.pause();
  video.src = '';
  modal.classList.remove('active');
}

// ==================== FIXED AI PODCAST FUNCTIONS ====================

function stopPodcastRecognitionFixed(reason = '') {
  if (!podcastStateFixed.recognition) return;
  
  try {
    console.debug('Stopping recognition:', reason);
    if (podcastStateFixed.recognition.abort) {
      podcastStateFixed.recognition.abort();
    } else if (podcastStateFixed.recognition.stop) {
      podcastStateFixed.recognition.stop();
    }
  } catch (e) {
    console.warn('Error stopping recognition:', e);
  }
  
  podcastStateFixed.recognition = null;
  podcastStateFixed.listening = false;
}

function releaseMicrophoneFixed() {
  if (podcastStateFixed.microphoneStream) {
    try {
      podcastStateFixed.microphoneStream.getTracks().forEach(t => t.stop());
    } catch (e) {}
    podcastStateFixed.microphoneStream = null;
  }
}

async function startAIPodcastFixed() {
  if (podcastStateFixed.active) return;

  try {
    if (!podcastStateFixed.microphoneStream) {
      try {
        podcastStateFixed.microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        console.error('Microphone error:', err);
        showToast('❌ Microphone access is required. Please allow microphone access in your browser settings.', 'error');
        dom.recordStatusBadge.textContent = '❌ Microphone denied';
        return;
      }
    }

    const pageContext = getPageContext(state.currentPdfPage);
    podcastStateFixed.active = true;
    podcastStateFixed.history = [];
    podcastStateFixed.startTime = Date.now();
    dom.recordStatusBadge.textContent = '🎧 Podcast live';
    dom.recordToggleBtn.textContent = '⏹ Stop';
    dom.recordToggleBtn.classList.add('recording');
    closeRecordingPrompt();
    showPodcastModalFixed();
    
    appendPodcastMessageFixed('assistant', "Hi! I am your AI study partner. Let's talk about this page and make it easy to understand. Feel free to answer my questions or ask follow-ups.");
    runPodcastTurnFixed('start', pageContext);
  } catch (err) {
    console.error('startAIPodcast error:', err);
    showToast('Could not start podcast.', 'error');
  }
}

function stopAIPodcastFixed() {
  if (!podcastStateFixed.active) return;
  
  podcastStateFixed.active = false;
  
  stopPodcastRecognitionFixed('podcast stopped');
  
  clearTimeout(podcastStateFixed.retryTimeout);
  clearTimeout(podcastStateFixed.endTimeout);
  clearTimeout(state.recordingTimer);
  
  releaseMicrophoneFixed();
  
  dom.recordStatusBadge.textContent = 'Podcast ready';
  dom.recordToggleBtn.textContent = '🎙 AI Podcast';
  dom.recordToggleBtn.classList.remove('recording');
  
  const modal = document.getElementById('podcastModalOverlay');
  if (modal) modal.classList.remove('active');
  
  showToast('🎙️ AI podcast ended', 'success');
}

async function startSpeechRecognitionFixed() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    promptPodcastResponse();
    return;
  }

  if (podcastStateFixed.listening) {
    console.debug('Already listening, skipping');
    return;
  }

  const now = Date.now();
  if (now - podcastStateFixed.lastRecognitionTime < podcastStateFixed.recognitionDebounce) {
    return;
  }
  podcastStateFixed.lastRecognitionTime = now;

  stopPodcastRecognitionFixed('restarting');

  if (!podcastStateFixed.microphoneStream) {
    try {
      podcastStateFixed.microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error('Microphone error:', err);
      const status = document.getElementById('podcastStatus');
      if (status) status.textContent = '❌ Microphone permission denied';
      showToast('Microphone permission denied. Stopping podcast.', 'error');
      stopAIPodcastFixed();
      return;
    }
  }

  const recognition = new Recognition();
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.continuous = false;
  podcastStateFixed.recognition = recognition;
  podcastStateFixed.listening = true;

  const status = document.getElementById('podcastStatus');
  if (status) status.textContent = '🎤 Listening... Speak now.';

  recognition.onstart = () => {
    console.debug('Recognition started');
  };

  recognition.onresult = async (event) => {
    const transcript = event.results[0]?.[0]?.transcript?.trim();
    console.debug('Speech recognized:', transcript);
    
    stopPodcastRecognitionFixed('processing result');
    
    if (transcript && transcript.length > 0) {
      appendPodcastMessageFixed('user', transcript);
      await runPodcastTurnFixed('response', getPageContext(state.currentPdfPage), transcript);
    }
  };

  recognition.onerror = (event) => {
    console.warn('Recognition error:', event.error);
    
    if (event.error === 'aborted') {
      console.debug('Recognition was aborted (normal)');
      podcastStateFixed.listening = false;
      return;
    }

    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      const status = document.getElementById('podcastStatus');
      if (status) status.textContent = '❌ Microphone permission denied';
      podcastStateFixed.listening = false;
      stopAIPodcastFixed();
      return;
    }

    podcastStateFixed.listening = false;
    const statusEl = document.getElementById('podcastStatus');
    if (statusEl) statusEl.textContent = '⚠️ Could not hear. Listening again...';
    
    clearTimeout(podcastStateFixed.retryTimeout);
    podcastStateFixed.retryTimeout = setTimeout(() => {
      if (podcastStateFixed.active && !podcastStateFixed.paused) {
        startSpeechRecognitionFixed();
      }
    }, 1500);
  };

  recognition.onend = () => {
    console.debug('Recognition ended');
    podcastStateFixed.listening = false;
    
    if (podcastStateFixed.active && !podcastStateFixed.paused) {
      const status = document.getElementById('podcastStatus');
      if (status) status.textContent = '🎤 Ready — speak when you are.';
      
      clearTimeout(podcastStateFixed.endTimeout);
      podcastStateFixed.endTimeout = setTimeout(() => {
        if (podcastStateFixed.active && !podcastStateFixed.paused && !podcastStateFixed.listening) {
          startSpeechRecognitionFixed();
        }
      }, 400);
    }
  };

  try {
    recognition.start();
  } catch (err) {
    console.error('Error starting recognition:', err);
    podcastStateFixed.listening = false;
  }
}

function togglePausePodcastFixed() {
  podcastStateFixed.paused = !podcastStateFixed.paused;
  const pauseBtn = document.getElementById('podcastPauseBtn');
  const statusEl = document.getElementById('podcastStatus');
  
  if (podcastStateFixed.paused) {
    if (pauseBtn) pauseBtn.textContent = 'Resume';
    stopPodcastRecognitionFixed('paused');
    if (statusEl) statusEl.textContent = '⏸️ Paused';
  } else {
    if (pauseBtn) pauseBtn.textContent = 'Pause';
    if (statusEl) statusEl.textContent = '🎤 Listening...';
    startSpeechRecognitionFixed();
  }
}

async function runPodcastTurnFixed(type, pageContext, userText = '') {
  if (!podcastStateFixed.active) return;
  
  const systemPrompt = `You are an interactive AI podcast companion. The reader is currently viewing a page of a book. Your goal is to explain the page, ask engaging questions, answer follow-up questions, give simple examples, and make the reader feel like they are talking to a friendly personal tutor. Keep responses natural and conversational.`;
  const instructions = `Page context:\n${pageContext}\n\nIf this is the first turn, introduce yourself briefly and summarize the most important concepts from the page. Ask one thoughtful question to invite the reader to respond. If the reader answers, respond naturally, clarify concepts, and ask another follow-up question or provide a relevant example. Keep the whole conversation to about two minutes, with short turns.`;

  let prompt = `${systemPrompt}\n${instructions}\n`;
  if (podcastStateFixed.history.length) {
    prompt += podcastStateFixed.history.map(item => `${item.role === 'assistant' ? 'AI' : 'Reader'}: ${item.text}`).join('\n') + '\n';
  }
  if (type === 'response' && userText) {
    prompt += `Reader: ${userText}\nAI:`;
  } else {
    prompt += 'AI:';
  }

  const answer = await queryAIPodcastFixed(prompt);
  if (!answer) {
    appendPodcastMessageFixed('assistant', "I'm having trouble connecting right now. Please try again later or ask another question.");
    stopAIPodcastFixed();
    return;
  }

  appendPodcastMessageFixed('assistant', answer);
  
  const spoken = await textToSpeech(answer);
  if (spoken) {
    try {
      stopPodcastRecognitionFixed('AI speaking');
      const statusEl = document.getElementById('podcastStatus');
      if (statusEl) statusEl.textContent = '🔊 AI speaking...';

      state.podcastAudio = new Audio(spoken);
      state.podcastAudio.onended = () => {
        state.podcastAudio = null;
        if (podcastStateFixed.active && !podcastStateFixed.paused) {
          const statusEl2 = document.getElementById('podcastStatus');
          if (statusEl2) statusEl2.textContent = '🎤 Listening...';
          startSpeechRecognitionFixed();
        }
      };
      
      await state.podcastAudio.play();
    } catch (e) {
      console.warn('Audio playback failed', e);
      if (podcastStateFixed.active && !podcastStateFixed.paused) {
        startSpeechRecognitionFixed();
      }
    }
  }

  if (Date.now() - podcastStateFixed.startTime >= 120000) {
    appendPodcastMessageFixed('assistant', "This was a great session! Keep going through the page, and I'll be here when you want the next discussion.");
    stopAIPodcastFixed();
    return;
  }

  if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
    startSpeechRecognitionFixed();
  }
}

function appendPodcastMessageFixed(role, text) {
  podcastStateFixed.history.push({ role, text, timestamp: Date.now() });
}

async function queryAIPodcastFixed(prompt) {
  console.debug('Querying AI podcast, prompt length:', prompt?.length);
  try {
    const response = await fetch(getApiUrl('/api/groq'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.choices?.[0]?.text || data.output?.[0]?.content || null;
  } catch (err) {
    console.error('Podcast AI error:', err);
    return null;
  }
}

function showPodcastModalFixed() {
  let modal = document.getElementById('podcastModalOverlay');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'podcastModalOverlay';
    modal.className = 'modal-overlay active';
    modal.innerHTML = `
      <div class="modal podcast-modal">
        <button class="modal-close" id="closePodcastBtn">✕</button>
        <h2 class="modal-title">🎙 AI Voice Companion</h2>
        <div class="podcast-status" id="podcastStatus">Initializing...</div>
        <div class="podcast-wave" id="podcastWave" aria-hidden="true">
          <div class="wave-bar"></div>
          <div class="wave-bar"></div>
          <div class="wave-bar"></div>
          <div class="wave-bar"></div>
          <div class="wave-bar"></div>
        </div>
        <div class="podcast-controls" style="display:flex; gap:10px; justify-content:center; margin-top:14px;">
          <button class="control-btn primary" id="podcastStartBtn">Start</button>
          <button class="control-btn" id="podcastPauseBtn">Pause</button>
          <button class="control-btn" id="podcastEndBtn">End</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    document.getElementById('closePodcastBtn').addEventListener('click', stopAIPodcastFixed);
    document.getElementById('podcastEndBtn').addEventListener('click', stopAIPodcastFixed);
    document.getElementById('podcastPauseBtn').addEventListener('click', togglePausePodcastFixed);
    document.getElementById('podcastStartBtn').addEventListener('click', () => {
      if (!podcastStateFixed.active) startAIPodcastFixed();
      else if (podcastStateFixed.paused) togglePausePodcastFixed();
    });
  } else {
    modal.classList.add('active');
  }
}

function promptPodcastResponse() {
  // Voice-only podcast
}

// ==================== NAVIGATION EVENTS ====================
function openChapterModal() {
  const modal = document.getElementById('chapterModal');
  if (modal) modal.classList.add('active');
}

function closeChapterModal() {
  const modal = document.getElementById('chapterModal');
  if (modal) modal.classList.remove('active');
}

document.getElementById('chapterBtn').addEventListener('click', openChapterModal);
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

// ==================== RECORDING BUTTON ====================
function openRecordingPrompt() {
  // Add recording prompt modal if needed
  startRecordingFixed();
}

function closeRecordingPrompt() {
  // Close recording prompt modal if needed
}

// Create recording button handler - needs to be added to HTML
if (document.getElementById('recordToggleBtn')) {
  document.getElementById('recordToggleBtn').addEventListener('click', () => {
    if (podcastStateFixed.active) {
      stopAIPodcastFixed();
    } else {
      startAIPodcastFixed();
    }
  });
}

// ==================== DARK MODE ====================
document.getElementById('darkModeToggle').addEventListener('click', () => {
  document.body.classList.toggle('dark');
  const isDark = document.body.classList.contains('dark');
  document.getElementById('darkModeToggle').textContent = isDark ? '☀️' : '🌙';
  showToast(isDark ? '🌙 Dark mode enabled' : '☀️ Light mode enabled', 'info');
});

// ==================== KEYBOARD SHORTCUTS ====================
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    document.getElementById('prevBtn').click();
  }
  if (e.ctrlKey && e.key === 'ArrowRight') {
    e.preventDefault();
    document.getElementById('nextBtn').click();
  }
  
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach(modal => {
      modal.classList.remove('active');
    });
  }
  
  if (e.ctrlKey && e.key === 'f') {
    e.preventDefault();
    const search = prompt('Search in document:');
    if (search) {
      findInPage(search);
    }
  }
});

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

document.querySelectorAll('.modal-overlay').forEach(modal => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.remove('active');
    }
  });
});

document.getElementById('videoPlaybackModal').addEventListener('click', (e) => {
  if (e.target.id === 'videoPlaybackModal') closeVideoModal();
});

console.log('✅ Reader.js loaded with fixed voice conversation');