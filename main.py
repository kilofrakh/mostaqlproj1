import os
import json
from pathlib import Path
from typing import List, Dict, Optional

import httpx
from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from groq import Groq
from elevenlabs import ElevenLabs

# -----------------------------------------------------------------------------
# Config (ENV vars in Railway Variables)
# -----------------------------------------------------------------------------
DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY", "").strip()
DEEPGRAM_MODEL = os.environ.get("DEEPGRAM_MODEL", "nova-2").strip()
DEEPGRAM_LANGUAGE = os.environ.get("DEEPGRAM_LANGUAGE", "ar").strip()

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "").strip()

GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile").strip()

# ElevenLabs streaming output format (good for MediaSource in browser)
ELEVEN_OUTPUT_FORMAT = os.environ.get("ELEVEN_OUTPUT_FORMAT", "mp3_44100_128").strip()
ELEVEN_MODEL_ID = os.environ.get("ELEVEN_MODEL_ID", "eleven_multilingual_v2").strip()

# -----------------------------------------------------------------------------
# App + Static
# -----------------------------------------------------------------------------
app = FastAPI()

BASE_DIR = Path(__file__).resolve().parent  # repo root
STATIC_DIR = BASE_DIR / "static"

if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
else:
    print(f"[WARN] Static directory not found: {STATIC_DIR}")

# -----------------------------------------------------------------------------
# Clients
# -----------------------------------------------------------------------------
groq_client: Optional[Groq] = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None
eleven_client: Optional[ElevenLabs] = ElevenLabs(api_key=ELEVENLABS_API_KEY) if ELEVENLABS_API_KEY else None

# -----------------------------------------------------------------------------
# Prompt
# -----------------------------------------------------------------------------
SYSTEM_PROMPT_TEMPLATE = """أنت مُعلِّمة لغة عربية متخصصة اسمك "{tutor_name}"، تعمل في معهد اللغة العربية.
مهمتك:
١. إجراء محادثة تعليمية طبيعية باللغة العربية الفصحى المعاصرة حصراً.
٢. تصحيح الأخطاء النحوية والصرفية بأسلوب لطيف وبنّاء.
٣. تشجيع الطالب باستمرار وتعزيز ثقته بنفسه.
٤. طرح سؤال واحد في نهاية كل رد للحفاظ على تدفق المحادثة.
قواعد صارمة:
- اللغة العربية الفصحى فقط، لا دارجة ولا إنجليزية إطلاقاً.
- لا تكرار للترحيب في كل رد.
- الردود موجزة: جملتان إلى أربع جمل.
- عند تصحيح خطأ: اذكر الصواب أولاً ثم اشرح ثم تابع.
- الأسلوب دافئ وصبور.
"""

def build_system_prompt(tutor_name: str) -> str:
    return SYSTEM_PROMPT_TEMPLATE.format(tutor_name=tutor_name)

def groq_chat_reply(history: List[Dict[str, str]], user_text: str, tutor_name: str) -> str:
    if not groq_client:
        return "⚠️ لم يتم ضبط GROQ_API_KEY على الخادم."

    history.append({"role": "user", "content": user_text})
    if len(history) > 20:
        history[:] = history[-20:]

    messages = [{"role": "system", "content": build_system_prompt(tutor_name)}] + history

    resp = groq_client.chat.completions.create(
        model=GROQ_MODEL,
        messages=messages,
        max_tokens=320,
        temperature=0.7,
        top_p=0.9,
    )
    reply = resp.choices[0].message.content.strip()

    history.append({"role": "assistant", "content": reply})
    if len(history) > 20:
        history[:] = history[-20:]
    return reply

# -----------------------------------------------------------------------------
# Deepgram STT
# -----------------------------------------------------------------------------
def _guess_content_type(upload: UploadFile) -> str:
    """
    Deepgram needs correct Content-Type. Browser MediaRecorder usually sends audio/webm.
    """
    if upload.content_type:
        return upload.content_type

    # fallback based on filename
    name = (upload.filename or "").lower()
    if name.endswith(".webm"):
        return "audio/webm"
    if name.endswith(".ogg"):
        return "audio/ogg"
    if name.endswith(".wav"):
        return "audio/wav"
    if name.endswith(".mp3"):
        return "audio/mpeg"
    return "application/octet-stream"

async def deepgram_transcribe(audio_bytes: bytes, content_type: str) -> str:
    if not DEEPGRAM_API_KEY:
        return ""

    # smart_format/punctuate helps readability
    url = (
        "https://api.deepgram.com/v1/listen"
        f"?model={DEEPGRAM_MODEL}"
        f"&language={DEEPGRAM_LANGUAGE}"
        "&smart_format=true&punctuate=true"
    )

    headers = {
        "Authorization": f"Token {DEEPGRAM_API_KEY}",
        "Content-Type": content_type,
    }

    async with httpx.AsyncClient(timeout=90) as client:
        r = await client.post(url, headers=headers, content=audio_bytes)

    if r.status_code != 200:
        # Useful debug message
        return ""

    data = r.json()
    try:
        return (data["results"]["channels"][0]["alternatives"][0]["transcript"] or "").strip()
    except Exception:
        return ""

# -----------------------------------------------------------------------------
# Routes
# -----------------------------------------------------------------------------
@app.get("/")
def root():
    return FileResponse(str(STATIC_DIR / "index.html"))

@app.get("/health")
def health():
    return JSONResponse(
        {
            "ok": True,
            "groq": bool(GROQ_API_KEY),
            "eleven": bool(ELEVENLABS_API_KEY),
            "deepgram": bool(DEEPGRAM_API_KEY),
            "deepgram_cfg": {"model": DEEPGRAM_MODEL, "language": DEEPGRAM_LANGUAGE},
        }
    )

@app.post("/stt")
async def stt(audio: UploadFile = File(...)):
    """
    Deepgram Speech-to-Text.
    Accepts audio/webm from browser MediaRecorder.
    """
    if not DEEPGRAM_API_KEY:
        return {"text": ""}

    audio_bytes = await audio.read()
    if not audio_bytes:
        return {"text": ""}

    content_type = _guess_content_type(audio)
    transcript = await deepgram_transcribe(audio_bytes, content_type)
    return {"text": transcript}

@app.post("/chat")
async def chat(payload: dict):
    """
    payload:
      {
        "history": [{"role":"user|assistant","content":"..."}],
        "user_text": "...",
        "tutor_name": "لورا",
        "voice_id": "...."
      }
    """
    history = payload.get("history", [])
    user_text = (payload.get("user_text") or "").strip()
    tutor_name = (payload.get("tutor_name") or "نور").strip()

    if not user_text:
        return {"reply": "لم أسمع شيئاً. هل تستطيع إعادة المحاولة؟", "history": history}

    reply = groq_chat_reply(history, user_text, tutor_name)
    return {"reply": reply, "history": history}

@app.websocket("/tts")
async def tts_ws(ws: WebSocket):
    """
    WebSocket: client sends JSON with {text, voice_id}
    server streams back binary mp3 chunks.
    """
    await ws.accept()

    if not eleven_client:
        await ws.send_text(json.dumps({"error": "ELEVENLABS_API_KEY not set"}))
        await ws.close()
        return

    try:
        while True:
            msg = await ws.receive_text()
            data = json.loads(msg)

            text = (data.get("text") or "").strip()
            voice_id = (data.get("voice_id") or "").strip()

            if not text or not voice_id:
                await ws.send_text(json.dumps({"error": "missing text/voice_id"}))
                continue

            try:
                audio_stream = eleven_client.text_to_speech.stream(
                    voice_id=voice_id,
                    text=text,
                    model_id=ELEVEN_MODEL_ID,
                    output_format=ELEVEN_OUTPUT_FORMAT,
                )
                for chunk in audio_stream:
                    await ws.send_bytes(chunk)

                await ws.send_text(json.dumps({"event": "end"}))

            except Exception as e:
                await ws.send_text(json.dumps({"error": f"elevenlabs: {str(e)}"}))

    except WebSocketDisconnect:
        return
    except Exception:
        try:
            await ws.close()
        except Exception:
            pass
