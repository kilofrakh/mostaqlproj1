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
    <div class="meta">${escapeHtml(meta)}</div>
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
      <span class="badge ${j.deepgram ? "ok":"no"}">${j.deepgram ? "✅":"❌"} Deepgram</span>
      ${j.deepgram_cfg ? `<div class="hint">STT: ${j.deepgram_cfg.model} (${j.deepgram_cfg.language})</div>` : ""}
    `;
  } catch {
    statusEl.innerHTML = `<span class="badge no">❌ health</span>`;
  }
}

// ------------------------------
// TTS Streaming (MediaSource) — no audio player UI
// ------------------------------
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
  sourceBuffer = null;

  mediaSource = new MediaSource();
  audioEl.src = URL.createObjectURL(mediaSource);

  mediaSource.addEventListener("sourceopen", () => {
    // mp3 mime for MSE
    sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
    sourceBuffer.mode = "sequence";

    sourceBuffer.addEventListener("updateend", () => {
      if (queue.length > 0 && !sourceBuffer.updating) {
        sourceBuffer.appendBuffer(queue.shift());
      } else if (!streaming && mediaSource.readyState === "open") {
        try { mediaSource.endOfStream(); } catch {}
      }
    });

    if (queue.length > 0 && !sourceBuffer.updating) {
      sourceBuffer.appendBuffer(queue.shift());
    }
  });
}

function appendMp3Chunk(uint8) {
  if (!sourceBuffer || sourceBuffer.updating) {
    queue.push(uint8);
    return;
  }
  sourceBuffer.appendBuffer(uint8);
}

function endStream() {
  streaming = false;
  if (mediaSource && mediaSource.readyState === "open" && sourceBuffer && !sourceBuffer.updating && queue.length === 0) {
    try { mediaSource.endOfStream(); } catch {}
  }
}

// ------------------------------
// WebSocket /tts (auto-reconnect)
// ------------------------------
let ttsSocket = null;
let ttsConnecting = false;

function wsUrl(path) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}`;
}

function connectTTS() {
  if (ttsSocket && (ttsSocket.readyState === WebSocket.OPEN || ttsSocket.readyState === WebSocket.CONNECTING)) return;
  if (ttsConnecting) return;

  ttsConnecting = true;

  ttsSocket = new WebSocket(wsUrl("/tts"));
  ttsSocket.binaryType = "arraybuffer";

  ttsSocket.onopen = () => {
    ttsConnecting = false;
  };

  ttsSocket.onclose = () => {
    ttsConnecting = false;
    // reconnect
    setTimeout(connectTTS, 800);
  };

  ttsSocket.onerror = () => {
    try { ttsSocket.close(); } catch {}
  };

  ttsSocket.onmessage = (evt) => {
    // If server sends JSON events (end/error)
    if (typeof evt.data === "string") {
      try {
        const j = JSON.parse(evt.data);
        if (j.event === "end") endStream();
        if (j.error) addMessage("ai", "خطأ", j.error);
      } catch {}
      return;
    }

    // Binary audio chunk
    const chunk = new Uint8Array(evt.data);
    appendMp3Chunk(chunk);
  };
}

function waitForSocketOpen(timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (ttsSocket && ttsSocket.readyState === WebSocket.OPEN) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("TTS socket timeout"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

// Send text to TTS stream and autoplay
async function speak(text) {
  connectTTS();
  resetMediaSource();

  // Attempt autoplay (usually allowed after record/stop gesture)
  try { await audioEl.play(); } catch {}

  try {
    await waitForSocketOpen();
    ttsSocket.send(JSON.stringify({ text, voice_id: selected.voice_id }));
  } catch (e) {
    addMessage("ai", "خطأ", "تعذّر تشغيل الصوت (WebSocket).");
  }
}

// ------------------------------
// Recording (MediaRecorder)
// ------------------------------
async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  chunks = [];

  // Some browsers might prefer audio/webm; fallback handled by server.
  mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
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
  } catch {
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

    // Reset session on voice change (production UX)
    history = [];
    chatEl.innerHTML = "";

    const greeting = `أهلاً وسهلاً! أنا ${selected.tutor_name}. ما الموضوع الذي تريد أن نتحدث عنه اليوم؟`;
    addMessage("ai", selected.tutor_name, greeting);

    // Autoplay may be blocked before user gesture; harmless if it fails
    speak(greeting);
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
  const msg = `بدأنا محادثة جديدة. ما الذي تريد أن تتحدث عنه؟`;
  addMessage("ai", selected.tutor_name, msg);
  speak(msg);
});

(async function boot() {
  initVoices();
  connectTTS();
  await loadHealth();

  // First greeting (autoplay may be blocked until first user gesture)
  const greeting = `أهلاً وسهلاً! أنا ${selected.tutor_name}. ما الموضوع الذي تريد أن نتحدث عنه اليوم؟`;
  addMessage("ai", selected.tutor_name, greeting);
})();
