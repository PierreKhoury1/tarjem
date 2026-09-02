/* Tarjem front-end: browser VAD -> WAV segments -> /api/transcribe -> cards, persisted conversations, optional TTS. */
(() => {
  "use strict";

  const SAMPLE_RATE = 16000;
  const INTERIM_EVERY_MS = 3000;      // Groq free tier: 20 req/min per whisper model
  const INTERIM_MIN_S = 1.4;
  const MAX_SEGMENT_S = 16;
  const MIN_FINAL_S = 0.35;
  const PREPAD_FRAMES = 12;
  const CONTEXT_TURNS = 6;
  const SAVE_DEBOUNCE_MS = 900;

  const $ = (id) => document.getElementById(id);
  const els = {
    dot: $("dot"), statusText: $("statusText"), live: $("live"), liveSrc: $("liveSrc"), liveTr: $("liveTr"),
    liveLabel: $("liveLabel"), lvl: $("lvl"), latency: $("latency"), feed: $("feed"), emptyHint: $("emptyHint"),
    micBtn: $("micBtn"), hintR: $("hintR"), hintL: $("hintL"), toast: $("toast"), gate: $("gate"),
    codeInput: $("codeInput"), codeBtn: $("codeBtn"), settings: $("settings"), settingsBtn: $("settingsBtn"),
    settingsClose: $("settingsClose"), setRedemption: $("setRedemption"), setThreshold: $("setThreshold"),
    setDuck: $("setDuck"), setCode: $("setCode"), setInfo: $("setInfo"), modeSeg: $("modeSeg"),
    speak: $("speak"), liveInterim: $("liveInterim"), speakToggle: $("speakToggle"), liveToggle: $("liveToggle"),
    copyBtn: $("copyBtn"), side: $("side"), menuBtn: $("menuBtn"), newConv: $("newConv"), convList: $("convList"),
    downloadAll: $("downloadAll"), backupJson: $("backupJson"), syncState: $("syncState"), convTitle: $("convTitle"),
    convMeta: $("convMeta"), downloadConv: $("downloadConv"), deleteConv: $("deleteConv"), userKey: $("userKey"),
    setUserKey: $("setUserKey"),
  };

  const store = {
    get(k, d) { try { const v = localStorage.getItem("tarjem_" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("tarjem_" + k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem("tarjem_" + k); } catch {} },
  };

  function randomId(n) {
    const a = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const buf = new Uint8Array(n); crypto.getRandomValues(buf);
    return Array.from(buf, (b) => a[b % a.length]).join("");
  }

  const state = {
    mode: store.get("mode", "auto"),
    dialect: store.get("dialect", "palestinian"),
    speak: store.get("speak", false),
    liveInterim: store.get("live", true),
    duck: store.get("duck", true),
    redemptionMs: store.get("redemption", 700),
    threshold: store.get("threshold", 0.6),
    code: store.get("code", ""),
    userKey: store.get("userkey", "") || (() => { const k = randomId(20); store.set("userkey", k); return k; })(),
    vad: null, listening: false, speaking: false,
    ring: [], seg: null, segSeq: 0, interimInFlight: false,
    convs: {},            // id -> {id,title,createdAt,updatedAt,entries?:[], count}
    current: null,        // full conversation doc
    dirty: new Set(), saveTimer: null, serverOk: null,
    ttsQueue: [], ttsPlaying: false, ducked: false,
  };

  // ------------------------------------------------------------------ ui helpers
  let toastTimer = null;
  function toast(msg, ms = 3500, ok = false) {
    els.toast.textContent = msg; els.toast.className = "toast show" + (ok ? " ok" : "");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => els.toast.classList.remove("show"), ms);
  }
  function setStatus(text, cls) { els.statusText.textContent = text; els.dot.className = "dot" + (cls ? " " + cls : ""); }
  function dirFor(lang) { return lang === "ar" ? "rtl" : "ltr"; }
  function fmtTime(ms) { return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  function fmtDate(ms) { return new Date(ms).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  function headers(extra) {
    const h = Object.assign({ "X-User-Key": state.userKey }, extra || {});
    if (state.code) h["X-Access-Code"] = state.code;
    return h;
  }
  function download(name, text, type = "text/plain;charset=utf-8") {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function stamp() { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`; }
  function safeName(s) { return (s || "untitled").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60) || "untitled"; }

  // ------------------------------------------------------------------ conversations: persistence
  function localSaveAll() {
    const docs = {};
    for (const id of Object.keys(state.convs)) {
      const c = state.convs[id];
      if (c.entries) docs[id] = c;
    }
    store.set("convs", docs);
  }
  function localLoadAll() {
    const docs = store.get("convs", {}) || {};
    for (const id of Object.keys(docs)) state.convs[id] = docs[id];
  }

  async function serverList() {
    const r = await fetch("/api/conversations", { headers: headers() });
    if (r.status === 401) { showGate(); throw new Error("access code"); }
    if (!r.ok) throw new Error("list failed");
    return r.json();
  }
  async function serverGet(id) {
    const r = await fetch("/api/conversations/" + id, { headers: headers() });
    if (!r.ok) throw new Error("get failed");
    return r.json();
  }
  async function serverPut(doc) {
    const r = await fetch("/api/conversations/" + doc.id, { method: "PUT", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(doc) });
    if (!r.ok) throw new Error("save failed");
    return r.json();
  }
  async function serverDelete(id) {
    await fetch("/api/conversations/" + id, { method: "DELETE", headers: headers() });
  }

  function markDirty(doc) {
    doc.updatedAt = Date.now();
    state.dirty.add(doc.id);
    localSaveAll();
    renderConvList();
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushSaves, SAVE_DEBOUNCE_MS);
    setSync("saving…");
  }

  async function flushSaves() {
    const ids = Array.from(state.dirty); state.dirty.clear();
    let failed = false;
    for (const id of ids) {
      const doc = state.convs[id];
      if (!doc || !doc.entries) continue;
      try { await serverPut(doc); state.serverOk = true; }
      catch { failed = true; state.dirty.add(id); }
    }
    if (failed) { state.serverOk = false; setSync("saved locally · server unreachable, will retry"); setTimeout(flushSaves, 15000); }
    else setSync(state.serverOk ? "synced to server" : "saved locally");
  }
  function setSync(t) { els.syncState.textContent = t; }

  async function syncFromServer() {
    try {
      const j = await serverList();
      state.serverOk = true;
      for (const m of j.conversations || []) {
        const local = state.convs[m.id];
        if (!local) state.convs[m.id] = { id: m.id, title: m.title, createdAt: m.createdAt, updatedAt: m.updatedAt, count: m.count };
        else if ((m.updatedAt || 0) > (local.updatedAt || 0)) {
          // Server is newer (edited from another device) - drop the stale local copy so it is re-fetched.
          state.convs[m.id] = { id: m.id, title: m.title, createdAt: m.createdAt, updatedAt: m.updatedAt, count: m.count };
        }
      }
      // Anything only local (server copy missing, e.g. after a redeploy on a free host) gets pushed back up.
      const serverIds = new Set((j.conversations || []).map((m) => m.id));
      for (const id of Object.keys(state.convs)) if (!serverIds.has(id) && state.convs[id].entries) state.dirty.add(id);
      if (state.dirty.size) flushSaves(); else setSync(j.store === "supabase" ? "synced · cloud storage" : "synced to server");
    } catch (e) {
      state.serverOk = false; setSync("saved locally · server unreachable");
    }
    renderConvList();
  }

  async function ensureLoaded(id) {
    let c = state.convs[id];
    if (c && c.entries) return c;
    try { c = await serverGet(id); state.convs[id] = c; localSaveAll(); return c; }
    catch { toast("Could not load conversation from server"); return null; }
  }

  // ------------------------------------------------------------------ conversations: ui
  function newConversation() {
    const doc = { id: randomId(12), title: "", createdAt: Date.now(), updatedAt: Date.now(), entries: [] };
    state.convs[doc.id] = doc;
    openConversation(doc);
    markDirty(doc);
    closeSide();
    return doc;
  }

  async function openConversation(docOrId) {
    const doc = typeof docOrId === "string" ? await ensureLoaded(docOrId) : docOrId;
    if (!doc) return;
    state.current = doc;
    store.set("current", doc.id);
    els.convTitle.value = doc.title || "";
    els.feed.querySelectorAll(".card").forEach((c) => c.remove());
    for (const e of doc.entries) renderCard(e, false);
    refreshEmpty(); clearLive();
    renderConvList(); updateConvMeta();
    scrollToBottom(true);
  }

  function updateConvMeta() {
    const c = state.current; if (!c) return;
    els.convMeta.textContent = `${c.entries.length} line${c.entries.length === 1 ? "" : "s"} · ${fmtDate(c.createdAt)}`;
  }

  function renderConvList() {
    const list = Object.values(state.convs).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    els.convList.innerHTML = "";
    if (!list.length) { els.convList.innerHTML = '<div class="side-empty">No conversations yet</div>'; return; }
    for (const c of list) {
      const d = document.createElement("div");
      d.className = "conv" + (state.current && state.current.id === c.id ? " active" : "");
      const n = c.entries ? c.entries.length : (c.count || 0);
      d.innerHTML = `<div class="t"></div><div class="m"><span>${fmtDate(c.updatedAt || c.createdAt)}</span><span>${n} line${n === 1 ? "" : "s"}</span></div>`;
      d.querySelector(".t").textContent = c.title || autoTitle(c);
      d.onclick = () => { openConversation(c.id); closeSide(); };
      els.convList.appendChild(d);
    }
  }

  function autoTitle(c) {
    const first = c.entries && c.entries.find((e) => e.text);
    return first ? first.text.slice(0, 48) : "";
  }

  function transcriptText(c) {
    const head = `${c.title || autoTitle(c) || "Untitled"}\n${fmtDate(c.createdAt)} · ${c.entries.length} lines\n${"=".repeat(50)}\n\n`;
    return head + c.entries.filter((e) => e.text).map((e) =>
      `[${fmtTime(e.at)}] ${(e.lang || "").toUpperCase()}: ${e.text}\n            ${(e.target || "").toUpperCase()}: ${e.translation || "(no translation)"}`
    ).join("\n\n");
  }

  async function downloadAllScripts() {
    const ids = Object.keys(state.convs);
    if (!ids.length) { toast("Nothing to download"); return; }
    const parts = [];
    for (const id of ids) { const c = await ensureLoaded(id); if (c) parts.push(c); }
    parts.sort((a, b) => a.createdAt - b.createdAt);
    download(`tarjem-all-scripts-${stamp()}.txt`, parts.map(transcriptText).join("\n\n\n" + "#".repeat(60) + "\n\n\n"));
  }

  async function backupJson() {
    const ids = Object.keys(state.convs);
    const docs = [];
    for (const id of ids) { const c = await ensureLoaded(id); if (c) docs.push(c); }
    download(`tarjem-backup-${stamp()}.json`, JSON.stringify({ exportedAt: Date.now(), userKey: state.userKey, conversations: docs }, null, 2), "application/json");
  }

  function openSide() { els.side.classList.add("open"); }
  function closeSide() { els.side.classList.remove("open"); }

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

  // ------------------------------------------------------------------ server: transcription
  function recentContext() {
    const c = state.current; if (!c) return [];
    return c.entries.filter((e) => e.text).slice(-CONTEXT_TURNS).map((e) => ({ text: e.text, lang: e.lang }));
  }

  async function postSegment(samples, kind) {
    const fd = new FormData();
    fd.append("audio", encodeWav16(samples), "segment.wav");
    fd.append("kind", kind);
    fd.append("mode", state.mode);
    fd.append("dialect", state.dialect);
    fd.append("translate", "1");
    fd.append("context", JSON.stringify(recentContext()));
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
    } catch (e) { console.warn("interim failed", e); }
    finally { state.interimInFlight = false; }
  }

  function finalizeSegment(seg) {
    if (!seg || segDuration(seg) < MIN_FINAL_S) return;
    if (!state.current) newConversation();
    const conv = state.current;
    const samples = concatFrames(seg.frames);
    const entry = { at: seg.startedAt, text: "", lang: "", target: "", translation: "" };
    const card = renderCard(entry, true);
    setStatus("transcribing…", "busy");
    const t0 = performance.now();
    postSegment(samples, "final").then((j) => {
      if (j.dropped) { card.remove(); refreshEmpty(); return; }
      entry.text = j.text; entry.lang = j.lang; entry.target = j.target;
      entry.translation = j.translation || ""; entry.error = j.translation_error || "";
      conv.entries.push(entry);
      if (!conv.title) { els.convTitle.value = ""; }
      markDirty(conv); updateConvMeta();
      updateCard(card, entry);
      els.latency.textContent = Math.round(performance.now() - t0) + " ms";
      if (state.speak && entry.translation) enqueueTts(entry.translation, entry.target);
    }).catch((e) => {
      entry.error = e.message; updateCard(card, entry); toast(e.message);
    }).finally(() => { if (state.listening) setStatus(state.speaking ? "speaking" : "listening", "on"); });
  }

  // ------------------------------------------------------------------ scrolling
  // The bottom bar (live preview + mic) is fixed; keep main's bottom padding equal to its
  // height so the newest card is never hidden behind it, and follow new lines like a chat.
  const bar = $("bar"), jumpBtn = $("jumpBtn");
  function syncBarHeight() { document.body.style.setProperty("--barH", bar.getBoundingClientRect().height + "px"); }
  if (window.ResizeObserver) new ResizeObserver(syncBarHeight).observe(bar); else window.addEventListener("resize", syncBarHeight);
  syncBarHeight();
  function distanceFromBottom() { const se = document.scrollingElement; return se.scrollHeight - se.clientHeight - se.scrollTop; }
  let followNewest = true;
  function scrollToBottom(force) {
    if (!force && !followNewest) return;
    requestAnimationFrame(() => window.scrollTo({ top: document.scrollingElement.scrollHeight, behavior: force ? "smooth" : "auto" }));
    followNewest = true; jumpBtn.classList.remove("show");
  }
  window.addEventListener("scroll", () => {
    followNewest = distanceFromBottom() < 160;
    jumpBtn.classList.toggle("show", !followNewest && !!els.feed.querySelector(".card"));
  }, { passive: true });
  jumpBtn.onclick = () => scrollToBottom(true);

  // ------------------------------------------------------------------ cards
  function refreshEmpty() { els.emptyHint.style.display = els.feed.querySelector(".card") ? "none" : ""; }

  function renderCard(entry, pending) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <div class="meta"><span class="badge">…</span><span class="time">${fmtTime(entry.at)}</span>
        <span class="actions"><button class="play" title="Speak translation">🔊</button><button class="copy" title="Copy">⧉</button></span></div>
      <div class="orig"></div>
      <div class="trans pending">listening…</div>`;
    card.querySelector(".play").onclick = () => { if (entry.translation) enqueueTts(entry.translation, entry.target); };
    card.querySelector(".copy").onclick = () => navigator.clipboard?.writeText(entry.text + "\n" + entry.translation).then(() => toast("Copied", 1200, true));
    els.feed.appendChild(card); refreshEmpty();
    if (!pending) updateCard(card, entry);
    else scrollToBottom(false);
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
    if (card === els.feed.lastElementChild) scrollToBottom(false);
  }

  // ------------------------------------------------------------------ tts
  function enqueueTts(text, lang) { state.ttsQueue.push({ text, lang }); pumpTts(); }

  async function pumpTts() {
    if (state.ttsPlaying || !state.ttsQueue.length) return;
    state.ttsPlaying = true;
    const { text, lang } = state.ttsQueue.shift();
    try {
      if (state.duck && state.vad && state.listening) { await state.vad.pause(); state.ducked = true; setStatus("speaking translation", "busy"); }
      const r = await fetch("/api/tts?" + new URLSearchParams({ text, lang }), { headers: headers() });
      if (!r.ok) throw new Error("tts unavailable");
      const blob = await r.blob();
      await new Promise((res) => { const a = new Audio(URL.createObjectURL(blob)); a.onended = res; a.onerror = res; a.play().catch(res); });
    } catch (e) {
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
        if (segDuration(seg) >= MAX_SEGMENT_S) { finalizeSegment(seg); startSegment(false); clearLive(); return; }
        if (state.liveInterim && now - seg.lastInterim >= INTERIM_EVERY_MS && segDuration(seg) >= INTERIM_MIN_S) { seg.lastInterim = now; sendInterim(seg); }
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
      if (!state.current) newConversation();
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
    els.live.classList.remove("speaking"); els.liveLabel.textContent = "Listening"; clearLive(); els.lvl.style.width = "0";
    els.micBtn.classList.remove("on"); els.micBtn.textContent = "🎤"; els.hintR.textContent = "tap to start";
    setStatus("idle", "");
  }

  async function rebuildVad() {
    const was = state.listening;
    if (was) await stopListening();
    if (state.vad) { try { state.vad.destroy(); } catch {} state.vad = null; }
    if (was) await startListening();
  }

  // ------------------------------------------------------------------ access gate
  function showGate() { els.gate.classList.add("show"); els.codeInput.value = ""; setTimeout(() => els.codeInput.focus(), 50); }
  async function tryCode(code) {
    const r = await fetch("/api/auth", { method: "POST", headers: { "X-Access-Code": code } });
    if (r.ok) { state.code = code; store.set("code", code); els.gate.classList.remove("show"); toast("Unlocked", 1200, true); syncFromServer(); return true; }
    toast("Wrong access code"); return false;
  }

  async function boot() {
    localLoadAll();
    let cfg = {};
    try { cfg = await (await fetch("/api/config")).json(); } catch {}
    if (!cfg.stt_ready) toast("Server has no GROQ_API_KEY - transcription will fail", 6000);
    if (cfg.access_required) {
      if (!state.code) showGate();
      else { const r = await fetch("/api/auth", { method: "POST", headers: headers() }); if (!r.ok) showGate(); }
    }
    await syncFromServer();
    const lastId = store.get("current", "");
    if (lastId && state.convs[lastId]) await openConversation(lastId);
    else {
      const newest = Object.values(state.convs).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      if (newest) await openConversation(newest.id); else newConversation();
    }
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

  const dialectSeg = $("dialectSeg");
  function applyDialect(d) {
    state.dialect = d; store.set("dialect", d);
    dialectSeg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.dialect === d));
  }
  dialectSeg.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) applyDialect(b.dataset.dialect); });
  applyDialect(state.dialect);

  els.speak.checked = state.speak; els.speakToggle.classList.toggle("on", state.speak);
  els.speak.onchange = () => { state.speak = els.speak.checked; store.set("speak", state.speak); els.speakToggle.classList.toggle("on", state.speak); };
  els.liveInterim.checked = state.liveInterim; els.liveToggle.classList.toggle("on", state.liveInterim);
  els.liveInterim.onchange = () => { state.liveInterim = els.liveInterim.checked; store.set("live", state.liveInterim); els.liveToggle.classList.toggle("on", state.liveInterim); };

  els.micBtn.onclick = () => (state.listening ? stopListening() : startListening());
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !/input|select|textarea/i.test(e.target.tagName)) { e.preventDefault(); els.micBtn.click(); }
  });

  els.menuBtn.onclick = () => els.side.classList.toggle("open");
  els.newConv.onclick = () => newConversation();
  els.downloadAll.onclick = downloadAllScripts;
  els.backupJson.onclick = backupJson;
  els.convTitle.onchange = () => { if (state.current) { state.current.title = els.convTitle.value.trim(); markDirty(state.current); } };
  els.downloadConv.onclick = () => { const c = state.current; if (c) download(`tarjem-${safeName(c.title || autoTitle(c))}-${stamp()}.txt`, transcriptText(c)); };
  els.copyBtn.onclick = () => { if (state.current) navigator.clipboard?.writeText(transcriptText(state.current)).then(() => toast("Transcript copied", 1200, true)); };
  els.deleteConv.onclick = async () => {
    const c = state.current; if (!c) return;
    if (!confirm(`Delete "${c.title || autoTitle(c) || "this conversation"}"? This cannot be undone.`)) return;
    if (state.listening) await stopListening();
    delete state.convs[c.id]; state.dirty.delete(c.id); localSaveAll();
    serverDelete(c.id).catch(() => {});
    state.current = null;
    const next = Object.values(state.convs).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (next) await openConversation(next.id); else newConversation();
    toast("Deleted", 1200, true);
  };

  els.codeBtn.onclick = () => tryCode(els.codeInput.value.trim());
  els.codeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") els.codeBtn.click(); });

  els.settingsBtn.onclick = async () => {
    els.setRedemption.value = String(state.redemptionMs); els.setThreshold.value = String(state.threshold); els.setDuck.checked = state.duck;
    els.userKey.textContent = state.userKey;
    els.settings.classList.add("show");
    try {
      const h = await (await fetch("/api/health", { headers: headers() })).json();
      els.setInfo.textContent = `STT: ${h.stt_model} · translation: ${h.translate_provider} / ${h.translate_model} · storage: ${h.store}` + (h.stt ? "" : " · ⚠ no GROQ_API_KEY");
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
  els.setUserKey.onclick = async () => {
    const k = prompt("Paste the sync key from your other device:", "");
    if (!k) return;
    if (!/^[A-Za-z0-9_-]{8,48}$/.test(k.trim())) { toast("That doesn't look like a sync key"); return; }
    await flushSaves();
    state.userKey = k.trim(); store.set("userkey", state.userKey);
    state.convs = {}; state.current = null; store.del("convs"); store.del("current");
    els.settings.classList.remove("show");
    await syncFromServer();
    const newest = Object.values(state.convs)[0];
    if (newest) await openConversation(newest.id); else newConversation();
    toast("Switched to the other device's conversations", 2500, true);
  };

  window.addEventListener("beforeunload", () => { if (state.dirty.size) localSaveAll(); if (state.vad && state.listening) try { state.vad.destroy(); } catch {} });
  boot();
})();
