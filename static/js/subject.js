/* ── subject.js (SaaS Cloud-Ready + Robust Markdown Parsing) ── */

const SUBJECT_ID = document.querySelector('.page-subject').dataset.subject;
let appData      = null;
let flashcards   = [];
let currentCard  = 0;
let examData     = null;
let examConfig   = { questions: 3, difficulty: 'mixed' };
let chatHistory  = [];
let examStartTime = null;
let timerInterval = null;
let progressChart = null;

const STORAGE_KEY = `flashcards_sm2_${SUBJECT_ID}`;

// ── Renderizado ───────────────────────────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return '';
  if (typeof marked !== 'undefined') return marked.parse(text);
  return text.replace(/\n/g, '<br>');
}

function renderMath() {
  if (typeof renderMathInElement !== 'undefined') {
    renderMathInElement(document.body, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$',  right: '$',  display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true }
      ],
      // Se elimina 'code' de los ignoredTags para que KaTeX procese fórmulas de la IA
      ignoredTags: ["script", "noscript", "style", "textarea", "pre"], 
      throwOnError: false
    });
  }
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Gestión del Onboarding Drag & Drop ────────────────────────────────────────
const dropzone  = document.getElementById('upload-dropzone');
const fileInput = document.getElementById('file-input');
const btnCloud  = document.getElementById('btn-cloud-analyze');
const filesList = document.getElementById('selected-files-list');
let filesToUpload = [];

if (dropzone && fileInput) {
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, e => { e.preventDefault(); e.stopPropagation(); }, false);
  });

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, () => dropzone.style.borderColor = 'var(--accent)', false);
  });
  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, () => dropzone.style.borderColor = 'var(--border-2)', false);
  });

  dropzone.addEventListener('drop', e => { handleFiles(e.dataTransfer.files); });
  fileInput.addEventListener('change', e => { handleFiles(e.target.files); });
}

function handleFiles(files) {
  filesToUpload = Array.from(files).filter(f => f.type === 'application/pdf');
  
  if (filesToUpload.length > 0) {
    filesList.innerHTML = `<p style="color:var(--green)">✓ ${filesToUpload.length} examen(es) listo(s) para procesar</p>`;
    filesList.classList.remove('hidden');
    if(btnCloud) btnCloud.disabled = false;
  } else {
    filesList.innerHTML = `<p style="color:var(--red)">Error: Sube únicamente archivos PDF.</p>`;
    filesList.classList.remove('hidden');
    if(btnCloud) btnCloud.disabled = true;
  }
}

if (btnCloud) {
  btnCloud.addEventListener('click', async () => {
    if (filesToUpload.length === 0) return;
    
    setAnalyzing(true);
    const formData = new FormData();
    filesToUpload.forEach(file => formData.append('files', file));

    try {
      const res = await fetch(`/api/analyze/${SUBJECT_ID}`, {
        method: 'POST',
        body: formData
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Fallo en el servidor');
      
      appData = json.data;
      const onboardingEl = document.getElementById('onboarding-state');
      if (onboardingEl) onboardingEl.classList.add('hidden');
      renderAll();
    } catch (e) {
      alert(`Error procesando: ${e.message}`);
    } finally {
      setAnalyzing(false);
    }
  });
}

// ── Tabs y Carga Inicial ──────────────────────────────────────────────────────
function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('tab--active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
  const tabEl = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (tabEl) tabEl.classList.add('tab--active');
  const contentEl = document.getElementById(`tab-${tabName}`);
  if (contentEl) contentEl.classList.remove('hidden');

  if (tabName === 'chat') {
    const nameEl = document.getElementById('chat-subject-name');
    if (nameEl) nameEl.textContent = SUBJECT_ID.toUpperCase();
  }
  if (tabName === 'progress') {
    loadProgress();
  }
  setTimeout(renderMath, 50);
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

function setAnalyzing(active) {
  const analyzingEl  = document.getElementById('analyzing-state');
  const mainEl       = document.getElementById('main-content');
  const onboardingEl = document.getElementById('onboarding-state');
  if (analyzingEl) analyzingEl.classList.toggle('hidden', !active);
  if (mainEl)      mainEl.classList.toggle('hidden', active);
  if (onboardingEl && active) onboardingEl.classList.add('hidden');
}

(async () => {
  try {
    const res = await fetch(`/api/cache/${SUBJECT_ID}`);
    if (res.ok) {
      const json = await res.json();
      if (json.success) { 
        appData = json.data; 
        const onboardingEl = document.getElementById('onboarding-state');
        if (onboardingEl) onboardingEl.classList.add('hidden');
        renderAll(); 
      }
    }
  } catch (_) {}
})();

function renderAll() {
  const mainEl  = document.getElementById('main-content');
  if (mainEl)  mainEl.classList.remove('hidden');
  renderPatterns();
  renderCheatSheet();
}

// ── Patrones (Markdown Robusto) ───────────────────────────────────────────────
function renderPatterns() {
  if (!appData) return;
  const { patterns, study_tips } = appData;

  const avgFreq    = Math.round(patterns.reduce((a, p) => a + p.frequency, 0) / patterns.length);
  const topPattern = patterns.reduce((a, b) => a.frequency > b.frequency ? a : b) || patterns[0];

  document.getElementById('patterns-summary').innerHTML = `
    <div class="summary-card"><div class="summary-card__label">Patrones detectados</div><div class="summary-card__value" style="color:var(--accent)">${patterns.length}</div></div>
    <div class="summary-card"><div class="summary-card__label">Frecuencia media</div><div class="summary-card__value">${avgFreq}%</div></div>
    <div class="summary-card"><div class="summary-card__label">Patrón #1</div><div class="summary-card__value" style="font-size:1rem;color:var(--green)">${topPattern.title}</div></div>
    <div class="summary-card"><div class="summary-card__label">Más frecuente</div><div class="summary-card__value" style="color:var(--green)">${topPattern.frequency}%</div></div>`;

  document.getElementById('patterns-list').innerHTML = patterns.map((p, i) => {
    const freqClass = p.frequency >= 70 ? 'high' : p.frequency >= 40 ? 'medium' : 'low';
    const concepts  = (p.key_concepts || []).map(c => `<span class="concept-tag">${esc(c)}</span>`).join('');
    
    const desc      = renderMarkdown(p.description || 'Sin descripción detallada.');
    const howTo     = renderMarkdown(p.how_to_answer || 'No se generó estrategia de respuesta.');
    const example   = renderMarkdown(p.example_question || 'No se extrajo pregunta de ejemplo.');
    const mistakes  = (p.common_mistakes || []).map(m => `<li>${renderMarkdown(m)}</li>`).join('');

    return `
    <div class="pattern-card">
      <div class="pattern-card__header" onclick="togglePattern(${i})">
        <div class="pattern-card__left">
          <span class="pattern-num">${String(i+1).padStart(2,'0')}</span>
          <span class="pattern-title">${esc(p.title)}</span>
        </div>
        <span class="pattern-freq freq--${freqClass}">${p.frequency}%</span>
        <span class="pattern-difficulty">${esc(p.difficulty || '')}</span>
        <span class="pattern-toggle" id="toggle-${i}">▾</span>
      </div>
      <div class="pattern-card__body" id="body-${i}">
        <div class="pattern-section">
          <div class="pattern-section-label">Descripción</div>
          <div class="pattern-desc">${desc}</div>
        </div>
        ${concepts ? `<div class="pattern-section"><div class="pattern-section-label">Conceptos clave</div><div class="concepts-list">${concepts}</div></div>` : ''}
        <div class="pattern-section">
          <div class="pattern-section-label">Cómo responderlo</div>
          <div class="how-to-box" style="color:var(--text);">${howTo}</div>
        </div>
        ${mistakes ? `<div class="pattern-section"><div class="pattern-section-label">Errores comunes</div><ul class="mistakes-list">${mistakes}</ul></div>` : ''}
        <div class="pattern-section">
          <div class="pattern-section-label">Pregunta típica de examen</div>
          <div class="example-box" style="color:var(--text);">${example}</div>
        </div>
      </div>
    </div>`;
  }).join('');

  if (study_tips && study_tips.length) {
    document.getElementById('study-tips').innerHTML = `<div class="study-tips"><h3>Estrategia de estudio</h3><ul class="tips-list">${study_tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>`;
  }
  renderMath();
}

window.togglePattern = function(i) {
  document.getElementById(`body-${i}`).classList.toggle('open');
  document.getElementById(`toggle-${i}`).classList.toggle('open');
}

// ── Cheat Sheet (Protección de fallback) ──────────────────────────────────────
function renderCheatSheet() {
  const contentEl = document.getElementById('cheatsheet-content');
  if (!appData || !appData.cheat_sheet) {
    contentEl.innerHTML = '<div style="text-align:center; padding: 2rem; color: var(--text-2);">El modelo no incluyó la Cheat Sheet en este análisis. Vuelve a analizar los documentos.</div>';
    return;
  }
  contentEl.innerHTML = renderMarkdown(appData.cheat_sheet);
  renderMath();
}

// ── Flashcards ────────────────────────────────────────────────────────────────
const btnGenCards = document.getElementById('btn-generate-cards');
if (btnGenCards) btnGenCards.addEventListener('click', generateFlashcards);

async function generateFlashcards() {
  document.getElementById('flashcards-empty').classList.add('hidden');
  document.getElementById('flashcards-loading').classList.remove('hidden');
  try {
    const res  = await fetch(`/api/flashcards/${SUBJECT_ID}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    flashcards  = json.flashcards;
    currentCard = 0;
    renderFlashcard();
    document.getElementById('flashcards-container').classList.remove('hidden');
  } catch (e) {
    alert(`Error: ${e.message}`);
    document.getElementById('flashcards-empty').classList.remove('hidden');
  } finally {
    document.getElementById('flashcards-loading').classList.add('hidden');
  }
}

function renderFlashcard() {
  if (!flashcards || !flashcards.length) return;

  if (currentCard >= flashcards.length) {
    document.getElementById('card-front').innerHTML  = '<h3>¡Sesión completada!</h3>';
    document.getElementById('card-back').innerHTML   = '<p>Has repasado todas las tarjetas. Vuelve mañana para aprovechar el efecto del espaciado.</p>';
    document.getElementById('flashcard-inner').classList.remove('flipped');
    document.getElementById('cards-verdict').classList.add('hidden');
    document.getElementById('flashcards-controls').classList.add('hidden');
    document.getElementById('card-category').textContent  = 'Fin';
    document.getElementById('card-difficulty').textContent = '';
    return;
  }

  const card = flashcards[currentCard];
  document.getElementById('card-front').innerHTML  = renderMarkdown(card.front);
  document.getElementById('card-back').innerHTML   = renderMarkdown(card.back);
  document.getElementById('card-category').textContent = card.category || '';

  const diffBadge = document.getElementById('card-difficulty');
  diffBadge.textContent = card.difficulty || '';
  diffBadge.className   = `difficulty-badge diff--${card.difficulty}`;

  document.getElementById('flashcard-inner').classList.remove('flipped');
  document.getElementById('cards-verdict').classList.add('hidden');
  document.getElementById('flashcards-controls').classList.remove('hidden');
  document.getElementById('cards-progress').textContent    = `${currentCard + 1} / ${flashcards.length}`;
  document.getElementById('progress-fill').style.width     = `${((currentCard + 1) / flashcards.length) * 100}%`;
  renderMath();
}

const btnFlip = document.getElementById('btn-card-flip');
if (btnFlip) btnFlip.addEventListener('click', () => {
  document.getElementById('flashcard-inner').classList.toggle('flipped');
  document.getElementById('cards-verdict').classList.remove('hidden');
  document.getElementById('flashcards-controls').classList.add('hidden');
});

const btnPrev = document.getElementById('btn-card-prev');
const btnNext = document.getElementById('btn-card-next');
if (btnPrev) btnPrev.addEventListener('click', () => { if (currentCard > 0) { currentCard--; renderFlashcard(); } });
if (btnNext) btnNext.addEventListener('click', () => { if (currentCard < flashcards.length - 1) { currentCard++; renderFlashcard(); } });

window.rateCard = function(quality) {
  if (typeof currentCard === 'undefined' || !flashcards || currentCard >= flashcards.length) return;
  const card        = flashcards[currentCard];
  const storageData = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  const uniqueId    = card.id || btoa(unescape(encodeURIComponent(card.front.slice(0, 20))));
  let cardStats     = storageData[uniqueId] || { repetitions: 0, interval: 1, efactor: 2.5, nextDate: Date.now() };

  if (quality < 3) {
    cardStats.repetitions = 0;
    cardStats.interval    = 1;
  } else {
    cardStats.interval = cardStats.repetitions === 0 ? 1 :
                         cardStats.repetitions === 1 ? 6 :
                         Math.round(cardStats.interval * cardStats.efactor);
    cardStats.repetitions++;
  }
  cardStats.efactor = Math.max(1.3, cardStats.efactor + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  const next = new Date();
  next.setDate(next.getDate() + cardStats.interval);
  cardStats.nextDate = next.getTime();

  storageData[uniqueId] = cardStats;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(storageData));

  const rating = quality <= 1 ? 'hard' : quality <= 3 ? 'medium' : 'easy';
  fetch('/api/flashcards/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject_id: SUBJECT_ID, card_id: card.id || currentCard, rating })
  }).catch(() => {});

  currentCard++;
  renderFlashcard();
};

// ── Exam ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.config-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.key;
    document.querySelectorAll(`.config-btn[data-key="${key}"]`).forEach(b => b.classList.remove('config-btn--active'));
    btn.classList.add('config-btn--active');
    examConfig[key === 'questions' ? 'questions' : 'difficulty'] =
      key === 'questions' ? parseInt(btn.dataset.val) : btn.dataset.val;
  });
});

const btnStartExam = document.getElementById('btn-start-exam');
if (btnStartExam) btnStartExam.addEventListener('click', startExam);

async function startExam() {
  document.getElementById('exam-setup').classList.add('hidden');
  document.getElementById('exam-loading').classList.remove('hidden');
  try {
    const res  = await fetch(`/api/exam/generate/${SUBJECT_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ difficulty: examConfig.difficulty, n_questions: examConfig.questions })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    examData = json.exam;
    renderExam();
  } catch (e) {
    alert(`Error generando examen: ${e.message}`);
    document.getElementById('exam-setup').classList.remove('hidden');
  } finally {
    document.getElementById('exam-loading').classList.add('hidden');
  }
}

function renderExam() {
  document.getElementById('exam-title').textContent = examData.exam_title;
  examStartTime = Date.now();
  startTimer(examData.duration_minutes * 60);

  const qs = examData.questions.map((q, i) => `
    <div class="exam-question" data-id="${q.id}">
      <div class="exam-question__header">
        <span class="exam-question__num">PREGUNTA ${i + 1} · ${esc(q.type || '')}</span>
        <span class="exam-question__points">${q.points} pts</span>
      </div>
      <div class="exam-question__text">${renderMarkdown(q.text)}</div>
      <button class="hint-toggle" onclick="toggleHint(${i})">💡 Ver pista</button>
      <div class="exam-question__hint" id="hint-${i}">${renderMarkdown(q.hint || '')}</div>
      <textarea placeholder="Escribe tu respuesta aquí..." id="answer-${q.id}"></textarea>
    </div>`).join('');

  document.getElementById('exam-questions').innerHTML = qs;
  document.getElementById('exam-active').classList.remove('hidden');
  renderMath();
}

window.toggleHint = function(i) {
  const hint = document.getElementById(`hint-${i}`);
  hint.style.display = hint.style.display === 'block' ? 'none' : 'block';
};

function startTimer(seconds) {
  clearInterval(timerInterval);
  const el = document.getElementById('exam-timer');
  timerInterval = setInterval(() => {
    seconds--;
    const m = Math.floor(seconds / 60), s = seconds % 60;
    el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    if (seconds <= 0) { clearInterval(timerInterval); el.textContent = '00:00'; }
  }, 1000);
}

const btnSubmit = document.getElementById('btn-submit-exam');
if (btnSubmit) btnSubmit.addEventListener('click', submitExam);

async function submitExam() {
  clearInterval(timerInterval);
  if (!confirm('¿Entregar el examen? No podrás modificar tus respuestas.')) return;

  const questions = examData.questions.map(q => ({
    question_text:    q.text,
    model_answer:     q.model_answer,
    user_answer:      document.getElementById(`answer-${q.id}`)?.value || '',
    points:           q.points,
    grading_criteria: q.grading_criteria || []
  }));

  document.getElementById('exam-active').classList.add('hidden');
  document.getElementById('exam-loading').classList.remove('hidden');

  try {
    const res  = await fetch('/api/exam/grade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject_id: SUBJECT_ID, questions })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    renderResults(json.result, questions);
  } catch (e) {
    alert(`Error corrigiendo: ${e.message}`);
    document.getElementById('exam-active').classList.remove('hidden');
  } finally {
    document.getElementById('exam-loading').classList.add('hidden');
  }
}

function renderResults(result, questions) {
  const pct   = result.total_score / result.max_score;
  const color = pct >= 0.7 ? 'var(--green)' : pct >= 0.5 ? 'var(--amber)' : 'var(--red)';

  document.getElementById('results-score-value').textContent   = result.total_score;
  document.getElementById('results-score-value').style.color   = color;
  document.getElementById('results-grade').textContent         = result.grade || '';
  document.getElementById('results-grade').style.color         = color;
  document.getElementById('results-global-feedback').textContent = result.global_feedback || '';

  const html = (result.results || []).map((r, i) => {
    const q   = questions[i] || {};
    const pct = r.score / r.max_score;
    const cls = pct >= 0.8 ? 'good' : pct >= 0.5 ? 'mid' : 'bad';
    return `
    <div class="result-question">
      <div class="result-question__header">
        <span>Pregunta ${r.question_id}</span>
        <span class="result-score--${cls}">${r.score} / ${r.max_score} pts</span>
      </div>
      ${q.question_text ? `<div class="result-text" style="margin-bottom:.75rem;color:var(--text)">${renderMarkdown(q.question_text)}</div>` : ''}
      <div class="result-label">Tu respuesta</div>
      <div class="result-text">${esc(q.user_answer || '[Sin responder]')}</div>
      <div class="result-label">Feedback</div>
      <div class="result-text">${esc(r.feedback || '')}</div>
      ${r.correct_approach ? `<div class="result-label">Cómo debería responderse</div><div class="result-text">${esc(r.correct_approach)}</div>` : ''}
    </div>`;
  }).join('');

  document.getElementById('results-questions').innerHTML = html;
  document.getElementById('exam-results').classList.remove('hidden');
  renderMath();
}

window.resetExam = function() {
  examData = null;
  document.getElementById('exam-results').classList.add('hidden');
  document.getElementById('exam-questions').innerHTML = '';
  document.getElementById('exam-setup').classList.remove('hidden');
};

// ── Chat ──────────────────────────────────────────────────────────────────────
const chatInput = document.getElementById('chat-input');
const btnSend   = document.getElementById('btn-send-chat');

if (btnSend)   btnSend.addEventListener('click', sendMessage);
if (chatInput) chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

async function sendMessage() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  chatInput.value = '';

  const historyForApi = chatHistory.slice(-6).map(m => ({
    role: m.role === 'assistant' ? 'model' : m.role,
    content: m.content
  }));

  appendMessage('user', msg);
  chatHistory.push({ role: 'user', content: msg });

  const bubble = appendMessage('ai', '');
  bubble.classList.add('streaming');
  btnSend.disabled = true;

  try {
    const res = await fetch(`/api/chat/${SUBJECT_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, history: historyForApi })
    });
    if (!res.ok) throw new Error(`Error en servidor (Código ${res.status}).`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText  = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') break;
        try {
          const obj = JSON.parse(payload);
          if (obj.error) throw new Error(obj.error);
          if (obj.text) {
            fullText += obj.text;
            bubble.innerHTML = renderMarkdown(fullText);
            renderMath();
            scrollChatToBottom();
          }
        } catch (err) {
          if (err.name !== 'SyntaxError') throw err;
        }
      }
    }
    chatHistory.push({ role: 'model', content: fullText });
  } catch (e) {
    bubble.textContent = `Error: ${e.message}`;
    chatHistory.pop();
  } finally {
    bubble.classList.remove('streaming');
    btnSend.disabled = false;
    chatInput.focus();
  }
}

function appendMessage(role, text) {
  const messages = document.getElementById('chat-messages');
  const div      = document.createElement('div');
  div.className  = `chat-message chat-message--${role}`;
  const bubble   = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.innerHTML = text ? renderMarkdown(text) : '';
  div.appendChild(bubble);
  messages.appendChild(div);
  scrollChatToBottom();
  return bubble;
}

function scrollChatToBottom() {
  const messages = document.getElementById('chat-messages');
  messages.scrollTop = messages.scrollHeight;
}

// ── Progreso ──────────────────────────────────────────────────────────────────
async function loadProgress() {
  const loadingEl = document.getElementById('progress-loading');
  const contentEl = document.getElementById('progress-content');
  if (!loadingEl || !contentEl) return;

  loadingEl.classList.remove('hidden');
  contentEl.classList.add('hidden');

  try {
    const res  = await fetch(`/api/stats/${SUBJECT_ID}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    renderProgress(json.stats);
  } catch (e) {
    if (loadingEl) loadingEl.innerHTML = `<p style="color:var(--red)">Error: ${e.message}</p>`;
  } finally {
    loadingEl.classList.add('hidden');
    contentEl.classList.remove('hidden');
  }
}

function renderProgress(stats) {
  const totalExams = stats.total_exams || 0;
  const avgScore   = stats.avg_score   || null;
  const history    = stats.exam_history || [];
  const lastScore  = history.length ? (history[history.length - 1].total_score / history[history.length - 1].max_score * 10).toFixed(1) : null;
  const fcStats    = stats.flashcards  || {};
  const fcTotal    = Object.values(fcStats).reduce((a, b) => a + b, 0);

  document.getElementById('progress-kpis').innerHTML = `
    <div class="kpi-card">
      <div class="kpi-value" style="color:var(--accent)">${totalExams}</div>
      <div class="kpi-label">Simulacros realizados</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value" style="color:${avgScore >= 5 ? 'var(--green)' : 'var(--red)'}">${avgScore !== null ? avgScore.toFixed(1) : '—'}</div>
      <div class="kpi-label">Nota media</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value" style="color:var(--text)">${lastScore !== null ? lastScore : '—'}</div>
      <div class="kpi-label">Último simulacro</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value" style="color:var(--green)">${fcTotal}</div>
      <div class="kpi-label">Flashcards valoradas</div>
    </div>`;

  const chartWrap  = document.getElementById('progress-chart-wrap');
  const chartEmpty = document.getElementById('progress-chart-empty');

  if (!history.length) {
    chartEmpty.classList.remove('hidden');
    chartWrap.classList.add('hidden');
  } else {
    chartEmpty.classList.add('hidden');
    chartWrap.classList.remove('hidden');

    const labels = history.map((r, i) => `#${i + 1}`);
    const scores = history.map(r => parseFloat((r.total_score / r.max_score * 10).toFixed(2)));
    const grades = history.map(r => r.grade);

    if (progressChart) progressChart.destroy();

    const ctx = document.getElementById('progress-chart').getContext('2d');
    progressChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Nota (sobre 10)',
          data: scores,
          borderColor: '#4f8ef7',
          backgroundColor: 'rgba(79,142,247,0.12)',
          pointBackgroundColor: scores.map(s => s >= 7 ? '#34d399' : s >= 5 ? '#fbbf24' : '#f87171'),
          pointRadius: 6,
          pointHoverRadius: 8,
          tension: 0.3,
          fill: true,
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => `Nota: ${ctx.parsed.y} — ${grades[ctx.dataIndex]}`
            }
          }
        },
        scales: {
          y: {
            min: 0, max: 10,
            grid:  { color: 'rgba(255,255,255,0.06)' },
            ticks: { color: '#9ca3af' }
          },
          x: {
            grid:  { color: 'rgba(255,255,255,0.06)' },
            ticks: { color: '#9ca3af' }
          }
        }
      }
    });
  }

  const fcBarsEl  = document.getElementById('progress-fc-bars');
  const fcEmptyEl = document.getElementById('progress-fc-empty');

  if (!fcTotal) {
    fcEmptyEl.classList.remove('hidden');
    fcBarsEl.classList.add('hidden');
  } else {
    fcEmptyEl.classList.add('hidden');
    fcBarsEl.classList.remove('hidden');

    const labels = { easy: 'Fácil', medium: 'Media', hard: 'Difícil' };
    const colors = { easy: 'var(--green)', medium: 'var(--amber)', hard: 'var(--red)' };

    fcBarsEl.innerHTML = ['easy', 'medium', 'hard'].map(rating => {
      const count = fcStats[rating] || 0;
      const pct   = fcTotal ? Math.round(count / fcTotal * 100) : 0;
      return `
        <div class="fc-bar-row">
          <span class="fc-bar-label" style="color:${colors[rating]}">${labels[rating]}</span>
          <div class="fc-bar-track">
            <div class="fc-bar-fill" style="width:${pct}%;background:${colors[rating]}"></div>
          </div>
          <span class="fc-bar-count">${count}</span>
        </div>`;
    }).join('');
  }
}
