# ☁️ AI Personal Academy (FIB Exam Analyzer)

[![Live Demo](https://img.shields.io/badge/Demo-Live%20SaaS-0A84FF?style=for-the-badge)](TU_URL_DE_RENDER_AQUI)

**AI Personal Academy** is an intelligent learning companion that transforms raw, unstructured historical university exams into a comprehensive, hyper-personalized study platform. 

Built as a continuous value loop, it removes all technical friction for the student: just drag and drop your past papers, and the AI models your professor's testing style in seconds.

---

## ✨ Core Product Features

* **🔍 Exam Pattern Detection:** Upload your past tests to instantly see exactly which topics have the highest probability of appearing on your next exam, sorted by historical frequency and difficulty.
* **📝 Dynamic Cheat Sheets:** Get an exhaustive markdown summary of all core concepts, formulas, and step-by-step resolution templates needed to answer exam questions accurately.
* **🎴 Smart Spaced-Repetition Flashcards:** Study core definitions utilizing an integrated **SM-2 algorithmic progression** that tracks your confidence levels (Easy, Medium, Hard) to optimize active recall.
* **✍️ Exam Simulator & AI Grading:** Test your knowledge under real exam conditions. The platform generates custom questions based on historical syllabus data, accepts your text inputs, and delivers strict, fair grading out of 10 with granular actionable feedback.
* **💬 24/7 Contextual AI Tutor:** Stuck on a complex algorithm or recurrence relation? Ask the built-in streaming AI tutor any question to get immediate technical explanations tailored directly to your course guidelines.
* **📊 Student Telemetry Dashboard:** Track your preparation journey via visual analytics. Monitor your mock exam score evolution and track your flashcard mastery metrics over time.

---

## 🛠️ Tech Stack & Systems Architecture

* **Backend Core:** Python / Flask (Asynchronous server-side event streaming configuration for real-time generative chat routing).
* **AI Engine:** Google GenAI SDK (`gemini-2.5-flash`) utilizing custom system-instruction prompting and structured constraints to enforce strict JSON/LaTeX delivery schemas.
* **Data Layer:** SQLite relational database mapping historical mock exam results, performance metrics, and multi-user spaced repetition logs.
* **Frontend Layer:** Built with a premium, accessible Apple Dark Mode aesthetic. Powered by Vanilla JS (ES6+), `marked.js` for robust markdown rendering, `KaTeX` for native mathematical equation execution, and `Chart.js` for student performance analytics.
* **Distribution & Deployment:** Production-hardened utilizing a Linux-based Gunicorn WSGI gateway deployed natively on Render.

---

## 🚀 Quick Start for Users

1. **Select your Course:** Open the platform in your browser and choose the engineering subject you want to master.
2. **Upload Past Papers:** Drag and drop your university exam PDFs directly into the interactive dropzone.
3. **Train the System:** Click on **"Analyze uploaded exams"**. The platform reads the documents in memory, processes the tokens, and instantiates your personalized academy dashboard.
4. **Iterate & Master:** Practice with the flashcards, take custom mock exams, and watch your grade average move up on the live telemetry graph.
