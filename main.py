"""
Academia Personal — Backend Flask (Cloud Run + Google Cloud Storage)
====================================================================
Local:   GOOGLE_API_KEY=xxx GCS_BUCKET=academia-fib-data python main.py
Cloud:   gunicorn main:app
"""

import os, json, re, io, sqlite3, tempfile
from datetime import datetime
from pathlib import Path
from flask import Flask, render_template, jsonify, request, stream_with_context, Response
from google import genai
from google.genai import types
from google.cloud import storage as gcs
from pypdf import PdfReader
from json_repair import repair_json
from werkzeug.utils import secure_filename

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50 MB

MODEL         = 'gemini-2.5-flash'
MIN_PDF_CHARS = 200
BUCKET_NAME   = os.environ.get('GCS_BUCKET', 'academia-fib-data')
ALLOWED_EXT   = {'pdf'}

FORMAT_RULES = """
REGLAS DE FORMATO OBLIGATORIAS:
- Fórmulas matemáticas en LaTeX inline: $O(n \\log n)$, $T(n) = 2T(n/2) + O(n)$
- Código/pseudocódigo en bloques Markdown con lenguaje: ```cpp ... ``` o ```python ... ```
- NO uses notación plana fuera de LaTeX.
"""

# =============================================================================
#  GCS HELPERS
# =============================================================================

def get_bucket():
    client = gcs.Client()
    return client.bucket(BUCKET_NAME)

def gcs_exists(path: str) -> bool:
    return get_bucket().blob(path).exists()

def gcs_read(path: str) -> bytes:
    return get_bucket().blob(path).download_as_bytes()

def gcs_read_text(path: str) -> str:
    return gcs_read(path).decode('utf-8')

def gcs_write(path: str, data: bytes, content_type: str = 'application/octet-stream'):
    blob = get_bucket().blob(path)
    blob.upload_from_string(data, content_type=content_type)

def gcs_write_text(path: str, text: str):
    gcs_write(path, text.encode('utf-8'), 'text/plain; charset=utf-8')

def gcs_write_json(path: str, obj):
    gcs_write(path, json.dumps(obj, ensure_ascii=False, indent=2).encode('utf-8'), 'application/json')

def gcs_read_json(path: str):
    return json.loads(gcs_read_text(path))

def gcs_delete(path: str):
    blob = get_bucket().blob(path)
    if blob.exists():
        blob.delete()

def gcs_list(prefix: str) -> list[str]:
    return [b.name for b in get_bucket().list_blobs(prefix=prefix)]

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXT

# =============================================================================
#  PROGRESS — persistido en GCS (survives Cloud Run cold starts)
#  Estructura: progreso/{subject_id}_progress.json
# =============================================================================

def _progress_path(subject_id: str) -> str:
    return f"progreso/{subject_id}_progress.json"

def _load_progress(subject_id: str) -> dict:
    path = _progress_path(subject_id)
    if gcs_exists(path):
        return gcs_read_json(path)
    return {"exam_history": [], "flashcard_progress": {}}

def _save_progress(subject_id: str, data: dict):
    gcs_write_json(_progress_path(subject_id), data)

def init_db():
    pass  # No-op: progress now lives in GCS

def save_exam_result(subject_id, total_score, max_score, grade, n_questions):
    p = _load_progress(subject_id)
    p.setdefault("exam_history", []).append({
        "date":        datetime.now().isoformat(),
        "total_score": total_score,
        "max_score":   max_score,
        "grade":       grade,
        "n_questions": n_questions,
    })
    # Keep last 20 exams
    p["exam_history"] = p["exam_history"][-20:]
    _save_progress(subject_id, p)

def save_flashcard_rating(subject_id: str, card_id: int, rating: str):
    p = _load_progress(subject_id)
    p.setdefault("flashcard_progress", {})[str(card_id)] = {
        "rating": rating,
        "date":   datetime.now().isoformat(),
    }
    _save_progress(subject_id, p)

def get_subject_stats(subject_id):
    p       = _load_progress(subject_id)
    history = p.get("exam_history", [])
    fc_map  = p.get("flashcard_progress", {})

    scores  = [r["total_score"] * 10.0 / r["max_score"] for r in history if r.get("max_score")]
    avg     = round(sum(scores) / len(scores), 2) if scores else None

    fc_counts: dict = {}
    for v in fc_map.values():
        r = v.get("rating", "")
        fc_counts[r] = fc_counts.get(r, 0) + 1

    return {
        "exam_history": history,
        "avg_score":    avg,
        "flashcards":   fc_counts,
        "total_exams":  len(history),
    }

# =============================================================================
#  JSON REPAIR
# =============================================================================

def parse_llm_json(raw):
    try: return json.loads(raw)
    except: pass
    c = raw.strip()
    c = re.sub(r"^```json\s*","",c,flags=re.IGNORECASE)
    c = re.sub(r"^```\s*","",c); c = re.sub(r"\s*```$","",c); c = c.strip()
    f = min((c.find(x) for x in ('{','[') if c.find(x)!=-1), default=0)
    if f > 0: c = c[f:]
    l = max(c.rfind('}'), c.rfind(']'))
    if l != -1 and l < len(c)-1: c = c[:l+1]
    try: return json.loads(c)
    except: pass
    r = repair_json(c, return_objects=True)
    if not r: raise ValueError(f"No se pudo parsear JSON: {repr(raw[:200])}")
    return r

# =============================================================================
#  PDF UTILS
# =============================================================================

def extract_pdfs_text_from_gcs(subject_id: str) -> str:
    """Lee todos los PDFs de un subject desde GCS y extrae su texto."""
    prefix = f"examenes/{subject_id}/"
    blobs  = gcs_list(prefix)
    texts  = []
    for blob_name in sorted(blobs):
        if not blob_name.endswith('.pdf'): continue
        filename = blob_name.split('/')[-1]
        try:
            pdf_bytes = gcs_read(blob_name)
            reader    = PdfReader(io.BytesIO(pdf_bytes))
            text      = "\n".join(p.extract_text() or "" for p in reader.pages).strip()
            if text:
                texts.append(f"=== {filename} ===\n{text}")
        except Exception as e:
            texts.append(f"=== {filename} === [Error: {e}]")
    return "\n\n".join(texts)

def validate_pdf_text(text, ctx="los PDFs"):
    if not text or len(text.strip()) < MIN_PDF_CHARS:
        return False, (f"No hay suficiente texto legible en {ctx}. "
                       "¿Son PDFs escaneados? Pásalos por OCR primero.")
    return True, ""

def get_client():
    key = os.environ.get("GOOGLE_API_KEY","")
    if not key: raise ValueError("GOOGLE_API_KEY no configurada.")
    return genai.Client(api_key=key)

# =============================================================================
#  SUBJECTS (desde GCS)
# =============================================================================

def get_subjects() -> list[dict]:
    """Lista asignaturas leyendo prefijos en GCS."""
    blobs    = gcs_list("examenes/")
    subjects = {}
    for blob_name in blobs:
        parts = blob_name.split('/')
        if len(parts) >= 2:
            sid = parts[1]
            if sid not in subjects:
                subjects[sid] = {"id": sid, "name": sid.upper(), "pdf_count": 0, "has_cache": False}
            if blob_name.endswith('.pdf'):
                subjects[sid]["pdf_count"] += 1

    # Check caches
    cache_blobs = gcs_list("resultados/")
    for blob_name in cache_blobs:
        if blob_name.endswith('_cache.json'):
            sid = blob_name.replace('resultados/','').replace('_cache.json','')
            if sid in subjects:
                subjects[sid]["has_cache"] = True

    return sorted(subjects.values(), key=lambda x: x["id"])

def load_cache(sid):
    path = f"resultados/{sid}_cache.json"
    if gcs_exists(path):
        return gcs_read_json(path)
    return None

def save_cache(sid, data):
    gcs_write_json(f"resultados/{sid}_cache.json", data)

# =============================================================================
#  ROUTES — PAGES
# =============================================================================

@app.route("/")
def index():
    try:
        subjects = get_subjects()
    except Exception:
        subjects = []
    return render_template("index.html", subjects=subjects)

@app.route("/subject/<sid>")
def subject_view(sid):
    try:
        subjects = get_subjects()
        sub = next((s for s in subjects if s["id"]==sid), None)
        # Si no existe en GCS aún pero se acaba de crear, construirlo
        if not sub:
            sub = {"id": sid, "name": sid.upper(), "pdf_count": 0, "has_cache": False}
    except Exception:
        sub = {"id": sid, "name": sid.upper(), "pdf_count": 0, "has_cache": False}
    return render_template("subject.html", subject=sub)

# =============================================================================
#  API — SUBJECTS
# =============================================================================

@app.route("/api/subjects", methods=["POST"])
def create_subject():
    body = request.json or {}
    name = body.get("name","").strip().lower().replace(" ","_")
    if not name or len(name) < 1:
        return jsonify({"error": "Nombre requerido"}), 400
    # Crear un marcador en GCS para que el subject exista
    gcs_write_text(f"examenes/{name}/.keep", "")
    return jsonify({"success": True, "id": name})

# =============================================================================
#  API — UPLOAD PDFs
# =============================================================================

@app.route("/api/upload/<sid>", methods=["POST"])
def upload_pdfs(sid):
    if 'files' not in request.files:
        return jsonify({"error": "No se enviaron archivos"}), 400

    saved  = []
    errors = []
    for f in request.files.getlist('files'):
        if not f.filename: continue
        if not allowed_file(f.filename):
            errors.append(f"{f.filename}: solo PDFs"); continue
        name = secure_filename(f.filename)
        try:
            gcs_write(f"examenes/{sid}/{name}", f.read(), 'application/pdf')
            saved.append(name)
        except Exception as e:
            errors.append(f"{f.filename}: {e}")

    if not saved and errors:
        return jsonify({"error": "; ".join(errors)}), 400
    return jsonify({"success": True, "saved": saved, "errors": errors})

@app.route("/api/pdfs/<sid>")
def list_pdfs(sid):
    blobs = gcs_list(f"examenes/{sid}/")
    pdfs  = [b.split('/')[-1] for b in blobs if b.endswith('.pdf')]
    return jsonify({"pdfs": sorted(pdfs)})

@app.route("/api/pdfs/<sid>/<filename>", methods=["DELETE"])
def delete_pdf(sid, filename):
    gcs_delete(f"examenes/{sid}/{secure_filename(filename)}")
    return jsonify({"success": True})

# =============================================================================
#  API — ANALYSE
# =============================================================================

@app.route("/api/analyze/<sid>", methods=["POST"])
def analyze_subject(sid):
    exam_text = extract_pdfs_text_from_gcs(sid)
    ok, err   = validate_pdf_text(exam_text, "los exámenes")
    if not ok: return jsonify({"error": err}), 400

    client = get_client()
    prompt = f"""Eres un examinador experto en {sid.upper()} de la FIB (UPC).
Analiza estos exámenes históricos y extrae los patrones de preguntas más frecuentes.

{FORMAT_RULES}

EXÁMENES:
{exam_text[:40000]}

Responde SOLO con JSON válido:
{{
  "subject": "{sid.upper()}",
  "patterns": [{{
    "id": 1, "title": "...", "frequency": 90, "difficulty": "Alta",
    "description": "...", "key_concepts": ["..."],
    "how_to_answer": "...", "common_mistakes": ["..."],
    "example_question": "..."
  }}],
  "cheat_sheet": "Markdown denso con LaTeX y bloques de código.",
  "study_tips": ["..."]
}}
Entre 4 y 7 patrones."""

    try:
        r    = client.models.generate_content(
            model=MODEL, contents=prompt,
            config=types.GenerateContentConfig(temperature=0.2, max_output_tokens=8000, response_mime_type="application/json")
        )
        data = parse_llm_json(r.text)
        save_cache(sid, data)
        return jsonify({"success": True, "data": data})
    except Exception as e:
        return jsonify({"error": f"Error analizando: {e}"}), 500

@app.route("/api/cache/<sid>")
def get_cache(sid):
    data = load_cache(sid)
    return jsonify({"success": True, "data": data}) if data else (jsonify({"success": False}), 404)

# =============================================================================
#  API — FLASHCARDS (ruta fija ANTES de la dinámica)
# =============================================================================

@app.route("/api/flashcards/update", methods=["POST"])
def update_flashcard_progress():
    body = request.json or {}
    sid, card_id, rating = body.get("subject_id"), body.get("card_id"), body.get("rating")
    if not sid or card_id is None or rating not in ("easy","medium","hard"):
        return jsonify({"error": "Params: subject_id, card_id, rating"}), 400
    con = sqlite3.connect(DB_PATH)
    con.execute("INSERT OR REPLACE INTO flashcard_progress VALUES (null,?,?,?,?)",
                (sid, card_id, rating, datetime.now().isoformat()))
    con.commit(); con.close()
    return jsonify({"success": True})

@app.route("/api/flashcards/<sid>")
def get_flashcards(sid):
    cache = load_cache(sid)
    if not cache: return jsonify({"error": "Primero analiza la asignatura"}), 404
    client = get_client()
    prompt = f"""Patrones de {sid.upper()}:
{json.dumps(cache["patterns"], ensure_ascii=False)}

{FORMAT_RULES}

Genera exactamente 12 flashcards. Responde SOLO con JSON:
[{{"id":1,"front":"...","back":"...","category":"...","difficulty":"Fácil|Media|Difícil"}}]"""
    try:
        r = client.models.generate_content(
            model=MODEL, contents=prompt,
            config=types.GenerateContentConfig(temperature=0.3, max_output_tokens=4000, response_mime_type="application/json")
        )
        return jsonify({"success": True, "flashcards": parse_llm_json(r.text)})
    except Exception as e:
        return jsonify({"error": f"Error: {e}"}), 500

# =============================================================================
#  API — EXAM
# =============================================================================

@app.route("/api/exam/generate/<sid>", methods=["POST"])
def generate_exam(sid):
    cache = load_cache(sid)
    if not cache: return jsonify({"error": "Primero analiza"}), 404
    diff = request.json.get("difficulty","mixed")
    nq   = request.json.get("n_questions", 5)
    client = get_client()
    ps = json.dumps([{"title":p["title"],"example":p["example_question"],"how":p["how_to_answer"]}
                     for p in cache["patterns"]], ensure_ascii=False)
    prompt = f"""Profesor de {sid.upper()} FIB. {FORMAT_RULES}
Patrones: {ps}
Genera {nq} preguntas. Dificultad: {diff}.
JSON:
{{"exam_title":"Simulacro — {sid.upper()}","duration_minutes":{nq*15},"questions":[
  {{"id":1,"text":"...","type":"desarrollo|calculo|implementacion|teoria","points":2,
    "pattern":"...","hint":"...","model_answer":"...","grading_criteria":["..."]}}
]}}"""
    try:
        r = client.models.generate_content(
            model=MODEL, contents=prompt,
            config=types.GenerateContentConfig(temperature=0.7, max_output_tokens=5000, response_mime_type="application/json")
        )
        return jsonify({"success": True, "exam": parse_llm_json(r.text)})
    except Exception as e:
        return jsonify({"error": f"Error: {e}"}), 500

@app.route("/api/exam/grade", methods=["POST"])
def grade_exam():
    data = request.json or {}
    sid  = data.get("subject_id")
    qs   = data.get("questions", [])
    if not qs: return jsonify({"error": "Sin respuestas"}), 400
    client = get_client()
    qa = ""
    for i,q in enumerate(qs,1):
        qa += f"\nPREGUNTA {i} ({q.get('points',2)} pts):\n{q.get('question_text','')}\n" \
              f"CRITERIOS:\n{chr(10).join(q.get('grading_criteria',[]))}\n" \
              f"MODELO:\n{q.get('model_answer','')}\nALUMNO:\n{q.get('user_answer','') or '[Sin responder]'}\n---"
    prompt = f"""Corrector de {sid} FIB.\n{qa}\nJSON:
{{"results":[{{"question_id":1,"score":1.5,"max_score":2,"feedback":"...","what_was_right":"...","what_was_wrong":"...","correct_approach":"..."}}],
  "total_score":7.5,"max_score":10,"grade":"Notable","global_feedback":"...","recommended_patterns":["..."]}}"""
    try:
        r = client.models.generate_content(
            model=MODEL, contents=prompt,
            config=types.GenerateContentConfig(temperature=0.1, max_output_tokens=4000, response_mime_type="application/json")
        )
        result = parse_llm_json(r.text)
        try:
            save_exam_result(sid, result.get("total_score",0), result.get("max_score",10),
                             result.get("grade","-"), len(qs))
        except: pass
        return jsonify({"success": True, "result": result})
    except Exception as e:
        return jsonify({"error": f"Error: {e}"}), 500

# =============================================================================
#  API — STATS & CHAT
# =============================================================================

@app.route("/api/stats/<sid>")
def get_stats(sid):
    try: return jsonify({"success": True, "stats": get_subject_stats(sid)})
    except Exception as e: return jsonify({"error": str(e)}), 500

@app.route("/api/chat/<sid>", methods=["POST"])
def chat(sid):
    msg     = request.json.get("message","")
    history = request.json.get("history",[])
    if not msg: return jsonify({"error": "Mensaje vacío"}), 400
    cache   = load_cache(sid)
    ctx     = ""
    if cache:
        ctx  = f"Patrones: {json.dumps(cache['patterns'][:3], ensure_ascii=False)}\n"
        ctx += f"Cheat: {cache.get('cheat_sheet','')[:2000]}"
    client = get_client()
    system = f"""Tutor de {sid.upper()} FIB. Esquema: concepto → por qué importa → cómo cae en el examen.
{FORMAT_RULES}
{ctx}"""
    contents = [types.Content(role=m["role"], parts=[types.Part(text=m["content"])]) for m in history[-6:]]
    contents.append(types.Content(role="user", parts=[types.Part(text=msg)]))
    def gen():
        try:
            for chunk in client.models.generate_content_stream(
                model=MODEL, contents=contents,
                config=types.GenerateContentConfig(system_instruction=system, temperature=0.5, max_output_tokens=2000)
            ):
                if chunk.text: yield f"data: {json.dumps({'text':chunk.text})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error':str(e)})}\n\n"
    return Response(stream_with_context(gen()), mimetype="text/event-stream")

# =============================================================================
#  ENTRY POINT
# =============================================================================

if __name__ == "__main__":
    init_db()
    port  = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_ENV") == "development"
    print(f"\n  Academia Personal → http://localhost:{port}\n")
    app.run(host="0.0.0.0", port=port, debug=debug)
else:
    init_db()
