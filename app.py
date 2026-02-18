import os
import json
import uuid
import tempfile
import anthropic
from flask import Flask, request, jsonify, render_template, send_from_directory
from gtts import gTTS
import whisper

app = Flask(__name__)

# ─── Configuration ────────────────────────────────────────────────────────────
AUDIO_OUTPUT_DIR = os.path.join(app.static_folder, "audio")
os.makedirs(AUDIO_OUTPUT_DIR, exist_ok=True)

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
anthropic_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

# Load Whisper model once at startup (use "base" for speed, "small"/"medium" for accuracy)
print("⏳ Loading Whisper model...")
whisper_model = whisper.load_model("base")
print("✅ Whisper model loaded.")

# ─── Claude Prompt ────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """أنت مدرّس لغة عربية متخصص ومحترف. مهمتك تصحيح الجمل العربية وشرح الأخطاء وإجراء محادثة تعليمية مستمرة.

عندما يُرسل إليك نص عربي من المتعلم، يجب أن تُعيد JSON فقط — بلا أي نص خارجه — بالتنسيق التالي بالضبط:

{
  "original": "الجملة الأصلية كما أرسلها المتعلم",
  "corrected": "الجملة المصحّحة إن كان هناك أخطاء، أو نفس الجملة إن كانت صحيحة",
  "has_errors": true أو false,
  "explanation": "شرح مختصر وواضح للأخطاء النحوية أو الإملائية إن وُجدت، أو عبارة تشجيعية إن كانت الجملة صحيحة",
  "improved": "نسخة محسّنة وأكثر أسلوبية من الجملة (حتى لو كانت الجملة صحيحة نحوياً)",
  "followup": "سؤال متابعة طبيعي ومحفّز يُشجّع المتعلم على الاستمرار في المحادثة"
}

قواعد مهمة:
- كن لطيفاً ومشجعاً دائماً
- الشرح يجب أن يكون بالعربية الفصحى البسيطة
- اجعل سؤال المتابعة مثيراً للاهتمام ومرتبطاً بموضوع المتعلم
- أعِد JSON صحيحاً فقط، بلا markdown أو نص إضافي"""


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

    # Save uploaded audio to a temp file
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        tmp_path = tmp.name
        audio_file.save(tmp_path)

    try:
        # ── Step 1: Transcribe with Whisper ──────────────────────────────────
        result = whisper_model.transcribe(tmp_path, language="ar")
        original_text = result["text"].strip()

        if not original_text:
            return jsonify({"error": "لم يتم التعرف على أي كلام. يرجى المحاولة مرة أخرى."}), 422

        # ── Step 2: Claude correction + conversation ──────────────────────────
        message = anthropic_client.messages.create(
            model="claude-opus-4-6",
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=[
                {"role": "user", "content": original_text}
            ]
        )

        raw_response = message.content[0].text.strip()

        # Parse JSON response
        try:
            data = json.loads(raw_response)
        except json.JSONDecodeError:
            # Try to extract JSON if extra text slipped through
            import re
            match = re.search(r'\{.*\}', raw_response, re.DOTALL)
            if match:
                data = json.loads(match.group())
            else:
                return jsonify({"error": "خطأ في معالجة الرد. يرجى المحاولة مرة أخرى."}), 500

        # ── Step 3: TTS for follow-up question ───────────────────────────────
        tts_text = data.get("followup", data.get("corrected", ""))
        audio_filename = f"{uuid.uuid4().hex}.mp3"
        audio_path = os.path.join(AUDIO_OUTPUT_DIR, audio_filename)

        tts = gTTS(text=tts_text, lang="ar", slow=False)
        tts.save(audio_path)

        # ── Step 4: Return JSON ───────────────────────────────────────────────
        return jsonify({
            "original":    data.get("original", original_text),
            "corrected":   data.get("corrected", original_text),
            "has_errors":  data.get("has_errors", False),
            "explanation": data.get("explanation", ""),
            "improved":    data.get("improved", ""),
            "followup":    data.get("followup", ""),
            "audio_url":   f"/static/audio/{audio_filename}"
        })

    except anthropic.APIError as e:
        return jsonify({"error": f"خطأ في الاتصال بـ Claude API: {str(e)}"}), 503
    except Exception as e:
        return jsonify({"error": f"حدث خطأ غير متوقع: {str(e)}"}), 500
    finally:
        os.unlink(tmp_path)


if __name__ == "__main__":
    app.run(debug=True, port=5000)
