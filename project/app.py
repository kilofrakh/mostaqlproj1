from dotenv import load_dotenv
load_dotenv()

import os
import json
import uuid
import re
from flask import Flask, request, jsonify, render_template, send_from_directory
from gtts import gTTS
from groq import Groq

app = Flask(__name__)

# ─── Configuration ────────────────────────────────────────────────────────────
AUDIO_OUTPUT_DIR = os.path.join(app.static_folder, "audio")
os.makedirs(AUDIO_OUTPUT_DIR, exist_ok=True)

groq_client = Groq(api_key=os.environ.get("GROQ_API_KEY", ""))

# ─── Prompt ───────────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """أنت مدرّس لغة عربية متخصص ومحترف. مهمتك تصحيح الجمل العربية وشرح الأخطاء وإجراء محادثة تعليمية مستمرة.

عندما يُرسل إليك نص عربي من المتعلم، يجب أن تُعيد JSON فقط بلا أي نص خارجه بالتنسيق التالي:

{
  "original": "الجملة الأصلية كما أرسلها المتعلم",
  "corrected": "الجملة المصحّحة إن كان هناك أخطاء أو نفس الجملة إن كانت صحيحة",
  "has_errors": true,
  "explanation": "شرح مختصر وواضح للأخطاء النحوية أو الإملائية إن وجدت أو عبارة تشجيعية إن كانت الجملة صحيحة",
  "improved": "نسخة محسّنة وأكثر أسلوبية من الجملة",
  "followup": "سؤال متابعة طبيعي ومحفّز يشجع المتعلم على الاستمرار في المحادثة"
}

قواعد: كن لطيفاً ومشجعاً. الشرح بالعربية الفصحى البسيطة. أعِد JSON صحيحاً فقط بلا markdown."""


# ─── Routes ───────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/static/audio/<filename>")
def serve_audio(filename):
    return send_from_directory(AUDIO_OUTPUT_DIR, filename)


@app.route("/api/process", methods=["POST"])
def process_audio():
    if "audio" not in request.files:
        return jsonify({"error": "لم يتم إرسال أي ملف صوتي."}), 400

    audio_file = request.files["audio"]
    audio_bytes = audio_file.read()

    if not audio_bytes:
        return jsonify({"error": "الملف الصوتي فارغ."}), 400

    try:
        # ── Step 1: Whisper via Groq API ─────────────────────────────────────
        transcription = groq_client.audio.transcriptions.create(
            file=("recording.webm", audio_bytes),
            model="whisper-large-v3",
            language="ar",
            response_format="text"
        )
        original_text = transcription.strip() if isinstance(transcription, str) else transcription.text.strip()

        if not original_text:
            return jsonify({"error": "لم يتم التعرف على أي كلام. يرجى المحاولة مرة أخرى."}), 422

        # ── Step 2: Llama 3 via Groq API ─────────────────────────────────────
        chat_completion = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user",   "content": original_text}
            ],
            temperature=0.4,
            max_tokens=1024,
        )

        raw_response = chat_completion.choices[0].message.content.strip()

        try:
            data = json.loads(raw_response)
        except json.JSONDecodeError:
            match = re.search(r'\{.*\}', raw_response, re.DOTALL)
            if match:
                data = json.loads(match.group())
            else:
                return jsonify({"error": "خطأ في معالجة الرد. يرجى المحاولة مرة أخرى."}), 500

        # ── Step 3: gTTS ─────────────────────────────────────────────────────
        tts_text = data.get("followup") or data.get("corrected", "")
        audio_filename = f"{uuid.uuid4().hex}.mp3"
        audio_path = os.path.join(AUDIO_OUTPUT_DIR, audio_filename)
        tts = gTTS(text=tts_text, lang="ar", slow=False)
        tts.save(audio_path)

        return jsonify({
            "original":    data.get("original",    original_text),
            "corrected":   data.get("corrected",   original_text),
            "has_errors":  data.get("has_errors",  False),
            "explanation": data.get("explanation", ""),
            "improved":    data.get("improved",    ""),
            "followup":    data.get("followup",    ""),
            "audio_url":   f"/static/audio/{audio_filename}"
        })

    except Exception as e:
        return jsonify({"error": f"حدث خطأ: {str(e)}"}), 500


if __name__ == "__main__":
    app.run(debug=True, port=5000)