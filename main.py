import os
import json
import tempfile
import subprocess
from pathlib import Path
from typing import List, Dict, Optional

from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from groq import Groq
from elevenlabs import ElevenLabs
import httpx

DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY", "").strip()
# -----------------------------------------------------------------------------
# Config (ENV vars on HF Spaces -> Settings -> Variables / Secrets)
# -----------------------------------------------------------------------------
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "").strip()

GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
WHISPER_MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")  # small/base/medium
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")

# This is the ElevenLabs output format we stream to the browser
# mp3_44100_128 is widely compatible with MSE.
ELEVEN_OUTPUT_FORMAT = os.environ.get("ELEVEN_OUTPUT_FORMAT", "mp3_44100_128")
ELEVEN_MODEL_ID = os.environ.get("ELEVEN_MODEL_ID", "eleven_multilingual_v2")

# -----------------------------------------------------------------------------
# App
# -----------------------------------------------------------------------------
app = FastAPI()

# Serve static frontend
app.mount("/static", StaticFiles(directory="static"), name="static")

# -----------------------------------------------------------------------------
# Global models/clients (production: load once)
# -----------------------------------------------------------------------------
whisper = WhisperModel(
    WHISPER_MODEL_NAME,
    device=WHISPER_DEVICE,
    compute_type=WHISPER_COMPUTE_TYPE,
)

groq_client: Optional[Groq] = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None
eleven_client: Optional[ElevenLabs] = ElevenLabs(api_key=ELEVENLABS_API_KEY) if ELEVENLABS_API_KEY else None


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


def _ffmpeg_to_wav_16k_mono(src_path: str) -> str:
    """
    Convert any audio file to wav 16k mono using ffmpeg.
    Returns path to wav file.
    """
    out_path = src_path + "_16k.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-i", src_path, "-ar", "16000", "-ac", "1", out_path],
        capture_output=True,
        check=False,
        timeout=60,
    )
    if Path(out_path).exists():
        return out_path
    return src_path  # fallback


def transcribe(file_path: str) -> str:
    segments, _ = whisper.transcribe(file_path, language="ar", beam_size=5)
    return " ".join(s.text for s in segments).strip()


def groq_chat_reply(
    history: List[Dict[str, str]],
    user_text: str,
    tutor_name: str,
) -> str:
    if not groq_client:
        return "⚠️ لم يتم ضبط GROQ_API_KEY على الخادم."

    # append user
    history.append({"role": "user", "content": user_text})
    # keep last 20
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
# Routes
# -----------------------------------------------------------------------------
@app.get("/")
def root():
    return FileResponse("static/index.html")


@app.get("/health")
def health():
    return JSONResponse(
        {
            "ok": True,
            "groq": bool(GROQ_API_KEY),
            "eleven": bool(ELEVENLABS_API_KEY),
            "whisper": {
                "model": WHISPER_MODEL_NAME,
                "device": WHISPER_DEVICE,
                "compute_type": WHISPER_COMPUTE_TYPE,
            },
        }
    )

@app.post("/stt")
async def stt(audio: UploadFile = File(...)):
    """
    Uses Deepgram Speech-to-Text API.
    Accepts audio/webm from browser.
    """

    if not DEEPGRAM_API_KEY:
        return {"text": ""}

    # Read audio bytes
    audio_bytes = await audio.read()

    url = "https://api.deepgram.com/v1/listen?model=nova-2&language=ar"

    headers = {
        "Authorization": f"Token {DEEPGRAM_API_KEY}",
        "Content-Type": "audio/webm"
    }

    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(url, headers=headers, content=audio_bytes)

    if response.status_code != 200:
        return {"text": ""}

    data = response.json()

    try:
        transcript = data["results"]["channels"][0]["alternatives"][0]["transcript"]
    except Exception:
        transcript = ""

    return {"text": transcript.strip()}
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

            # Stream MP3 chunks from ElevenLabs and forward to browser
            try:
                audio_stream = eleven_client.text_to_speech.stream(
                    voice_id=voice_id,
                    text=text,
                    model_id=ELEVEN_MODEL_ID,
                    output_format=ELEVEN_OUTPUT_FORMAT,
                )
                for chunk in audio_stream:
                    # chunk is bytes
                    await ws.send_bytes(chunk)

                # signal end of stream for this utterance
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
