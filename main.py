"""
Academia Personal — Backend Flask (Versión SaaS Cloud-Ready)
=========================================================
Uso Local:   python main.py
Uso Cloud:   gunicorn main:app
"""

import os
import json
import re
import time
import sqlite3
from datetime import datetime
from pathlib import Path
from flask import Flask, render_template, jsonify, request, stream_with_context, Response

from google import genai
from google.genai import types
from pypdf import PdfReader
from json_repair import repair_json

app = Flask(__name__)

BASE_DIR       = Path(__file__).parent
DIR_RESULTADOS = BASE_DIR / "data" / "resultados"
DIR_RESULTADOS.mkdir(parents=True, exist_ok=True)

DB_PATH = BASE_DIR / "data" / "progress.db"
MODEL   = "gemini-2.5-flash"
MIN_PDF_CHARS = 200

FORMAT_RULES = """
REGLAS DE FORMATO OBLIGATORIAS (sin excepción):
- Cualquier expresión matemática o complejidad algorítmica DEBE escribirse en LaTeX inline: $O(n \\log n)$, $T(n) = 2T(n/2) + O(n)$, etc.
- Cualquier fragmento de código o pseudocódigo DEBE ir en un bloque de código Markdown con el lenguaje especificado: ```cpp ... ``` o ```python ... ```.
- NO uses notación plana como O(n log n) o T(n)=... fuera de LaTeX.
"""

# =============================================================================
#  REINTENTO AUTOMÁTICO PARA GEMINI (503 / rate limit / timeout)
# =============================================================================

def gemini_generate(client, contents, config, retries=4, delay=15):
    """Llama a Gemini con reintentos automáticos ante errores 503/429/timeout."""
    last_err = None
    for attempt in range(retries):
        try:
            return client.models.generate_content(
                model=MODEL, contents=contents, config=config
            )
        except Exception as e:
            last_err = e
            err_str = str(e)
            # Reintentar solo en errores transitorios
            if any(code in err_str for code in ("503", "429", "UNAVAILABLE", "RESOURCE_EXHAUSTED", "timeout")):
                if attempt < retries - 1:
                    wait = delay * (attempt + 1)  # backoff: 15s, 30s, 45s
                    print(f"[gemini_generate] intento {attempt+1}/{retries} fallido ({err_str[:80]}). Reintentando en {wait}s...")
                    time.sleep(wait)
                    continue
            raise  # Error no transitorio → propagar inmediatamente
    raise RuntimeError(f"Gemini no disponible tras {retries} intentos: {last_err}")


# =============================================================================
#  BASE DE DATOS DE PROGRESO
# =============================================================================

def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.executescript("""
        CREATE TABLE IF NOT EXISTS exam_results (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_id  TEXT    NOT NULL,
            date        TEXT    NOT NULL,
            total_score REAL    NOT NULL,
            max_score   REAL    NOT NULL,
            grade       TEXT    NOT NULL,
            n_questions INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS flashcard_progress (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_id  TEXT    NOT NULL,
            card_id     INTEGER NOT NULL,
            rating      TEXT    NOT NULL,
            date        TEXT    NOT NULL,
            UNIQUE(subject_id, card_id) ON CONFLICT REPLACE
        );
    """)
    con.commit()
    con.close()
init_db()


def save_exam_result(subject_id, total_score, max_score, grade, n_questions):
    con = sqlite3.connect(DB_PATH)
    con.execute(
        "INSERT INTO exam_results (subject_id, date, total_score, max_score, grade, n_questions) VALUES (?,?,?,?,?,?)",
        (subject_id, datetime.now().isoformat(), total_score, max_score, grade, n_questions)
    )
    con.commit()
    con.close()


def get_subject_stats(subject_id):
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row

    rows = con.execute(
        "SELECT date, total_score, max_score, grade FROM exam_results WHERE subject_id=? ORDER BY date ASC LIMIT 20",
        (subject_id,)
    ).fetchall()
    history = [dict(r) for r in rows]

    avg_row = con.execute(
        "SELECT AVG(total_score * 10.0 / max_score) as avg FROM exam_results WHERE subject_id=?",
        (subject_id,)
    ).fetchone()
    avg_score = round(avg_row["avg"], 2) if avg_row["avg"] else None

    fc_rows = con.execute(
        "SELECT rating, COUNT(*) as cnt FROM flashcard_progress WHERE subject_id=? GROUP BY rating",
        (subject_id,)
    ).fetchall()
    fc_stats = {r["rating"]: r["cnt"] for r in fc_rows}

    total_exams = con.execute(
        "SELECT COUNT(*) as cnt FROM exam_results WHERE subject_id=?", (subject_id,)
    ).fetchone()["cnt"]

    con.close()
    return {
        "exam_history": history,
        "avg_score":    avg_score,
        "flashcards":   fc_stats,
        "total_exams":  total_exams,
    }

# =============================================================================
#  PARSEO ROBUSTO DE JSON
# =============================================================================

def parse_llm_json(raw: str):
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    cleaned = raw.strip()
    cleaned = re.sub(r"^```json\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^```\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    cleaned = cleaned.strip()

    first = min((cleaned.find(c) for c in ('{', '[') if cleaned.find(c) != -1), default=0)
    if first > 0:
        cleaned = cleaned[first:]
    last = max(cleaned.rfind('}'), cleaned.rfind(']'))
    if last != -1 and last < len(cleaned) - 1:
        cleaned = cleaned[:last + 1]

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    repaired = repair_json(cleaned, return_objects=True)
    if repaired is None or repaired == "" or repaired == {} or repaired == []:
        raise ValueError(f"No se pudo parsear el JSON. Inicio: {repr(raw[:300])}")
    return repaired

# =============================================================================
#  UTILIDADES
# =============================================================================

def validate_pdf_text(text, context="los PDFs"):
    if not text or len(text.strip()) < MIN_PDF_CHARS:
        return False, (
            f"No se encontró suficiente texto legible en {context} "
            f"(mínimo {MIN_PDF_CHARS} caracteres). "
            "Es posible que los PDFs sean imágenes escaneadas sin OCR. "
            "Pásalos por un OCR antes de subirlos."
        )
    return True, ""


def get_client():
    api_key = os.environ.get("GOOGLE_API_KEY", "")
    if not api_key:
        raise ValueError("GOOGLE_API_KEY no encontrada. Configúrala en tu entorno de Windows o Render.")
    return genai.Client(api_key=api_key)


def get_subjects():
    subjects = []
    if DIR_RESULTADOS.exists():
        for file in DIR_RESULTADOS.glob("*_cache.json"):
            sub_id = file.stem.replace("_cache", "")
            subjects.append({
                "id":        sub_id,
                "name":      sub_id.upper(),
                "pdf_count": 0,
                "has_cache": True,
            })
    return subjects


def load_cache(subject_id):
    cache_file = DIR_RESULTADOS / f"{subject_id}_cache.json"
    if cache_file.exists():
        with open(cache_file, encoding="utf-8") as f:
            return json.load(f, strict=False)
    return None


def save_cache(subject_id, data):
    cache_file = DIR_RESULTADOS / f"{subject_id}_cache.json"
    with open(cache_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

# =============================================================================
#  RUTAS PRINCIPALES
# =============================================================================

@app.route("/")
def index():
    return render_template("index.html", subjects=get_subjects())


@app.route("/subject/<subject_id>")
def subject_view(subject_id):
    subject_id = subject_id.lower().strip()
    cache_file = DIR_RESULTADOS / f"{subject_id}_cache.json"
    subject = {
        "id":        subject_id,
        "name":      subject_id.upper(),
        "pdf_count": 0,
        "has_cache": cache_file.exists()
    }
    return render_template("subject.html", subject=subject)

# =============================================================================
#  API: ANÁLISIS DE PATRONES (CLOUD MULTI-USER UPLOAD)
# =============================================================================

@app.route("/api/analyze/<subject_id>", methods=["POST"])
def analyze_subject(subject_id):
    if 'files' not in request.files:
        return jsonify({"error": "No se han seleccionado archivos para analizar"}), 400

    uploaded_files = request.files.getlist('files')
    if not uploaded_files or uploaded_files[0].filename == '':
        return jsonify({"error": "No se han seleccionado archivos válidos"}), 400

    texts = []
    for file in uploaded_files:
        if file and file.filename.endswith('.pdf'):
            try:
                reader = PdfReader(file)
                text = "\n".join(p.extract_text() or "" for p in reader.pages).strip()
                if text:
                    texts.append(f"=== {file.filename} ===\n{text}")
            except Exception as e:
                return jsonify({"error": f"Error leyendo {file.filename}: {e}"}), 500

    exam_text = "\n\n".join(texts)
    ok, err   = validate_pdf_text(exam_text, "los exámenes subidos")
    if not ok:
        return jsonify({"error": err}), 400

    client = get_client()

    prompt_patterns = f"""Eres un examinador experto en la asignatura {subject_id.upper()} de la FIB (UPC).
Analiza TODOS estos exámenes históricos con MÁXIMO DETALLE y extrae los patrones de preguntas.

{FORMAT_RULES}

EXÁMENES HISTÓRICOS:
{exam_text[:40000]}

INSTRUCCIONES CRÍTICAS:
- Extrae ENTRE 5 Y 7 patrones distintos. NUNCA menos de 5.
- Cada patrón debe tener description de al menos 3 frases explicando el tipo de pregunta.
- how_to_answer debe ser un párrafo denso con el método de resolución paso a paso.
- key_concepts: mínimo 4 conceptos por patrón.
- common_mistakes: mínimo 3 errores frecuentes por patrón.
- example_question: una pregunta representativa y concreta del examen.
- frequency: porcentaje real basado en cuántas veces aparece en los exámenes (0-100).
- difficulty: exactamente uno de estos valores: Easy, Medium, Hard."""

    try:
        # Llamada 1: patrones + study_tips con schema estricto
        # (cheat_sheet excluido del schema para que Gemini no lo trunce)
        response_patterns = gemini_generate(
            client,
            contents=prompt_patterns,
            config=types.GenerateContentConfig(
                temperature=0.2,
                max_output_tokens=8000,
                response_mime_type="application/json",
                response_schema={
                    "type": "OBJECT",
                    "properties": {
                        "subject": {"type": "STRING"},
                        "patterns": {
                            "type": "ARRAY",
                            "items": {
                                "type": "OBJECT",
                                "properties": {
                                    "id":               {"type": "INTEGER"},
                                    "title":            {"type": "STRING"},
                                    "frequency":        {"type": "INTEGER"},
                                    "difficulty":       {"type": "STRING"},
                                    "description":      {"type": "STRING"},
                                    "key_concepts":     {"type": "ARRAY", "items": {"type": "STRING"}},
                                    "how_to_answer":    {"type": "STRING"},
                                    "common_mistakes":  {"type": "ARRAY", "items": {"type": "STRING"}},
                                    "example_question": {"type": "STRING"}
                                },
                                "required": ["id", "title", "frequency", "difficulty", "description", "how_to_answer"]
                            }
                        },
                        "study_tips": {"type": "ARRAY", "items": {"type": "STRING"}}
                    },
                    "required": ["subject", "patterns", "study_tips"]
                }
            )
        )
        raw_text = getattr(response_patterns, "text", None) or ""
        print("RAW PATTERNS:", raw_text[:300])
        if not raw_text.strip():
            return jsonify({"error": "Gemini no devolvió contenido. Inténtalo de nuevo."}), 500

        data = parse_llm_json(raw_text)

        if not data.get("patterns"):
            return jsonify({"error": "No se detectaron patrones. Asegúrate de subir PDFs con texto legible."}), 500

        # Llamada 2: cheat_sheet en Markdown libre, tokens dedicados, sin schema
        prompt_cheat = f"""Eres un examinador experto en {subject_id.upper()} de la FIB (UPC).
Genera una cheat sheet MUY COMPLETA Y DENSA para el examen final, basada en estos exámenes históricos.

{FORMAT_RULES}

EXÁMENES HISTÓRICOS:
{exam_text[:40000]}

INSTRUCCIONES CRÍTICAS — SIGUE ESTO AL PIE DE LA LETRA:
- La cheat sheet debe cubrir TODOS los temas que aparecen en los exámenes sin excepción.
- Estructura con secciones Markdown claras (## para cada tema principal, ### para subtemas).
- Cada sección debe incluir: definición formal, propiedades clave, fórmulas en $LaTeX$, y ejemplo concreto.
- Para algoritmos: incluye pseudocódigo en bloque de código, complejidad temporal y espacial en $LaTeX$.
- Mínimo 800 palabras de contenido útil. Sé extremadamente denso y técnico.
- NO incluyas introducciones ni conclusiones. Ve directo al contenido técnico.
- Responde ÚNICAMENTE con Markdown. Sin JSON, sin explicaciones previas."""

        response_cheat = gemini_generate(
            client,
            contents=prompt_cheat,
            config=types.GenerateContentConfig(temperature=0.1, max_output_tokens=8192)
        )
        data["cheat_sheet"] = response_cheat.text.strip()

        if not data["cheat_sheet"]:
            return jsonify({"error": "No se pudo generar la Cheat Sheet. Inténtalo de nuevo."}), 500

        save_cache(subject_id, data)
        return jsonify({"success": True, "data": data})

    except Exception as e:
        return jsonify({"error": f"Error analizando: {e}"}), 500


@app.route("/api/cache/<subject_id>")
def get_cache(subject_id):
    data = load_cache(subject_id)
    if data:
        return jsonify({"success": True, "data": data})
    return jsonify({"success": False}), 404

# =============================================================================
#  API: FLASHCARDS
# =============================================================================

@app.route("/api/flashcards/update", methods=["POST"])
def update_flashcard_progress():
    body       = request.json or {}
    subject_id = body.get("subject_id")
    card_id    = body.get("card_id")
    rating     = body.get("rating")

    if not subject_id or card_id is None or rating not in ("easy", "medium", "hard"):
        return jsonify({"error": "Parámetros inválidos."}), 400

    try:
        con = sqlite3.connect(DB_PATH)
        con.execute(
            "INSERT OR REPLACE INTO flashcard_progress (subject_id, card_id, rating, date) VALUES (?,?,?,?)",
            (subject_id, card_id, rating, datetime.now().isoformat())
        )
        con.commit()
        con.close()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/flashcards/<subject_id>")
def get_flashcards(subject_id):
    cache = load_cache(subject_id)
    if not cache:
        return jsonify({"error": "Primero analiza la asignatura"}), 404

    client           = get_client()
    patterns_summary = json.dumps(cache["patterns"], ensure_ascii=False)

    prompt = f"""A partir de estos patrones de examen de {subject_id.upper()}:

{patterns_summary}

{FORMAT_RULES}

Genera exactamente 12 flashcards de estudio. Usa $LaTeX$ para fórmulas matemáticas
y bloques de código Markdown para algoritmos cuando sea necesario.

Responde ÚNICAMENTE con un array JSON válido:

[
  {{
    "id": 1,
    "front": "Pregunta o concepto a memorizar (concisa). Usa $LaTeX$ si hay fórmulas.",
    "back": "Respuesta completa y útil para el examen. Usa $LaTeX$ y bloques de código.",
    "category": "nombre del patrón al que pertenece",
    "difficulty": "Fácil|Media|Difícil"
  }}
]"""

    try:
        response = gemini_generate(
            client,
            contents=prompt,
            config=types.GenerateContentConfig(temperature=0.3, max_output_tokens=4000, response_mime_type="application/json")
        )
        cards = parse_llm_json(response.text)
        return jsonify({"success": True, "flashcards": cards})
    except Exception as e:
        return jsonify({"error": f"Error generando flashcards: {e}"}), 500

# =============================================================================
#  API: SIMULACRO DE EXAMEN
# =============================================================================

@app.route("/api/exam/generate/<subject_id>", methods=["POST"])
def generate_exam(subject_id):
    cache = load_cache(subject_id)
    if not cache:
        return jsonify({"error": "Primero analiza la asignatura"}), 404

    difficulty  = request.json.get("difficulty", "mixed")
    n_questions = request.json.get("n_questions", 5)
    client      = get_client()

    # Acceso seguro a example_question (campo opcional)
    patterns_summary = json.dumps(
        [{"title": p["title"], "example": p.get("example_question", ""), "how": p["how_to_answer"]}
         for p in cache["patterns"]], ensure_ascii=False
    )

    prompt = f"""Eres un profesor de {subject_id.upper()} de la FIB (UPC) creando un examen real.

{FORMAT_RULES}

Patrones de preguntas conocidos:
{patterns_summary}

Genera un examen con exactamente {n_questions} preguntas. Dificultad: {difficulty}.
Usa $LaTeX$ para todas las fórmulas matemáticas y bloques de código para algoritmos.

Responde ÚNICAMENTE con JSON válido:

{{
  "exam_title": "Simulacro de Examen — {subject_id.upper()}",
  "duration_minutes": {n_questions * 15},
  "questions": [
    {{
      "id": 1,
      "text": "Enunciado completo. Usa $LaTeX$ para fórmulas.",
      "type": "desarrollo|calculo|implementacion|teoria",
      "points": 2,
      "pattern": "patrón al que pertenece",
      "hint": "Una pista sutil si el alumno se bloquea",
      "model_answer": "Respuesta modelo completa. Usa $LaTeX$ y bloques de código.",
      "grading_criteria": ["criterio1", "criterio2", "criterio3"]
    }}
  ]
}}"""

    try:
        response = gemini_generate(
            client,
            contents=prompt,
            config=types.GenerateContentConfig(temperature=0.7, max_output_tokens=5000, response_mime_type="application/json")
        )
        exam = parse_llm_json(response.text)
        return jsonify({"success": True, "exam": exam})
    except Exception as e:
        return jsonify({"error": f"Error generando examen: {e}"}), 500

# =============================================================================
#  API: CORRECCIÓN DE EXAMEN
# =============================================================================

@app.route("/api/exam/grade", methods=["POST"])
def grade_exam():
    data       = request.json or {}
    subject_id = data.get("subject_id")
    questions  = data.get("questions", [])

    if not questions:
        return jsonify({"error": "No hay respuestas para corregir"}), 400

    client  = get_client()
    qa_text = ""
    for i, q in enumerate(questions, 1):
        qa_text += f"""
PREGUNTA {i} ({q.get('points', 2)} puntos):
{q.get('question_text', '')}

CRITERIOS DE CORRECCIÓN:
{chr(10).join(q.get('grading_criteria', []))}

RESPUESTA MODELO:
{q.get('model_answer', '')}

RESPUESTA DEL ALUMNO:
{q.get('user_answer', '') or '[Sin responder]'}

---"""

    prompt = f"""Eres un corrector estricto pero justo de {subject_id.upper()} en la FIB.

{qa_text}

Corrige cada pregunta. Responde ÚNICAMENTE con JSON válido:

{{
  "results": [
    {{
      "question_id": 1,
      "score": 1.5,
      "max_score": 2,
      "feedback": "Feedback detallado",
      "what_was_right": "Puntos positivos",
      "what_was_wrong": "Qué faltó o estuvo incorrecto",
      "correct_approach": "Cómo debería haberse respondido"
    }}
  ],
  "total_score": 7.5,
  "max_score": 10,
  "grade": "Notable",
  "global_feedback": "Feedback global",
  "recommended_patterns": ["patrón 1", "patrón 2"]
}}"""

    try:
        response = gemini_generate(
            client,
            contents=prompt,
            config=types.GenerateContentConfig(temperature=0.1, max_output_tokens=4000, response_mime_type="application/json")
        )
        result = parse_llm_json(response.text)

        try:
            save_exam_result(
                subject_id  = subject_id,
                total_score = result.get("total_score", 0),
                max_score   = result.get("max_score", 10),
                grade       = result.get("grade", "-"),
                n_questions = len(questions),
            )
        except Exception:
            pass

        return jsonify({"success": True, "result": result})
    except Exception as e:
        return jsonify({"error": f"Error corrigiendo examen: {e}"}), 500

# =============================================================================
#  API: ESTADÍSTICAS DE PROGRESO
# =============================================================================

@app.route("/api/stats/<subject_id>")
def get_stats(subject_id):
    try:
        stats = get_subject_stats(subject_id)
        return jsonify({"success": True, "stats": stats})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# =============================================================================
#  API: CHAT CON LA ASIGNATURA
# =============================================================================

@app.route("/api/chat/<subject_id>", methods=["POST"])
def chat_with_subject(subject_id):
    user_message = request.json.get("message", "")
    history      = request.json.get("history", [])

    if not user_message:
        return jsonify({"error": "Mensaje vacío"}), 400

    cache   = load_cache(subject_id)
    context = ""
    if cache:
        context  = f"Patrones detectados: {json.dumps(cache['patterns'][:3], ensure_ascii=False)}\n"
        context += f"Cheat sheet: {cache.get('cheat_sheet', '')[:2000]}"

    client = get_client()
    system = f"""Eres el tutor personal de {subject_id.upper()} de la FIB (UPC).
Tu misión: explicar conceptos de forma clara, directa y orientada al examen.
Cuando expliques algo, sigue siempre este esquema: concepto → por qué importa → cómo cae en el examen.

{FORMAT_RULES}

Usa $LaTeX$ para TODAS las fórmulas (complejidades, recurrencias, demostraciones).
Usa bloques de código Markdown con el lenguaje especificado para cualquier fragmento de código o pseudocódigo.

Contexto de la asignatura:
{context}"""

    contents = []
    for msg in history[-6:]:
        contents.append(types.Content(role=msg["role"], parts=[types.Part(text=msg["content"])]))
    contents.append(types.Content(role="user", parts=[types.Part(text=user_message)]))

    def generate():
        try:
            stream = client.models.generate_content_stream(
                model=MODEL, contents=contents,
                config=types.GenerateContentConfig(system_instruction=system, temperature=0.5, max_output_tokens=2000)
            )
            for chunk in stream:
                if chunk.text:
                    yield f"data: {json.dumps({'text': chunk.text})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return Response(stream_with_context(generate()), mimetype="text/event-stream")


if __name__ == "__main__":
    init_db()
    app.run(debug=True, port=5000)
