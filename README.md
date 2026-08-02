<div align="center">

# 🎓 Personal Academy
### AI-Powered Exam Pattern Analyzer

Upload past exams. The AI finds the patterns that repeat every year, then generates a cheat sheet, flashcards, and a mock exam calibrated to your professor's actual style.

[![Live Demo](https://img.shields.io/badge/demo-live-2ea44f?style=for-the-badge&logo=googlecloud&logoColor=white)](https://academia-fib-846081440727.europe-west1.run.app/)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![Flask](https://img.shields.io/badge/Flask-3.1-000000?style=for-the-badge&logo=flask&logoColor=white)](https://flask.palletsprojects.com/)
[![Gemini](https://img.shields.io/badge/Gemini_2.5_Flash-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white)](https://ai.google.dev/)
[![Cloud Run](https://img.shields.io/badge/Cloud_Run-4285F4?style=for-the-badge&logo=googlecloud&logoColor=white)](https://cloud.google.com/run)

<!-- Replace with a 5-8s GIF of the flow: upload PDFs → Patterns → Cheat Sheet -->
<!-- <img src="docs/demo.gif" width="800" alt="Personal Academy demo"> -->

</div>

---

## The problem

Studying for an exam at FIB isn't about reviewing the whole syllabus. Every subject has a small, repeating set of exercise patterns that the professor reuses year after year. Finding them by hand, skimming 10-15 past PDFs, is exactly the slow, tedious work an LLM can do in seconds once it has the right context.

**Personal Academy automates that analysis.** Upload the exams, the AI extracts the recurring patterns, and everything else (cheat sheet, flashcards, mock exams) gets generated from that.

## What it does

| Module | What it generates |
|---|---|
| 🧩 **Patterns** | Automatic detection of recurring exercise types, with frequency, key concept, why it matters, and how it typically shows up in the exam |
| 📋 **Cheat Sheet** | Structured reference sheet with formulas, definitions and step-by-step methods per pattern, LaTeX rendered |
| 🗂️ **Flashcards** | Active-recall cards generated directly from the detected patterns, not generic filler |
| ⏱️ **Mock Exam** | Timed exam with questions calibrated to real difficulty, graded by AI with per-question feedback |
| 💬 **AI Chat** | Tutor with full context of the subject (patterns + cheat sheet) for quick questions, no need to re-explain from scratch |
| 📈 **Progress** | Dashboard tracking mock exam scores and per-pattern mastery over time |

## Tech stack

**Backend:** Python / Flask, streaming responses via Server-Sent Events (SSE) so long LLM answers don't block the UI.
**AI:** Gemini 2.5 Flash (`google-genai` SDK), structured JSON generation for patterns/flashcards/exams, streamed text for chat.
**Storage:** Google Cloud Storage for source PDFs, analysis cache, and per-user progress.
**Frontend:** Vanilla JavaScript, `marked.js` for Markdown, `KaTeX` for LaTeX, `Chart.js` for the progress dashboard.
**Infrastructure:** Docker + Gunicorn, deployed on **Google Cloud Run** with autoscaling and managed HTTPS.

## Engineering notes

A few things that didn't work on the first try, and why:

- **Silent JSON truncation.** Gemini 2.5 Flash reserves "thinking" tokens by default, which count against `max_output_tokens`. When generating long lists (12 flashcards), the JSON was getting cut mid-array, and the recovery parser (`json_repair`) silently returned only what had arrived intact: 2 cards instead of 12, with no visible error. Fixed by setting `thinking_budget=0` on structured-output calls.
- **Prompt contamination.** The chat endpoint was reusing format rules meant for JSON generation, and receiving pattern context as raw JSON. The model would literally respond in JSON when asked to "list the patterns." Split the JSON-generation rules (analyze/flashcards/exam) from conversational Markdown rules (chat).
- **Dark theme contrast bug.** A duplicated CSS block referenced variables that didn't exist in the actual design system, falling back to light-theme defaults: near-black text on a near-black background, invisible. Consolidated into a single source of truth for theme variables.

## Getting started

```bash
git clone https://github.com/daalmor/fib-ai-academy.git
cd fib-ai-academy
python -m venv venv
venv\Scripts\activate          # Windows
pip install -r requirements.txt
```

Create a `.env` file in the project root:
```
GOOGLE_API_KEY=your_gemini_api_key
GCS_BUCKET=your_gcs_bucket_name
```

```bash
python main.py
```

Open `http://localhost:5000`.

## Deployment

```bash
gcloud run deploy academia-fib \
  --source . \
  --region europe-west1 \
  --allow-unauthenticated \
  --memory 512Mi \
  --timeout 300 \
  --set-env-vars GCS_BUCKET=your_gcs_bucket_name \
  --set-secrets GOOGLE_API_KEY=GOOGLE_API_KEY:latest
```

The API key lives in Secret Manager, never as a plaintext environment variable.

## Usage

1. Create a subject and upload past exam PDFs
2. Hit **Analyze**. The AI detects the recurring patterns automatically
3. Review with the Cheat Sheet and Flashcards
4. Test yourself with the timed Mock Exam
5. Clear up quick questions with the AI Chat

---

<div align="center">

Built by [**Rubén**](https://github.com/daalmor), Computer Engineering student at FIB (UPC).
I use this every week to study for my own exams.

</div>
