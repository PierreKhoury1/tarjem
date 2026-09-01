/* Tarjem front-end: browser VAD -> WAV segments -> /api/transcribe -> cards + optional TTS. */
(() => {
  "use strict";

  const SAMPLE_RATE = 16000;
  const INTERIM_EVERY_MS = 3000;      // Groq free tier: 20 req/min per whisper model
  const INTERIM_MIN_S = 1.4;          // don't bother transcribing tiny partials
  const MAX_SEGMENT_S = 16;           // force a cut on long monologues
  const MIN_FINAL_S = 0.35;
  const PREPAD_FRAMES = 12;           // ~380 ms of audio kept before speech start
  const CONTEXT_TURNS = 6;

  const $ = (id) => document.getElementById(id);
  const els = {
    dot: $("dot"), statusText: $("statusText"), live: $("live"), liveSrc: $("liveSrc"), liveTr: $("liveTr"),
    liveLabel: $("liveLabel"), lvl: $("lvl"), latency: $("latency"), feed: $("feed"), emptyHint: $("emptyHint"),
    micBtn: $("micBtn"), hintR: $("hintR"), hintL: $("hintL"), toast: $("toast"), gate: $("gate"),
    codeInput: $("codeInput"), codeBtn: $("codeBtn"), settings: $("settings"), settingsBtn: $("settingsBtn"),
    settingsClose: $("settingsClose"), setRedemption: $("setRedemption"), setThreshold: $("setThreshold"),
    setDuck: $("setDuck"), setCode: $("setCode"), setInfo: $("setInfo"), modeSeg: $("modeSeg"),
    speak: $("speak"), liveInterim: $("liveInterim"), speakToggle: $("speakToggle"), liveToggle: $("liveToggle"),
    copyBtn: $("copyBtn"), downloadBtn: $("downloadBtn"), clearBtn: $("clearBtn"),
  };

  const store = {
    get(k, d) { try { const v = localStorage.getItem("tarjem_" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("tarjem_" + k, JSON.stringify(v)); } catch {} },
  };

  const state = {
    mode: store.get("mode", "auto"),
    speak: store.get("speak", false),
    liveInterim: store.get("live", true),
    duck: store.get("duck", true),
    redemptionMs: store.get("redemption", 700),
    threshold: store.get("threshold", 0.6),
    code: store.get("code", ""),
    vad: null, listening: false, speaking: false,
    ring: [], seg: null, segSeq: 0, interimInFlight: false,
    context: [], entries: [],
    ttsQueue: [], ttsPlaying: false, ducked: false,
  };

  // ------------------------------------------------------------------ ui helpers
  let toastTimer = null;
  function toast(msg, ms = 3500) {
    els.toast.textContent = msg; els.toast.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => els.toast.classList.remove("show"), ms);
  }
  function setStatus(text, cls) {
    els.statusText.textContent = text; els.dot.className = "dot" + (cls ? " " + cls : "");
  }
  function dirFor(lang) { return lang === "ar" ? "rtl" : "ltr"; }
  function fmtTime(d) { return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  function headers(extra) {
    const h = Object.assign({}, extra || {});
    if (state.code) h["X-Access-Code"] = state.code;
    return h;
  }

  // ------------------------------------------------------------------ audio utils
  function concatFrames(frames) {
    let n = 0; for (const f of frames) n += f.length;
    const out = new Float32Array(n); let o = 0;
    for (const f of frames) { out.set(f, o); o += f.length; }
    return out;
  }
  function encodeWav16(samples) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
    str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, samples.length * 2, true);
    let o = 44;
    for (let i = 0; i < samples.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  // ------------------------------------------------------------------ server calls
  async function postSegment(samples, kind) {
    const fd = new FormData();
    fd.append("audio", encodeWav16(samples), "segment.wav");
    fd.append("kind", kind);
    fd.append("mode", state.mode);
    fd.append("translate", "1");
    fd.append("context", JSON.stringify(state.context.slice(-CONTEXT_TURNS)));
    const r = await fetch("/api/transcribe", { method: "POST", body: fd, headers: headers() });
    if (r.status === 401) { showGate(); throw new Error("access code rejected"); }
    if (r.status === 429) throw new Error("Rate limit - slow down a little");
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ("server error " + r.status));
    return j;
  }

  // ------------------------------------------------------------------ segments
  function segDuration(seg) { return seg.samples / SAMPLE_RATE; }

  function startSegment(withPrepad) {
    state.seg = { id: ++state.segSeq, frames: withPrepad ? state.ring.slice() : [], samples: 0, lastInterim: performance.now(), startedAt: Date.now() };
    for (const f of state.seg.frames) state.seg.samples += f.length;
  }

  async function sendInterim(seg) {
    if (state.interimInFlight || !state.liveInterim) return;
    state.interimInFlight = true;
    const samples = concatFrames(seg.frames);
    const t0 = performance.now();
    try {
      const j = await postSegment(samples, "interim");
      if (state.seg && state.seg.id === seg.id && !j.dropped) {
        els.liveSrc.textContent = j.text; els.liveSrc.dir = dirFor(j.lang);
        els.liveTr.textContent = j.translation || ""; els.liveTr.dir = dirFor(j.target);
        els.latency.textContent = Math.round(performance.now() - t0) + " ms";
      }
    } catch (e) {
      console.warn("interim failed", e);
    } finally { state.interimInFlight = false; }
  }

  function finalizeSegment(seg) {
    if (!seg || segDuration(seg) < MIN_FINAL_S) return;
    const samples = concatFrames(seg.frames);
    const entry = { id: seg.id, at: new Date(seg.startedAt), text: "", lang: "", translation: "", pending: true };
    const card = renderCard(entry);
    state.entries.push(entry);
    setStatus("transcribing…", "busy");
    const t0 = performance.now();
    postSegment(samples, "final").then((j) => {
      if (j.dropped) { card.remove(); state.entries = state.entries.filter((e) => e !== entry); refreshEmpty(); return; }
      entry.text = j.text; entry.lang = j.lang; entry.target = j.target;
      entry.translation = j.translation || ""; entry.error = j.translation_error || ""; entry.pending = false;
      entry.sttModel = j.stt_model; entry.trModel = j.translate_model;
      state.context.push({ text: j.text, lang: j.lang });
      if (state.context.length > 20) state.context.shift();
      updateCard(card, entry);
      els.latency.textContent = Math.round(performance.now() - t0) + " ms";
      if (state.speak && entry.translation) enqueueTts(entry.translation, entry.target);
    }).catch((e) => {
      entry.pending = false; entry.error = e.message; updateCard(card, entry); toast(e.message);
    }).finally(() => { if (state.listening) setStatus(state.speaking ? "speaking" : "listening", "on"); });
  }

  // ------------------------------------------------------------------ cards
  function refreshEmpty() { els.emptyHint.style.display = state.entries.length ? "none" : ""; }

  function renderCard(entry) {
    const card = document.createElement("article");
    card.className = "card"; card.dataset.id = entry.id;
    card.innerHTML = `
      <div class="meta"><span class="badge">…</span><span class="time">${fmtTime(entry.at)}</span>
        <span class="actions"><button class="play" title="Speak translation">🔊</button><button class="copy" title="Copy">⧉</button></span></div>
      <div class="orig"></div>
      <div class="trans pending">listening…</div>`;
    card.querySelector(".play").onclick = () => { if (entry.translation) enqueueTts(entry.translation, entry.target); };
    card.querySelector(".copy").onclick = () => navigator.clipboard?.writeText(entry.text + "\n" + entry.translation).then(() => toast("Copied", 1200));
    els.feed.appendChild(card); refreshEmpty();
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return card;
  }

  function updateCard(card, entry) {
    const badge = card.querySelector(".badge");
    badge.textContent = entry.lang ? entry.lang.toUpperCase() + " → " + (entry.target || "").toUpperCase() : "?";
    badge.className = "badge " + (entry.lang || "");
    const orig = card.querySelector(".orig");
    orig.textContent = entry.text; orig.dir = dirFor(entry.lang);
    const tr = card.querySelector(".trans");
    if (entry.error && !entry.translation) { tr.className = "trans error"; tr.textContent = "⚠ " + entry.error; tr.dir = "ltr"; }
    else { tr.className = "trans"; tr.textContent = entry.translation; tr.dir = dirFor(entry.target); }
    if (entry.sttModel) card.title = `STT ${entry.sttModel} · MT ${entry.trModel || "-"}`;
  }

  // ------------------------------------------------------------------ tts
  function enqueueTts(text, lang) { state.ttsQueue.push({ text, lang }); pumpTts(); }

  async function pumpTts() {
    if (state.ttsPlaying || !state.ttsQueue.length) return;
    state.ttsPlaying = true;
    const { text, lang } = state.ttsQueue.shift();
    try {
      if (state.duck && state.vad && state.listening) { await state.vad.pause(); state.ducked = true; setStatus("speaking translation", "busy"); }
      const url = "/api/tts?" + new URLSearchParams({ text, lang });
      const r = await fetch(url, { headers: headers() });
      if (!r.ok) throw new Error("tts unavailable");
      const blob = await r.blob();
      await new Promise((res) => {
        const a = new Audio(URL.createObjectURL(blob));
        a.onended = res; a.onerror = res; a.play().catch(res);
      });
    } catch (e) {
      // Fall back to the browser's own voices.
      try {
        await new Promise((res) => {
          const u = new SpeechSynthesisUtterance(text); u.lang = lang === "ar" ? "ar-SA" : "en-US";
          u.onend = res; u.onerror = res; speechSynthesis.speak(u);
        });
      } catch {}
    } finally {
      if (state.ducked) { state.ducked = false; if (state.listening && state.vad) { await state.vad.start(); setStatus("listening", "on"); } }
      state.ttsPlaying = false;
      if (state.ttsQueue.length) pumpTts();
    }
  }

  // ------------------------------------------------------------------ vad
  async function ensureVad() {
    if (state.vad) return state.vad;
    if (!window.vad || !window.vad.MicVAD) throw new Error("VAD library failed to load");
    setStatus("loading voice model…", "busy");
    const v = await window.vad.MicVAD.new({
      model: "v5",
      baseAssetPath: "/static/vad/",
      onnxWASMBasePath: "/static/vad/",
      positiveSpeechThreshold: state.threshold,
      negativeSpeechThreshold: Math.max(0.15, state.threshold - 0.25),
      redemptionMs: state.redemptionMs,
      preSpeechPadMs: 300,
      minSpeechMs: 250,
      startOnLoad: false,
      onFrameProcessed: (probs, frame) => {
        els.lvl.style.width = Math.round(probs.isSpeech * 100) + "%";
        state.ring.push(frame); if (state.ring.length > PREPAD_FRAMES) state.ring.shift();
        const seg = state.seg;
        if (!state.speaking || !seg) return;
        seg.frames.push(frame); seg.samples += frame.length;
        const now = performance.now();
        if (segDuration(seg) >= MAX_SEGMENT_S) {
          finalizeSegment(seg); startSegment(false); clearLive();
          return;
        }
        if (state.liveInterim && now - seg.lastInterim >= INTERIM_EVERY_MS && segDuration(seg) >= INTERIM_MIN_S) {
          seg.lastInterim = now; sendInterim(seg);
        }
      },
      onSpeechStart: () => {
        state.speaking = true; startSegment(true);
        els.live.classList.add("speaking"); els.liveLabel.textContent = "Speaking"; setStatus("speaking", "on");
      },
      onSpeechEnd: () => {
        state.speaking = false; const seg = state.seg; state.seg = null;
        els.live.classList.remove("speaking"); els.liveLabel.textContent = "Listening";
        finalizeSegment(seg); clearLive();
      },
      onVADMisfire: () => {
        state.speaking = false; state.seg = null;
        els.live.classList.remove("speaking"); els.liveLabel.textContent = "Listening"; clearLive();
      },
    });
    state.vad = v;
    return v;
  }

  function clearLive() { els.liveSrc.textContent = ""; els.liveTr.textContent = ""; }

  async function startListening() {
    els.micBtn.disabled = true;
    try {
      const v = await ensureVad();
      await v.start();
      state.listening = true;
      els.micBtn.classList.add("on"); els.micBtn.textContent = "■"; els.hintR.textContent = "tap to stop";
      setStatus("listening", "on"); els.liveLabel.textContent = "Listening";
    } catch (e) {
      console.error(e);
      toast(/denied|permission|NotAllowed/i.test(String(e)) ? "Microphone permission denied" : "Could not start microphone: " + (e.message || e));
      setStatus("error", "err");
    } finally { els.micBtn.disabled = false; }
  }

  async function stopListening() {
    state.listening = false;
    if (state.vad) { try { await state.vad.pause(); } catch {} }
    if (state.speaking && state.seg) { const seg = state.seg; state.seg = null; state.speaking = false; finalizeSegment(seg); }
    els.live.classList.remove("speaking"); clearLive(); els.lvl.style.width = "0";
    els.micBtn.classList.remove("on"); els.micBtn.textContent = "🎤"; els.hintR.textContent = "tap to start";
    setStatus("idle", "");
  }

  async function rebuildVad() {
    const was = state.listening;
    if (was) await stopListening();
    if (state.vad) { try { state.vad.destroy(); } catch {} state.vad = null; }
    if (was) await startListening();
  }

  // ------------------------------------------------------------------ transcript export
  function transcriptText() {
    return state.entries.filter((e) => e.text).map((e) =>
      `[${fmtTime(e.at)}] ${e.lang.toUpperCase()}: ${e.text}\n            ${(e.target || "").toUpperCase()}: ${e.translation || "(no translation)"}`
    ).join("\n\n");
  }

  // ------------------------------------------------------------------ access gate
  function showGate() { els.gate.classList.add("show"); els.codeInput.value = ""; setTimeout(() => els.codeInput.focus(), 50); }
  async function tryCode(code) {
    const r = await fetch("/api/auth", { method: "POST", headers: { "X-Access-Code": code } });
    if (r.ok) { state.code = code; store.set("code", code); els.gate.classList.remove("show"); toast("Unlocked", 1200); return true; }
    toast("Wrong access code"); return false;
  }

  async function boot() {
    let cfg = {};
    try { cfg = await (await fetch("/api/config")).json(); } catch {}
    if (!cfg.stt_ready) toast("Server has no GROQ_API_KEY - transcription will fail", 6000);
    if (cfg.access_required) {
      if (!state.code) showGate();
      else { const r = await fetch("/api/auth", { method: "POST", headers: headers() }); if (!r.ok) showGate(); }
    }
    // Warm up the model files in the background so the first tap is instant.
    ensureVad().then(() => setStatus("ready", "")).catch((e) => { console.warn(e); setStatus("idle", ""); });
  }

  // ------------------------------------------------------------------ wiring
  function applyMode(m) {
    state.mode = m; store.set("mode", m);
    els.modeSeg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
    els.hintL.textContent = m === "auto" ? "auto ⇄" : (m === "ar" ? "عربي → EN" : "EN → عربي");
  }
  els.modeSeg.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) applyMode(b.dataset.mode); });
  applyMode(state.mode);

  els.speak.checked = state.speak; els.speakToggle.classList.toggle("on", state.speak);
  els.speak.onchange = () => { state.speak = els.speak.checked; store.set("speak", state.speak); els.speakToggle.classList.toggle("on", state.speak); };
  els.liveInterim.checked = state.liveInterim; els.liveToggle.classList.toggle("on", state.liveInterim);
  els.liveInterim.onchange = () => { state.liveInterim = els.liveInterim.checked; store.set("live", state.liveInterim); els.liveToggle.classList.toggle("on", state.liveInterim); };

  els.micBtn.onclick = () => (state.listening ? stopListening() : startListening());
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !/input|select|textarea/i.test(e.target.tagName)) { e.preventDefault(); els.micBtn.click(); }
  });

  els.copyBtn.onclick = () => navigator.clipboard?.writeText(transcriptText()).then(() => toast("Transcript copied", 1200));
  els.downloadBtn.onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([transcriptText()], { type: "text/plain;charset=utf-8" }));
    a.download = "tarjem-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".txt"; a.click();
  };
  els.clearBtn.onclick = () => { state.entries = []; state.context = []; els.feed.querySelectorAll(".card").forEach((c) => c.remove()); refreshEmpty(); clearLive(); };

  els.codeBtn.onclick = () => tryCode(els.codeInput.value.trim());
  els.codeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") els.codeBtn.click(); });

  els.settingsBtn.onclick = async () => {
    els.setRedemption.value = String(state.redemptionMs); els.setThreshold.value = String(state.threshold); els.setDuck.checked = state.duck;
    els.settings.classList.add("show");
    try {
      const h = await (await fetch("/api/health", { headers: headers() })).json();
      els.setInfo.textContent = `STT: ${h.stt_model} · translation: ${h.translate_provider} / ${h.translate_model}` + (h.stt ? "" : " · ⚠ no GROQ_API_KEY");
    } catch { els.setInfo.textContent = ""; }
  };
  els.settingsClose.onclick = async () => {
    els.settings.classList.remove("show");
    const red = Number(els.setRedemption.value), thr = Number(els.setThreshold.value);
    state.duck = els.setDuck.checked; store.set("duck", state.duck);
    if (red !== state.redemptionMs || thr !== state.threshold) {
      state.redemptionMs = red; state.threshold = thr; store.set("redemption", red); store.set("threshold", thr);
      await rebuildVad();
    }
  };
  els.setCode.onclick = () => { els.settings.classList.remove("show"); showGate(); };

  window.addEventListener("beforeunload", () => { if (state.vad) try { state.vad.destroy(); } catch {} });
  boot();
})();
