/**
 * subject.js — Academia Personal FIB
 * Lógica completa de la página de asignatura:
 * upload, análisis, patrones, cheat-sheet, flashcards, simulacro, chat, progreso
 */

// ─── Globals ──────────────────────────────────────────────────────────────────
const SUBJECT_ID = document.getElementById('subject-data')?.dataset?.subject || '';
let currentExam     = null;
let examTimerInterval = null;
let examSecondsLeft = 0;
let flashcards      = [];
let currentCardIdx  = 0;
let chatHistory     = [];
let progressChart   = null;
let examConfig      = { questions: 3, difficulty: 'mixed' };
let selectedFiles   = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function show(id)  { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
function hide(id)  { const el = document.getElementById(id); if (el) el.classList.add('hidden'); }
function setText(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; }
function setHTML(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }

/** Render markdown + LaTeX safely */
function renderMD(text) {
  if (!text) return '';
  let html = '';
  if (typeof marked !== 'undefined') {
    html = marked.parse(text);
  } else {
    // Fallback: use app.js renderMarkdown if available
    html = typeof renderMarkdown === 'function' ? renderMarkdown(text) : text;
  }
  return html;
}

/** Re-render KaTeX after injecting HTML */
function renderKatex(el) {
  if (typeof renderMathInElement === 'function') {
    renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
      ],
      throwOnError: false,
    });
  }
}

function showError(msg) {
  alert('Error: ' + msg);
  console.error(msg);
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('tab--active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));

  const btn = document.querySelector(`.tab[data-tab="${name}"]`);
  const content = document.getElementById(`tab-${name}`);
  if (btn) btn.classList.add('tab--active');
  if (content) content.classList.remove('hidden');

  // Lazy-load progress tab
  if (name === 'progress') loadProgress();
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// ─── File Upload ──────────────────────────────────────────────────────────────

const fileInput    = document.getElementById('file-input');
const dropzone     = document.getElementById('upload-dropzone');
const filesList    = document.getElementById('selected-files-list');
const analyzeBtn   = document.getElementById('btn-cloud-analyze');

if (fileInput) {
  fileInput.addEventListener('change', e => {
    selectedFiles = Array.from(e.target.files);
    updateFilesList();
  });
}

if (dropzone) {
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    selectedFiles = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.pdf'));
    updateFilesList();
  });
}

function updateFilesList() {
  if (!filesList) return;
  if (selectedFiles.length === 0) {
    filesList.classList.add('hidden');
    if (analyzeBtn) analyzeBtn.disabled = true;
    return;
  }
  filesList.classList.remove('hidden');
  filesList.innerHTML = selectedFiles.map((f, i) => `
    <div class="upload-file-item">
      <span class="upload-file-item__name">📄 ${f.name}</span>
      <span class="upload-file-item__status" style="color:var(--text-3)">${(f.size/1024).toFixed(0)} KB</span>
    </div>
  `).join('');
  if (analyzeBtn) analyzeBtn.disabled = false;
}

if (analyzeBtn) {
  analyzeBtn.addEventListener('click', async () => {
    if (selectedFiles.length === 0) return;

    // Show analyzing state
    hide('onboarding-state');
    show('analyzing-state');
    analyzeBtn.disabled = true;

    const formData = new FormData();
    selectedFiles.forEach(f => formData.append('files', f));

    try {
      const res  = await fetch(`/api/analyze/${SUBJECT_ID}`, { method: 'POST', body: formData });
      const json = await res.json();

      if (!res.ok || json.error) throw new Error(json.error || 'Error desconocido');

      hide('analyzing-state');
      show('main-content');
      renderPatterns(json.data);
    } catch (err) {
      hide('analyzing-state');
      show('onboarding-state');
      analyzeBtn.disabled = false;
      showError(err.message);
    }
  });
}

// ─── Load Cache (if subject already analyzed) ─────────────────────────────────

async function loadCacheIfReady() {
  try {
    const res  = await fetch(`/api/cache/${SUBJECT_ID}`);
    const json = await res.json();
    if (json.success && json.data) {
      hide('onboarding-state');
      show('main-content');
      renderPatterns(json.data);
    }
  } catch (err) {
    console.warn('No cache found:', err);
  }
}

// ─── Patterns Tab ─────────────────────────────────────────────────────────────

function renderPatterns(data) {
  // Set subject name in chat tab
  setText('chat-subject-name', data.subject || SUBJECT_ID.toUpperCase());

  const patterns = data.patterns || [];

  // Summary cards
  const summaryEl = document.getElementById('patterns-summary');
  if (summaryEl) {
    summaryEl.innerHTML = `
      <div class="summary-card">
        <div class="summary-card__label">Patrones detectados</div>
        <div class="summary-card__value">${patterns.length}</div>
      </div>
      <div class="summary-card">
        <div class="summary-card__label">Frecuencia media</div>
        <div class="summary-card__value">${patterns.length ? Math.round(patterns.reduce((s,p)=>s+p.frequency,0)/patterns.length) : 0}%</div>
      </div>
      <div class="summary-card">
        <div class="summary-card__label">Alta dificultad</div>
        <div class="summary-card__value">${patterns.filter(p=>p.difficulty==='Alta'||p.difficulty==='Difícil').length}</div>
      </div>
    `;
  }

  // Pattern cards
  const listEl = document.getElementById('patterns-list');
  if (listEl) {
    listEl.innerHTML = patterns.map((p, i) => {
      const freqClass = p.frequency >= 70 ? 'freq--high' : p.frequency >= 40 ? 'freq--medium' : 'freq--low';
      const concepts  = (p.key_concepts || []).map(c => `<span class="concept-tag">${c}</span>`).join('');
      const mistakes  = (p.common_mistakes || []).map(m => `<li>${m}</li>`).join('');
      return `
        <div class="pattern-card">
          <div class="pattern-card__header" onclick="togglePattern(this)">
            <div class="pattern-card__left">
              <span class="pattern-num">#${String(i+1).padStart(2,'0')}</span>
              <span class="pattern-title">${p.title || 'Sin título'}</span>
            </div>
            <span class="pattern-freq ${freqClass}">${p.frequency}%</span>
            <span class="pattern-difficulty">${p.difficulty || ''}</span>
            <span class="pattern-toggle">▾</span>
          </div>
          <div class="pattern-card__body">
            <div class="pattern-section">
              <div class="pattern-section-label">Descripción</div>
              <div class="pattern-desc">${p.description || ''}</div>
            </div>
            ${concepts ? `<div class="pattern-section"><div class="pattern-section-label">Conceptos clave</div><div class="concepts-list">${concepts}</div></div>` : ''}
            ${p.how_to_answer ? `<div class="pattern-section"><div class="pattern-section-label">Cómo responder</div><div class="how-to-box">${p.how_to_answer}</div></div>` : ''}
            ${mistakes ? `<div class="pattern-section"><div class="pattern-section-label">Errores frecuentes</div><ul class="mistakes-list">${mistakes}</ul></div>` : ''}
            ${p.example_question ? `<div class="pattern-section"><div class="pattern-section-label">Ejemplo de pregunta</div><div class="example-box">${p.example_question}</div></div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    // Render math in patterns
    renderKatex(listEl);
  }

  // Cheat sheet
  const cheatEl = document.getElementById('cheatsheet-content');
  if (cheatEl) {
    if (data.cheat_sheet && data.cheat_sheet.trim().length > 10) {
      cheatEl.innerHTML = renderMD(data.cheat_sheet);
      renderKatex(cheatEl);
    } else {
      cheatEl.innerHTML = '<p style="text-align:center; padding: 2.5rem; color: var(--amber);">⚠️ La IA no ha podido generar la Cheat Sheet completa por límite de contexto. Por favor, vuelve a la pestaña de Asignaturas y analiza los documentos de nuevo.</p>';
    }
  }

  // Study tips
  const tipsEl = document.getElementById('study-tips');
  if (tipsEl) {
    if (data.study_tips && data.study_tips.length > 0) {
      tipsEl.style.display = 'block';
      tipsEl.innerHTML = `
        <h3>Consejos de estudio</h3>
        <ul class="tips-list">
          ${data.study_tips.map(t => `<li>${t}</li>`).join('')}
        </ul>
      `;
    } else {
      tipsEl.style.display = 'none';
    }
  }
}

function togglePattern(header) {
  const body   = header.nextElementSibling;
  const toggle = header.querySelector('.pattern-toggle');
  const open   = body.classList.toggle('open');
  if (toggle) toggle.classList.toggle('open', open);
}

// ─── Flashcards ───────────────────────────────────────────────────────────────

const btnGenCards = document.getElementById('btn-generate-cards');
if (btnGenCards) btnGenCards.addEventListener('click', generateFlashcards);

async function generateFlashcards() {
  show('flashcards-loading');
  hide('flashcards-empty');

  try {
    const res  = await fetch(`/api/flashcards/${SUBJECT_ID}`);
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(json.error);

    flashcards    = json.flashcards || [];
    currentCardIdx = 0;
    hide('flashcards-loading');
    show('flashcards-container');
    renderCard();
  } catch (err) {
    hide('flashcards-loading');
    show('flashcards-empty');
    showError(err.message);
  }
}

function renderCard() {
  if (!flashcards.length) return;
  const card = flashcards[currentCardIdx];

  // Reset flip
  const inner = document.getElementById('flashcard-inner');
  if (inner) inner.classList.remove('flipped');

  // Content
  const frontEl = document.getElementById('card-front');
  const backEl  = document.getElementById('card-back');
  if (frontEl) { frontEl.innerHTML = renderMD(card.front || ''); renderKatex(frontEl); }
  if (backEl)  { backEl.innerHTML  = renderMD(card.back  || ''); renderKatex(backEl);  }

  setText('card-category', card.category || '');

  const diffEl = document.getElementById('card-difficulty');
  if (diffEl) {
    diffEl.textContent  = card.difficulty || '';
    diffEl.className    = `difficulty-badge diff--${card.difficulty || ''}`;
  }

  // Progress
  setText('cards-progress', `${currentCardIdx + 1} / ${flashcards.length}`);
  const fill = document.getElementById('progress-fill');
  if (fill) fill.style.width = `${((currentCardIdx + 1) / flashcards.length) * 100}%`;

  // Show verdict after flip
  hide('cards-verdict');
}

// Flip on card click
const flashcardEl = document.getElementById('flashcard');
if (flashcardEl) {
  flashcardEl.addEventListener('click', () => {
    const inner = document.getElementById('flashcard-inner');
    if (!inner) return;
    const flipped = inner.classList.toggle('flipped');
    if (flipped) show('cards-verdict');
    else hide('cards-verdict');
  });
}

document.getElementById('btn-card-flip')?.addEventListener('click', () => {
  flashcardEl?.click();
});
document.getElementById('btn-card-prev')?.addEventListener('click', () => {
  if (currentCardIdx > 0) { currentCardIdx--; renderCard(); }
});
document.getElementById('btn-card-next')?.addEventListener('click', () => {
  if (currentCardIdx < flashcards.length - 1) { currentCardIdx++; renderCard(); }
});

// FIX: rating values must be 'easy'/'medium'/'hard' strings (not numbers)
async function rateCard(rating) {
  const card = flashcards[currentCardIdx];
  if (!card) return;

  try {
    await fetch('/api/flashcards/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject_id: SUBJECT_ID, card_id: card.id, rating }),
    });
  } catch (err) {
    console.warn('Rating save failed:', err);
  }

  // Advance to next card
  if (currentCardIdx < flashcards.length - 1) {
    currentCardIdx++;
    renderCard();
  } else {
    // All cards done
    setHTML('flashcards-container', `
      <div style="text-align:center;padding:4rem 2rem;color:var(--text-2)">
        <div style="font-size:3rem;margin-bottom:1rem">🎉</div>
        <h3 style="color:var(--text);margin-bottom:.75rem">¡Repaso completado!</h3>
        <p>Has valorado las ${flashcards.length} flashcards.</p>
        <button class="btn btn--primary" style="margin-top:1.5rem" onclick="location.reload()">Repetir</button>
      </div>
    `);
  }
}

// Make rateCard global (called from inline onclick in HTML)
window.rateCard = rateCard;

// ─── Exam ─────────────────────────────────────────────────────────────────────

// Config buttons
document.querySelectorAll('.config-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.key;
    document.querySelectorAll(`.config-btn[data-key="${key}"]`).forEach(b => b.classList.remove('config-btn--active'));
    btn.classList.add('config-btn--active');
    examConfig[key === 'questions' ? 'questions' : 'difficulty'] = btn.dataset.val;
  });
});

document.getElementById('btn-start-exam')?.addEventListener('click', startExam);

async function startExam() {
  hide('exam-setup');
  show('exam-loading');

  try {
    const res  = await fetch(`/api/exam/generate/${SUBJECT_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ difficulty: examConfig.difficulty, n_questions: Number(examConfig.questions) }),
    });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(json.error);

    currentExam = json.exam;
    hide('exam-loading');
    renderExam(json.exam);
  } catch (err) {
    hide('exam-loading');
    show('exam-setup');
    showError(err.message);
  }
}

function renderExam(exam) {
  setText('exam-title', exam.exam_title || 'Simulacro');
  show('exam-active');

  // Timer
  examSecondsLeft = (exam.duration_minutes || 30) * 60;
  updateTimer();
  clearInterval(examTimerInterval);
  examTimerInterval = setInterval(() => {
    examSecondsLeft--;
    updateTimer();
    if (examSecondsLeft <= 0) { clearInterval(examTimerInterval); submitExam(); }
  }, 1000);

  // Questions
  const container = document.getElementById('exam-questions');
  if (!container) return;
  container.innerHTML = (exam.questions || []).map((q, i) => `
    <div class="exam-question" data-id="${q.id}">
      <div class="exam-question__header">
        <span class="exam-question__num">Pregunta ${i + 1} · ${q.type || ''}</span>
        <span class="exam-question__points">${q.points || 2} pts</span>
      </div>
      <div class="exam-question__text">${renderMD(q.text || '')}</div>
      ${q.hint ? `<button class="hint-toggle" onclick="toggleHint(this)">💡 Ver pista</button><div class="exam-question__hint">${q.hint}</div>` : ''}
      <textarea placeholder="Escribe tu respuesta aquí..." rows="5"></textarea>
    </div>
  `).join('');

  renderKatex(container);
}

function updateTimer() {
  const m = Math.floor(examSecondsLeft / 60);
  const s = examSecondsLeft % 60;
  setText('exam-timer', `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`);
}

function toggleHint(btn) {
  const hint = btn.nextElementSibling;
  if (!hint) return;
  const visible = hint.style.display === 'block';
  hint.style.display = visible ? 'none' : 'block';
  btn.textContent = visible ? '💡 Ver pista' : '💡 Ocultar pista';
}
window.toggleHint = toggleHint;

document.getElementById('btn-submit-exam')?.addEventListener('click', submitExam);

async function submitExam() {
  clearInterval(examTimerInterval);

  if (!currentExam) return;
  const questionEls = document.querySelectorAll('.exam-question');
  const answers = [];

  questionEls.forEach((el, i) => {
    const q = currentExam.questions[i];
    if (!q) return;
    answers.push({
      question_text:    q.text,
      model_answer:     q.model_answer,
      grading_criteria: q.grading_criteria || [],
      points:           q.points || 2,
      user_answer:      el.querySelector('textarea')?.value?.trim() || '',
    });
  });

  hide('exam-active');
  show('exam-loading');
  const loadingSpan = document.querySelector('#exam-loading span');
  if (loadingSpan) loadingSpan.textContent = 'Corrigiendo...';

  try {
    const res  = await fetch('/api/exam/grade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject_id: SUBJECT_ID, questions: answers }),
    });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(json.error);

    hide('exam-loading');
    renderResults(json.result);
  } catch (err) {
    hide('exam-loading');
    show('exam-active');
    showError(err.message);
  }
}

function renderResults(result) {
  show('exam-results');

  const scoreRaw  = result.total_score ?? 0;
  const maxScore  = result.max_score ?? 10;
  const score10   = Math.round((scoreRaw / maxScore) * 100) / 10;
  setText('results-score-value', score10.toFixed(1));

  const gradeEl = document.getElementById('results-grade');
  if (gradeEl) {
    gradeEl.textContent = result.grade || '';
    const color = score10 >= 9 ? 'var(--green)' : score10 >= 7 ? 'var(--accent)' : score10 >= 5 ? 'var(--amber)' : 'var(--red)';
    gradeEl.style.color = color;
  }

  setText('results-global-feedback', result.global_feedback || '');

  const container = document.getElementById('results-questions');
  if (container) {
    container.innerHTML = (result.results || []).map((r, i) => {
      const pct    = r.max_score > 0 ? r.score / r.max_score : 0;
      const cls    = pct >= 0.8 ? 'result-score--good' : pct >= 0.5 ? 'result-score--mid' : 'result-score--bad';
      return `
        <div class="result-question">
          <div class="result-question__header">
            <span>Pregunta ${i + 1}</span>
            <span class="${cls}">${r.score} / ${r.max_score} pts</span>
          </div>
          ${r.feedback ? `<div class="result-label">Feedback</div><div class="result-text">${r.feedback}</div>` : ''}
          ${r.what_was_right ? `<div class="result-label">✓ Correcto</div><div class="result-text" style="color:var(--green)">${r.what_was_right}</div>` : ''}
          ${r.what_was_wrong ? `<div class="result-label">✗ A mejorar</div><div class="result-text" style="color:var(--red)">${r.what_was_wrong}</div>` : ''}
          ${r.correct_approach ? `<div class="result-label">Enfoque correcto</div><div class="result-text">${renderMD(r.correct_approach)}</div>` : ''}
        </div>
      `;
    }).join('');
    renderKatex(container);
  }
}

function resetExam() {
  currentExam = null;
  hide('exam-results');
  hide('exam-active');
  show('exam-setup');
}
window.resetExam = resetExam;

// ─── Chat ─────────────────────────────────────────────────────────────────────

const chatInput   = document.getElementById('chat-input');
const btnSendChat = document.getElementById('btn-send-chat');

if (btnSendChat) btnSendChat.addEventListener('click', sendChat);
if (chatInput) {
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
}

async function sendChat() {
  const msg = chatInput?.value?.trim();
  if (!msg) return;

  chatInput.value = '';
  appendChatMsg('user', msg);

  // Streaming AI bubble
  const bubble = appendChatMsg('ai', '');
  bubble.classList.add('streaming');

  chatHistory.push({ role: 'user', content: msg });

  try {
    const res = await fetch(`/api/chat/${SUBJECT_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, history: chatHistory }),
    });

    if (!res.ok) throw new Error('Error del servidor');

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   full    = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') break;
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) throw new Error(parsed.error);
          if (parsed.text) {
            full += parsed.text;
            bubble.innerHTML = renderMD(full);
            renderKatex(bubble);
            // Scroll to bottom
            const msgs = document.getElementById('chat-messages');
            if (msgs) msgs.scrollTop = msgs.scrollHeight;
          }
        } catch { /* ignore parse errors on partial chunks */ }
      }
    }

    bubble.classList.remove('streaming');
    chatHistory.push({ role: 'assistant', content: full });
  } catch (err) {
    bubble.textContent = 'Error: ' + err.message;
    bubble.classList.remove('streaming');
  }
}

function appendChatMsg(role, html) {
  const msgs    = document.getElementById('chat-messages');
  const wrapper = document.createElement('div');
  wrapper.className = `chat-message chat-message--${role}`;
  const bubble  = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.innerHTML = html;
  wrapper.appendChild(bubble);
  msgs?.appendChild(wrapper);
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
  return bubble;
}

// ─── Progress ─────────────────────────────────────────────────────────────────

async function loadProgress() {
  show('progress-loading');
  hide('progress-content');

  try {
    const res  = await fetch(`/api/stats/${SUBJECT_ID}`);
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(json.error);

    renderProgress(json.stats);
  } catch (err) {
    hide('progress-loading');
    console.error('Progress load failed:', err);
  }
}

function renderProgress(stats) {
  hide('progress-loading');
  show('progress-content');

  // KPIs
  const kpisEl = document.getElementById('progress-kpis');
  if (kpisEl) {
    const avg = stats.avg_score != null ? stats.avg_score.toFixed(1) : '—';
    kpisEl.innerHTML = `
      <div class="kpi-card"><div class="kpi-value">${stats.total_exams ?? 0}</div><div class="kpi-label">Simulacros</div></div>
      <div class="kpi-card"><div class="kpi-value">${avg}</div><div class="kpi-label">Media</div></div>
      <div class="kpi-card"><div class="kpi-value">${Object.values(stats.flashcards || {}).reduce((a,b)=>a+b,0)}</div><div class="kpi-label">Flashcards valoradas</div></div>
    `;
  }

  // Exam history chart
  const history = stats.exam_history || [];
  if (history.length === 0) {
    show('progress-chart-empty');
    hide('progress-chart-wrap');
  } else {
    hide('progress-chart-empty');
    show('progress-chart-wrap');
    renderChart(history);
  }

  // Flashcard bars
  const fc = stats.flashcards || {};
  const fcTotal = Object.values(fc).reduce((a,b)=>a+b,0);
  const fcBars  = document.getElementById('progress-fc-bars');

  if (fcTotal === 0) {
    show('progress-fc-empty');
    hide('progress-fc-bars');
  } else {
    hide('progress-fc-empty');
    if (fcBars) {
      fcBars.classList.remove('hidden');
      const items = [
        { label: 'Fácil',   key: 'easy',   color: 'var(--green)' },
        { label: 'Media',   key: 'medium', color: 'var(--amber)' },
        { label: 'Difícil', key: 'hard',   color: 'var(--red)'   },
      ];
      fcBars.innerHTML = items.map(it => {
        const cnt = fc[it.key] || 0;
        const pct = fcTotal > 0 ? Math.round(cnt / fcTotal * 100) : 0;
        return `
          <div class="fc-bar-row">
            <span class="fc-bar-label">${it.label}</span>
            <div class="fc-bar-track"><div class="fc-bar-fill" style="width:${pct}%;background:${it.color}"></div></div>
            <span class="fc-bar-count">${cnt}</span>
          </div>
        `;
      }).join('');
    }
  }
}

function renderChart(history) {
  const canvas = document.getElementById('progress-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  const labels = history.map((_, i) => `#${i + 1}`);
  const scores = history.map(h => h.max_score > 0 ? Math.round(h.total_score / h.max_score * 100) / 10 : 0);

  if (progressChart) progressChart.destroy();
  progressChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Nota (/ 10)',
        data: scores,
        borderColor: '#0a84ff',
        backgroundColor: 'rgba(10,132,255,0.08)',
        borderWidth: 2,
        pointBackgroundColor: '#0a84ff',
        tension: 0.3,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      scales: {
        y: { min: 0, max: 10, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#86868b' } },
        x: { grid: { display: false }, ticks: { color: '#86868b' } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => `${ctx.parsed.y.toFixed(1)} / 10` } },
      },
    },
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Set subject name in chat tab
  setText('chat-subject-name', SUBJECT_ID.toUpperCase());

  // If already analyzed, load cache
  loadCacheIfReady();
});
