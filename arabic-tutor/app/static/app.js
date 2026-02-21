// ------------------------------
// Voice catalog (keep in sync with your ElevenLabs voices)
// ------------------------------
const VOICES = [
  { label: "Aria (أريا) — موصى به", voice_id: "9BWtsMINqrJLrRacOk9x", tutor_name: "نور" },
  { label: "Sarah (سارة) — دافئ",   voice_id: "EXAVITQu4vr4xnSDxMaL", tutor_name: "سارة" },
  { label: "Laura (لورا) — واضح",   voice_id: "FGY2WhTYpPnrIDTdsKH5", tutor_name: "لورا" },
  { label: "Charlotte (شارلوت) — رسمي", voice_id: "XB0fDUnXU5powFXDhCwa", tutor_name: "شارلوت" },
];

// ------------------------------
// State
// ------------------------------
let history = []; // [{role, content}]
let mediaRecorder = null;
let chunks = [];

let selected = VOICES[0];

// ------------------------------
// DOM
// ------------------------------
const voiceSelect = document.getElementById("voiceSelect");
const personaHint = document.getElementById("personaHint");
const titleName = document.getElementById("titleName");
const chatEl = document.getElementById("chat");
const recBtn = document.getElementById("recBtn");
const stopBtn = document.getElementById("stopBtn");
const recState = document.getElementById("recState");
const statusEl = document.getElementById("status");
const newChatBtn = document.getElementById("newChatBtn");

// ------------------------------
// Helpers
// ------------------------------
function addMessage(kind, meta, text) {
  const div = document.createElement("div");
  div.className = `msg ${kind}`;
  div.innerHTML = `
    <div class="meta">${meta}</div>
    <div class="text">${escapeHtml(text)}</div>
  `;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function escapeHtml(str) {
  return (str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function setTutorUI() {
  titleName.textContent = `${selected.tutor_name} — مُعلِّمة اللغة العربية`;
  personaHint.textContent = `الشخصية الحالية: ${selected.tutor_name}`;
}

// ------------------------------
// Health check
// ------------------------------
async function loadHealth() {
  try {
    const r = await fetch("/health");
    const j = await r.json();
    statusEl.innerHTML = `
      <span class="badge ${j.groq ? "ok":"no"}">${j.groq ? "✅":"❌"} Groq</span>
      <span class="badge ${j.eleven ? "ok":"no"}">${j.eleven ? "✅":"❌"} ElevenLabs</span>
      <div class="hint">Whisper: ${j.whisper.model} (${j.whisper.device})</div>
    `;
  } catch {
    statusEl.innerHTML = `<span class="badge no">❌ health</span>`;
  }
}

// ------------------------------
// TTS Streaming player via MediaSource (no audio player UI)
// ------------------------------
let ttsSocket = null;
let audioEl = null;
let mediaSource = null;
let sourceBuffer = null;
let queue = [];
let streaming = false;

function ensureAudioPipeline() {
  if (audioEl) return;

  audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  audioEl.muted = false;
  audioEl.style.display = "none";
  document.body.appendChild(audioEl);
}

function resetMediaSource() {
  ensureAudioPipeline();
  queue = [];
  streaming = true;

  mediaSource = new MediaSource();
  audioEl.src = URL.createObjectURL(mediaSource);

  mediaSource.addEventListener("sourceopen", () => {
    // mp3 mime for MSE
    sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
    sourceBuffer.mode = "sequence";

    sourceBuffer.addEventListener("updateend", () => {
      if (queue.length > 0 && !sourceBuffer.updating) {
        sourceBuffer.appendBuffer(queue.shift());
      } else if (!streaming && mediaSource.readyState === "open") {
        try { mediaSource.endOfStream(); } catch {}
      }
    });

    // kick off queued buffers
    if (queue.length > 0 && !sourceBuffer.updating) {
      sourceBuffer.appendBuffer(queue.shift());
    }
  });
}

function appendMp3Chunk(chunk) {
  if (!sourceBuffer || sourceBuffer.updating) {
    queue.push(chunk);
    return;
  }
  sourceBuffer.appendBuffer(chunk);
}

// ------------------------------
// Connect TTS websocket
// ------------------------------
function connectTTS() {
  if (ttsSocket && (ttsSocket.readyState === 0 || ttsSocket.readyState === 1)) return;

  const proto = location.protocol === "https:" ? "wss" : "ws";
  ttsSocket = new WebSocket(`${proto}://${location.host}/tts`);
  ttsSocket.binaryType = "arraybuffer";

  ttsSocket.onmessage = (evt) => {
    if (typeof evt.data === "string") {
      // JSON event
      try {
        const j = JSON.parse(evt.data);
        if (j.event === "end") {
          streaming = false;
          // if nothing is updating, close stream
          if (mediaSource && mediaSource.readyState === "open" && sourceBuffer && !sourceBuffer.updating && queue.length === 0) {
            try { mediaSource.endOfStream(); } catch {}
          }
        }
        if (j.error) {
          addMessage("ai", "خطأ", j.error);
        }
      } catch {}
      return;
    }

    // binary chunk
    appendMp3Chunk(new Uint8Array(evt.data));
  };

  ttsSocket.onclose = () => {};
  ttsSocket.onerror = () => {};
}

// Send text to TTS stream and autoplay
async function speak(text) {
  connectTTS();
  resetMediaSource();

  // (Important) browsers often allow autoplay only after a user gesture.
  // Recording/Stop counts as a gesture so autoplay typically works.
  audioEl.play().catch(() => { /* ignore */ });

  ttsSocket.send(JSON.stringify({
    text,
    voice_id: selected.voice_id
  }));
}

// ------------------------------
// Recording (MediaRecorder)
// ------------------------------
async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  chunks = [];

  mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    // stop tracks
    stream.getTracks().forEach(t => t.stop());

    const blob = new Blob(chunks, { type: "audio/webm" });
    await handleAudio(blob);
  };

  mediaRecorder.start();
}

async function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

// ------------------------------
// Pipeline: audio -> /stt -> /chat -> /tts(stream)
// ------------------------------
async function handleAudio(blob) {
  recState.textContent = "⏳ جاري التفريغ...";
  recBtn.disabled = true;
  stopBtn.disabled = true;

  // 1) STT
  const fd = new FormData();
  fd.append("audio", blob, "audio.webm");

  let transcript = "";
  try {
    const r = await fetch("/stt", { method: "POST", body: fd });
    const j = await r.json();
    transcript = (j.text || "").trim();
  } catch (e) {
    addMessage("ai", "خطأ", "فشل التفريغ.");
    recState.textContent = "جاهز";
    recBtn.disabled = false;
    return;
  }

  if (!transcript) {
    addMessage("ai", "تنبيه", "لم أسمع كلاماً واضحاً. حاول مجدداً.");
    recState.textContent = "جاهز";
    recBtn.disabled = false;
    return;
  }

  addMessage("user", "أنت", transcript);

  // 2) Chat
  recState.textContent = "💭 جاري توليد الرد...";
  let reply = "";
  try {
    const r = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        history,
        user_text: transcript,
        tutor_name: selected.tutor_name,
        voice_id: selected.voice_id,
      }),
    });
    const j = await r.json();
    reply = (j.reply || "").trim();
    history = j.history || history;
  } catch {
    addMessage("ai", "خطأ", "فشل الاتصال بالمحادثة.");
    recState.textContent = "جاهز";
    recBtn.disabled = false;
    return;
  }

  addMessage("ai", selected.tutor_name, reply);

  // 3) TTS stream autoplay
  recState.textContent = "🎙️ تشغيل الصوت...";
  await speak(reply);

  recState.textContent = "جاهز";
  recBtn.disabled = false;
}

// ------------------------------
// Init UI
// ------------------------------
function initVoices() {
  VOICES.forEach((v, idx) => {
    const opt = document.createElement("option");
    opt.value = String(idx);
    opt.textContent = v.label;
    voiceSelect.appendChild(opt);
  });

  voiceSelect.value = "0";
  setTutorUI();

  voiceSelect.addEventListener("change", () => {
    selected = VOICES[Number(voiceSelect.value)];
    setTutorUI();

    // production UX: changing voice resets session (fix duplicates, cache, etc.)
    history = [];
    chatEl.innerHTML = "";
    addMessage("ai", selected.tutor_name, `أهلاً وسهلاً! أنا ${selected.tutor_name}. ما الموضوع الذي تريد أن نتحدث عنه اليوم؟`);
    speak(`أهلاً وسهلاً! أنا ${selected.tutor_name}. ما الموضوع الذي تريد أن نتحدث عنه اليوم؟`);
  });
}

recBtn.addEventListener("click", async () => {
  recState.textContent = "🔴 تسجيل...";
  recBtn.disabled = true;
  stopBtn.disabled = false;
  await startRecording();
});

stopBtn.addEventListener("click", async () => {
  recState.textContent = "⏳ إنهاء التسجيل...";
  stopBtn.disabled = true;
  await stopRecording();
});

newChatBtn.addEventListener("click", () => {
  history = [];
  chatEl.innerHTML = "";
  addMessage("ai", selected.tutor_name, `بدأنا محادثة جديدة. ما الذي تريد أن تتحدث عنه؟`);
  speak(`بدأنا محادثة جديدة. ما الذي تريد أن تتحدث عنه؟`);
});

(async function boot(){
  initVoices();
  await loadHealth();

  // First greeting (autoplay after user gesture might be blocked; still show text)
  addMessage("ai", selected.tutor_name, `أهلاً وسهلاً! أنا ${selected.tutor_name}. ما الموضوع الذي تريد أن نتحدث عنه اليوم؟`);
})();