# مُدرِّسي — Arabic AI Conversation Tutor

A complete, production-quality web application for learning Arabic through real-time spoken conversation. Students speak into their microphone, and the system:

1. Transcribes speech to text using **OpenAI Whisper** (local)
2. Corrects grammar mistakes and explains them using **Claude API**
3. Generates an improved sentence and a follow-up conversation question
4. Converts the AI response back to speech using **gTTS**
5. Displays everything in a beautiful, RTL-ready Arabic UI

---

## 🗂️ Project Structure

```
project/
├── app.py                  ← Flask backend
├── templates/
│   └── index.html          ← Main UI template
├── static/
│   ├── style.css           ← Modern RTL-ready CSS
│   ├── script.js           ← MediaRecorder + fetch logic
│   └── audio/              ← Generated TTS files (auto-created)
├── requirements.txt
└── README.md
```

---

## ⚙️ Prerequisites

### 1. Python 3.10+
Make sure you have Python 3.10 or newer.

### 2. ffmpeg (required by Whisper)

**macOS:**
```bash
brew install ffmpeg
```

**Ubuntu / Debian:**
```bash
sudo apt update && sudo apt install -y ffmpeg
```

**Windows:**
Download from https://ffmpeg.org/download.html and add to PATH.

### 3. Claude API Key
Get your API key from https://console.anthropic.com

---

## 🚀 Setup & Run

### Step 1 — Clone / create the project folder

```bash
mkdir arabic-tutor && cd arabic-tutor
# copy all project files here
```

### Step 2 — Create a virtual environment

```bash
python -m venv venv
source venv/bin/activate        # macOS/Linux
venv\Scripts\activate           # Windows
```

### Step 3 — Install dependencies

```bash
pip install -r requirements.txt
```

> **Note:** The first `pip install` will download the Whisper package. The model itself (~140 MB for "base") is downloaded automatically on first launch.

### Step 4 — Set your Claude API key

**macOS/Linux:**
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

**Windows (PowerShell):**
```powershell
$env:ANTHROPIC_API_KEY="sk-ant-..."
```

Or create a `.env` file and load it with `python-dotenv` (optional).

### Step 5 — Run the app

```bash
python app.py
```

Open your browser at **http://localhost:5000**

---

## 🎙️ How to Use

1. Click the **microphone button** in the center of the page
2. Allow microphone access when prompted
3. **Speak in Arabic** — any topic, any level
4. Click the mic button again to stop, or it auto-stops at 2 minutes
5. Click **"إرسال للتحليل"** (Send for Analysis)
6. Wait ~5–15 seconds for the AI to process
7. See:
   - 🗣️ What you said
   - ✅ / 🔴 The corrected sentence
   - 📚 Explanation of mistakes
   - ✨ A more stylistic version
   - 💬 A follow-up question (with audio!)
8. Click **"استمع للرد"** to hear the AI's question
9. Click **"سجّل رداً جديداً"** to continue the conversation

---

## 🔧 Configuration

### Whisper Model Size
In `app.py`, change the model to trade speed vs. accuracy:

| Model    | Size   | Speed   | Accuracy |
|----------|--------|---------|----------|
| `tiny`   | 39 MB  | Fastest | Lower    |
| `base`   | 74 MB  | Fast    | Good ✅  |
| `small`  | 244 MB | Medium  | Better   |
| `medium` | 769 MB | Slow    | Best     |

```python
whisper_model = whisper.load_model("base")  # change here
```

### Claude Model
In `app.py`, you can swap the Claude model:
```python
model="claude-opus-4-6"   # most powerful
model="claude-sonnet-4-6" # balanced speed/quality
```

---

## 🔒 Production Considerations

- Store `ANTHROPIC_API_KEY` in environment variables, never in code
- Periodically clean up `static/audio/` directory (TTS files accumulate)
- Use a WSGI server like **gunicorn** for production: `gunicorn app:app`
- Add rate limiting to the `/api/process` endpoint
- Consider adding user sessions for multi-turn conversation history

---

## 🐛 Common Issues

**"لم يتم التعرف على أي كلام"** — Whisper couldn't detect speech  
→ Speak louder and closer to the microphone; reduce background noise

**"خطأ في الاتصال بـ Claude API"** — API key issue  
→ Verify your `ANTHROPIC_API_KEY` is set correctly and has credit

**Microphone permission denied**  
→ Click the lock icon in your browser's address bar and allow microphone

**ffmpeg not found**  
→ Install ffmpeg and make sure it's in your system PATH

---

## 📦 Dependencies

| Package | Purpose |
|---------|---------|
| `flask` | Web framework |
| `anthropic` | Claude API client |
| `openai-whisper` | Local speech-to-text |
| `gTTS` | Google Text-to-Speech |
| `ffmpeg` | Audio processing (system install) |

---

## 📄 License

MIT License — free to use, modify, and distribute.
