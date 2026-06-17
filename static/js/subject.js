/* ── subject.js ─────────────────────────────────────────────────────────── */

const SUBJECT_ID   = document.querySelector('.page-subject').dataset.subject;
let appData        = null;
let flashcards     = [];
let currentCard    = 0;
let examData       = null;
let examConfig     = { questions: 3, difficulty: 'mixed' };
let chatHistory    = [];
let examStartTime  = null;
let timerInterval  = null;
let progressChart  = null;

const STORAGE_KEY  = `flashcards_sm2_${SUBJECT_ID}`;

// ── Markdown & KaTeX ──────────────────────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return '';
  if (typeof marked !== 'undefined') {
    marked.setOptions({ breaks: true, gfm: true });
    return marked.parse(String(text));
  }
  return String(text).replace(/\n/g, '<br>');
}

function renderMath(element) {
  if (typeof renderMathInElement !== 'undefined') {
    const target = element || document.body;
    renderMathInElement(target, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$',  right: '$',  display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true }
      ],
      throwOnError: false
    });
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('tab--active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
  const tab = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (tab) tab.classList.add('tab--active');
  const content = document.getElementById(`tab-${tabName}`);
  if (content) content.classList.remove('hidden');
  if (tabName === 'chat') {
    const el = document.getElementById('chat-subject-name');
    if (el) el.textContent = SUBJECT_ID.toUpperCase();
  }
  if (tabName === 'progress') loadProgress();
  setTimeout(renderMath, 60);
}

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

// ── Upload panel ──────────────────────────────────────────────────────────────
const btnUpload   = document.getElementById('btn-upload');
const uploadPanel = document.getElementById('upload-panel');
const fileInput   = document.getElementById('file-input');
const dropZone    = document.getElementById('upload-drop');

if (btnUpload) {
  btnUpload.addEventListener('click', () => {
    uploadPanel.classList.toggle('hidden');
    if (!uploadPanel.classList.contains('hidden')) loadExistingPdfs();
  });
}

if (fileInput) {
  fileInput.addEventListener('change', e => handleFiles(e.target.files));
}

if (dropZone) {
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });
}

async function handleFiles(files) {
  const pdfs = [...files].filter(f => f.name.toLowerCase().endsWith('.pdf'));
  if (!pdfs.length) { alert('Solo se aceptan archivos PDF.'); return; }

  const list = document.getElementById('upload-file-list');
  const items = pdfs.map(f => {
    const div = document.createElement('div');
    div.className = 'upload-file-item';
    div.innerHTML = `<span class="upload-file-item__name">${esc(f.name)}</span>
                     <span class="upload-file-item__status" id="status-${esc(f.name)}">⏳ Subiendo…</span>`;
    list.appendChild(div);
    return { file: f, div };
  });

  const fd = new FormData();
  pdfs.forEach(f => fd.append('files', f));

  try {
    const res  = await fetch(`/api/upload/${SUBJECT_ID}`, { method: 'POST', body: fd });
    const json = await res.json();
    if (!json.success && !json.saved?.length) throw new Error(json.error);

    items.forEach(({ file, div }) => {
      const saved = json.saved?.includes(file.name);
      div.querySelector('.upload-file-item__status').textContent = saved ? '✓ Subido' : '✗ Error';
      div.querySelector('.upload-file-item__status').style.color = saved ? 'var(--green)' : 'var(--red)';
    });

    // Refresh PDF count label
    const countRes  = await fetch(`/api/pdfs/${SUBJECT_ID}`);
    const countJson = await countRes.json();
    const n = countJson.pdfs?.length || 0;
    const label = document.getElementById('pdf-count-label');
    if (label) label.textContent = `${n} PDF${n !== 1 ? 's' : ''} cargado${n !== 1 ? 's' : ''}`;

    // Hide onboarding if PDFs now exist
    if (n > 0) {
      const ob = document.getElementById('onboarding-state');
      const em = document.getElementById('empty-state');
      if (ob) ob.classList.add('hidden');
      if (em) em.classList.remove('hidden');
    }

    loadExistingPdfs();
  } catch (e) {
    items.forEach(({ div }) => {
      div.querySelector('.upload-file-item__status').textContent = '✗ Error';
      div.querySelector('.upload-file-item__status').style.color = 'var(--red)';
    });
    alert('Error subiendo: ' + e.message);
  }
}

async function loadExistingPdfs() {
  const container = document.getElementById('upload-existing');
  if (!container) return;
  try {
    const res  = await fetch(`/api/pdfs/${SUBJECT_ID}`);
    const json = await res.json();
    const pdfs = json.pdfs || [];
    if (!pdfs.length) { container.innerHTML = ''; return; }
    container.innerHTML = `
      <div class="upload-existing-title">PDFs cargados (${pdfs.length})</div>
      <div class="upload-existing-list">
        ${pdfs.map(p => `
          <div class="upload-existing-tag">
            📄 ${esc(p)}
            <button class="upload-existing-del" onclick="deletePdf('${esc(p)}')" title="Eliminar">✕</button>
          </div>`).join('')}
      </div>`;
  } catch (_) {}
}

window.deletePdf = async function(filename) {
  if (!confirm(`¿Eliminar "${filename}"?`)) return;
  await fetch(`/api/pdfs/${SUBJECT_ID}/${encodeURIComponent(filename)}`, { method: 'DELETE' });
  loadExistingPdfs();
};

// ── Análisis ──────────────────────────────────────────────────────────────────
const btnAnalyze = document.getElementById('btn-analyze');
if (btnAnalyze) btnAnalyze.addEventListener('click', runAnalysis);

async function runAnalysis() {
  setAnalyzing(true);
  try {
    const res  = await fetch(`/api/analyze/${SUBJECT_ID}`, { method: 'POST' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Error desconocido');
    appData = json.data;
    renderAll();
  } catch (e) {
    alert(`Error analizando: ${e.message}`);
  } finally {
    setAnalyzing(false);
  }
}

function setAnalyzing(active) {
  document.getElementById('analyzing-state')?.classList.toggle('hidden', !active);
  document.getElementById('main-content')?.classList.toggle('hidden', active);
  document.getElementById('empty-state')?.classList.add('hidden');
  if (btnAnalyze) {
    btnAnalyze.disabled    = active;
    btnAnalyze.textContent = active ? '⏳ Analizando…' : '↻ Re-analizar';
  }
}

// Cargar cache al inicio
(async () => {
  try {
    const res  = await fetch(`/api/cache/${SUBJECT_ID}`);
    if (res.ok) {
      const json = await res.json();
      if (json.success) { appData = json.data; renderAll(); }
    }
  } catch (_) {}
  // Also load existing PDFs into upload panel state
  loadExistingPdfs();
})();

function renderAll() {
  document.getElementById('main-content')?.classList.remove('hidden');
  document.getElementById('empty-state')?.classList.add('hidden');
  document.getElementById('onboarding-state')?.classList.add('hidden');
  if (btnAnalyze) btnAnalyze.textContent = '↻ Re-analizar';
  renderPatterns();
  renderCheatSheet();
}

// ── Patterns ──────────────────────────────────────────────────────────────────
function renderPatterns() {
  if (!appData) return;
  const { patterns, study_tips } = appData;
  const avgFreq    = Math.round(patterns.reduce((a, p) => a + p.frequency, 0) / patterns.length);
  const topPattern = patterns.reduce((a, b) => a.frequency > b.frequency ? a : b);

  document.getElementById('patterns-summary').innerHTML = `
    <div class="summary-card"><div class="summary-card__label">Patrones</div><div class="summary-card__value" style="color:var(--accent)">${patterns.length}</div></div>
    <div class="summary-card"><div class="summary-card__label">Frecuencia media</div><div class="summary-card__value">${avgFreq}%</div></div>
    <div class="summary-card"><div class="summary-card__label">Patrón #1</div><div class="summary-card__value" style="font-size:.95rem;color:var(--green)">${topPattern.title}</div></div>
    <div class="summary-card"><div class="summary-card__label">Más frecuente</div><div class="summary-card__value" style="color:var(--green)">${topPattern.frequency}%</div></div>`;

  document.getElementById('patterns-list').innerHTML = patterns.map((p, i) => {
    const fc  = p.frequency >= 70 ? 'high' : p.frequency >= 40 ? 'medium' : 'low';
    const con = (p.key_concepts||[]).map(c => `<span class="concept-tag">${esc(c)}</span>`).join('');
    const mis = (p.common_mistakes||[]).map(m => `<li>${renderMarkdown(m)}</li>`).join('');
    return `<div class="pattern-card">
      <div class="pattern-card__header" onclick="togglePattern(${i})">
        <div class="pattern-card__left">
          <span class="pattern-num">${String(i+1).padStart(2,'0')}</span>
          <span class="pattern-title">${esc(p.title)}</span>
        </div>
        <span class="pattern-freq freq--${fc}">${p.frequency}%</span>
        <span class="pattern-difficulty">${esc(p.difficulty||'')}</span>
        <span class="pattern-toggle" id="toggle-${i}">▾</span>
      </div>
      <div class="pattern-card__body" id="body-${i}">
        <div class="pattern-section"><div class="pattern-section-label">Descripción</div><div class="pattern-desc">${renderMarkdown(p.description)}</div></div>
        ${con ? `<div class="pattern-section"><div class="pattern-section-label">Conceptos clave</div><div class="concepts-list">${con}</div></div>` : ''}
        <div class="pattern-section"><div class="pattern-section-label">Cómo responderlo</div><div class="how-to-box">${renderMarkdown(p.how_to_answer)}</div></div>
        ${mis ? `<div class="pattern-section"><div class="pattern-section-label">Errores comunes</div><ul class="mistakes-list">${mis}</ul></div>` : ''}
        <div class="pattern-section"><div class="pattern-section-label">Pregunta típica</div><div class="example-box">${renderMarkdown(p.example_question)}</div></div>
      </div>
    </div>`;
  }).join('');

  if (study_tips?.length) {
    const tipsHtml = study_tips.map(t => `<li>${renderMarkdown(t)}</li>`).join('');
    document.getElementById('study-tips').innerHTML = `<h3>Estrategia de estudio</h3><ul class="tips-list">${tipsHtml}</ul>`;
  }
  
  renderMath(document.getElementById('tab-patterns'));
}

window.togglePattern = function(i) {
  document.getElementById(`body-${i}`).classList.toggle('open');
  document.getElementById(`toggle-${i}`).classList.toggle('open');
};

// ── Cheat Sheet ───────────────────────────────────────────────────────────────
function renderCheatSheet() {
  if (!appData?.cheat_sheet) return;
  const container = document.getElementById('cheatsheet-content');
  container.innerHTML = renderMarkdown(appData.cheat_sheet);
  renderMath(container);
}

// ── Flashcards ────────────────────────────────────────────────────────────────
document.getElementById('btn-generate-cards')?.addEventListener('click', generateFlashcards);

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
  if (!flashcards?.length) return;
  if (currentCard >= flashcards.length) {
    document.getElementById('card-front').innerHTML = '<h3>¡Sesión completada!</h3>';
    document.getElementById('card-back').innerHTML  = '<p>Has repasado todas las tarjetas. Vuelve mañana para aprovechar el espaciado.</p>';
    document.getElementById('flashcard-inner').classList.remove('flipped');
    document.getElementById('cards-verdict').classList.add('hidden');
    document.getElementById('flashcards-controls').classList.add('hidden');
    document.getElementById('card-category').textContent  = 'Fin';
    document.getElementById('card-difficulty').textContent = '';
    return;
  }
  const card = flashcards[currentCard];
  document.getElementById('card-front').innerHTML   = renderMarkdown(card.front);
  document.getElementById('card-back').innerHTML    = renderMarkdown(card.back);
  document.getElementById('card-category').textContent = card.category || '';
  const badge = document.getElementById('card-difficulty');
  badge.textContent = card.difficulty || '';
  badge.className   = `difficulty-badge diff--${card.difficulty}`;
  document.getElementById('flashcard-inner').classList.remove('flipped');
  document.getElementById('cards-verdict').classList.add('hidden');
  document.getElementById('flashcards-controls').classList.remove('hidden');
  document.getElementById('cards-progress').textContent = `${currentCard+1} / ${flashcards.length}`;
  document.getElementById('progress-fill').style.width  = `${((currentCard+1)/flashcards.length)*100}%`;
  renderMath(document.getElementById('flashcards-container'));
}

document.getElementById('btn-card-flip')?.addEventListener('click', () => {
  document.getElementById('flashcard-inner').classList.toggle('flipped');
  document.getElementById('cards-verdict').classList.remove('hidden');
  document.getElementById('flashcards-controls').classList.add('hidden');
});
document.getElementById('btn-card-prev')?.addEventListener('click', () => { if (currentCard>0){currentCard--;renderFlashcard();} });
document.getElementById('btn-card-next')?.addEventListener('click', () => { if (currentCard<flashcards.length-1){currentCard++;renderFlashcard();} });

window.rateCard = function(quality) {
  if (!flashcards || currentCard >= flashcards.length) return;
  const card        = flashcards[currentCard];
  const store       = JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}');
  const uid         = card.id || btoa(unescape(encodeURIComponent(card.front.slice(0,20))));
  let s             = store[uid] || { repetitions:0, interval:1, efactor:2.5, nextDate:Date.now() };
  if (quality < 3) { s.repetitions=0; s.interval=1; }
  else {
    s.interval = s.repetitions===0 ? 1 : s.repetitions===1 ? 6 : Math.round(s.interval*s.efactor);
    s.repetitions++;
  }
  s.efactor = Math.max(1.3, s.efactor + 0.1 - (5-quality)*(0.08+(5-quality)*0.02));
  const next = new Date(); next.setDate(next.getDate()+s.interval);
  s.nextDate = next.getTime();
  store[uid] = s;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  const rating = quality<=1?'hard':quality<=3?'medium':'easy';
  fetch('/api/flashcards/update', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({subject_id:SUBJECT_ID, card_id:card.id||currentCard, rating})
  }).catch(()=>{});
  currentCard++;
  renderFlashcard();
};

// ── Exam ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.config-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.key;
    document.querySelectorAll(`.config-btn[data-key="${key}"]`).forEach(b => b.classList.remove('config-btn--active'));
    btn.classList.add('config-btn--active');
    examConfig[key==='questions'?'questions':'difficulty'] = key==='questions' ? parseInt(btn.dataset.val) : btn.dataset.val;
  });
});

document.getElementById('btn-start-exam')?.addEventListener('click', startExam);

async function startExam() {
  document.getElementById('exam-setup').classList.add('hidden');
  document.getElementById('exam-loading').classList.remove('hidden');
  try {
    const res  = await fetch(`/api/exam/generate/${SUBJECT_ID}`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({difficulty:examConfig.difficulty, n_questions:examConfig.questions})
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    examData = json.exam;
    renderExam();
  } catch(e) {
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
  document.getElementById('exam-questions').innerHTML = examData.questions.map((q,i) => `
    <div class="exam-question" data-id="${q.id}">
      <div class="exam-question__header">
        <span class="exam-question__num">PREGUNTA ${i+1} · ${esc(q.type||'')}</span>
        <span class="exam-question__points">${q.points} pts</span>
      </div>
      <div class="exam-question__text">${renderMarkdown(q.text)}</div>
      <button class="hint-toggle" onclick="toggleHint(${i})">💡 Ver pista</button>
      <div class="exam-question__hint" id="hint-${i}">${renderMarkdown(q.hint||'')}</div>
      <textarea placeholder="Escribe tu respuesta aquí…" id="answer-${q.id}"></textarea>
    </div>`).join('');
  document.getElementById('exam-active').classList.remove('hidden');
  renderMath(document.getElementById('exam-questions'));
}

window.toggleHint = function(i) {
  const h = document.getElementById(`hint-${i}`);
  h.style.display = h.style.display==='block' ? 'none' : 'block';
};

function startTimer(seconds) {
  clearInterval(timerInterval);
  const el = document.getElementById('exam-timer');
  timerInterval = setInterval(() => {
    seconds--;
    const m=Math.floor(seconds/60), s=seconds%60;
    el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    if (seconds<=0){clearInterval(timerInterval);el.textContent='00:00';}
  },1000);
}

document.getElementById('btn-submit-exam')?.addEventListener('click', submitExam);

async function submitExam() {
  clearInterval(timerInterval);
  if (!confirm('¿Entregar el examen?')) return;
  const questions = examData.questions.map(q=>({
    question_text:q.text, model_answer:q.model_answer,
    user_answer: document.getElementById(`answer-${q.id}`)?.value||'',
    points:q.points, grading_criteria:q.grading_criteria||[]
  }));
  document.getElementById('exam-active').classList.add('hidden');
  document.getElementById('exam-loading').classList.remove('hidden');
  try {
    const res  = await fetch('/api/exam/grade',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subject_id:SUBJECT_ID,questions})});
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    renderResults(json.result, questions);
  } catch(e) {
    alert(`Error corrigiendo: ${e.message}`);
    document.getElementById('exam-active').classList.remove('hidden');
  } finally {
    document.getElementById('exam-loading').classList.add('hidden');
  }
}

function renderResults(result, questions) {
  const pct   = result.total_score/result.max_score;
  const color = pct>=0.7?'var(--green)':pct>=0.5?'var(--amber)':'var(--red)';
  document.getElementById('results-score-value').textContent  = result.total_score;
  document.getElementById('results-score-value').style.color  = color;
  document.getElementById('results-grade').textContent        = result.grade||'';
  document.getElementById('results-grade').style.color        = color;
  document.getElementById('results-global-feedback').textContent = result.global_feedback||'';
  document.getElementById('results-questions').innerHTML = (result.results||[]).map((r,i)=>{
    const q=questions[i]||{};
    const p=r.score/r.max_score;
    const c=p>=0.8?'good':p>=0.5?'mid':'bad';
    return `<div class="result-question">
      <div class="result-question__header"><span>Pregunta ${r.question_id}</span><span class="result-score--${c}">${r.score} / ${r.max_score} pts</span></div>
      ${q.question_text?`<div class="result-text" style="margin-bottom:.65rem;color:var(--text)">${renderMarkdown(q.question_text)}</div>`:''}
      <div class="result-label">Tu respuesta</div><div class="result-text">${esc(q.user_answer||'[Sin responder]')}</div>
      <div class="result-label">Feedback</div><div class="result-text">${renderMarkdown(r.feedback||'')}</div>
      ${r.correct_approach?`<div class="result-label">Cómo debería responderse</div><div class="result-text">${renderMarkdown(r.correct_approach)}</div>`:''}
    </div>`;
  }).join('');
  document.getElementById('exam-results').classList.remove('hidden');
  renderMath(document.getElementById('results-questions'));
}

window.resetExam = function() {
  examData=null;
  document.getElementById('exam-results').classList.add('hidden');
  document.getElementById('exam-questions').innerHTML='';
  document.getElementById('exam-setup').classList.remove('hidden');
};

// ── Chat ──────────────────────────────────────────────────────────────────────
const chatInput = document.getElementById('chat-input');
const btnSend   = document.getElementById('btn-send-chat');
if (btnSend)   btnSend.addEventListener('click', sendMessage);
if (chatInput) chatInput.addEventListener('keydown', e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}});

async function sendMessage() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  chatInput.value='';
  const historyForApi = chatHistory.slice(-6).map(m=>({role:m.role==='assistant'?'model':m.role,content:m.content}));
  appendMessage('user',msg);
  chatHistory.push({role:'user',content:msg});
  const bubble = appendMessage('ai','');
  bubble.classList.add('streaming');
  btnSend.disabled=true;
  try {
    const res = await fetch(`/api/chat/${SUBJECT_ID}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg,history:historyForApi})});
    if (!res.ok) throw new Error(`Error ${res.status}`);
    const reader=res.body.getReader(), decoder=new TextDecoder();
    let fullText='';
    while(true){
      const{done,value}=await reader.read(); if(done) break;
      for(const line of decoder.decode(value).split('\n')){
        if(!line.startsWith('data: ')) continue;
        const p=line.slice(6); if(p==='[DONE]') break;
        try{
          const o=JSON.parse(p);
          if(o.error)throw new Error(o.error);
          if(o.text){
            fullText+=o.text;
            bubble.innerHTML=renderMarkdown(fullText);
            renderMath(bubble);
            scrollChat();
          }
        }
        catch(err){if(err.name!=='SyntaxError') throw err;}
      }
    }
    chatHistory.push({role:'model',content:fullText});
  } catch(e){
    bubble.textContent=`Error: ${e.message}`; chatHistory.pop();
  } finally {
    bubble.classList.remove('streaming'); btnSend.disabled=false; chatInput.focus();
  }
}

function appendMessage(role,text){
  const msgs=document.getElementById('chat-messages');
  const div=document.createElement('div'); div.className=`chat-message chat-message--${role}`;
  const b=document.createElement('div'); b.className='chat-bubble';
  b.innerHTML=text?renderMarkdown(text):''; div.appendChild(b); msgs.appendChild(div); scrollChat(); return b;
}
function scrollChat(){const m=document.getElementById('chat-messages');m.scrollTop=m.scrollHeight;}

// ── Progress ──────────────────────────────────────────────────────────────────
async function loadProgress() {
  const loading = document.getElementById('progress-loading');
  const content = document.getElementById('progress-content');
  if (!loading||!content) return;
  loading.classList.remove('hidden'); content.classList.add('hidden');
  try {
    const res  = await fetch(`/api/stats/${SUBJECT_ID}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    renderProgress(json.stats);
  } catch(e) {
    if (loading) loading.innerHTML=`<p style="color:var(--red)">Error: ${e.message}</p>`;
  } finally {
    loading.classList.add('hidden'); content.classList.remove('hidden');
  }
}

function renderProgress(stats) {
  const history  = stats.exam_history||[];
  const avg      = stats.avg_score;
  const total    = stats.total_exams||0;
  const last     = history.length ? (history[history.length-1].total_score/history[history.length-1].max_score*10).toFixed(1) : null;
  const fcStats  = stats.flashcards||{};
  const fcTotal  = Object.values(fcStats).reduce((a,b)=>a+b,0);

  document.getElementById('progress-kpis').innerHTML=`
    <div class="kpi-card"><div class="kpi-value" style="color:var(--accent)">${total}</div><div class="kpi-label">Simulacros</div></div>
    <div class="kpi-card"><div class="kpi-value" style="color:${avg>=5?'var(--green)':'var(--red)'}">${avg!==null?Number(avg).toFixed(1):'—'}</div><div class="kpi-label">Nota media</div></div>
    <div class="kpi-card"><div class="kpi-value">${last!==null?last:'—'}</div><div class="kpi-label">Último simulacro</div></div>
    <div class="kpi-card"><div class="kpi-value" style="color:var(--green)">${fcTotal}</div><div class="kpi-label">Flashcards valoradas</div></div>`;

  // Chart
  const chartWrap=document.getElementById('progress-chart-wrap');
  const chartEmpty=document.getElementById('progress-chart-empty');
  if (!history.length) { chartEmpty.classList.remove('hidden'); chartWrap.classList.add('hidden'); }
  else {
    chartEmpty.classList.add('hidden'); chartWrap.classList.remove('hidden');
    const labels = history.map((_,i)=>`#${i+1}`);
    const scores = history.map(r=>parseFloat((r.total_score/r.max_score*10).toFixed(2)));
    const grades = history.map(r=>r.grade);
    if (progressChart) progressChart.destroy();
    progressChart = new Chart(document.getElementById('progress-chart').getContext('2d'),{
      type:'line',
      data:{labels,datasets:[{
        label:'Nota',data:scores,
        borderColor:'#0a84ff',backgroundColor:'rgba(10,132,255,0.1)',
        pointBackgroundColor:scores.map(s=>s>=7?'#32d74b':s>=5?'#ff9f0a':'#ff453a'),
        pointRadius:6,pointHoverRadius:8,tension:0.3,fill:true
      }]},
      options:{
        responsive:true,
        plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>`${c.parsed.y} — ${grades[c.dataIndex]}`}}},
        scales:{
          y:{min:0,max:10,grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:'#48484a',callback:v=>`${v}`}},
          x:{grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:'#48484a'}}
        }
      }
    });
  }

  // FC bars
  const fcBars=document.getElementById('progress-fc-bars');
  const fcEmpty=document.getElementById('progress-fc-empty');
  if (!fcTotal){fcEmpty.classList.remove('hidden');fcBars.classList.add('hidden');}
  else {
    fcEmpty.classList.add('hidden'); fcBars.classList.remove('hidden');
    const labels={easy:'Fácil',medium:'Media',hard:'Difícil'};
    const colors={easy:'var(--green)',medium:'var(--amber)',hard:'var(--red)'};
    fcBars.innerHTML=['easy','medium','hard'].map(r=>{
      const n=fcStats[r]||0,pct=fcTotal?Math.round(n/fcTotal*100):0;
      return `<div class="fc-bar-row"><span class="fc-bar-label" style="color:${colors[r]}">${labels[r]}</span><div class="fc-bar-track"><div class="fc-bar-fill" style="width:${pct}%;background:${colors[r]}"></div></div><span class="fc-bar-count">${n}</span></div>`;
    }).join('');
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────
function esc(str) {
  if (str==null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
