/* ══════════════════════════════════════════════════════════════
   مُدرِّسي — Arabic Conversation Tutor
   script.js — Vanilla JS controller
   ══════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  // ─── DOM refs ──────────────────────────────────────────────
  const micBtn          = document.getElementById("micBtn");
  const micRing         = document.getElementById("micRing");
  const recorderStatus  = document.getElementById("recorderStatus");
  const timerRow        = document.getElementById("timerRow");
  const timerDisplay    = document.getElementById("timerDisplay");
  const btnRow          = document.getElementById("btnRow");
  const sendBtn         = document.getElementById("sendBtn");
  const cancelBtn       = document.getElementById("cancelBtn");
  const loadingOverlay  = document.getElementById("loadingOverlay");
  const errorBanner     = document.getElementById("errorBanner");
  const errorText       = document.getElementById("errorText");
  const errorClose      = document.getElementById("errorClose");
  const resultsSection  = document.getElementById("resultsSection");
  const accuracyBadge   = document.getElementById("accuracyBadge");
  const originalText    = document.getElementById("originalText");
  const correctedText   = document.getElementById("correctedText");
  const correctedIcon   = document.getElementById("correctedIcon");
  const correctedTitle  = document.getElementById("correctedTitle");
  const correctedCard   = document.getElementById("correctedCard");
  const explanationText = document.getElementById("explanationText");
  const explanationCard = document.getElementById("explanationCard");
  const improvedText    = document.getElementById("improvedText");
  const followupText    = document.getElementById("followupText");
  const audioRow        = document.getElementById("audioRow");
  const audioPlayer     = document.getElementById("audioPlayer");
  const playBtn         = document.getElementById("playBtn");
  const waveform        = document.getElementById("waveform");
  const againBtn        = document.getElementById("againBtn");

  // Loading step elements
  const ls1 = document.getElementById("ls1");
  const ls2 = document.getElementById("ls2");
  const ls3 = document.getElementById("ls3");

  // ─── State ─────────────────────────────────────────────────
  let mediaRecorder  = null;
  let audioChunks    = [];
  let isRecording    = false;
  let timerInterval  = null;
  let timerSeconds   = 0;
  let loadingStepIdx = 0;
  let loadingStepTimer = null;

  // ─── Mic permission check ───────────────────────────────────
  function checkMicSupport() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError("متصفّحك لا يدعم تسجيل الصوت. يرجى استخدام Chrome أو Firefox.");
      micBtn.disabled = true;
    }
  }

  // ─── Recording ─────────────────────────────────────────────
  async function startRecording() {
    hideError();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Prefer webm/opus, fallback to available
      const mimeType = getSupportedMimeType();
      const options  = mimeType ? { mimeType } : {};

      mediaRecorder = new MediaRecorder(stream, options);
      audioChunks   = [];

      mediaRecorder.addEventListener("dataavailable", (e) => {
        if (e.data && e.data.size > 0) audioChunks.push(e.data);
      });

      mediaRecorder.addEventListener("stop", () => {
        // Stop all tracks so mic indicator light goes off
        stream.getTracks().forEach((t) => t.stop());
      });

      mediaRecorder.start(250); // collect every 250ms
      isRecording = true;

      // UI: recording state
      micBtn.classList.add("recording");
      micRing.classList.add("recording");
      recorderStatus.textContent = "جارٍ التسجيل… تحدّث الآن";
      recorderStatus.style.color = "#e05252";
      timerRow.style.display = "flex";
      btnRow.style.display   = "flex";
      startTimer();

    } catch (err) {
      if (err.name === "NotAllowedError") {
        showError("لم يتم السماح بالوصول إلى الميكروفون. يرجى منح الإذن من إعدادات المتصفح.");
      } else {
        showError("تعذّر الوصول إلى الميكروفون: " + err.message);
      }
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    isRecording = false;
    stopTimer();

    // UI: idle state
    micBtn.classList.remove("recording");
    micRing.classList.remove("recording");
    recorderStatus.textContent = "تم التسجيل ✓ — اضغط إرسال للتحليل";
    recorderStatus.style.color = "";
  }

  function cancelRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    isRecording = false;
    audioChunks  = [];
    stopTimer();
    resetRecorderUI();
  }

  function resetRecorderUI() {
    micBtn.classList.remove("recording");
    micRing.classList.remove("recording");
    recorderStatus.textContent = "اضغط للبدء";
    recorderStatus.style.color = "";
    timerRow.style.display     = "none";
    btnRow.style.display       = "none";
    timerDisplay.textContent   = "00:00";
    timerSeconds               = 0;
  }

  // ─── Timer ──────────────────────────────────────────────────
  function startTimer() {
    timerSeconds = 0;
    timerInterval = setInterval(() => {
      timerSeconds++;
      const m = String(Math.floor(timerSeconds / 60)).padStart(2, "0");
      const s = String(timerSeconds % 60).padStart(2, "0");
      timerDisplay.textContent = `${m}:${s}`;

      // Auto-stop at 2 minutes
      if (timerSeconds >= 120) stopRecording();
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  // ─── Send audio to backend ──────────────────────────────────
  async function sendAudio() {
    if (!audioChunks.length) {
      showError("لا يوجد تسجيل صوتي. يرجى التسجيل أولاً.");
      return;
    }

    const mimeType  = getSupportedMimeType() || "audio/webm";
    const audioBlob = new Blob(audioChunks, { type: mimeType });

    const formData = new FormData();
    formData.append("audio", audioBlob, "recording.webm");

    // Loading state
    showLoading();
    resetRecorderUI();
    resultsSection.style.display = "none";
    hideError();

    try {
      const response = await fetch("/api/process", {
        method: "POST",
        body: formData,
      });

      hideLoading();

      if (!response.ok) {
        let msg = "حدث خطأ في الخادم.";
        try {
          const errData = await response.json();
          msg = errData.error || msg;
        } catch (_) {}
        showError(msg);
        return;
      }

      const data = await response.json();

      if (data.error) {
        showError(data.error);
        return;
      }

      renderResults(data);

    } catch (networkErr) {
      hideLoading();
      showError("تعذّر الاتصال بالخادم. تأكد من تشغيل الخادم المحلي.");
    }
  }

  // ─── Render results ─────────────────────────────────────────
  function renderResults(data) {
    // Basic fields
    originalText.textContent    = data.original    || "—";
    correctedText.textContent   = data.corrected   || "—";
    explanationText.textContent = data.explanation || "—";
    improvedText.textContent    = data.improved    || "—";
    followupText.textContent    = data.followup    || "—";

    // Accuracy badge
    if (data.has_errors) {
      accuracyBadge.textContent = "⚠️ تم العثور على أخطاء";
      accuracyBadge.className   = "accuracy-badge has-errors";
      correctedCard.classList.add("has-errors");
      correctedIcon.textContent  = "🔴";
      correctedTitle.textContent = "الجملة المصحّحة";
    } else {
      accuracyBadge.textContent = "✅ جملة صحيحة!";
      accuracyBadge.className   = "accuracy-badge correct";
      correctedCard.classList.remove("has-errors");
      correctedIcon.textContent  = "✅";
      correctedTitle.textContent = "الجملة صحيحة";
    }

    // Audio player
    if (data.audio_url) {
      audioPlayer.src = data.audio_url;
      audioRow.style.display = "flex";
    } else {
      audioRow.style.display = "none";
    }

    // Show section
    resultsSection.style.display = "block";
    resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ─── Audio playback ─────────────────────────────────────────
  playBtn.addEventListener("click", () => {
    if (audioPlayer.src) {
      audioPlayer.currentTime = 0;
      audioPlayer.play().catch(() => showError("تعذّر تشغيل الصوت."));
    }
  });

  audioPlayer.addEventListener("play", () => {
    waveform.classList.add("playing");
    playBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="4" width="4" height="16"/>
        <rect x="14" y="4" width="4" height="16"/>
      </svg> جارٍ التشغيل…`;
  });

  audioPlayer.addEventListener("ended", () => {
    waveform.classList.remove("playing");
    playBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      استمع للرد`;
  });

  audioPlayer.addEventListener("pause", () => {
    waveform.classList.remove("playing");
    playBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      استمع للرد`;
  });

  // ─── Loading steps animation ────────────────────────────────
  function showLoading() {
    loadingOverlay.style.display = "flex";
    [ls1, ls2, ls3].forEach((el) => el.classList.remove("active"));
    loadingStepIdx = 0;
    ls1.classList.add("active");

    loadingStepTimer = setInterval(() => {
      loadingStepIdx++;
      [ls1, ls2, ls3].forEach((el) => el.classList.remove("active"));
      if (loadingStepIdx === 1) ls2.classList.add("active");
      if (loadingStepIdx >= 2) {
        ls3.classList.add("active");
        clearInterval(loadingStepTimer);
      }
    }, 2500);
  }

  function hideLoading() {
    clearInterval(loadingStepTimer);
    loadingOverlay.style.display = "none";
  }

  // ─── Error handling ─────────────────────────────────────────
  function showError(msg) {
    errorText.textContent      = msg;
    errorBanner.style.display  = "flex";
    errorBanner.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function hideError() {
    errorBanner.style.display = "none";
  }

  // ─── MIME type helper ────────────────────────────────────────
  function getSupportedMimeType() {
    const types = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
      "audio/mp4",
    ];
    for (const t of types) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return null;
  }

  // ─── Event listeners ────────────────────────────────────────
  micBtn.addEventListener("click", () => {
    if (!isRecording) {
      startRecording();
    } else {
      stopRecording();
    }
  });

  sendBtn.addEventListener("click", sendAudio);
  cancelBtn.addEventListener("click", cancelRecording);
  errorClose.addEventListener("click", hideError);

  againBtn.addEventListener("click", () => {
    resultsSection.style.display = "none";
    audioChunks = [];
    resetRecorderUI();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // ─── Init ───────────────────────────────────────────────────
  checkMicSupport();
})();
