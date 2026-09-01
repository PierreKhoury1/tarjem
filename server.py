"""Tarjem - real-time Arabic <-> English transcriber + translator.

Browser does voice-activity detection and ships speech segments as WAV.
This server forwards them to Groq Whisper (large-v3) for transcription,
translates with a free Groq-hosted LLM (or Gemini if configured), and can
synthesise the translation with edge-tts. Nothing runs locally except this
thin relay, so it deploys to a free Render web service.
"""
from __future__ import annotations

import asyncio
import hmac
import io
import json
import logging
import os
import re
import threading
import time
import wave
from collections import OrderedDict, defaultdict, deque

import requests
from flask import Flask, Response, abort, jsonify, request, send_from_directory

log = logging.getLogger("tarjem")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
GROQ_BASE = "https://api.groq.com/openai/v1"
STT_MODEL = os.environ.get("STT_MODEL", "whisper-large-v3")
STT_INTERIM_MODEL = os.environ.get("STT_INTERIM_MODEL", "whisper-large-v3-turbo")

TRANSLATE_PROVIDER = os.environ.get("TRANSLATE_PROVIDER", "groq").lower()
# Groq rotates models often; try each in order and stick with the first that works.
TRANSLATE_MODELS = [
    m.strip()
    for m in os.environ.get(
        "TRANSLATE_MODELS",
        "moonshotai/kimi-k2-instruct-0905,openai/gpt-oss-120b,llama-3.3-70b-versatile",
    ).split(",")
    if m.strip()
]
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

ACCESS_CODE = os.environ.get("ACCESS_CODE", "").strip()
TTS_VOICE_EN = os.environ.get("TTS_VOICE_EN", "en-US-JennyNeural")
TTS_VOICE_AR = os.environ.get("TTS_VOICE_AR", "ar-SA-ZariyahNeural")
RATE_LIMIT_PER_MIN = int(os.environ.get("RATE_LIMIT_PER_MIN", "90"))
MAX_AUDIO_BYTES = 6 * 1024 * 1024  # ~3 min of 16 kHz PCM

app = Flask(__name__, static_folder=None)

LANG_NAMES = {"ar": "Arabic", "en": "English"}

# Phrases Whisper emits on silence / music instead of real speech.
JUNK_PATTERNS = [
    r"اشترك(وا)? في القناة",
    r"ترجمة نانسي قنقر",
    r"شكرا? (جزيلا )?(على|ل)?(ال)?مشاهد",
    r"لا تنسوا الاشتراك",
    r"subscribe to (my|the|our) channel",
    r"thanks? (you )?for watching",
    r"^\s*(you|bye|thank you\.?)\s*$",
    r"^\s*\.+\s*$",
]
JUNK_RE = re.compile("|".join(JUNK_PATTERNS), re.IGNORECASE)


# --------------------------------------------------------------------------- #
# access + rate limiting
# --------------------------------------------------------------------------- #
_hits: dict[str, deque] = defaultdict(deque)
_hits_lock = threading.Lock()


def _client_ip() -> str:
    fwd = request.headers.get("X-Forwarded-For", "")
    return (fwd.split(",")[0].strip() if fwd else request.remote_addr) or "?"


def _check_access() -> None:
    if ACCESS_CODE:
        given = request.headers.get("X-Access-Code", "")
        if not hmac.compare_digest(given.encode(), ACCESS_CODE.encode()):
            abort(401, description="bad access code")
    ip = _client_ip()
    now = time.time()
    with _hits_lock:
        q = _hits[ip]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= RATE_LIMIT_PER_MIN:
            abort(429, description="too many requests")
        q.append(now)


@app.errorhandler(401)
@app.errorhandler(413)
@app.errorhandler(429)
@app.errorhandler(400)
def _err(e):
    return jsonify(error=str(getattr(e, "description", e))), getattr(e, "code", 500)


# --------------------------------------------------------------------------- #
# speech to text (Groq Whisper)
# --------------------------------------------------------------------------- #
def _wav_duration(data: bytes) -> float:
    try:
        with wave.open(io.BytesIO(data)) as w:
            return w.getnframes() / float(w.getframerate() or 16000)
    except Exception:
        return 0.0


def _looks_like_junk(text: str, segments: list[dict], duration: float) -> str | None:
    """Return a reason string when the transcript should be discarded."""
    t = text.strip()
    if not t:
        return "empty"
    if JUNK_RE.search(t):
        return "known hallucination phrase"
    if segments:
        nsp = sum(float(s.get("no_speech_prob", 0)) for s in segments) / len(segments)
        lp = sum(float(s.get("avg_logprob", 0)) for s in segments) / len(segments)
        cr = max(float(s.get("compression_ratio", 0)) for s in segments)
        if nsp > 0.7 and lp < -0.9:
            return f"no-speech {nsp:.2f} logprob {lp:.2f}"
        if cr > 2.6:
            return f"repetitive (compression {cr:.2f})"
    # Long transcript for a tiny clip => made up.
    words = len(t.split())
    if duration > 0 and words / duration > 8:
        return "too many words for clip length"
    # Same short token repeated over and over.
    toks = t.split()
    if len(toks) >= 6 and len(set(toks)) <= 2:
        return "repeated token"
    return None


def transcribe(wav_bytes: bytes, *, interim: bool, lang: str | None, prompt: str) -> dict:
    if not GROQ_API_KEY:
        raise RuntimeError("GROQ_API_KEY is not set")
    model = STT_INTERIM_MODEL if interim else STT_MODEL
    data = {
        "model": model,
        "response_format": "verbose_json",
        "temperature": "0",
    }
    if lang in LANG_NAMES:
        data["language"] = lang
    if prompt:
        data["prompt"] = prompt[-600:]
    files = {"file": ("segment.wav", wav_bytes, "audio/wav")}
    r = requests.post(
        f"{GROQ_BASE}/audio/transcriptions",
        headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
        data=data,
        files=files,
        timeout=60,
    )
    if r.status_code == 429:
        raise RuntimeError("Groq rate limit hit - wait a moment")
    if r.status_code >= 400:
        raise RuntimeError(f"Groq STT {r.status_code}: {r.text[:200]}")
    j = r.json()
    text = (j.get("text") or "").strip()
    detected = (j.get("language") or "").lower()
    # Whisper reports full names ("arabic") on some models, codes on others.
    if detected.startswith("ar"):
        detected = "ar"
    elif detected.startswith("en"):
        detected = "en"
    elif lang in LANG_NAMES:
        detected = lang
    else:
        detected = _guess_lang(text)
    return {"text": text, "lang": detected, "segments": j.get("segments") or [], "model": model}


ARABIC_RE = re.compile(r"[؀-ۿ]")


def _guess_lang(text: str) -> str:
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return "en"
    ar = sum(1 for c in letters if ARABIC_RE.match(c))
    return "ar" if ar / len(letters) > 0.4 else "en"


# --------------------------------------------------------------------------- #
# translation
# --------------------------------------------------------------------------- #
SYSTEM_PROMPT = (
    "You are a professional simultaneous interpreter working between Arabic and English. "
    "You will receive one spoken utterance transcribed from audio. Translate it into {target}.\n"
    "Rules:\n"
    "- Render the meaning naturally in {target}, keeping the speaker's tone and register.\n"
    "- Understand all Arabic varieties: Levantine (Palestinian, Jordanian, Syrian, Lebanese), Egyptian, Gulf, "
    "Iraqi, Maghrebi and Modern Standard Arabic. Do not translate idioms literally.\n"
    "- Keep names, places, numbers, times and currencies exact.\n"
    "- The transcript may contain small speech-recognition errors; infer the intended words from context.\n"
    "- If the utterance mixes languages, give one complete {target} rendering of the whole thing.\n"
    "- If the utterance is already entirely in {target}, return it unchanged apart from fixing obvious punctuation.\n"
    "- Output ONLY the translation. No quotes, no notes, no explanations, no transliteration, no alternatives."
)

_working_model: str | None = None
_model_lock = threading.Lock()


def _groq_chat(model: str, system: str, user: str) -> str:
    r = requests.post(
        f"{GROQ_BASE}/chat/completions",
        headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
        json={
            "model": model,
            "temperature": 0.2,
            "max_tokens": 600,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        },
        timeout=45,
    )
    if r.status_code >= 400:
        raise requests.HTTPError(f"{r.status_code}: {r.text[:200]}", response=r)
    msg = r.json()["choices"][0]["message"]
    return (msg.get("content") or "").strip()


def _gemini_chat(system: str, user: str) -> str:
    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
        params={"key": GEMINI_API_KEY},
        json={
            "system_instruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 600},
        },
        timeout=45,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Gemini {r.status_code}: {r.text[:200]}")
    j = r.json()
    return "".join(p.get("text", "") for p in j["candidates"][0]["content"]["parts"]).strip()


def _clean_translation(out: str) -> str:
    out = out.strip()
    # Strip a wrapping pair of quotes some models add.
    if len(out) > 1 and out[0] in "\"'“«" and out[-1] in "\"'”»":
        out = out[1:-1].strip()
    # Drop "Translation:" style prefixes.
    out = re.sub(r"^(translation|الترجمة)\s*[:：]\s*", "", out, flags=re.IGNORECASE)
    return out


def translate(text: str, source: str, target: str, context: list[dict]) -> dict:
    global _working_model
    system = SYSTEM_PROMPT.format(target=LANG_NAMES[target])
    ctx_lines = []
    for c in context[-6:]:
        src = (c.get("text") or "").strip()
        if src:
            ctx_lines.append(f"- {src}")
    user = ""
    if ctx_lines:
        user += "Earlier utterances in this conversation (context only, do NOT translate these):\n"
        user += "\n".join(ctx_lines) + "\n\n"
    user += f"Utterance to translate into {LANG_NAMES[target]} (spoken in {LANG_NAMES[source]}):\n{text}"

    if TRANSLATE_PROVIDER == "gemini" and GEMINI_API_KEY:
        return {"translation": _clean_translation(_gemini_chat(system, user)), "model": GEMINI_MODEL}

    if not GROQ_API_KEY:
        raise RuntimeError("GROQ_API_KEY is not set")
    with _model_lock:
        preferred = _working_model
    order = ([preferred] if preferred else []) + [m for m in TRANSLATE_MODELS if m != preferred]
    last_err: Exception | None = None
    for model in order:
        try:
            out = _groq_chat(model, system, user)
            if out:
                with _model_lock:
                    _working_model = model
                return {"translation": _clean_translation(out), "model": model}
        except requests.HTTPError as e:
            last_err = e
            log.warning("translate model %s failed: %s", model, e)
            continue
    raise RuntimeError(f"all translation models failed: {last_err}")


# --------------------------------------------------------------------------- #
# text to speech (edge-tts)
# --------------------------------------------------------------------------- #
_tts_cache: "OrderedDict[str, bytes]" = OrderedDict()
_tts_lock = threading.Lock()


def synthesize(text: str, lang: str) -> bytes:
    import edge_tts  # imported lazily so the server still boots without it

    voice = TTS_VOICE_AR if lang == "ar" else TTS_VOICE_EN
    key = f"{voice}|{text}"
    with _tts_lock:
        if key in _tts_cache:
            _tts_cache.move_to_end(key)
            return _tts_cache[key]

    async def run() -> bytes:
        buf = io.BytesIO()
        async for chunk in edge_tts.Communicate(text, voice).stream():
            if chunk["type"] == "audio":
                buf.write(chunk["data"])
        return buf.getvalue()

    audio = asyncio.run(run())
    with _tts_lock:
        _tts_cache[key] = audio
        while len(_tts_cache) > 200:
            _tts_cache.popitem(last=False)
    return audio


# --------------------------------------------------------------------------- #
# routes
# --------------------------------------------------------------------------- #
@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/static/<path:path>")
def static_files(path):
    resp = send_from_directory(STATIC_DIR, path)
    if path.startswith("vad/"):
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.get("/api/health")
def health():
    return jsonify(
        ok=True,
        stt=bool(GROQ_API_KEY),
        stt_model=STT_MODEL,
        translate_provider="gemini" if (TRANSLATE_PROVIDER == "gemini" and GEMINI_API_KEY) else "groq",
        translate_model=_working_model or TRANSLATE_MODELS[0],
        access_required=bool(ACCESS_CODE),
    )


@app.get("/api/config")
def config():
    return jsonify(access_required=bool(ACCESS_CODE), stt_ready=bool(GROQ_API_KEY))


@app.post("/api/auth")
def auth():
    _check_access()
    return jsonify(ok=True)


@app.post("/api/transcribe")
def api_transcribe():
    _check_access()
    f = request.files.get("audio")
    if f is None:
        abort(400, description="audio file missing")
    wav = f.read()
    if len(wav) > MAX_AUDIO_BYTES:
        abort(413, description="audio too long")
    kind = request.form.get("kind", "final")
    mode = request.form.get("mode", "auto")
    want_translation = request.form.get("translate", "1") != "0"
    try:
        context = json.loads(request.form.get("context") or "[]")
    except json.JSONDecodeError:
        context = []
    forced = mode if mode in LANG_NAMES else None
    duration = _wav_duration(wav)
    if duration < 0.25:
        return jsonify(dropped=True, reason="too short", duration=duration)

    # Whisper's prompt conditions spelling/style on prior text in the same language.
    prompt = " ".join(
        (c.get("text") or "") for c in context[-4:] if (forced is None or c.get("lang") == forced)
    ).strip()

    t0 = time.time()
    try:
        stt = transcribe(wav, interim=(kind == "interim"), lang=forced, prompt=prompt)
    except Exception as e:
        log.warning("stt failed: %s", e)
        return jsonify(error=f"transcription failed: {e}"), 502
    t_stt = time.time() - t0

    reason = _looks_like_junk(stt["text"], stt["segments"], duration)
    if reason:
        log.info("dropped %s segment (%s): %r", kind, reason, stt["text"][:80])
        return jsonify(dropped=True, reason=reason, duration=duration)

    source = stt["lang"]
    target = "en" if source == "ar" else "ar"
    result = {
        "kind": kind,
        "text": stt["text"],
        "lang": source,
        "target": target,
        "duration": round(duration, 2),
        "stt_ms": int(t_stt * 1000),
        "stt_model": stt["model"],
    }
    if want_translation:
        t1 = time.time()
        try:
            tr = translate(stt["text"], source, target, context)
            result["translation"] = tr["translation"]
            result["translate_model"] = tr["model"]
            result["translate_ms"] = int((time.time() - t1) * 1000)
        except Exception as e:
            log.warning("translate failed: %s", e)
            result["translation_error"] = str(e)
    return jsonify(result)


@app.post("/api/translate")
def api_translate():
    _check_access()
    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        abort(400, description="text missing")
    source = body.get("source") or _guess_lang(text)
    if source not in LANG_NAMES:
        source = _guess_lang(text)
    target = body.get("target") or ("en" if source == "ar" else "ar")
    if target not in LANG_NAMES:
        abort(400, description="bad target")
    try:
        tr = translate(text, source, target, body.get("context") or [])
    except Exception as e:
        return jsonify(error=str(e)), 502
    return jsonify(text=text, lang=source, target=target, **tr)


@app.get("/api/tts")
def api_tts():
    _check_access()
    text = (request.args.get("text") or "").strip()[:1000]
    lang = request.args.get("lang", "en")
    if not text:
        abort(400, description="text missing")
    try:
        audio = synthesize(text, "ar" if lang == "ar" else "en")
    except Exception as e:
        log.warning("tts failed: %s", e)
        return jsonify(error=f"tts failed: {e}"), 502
    return Response(audio, mimetype="audio/mpeg", headers={"Cache-Control": "private, max-age=3600"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8096"))
    if not GROQ_API_KEY:
        log.warning("GROQ_API_KEY not set - transcription and translation will fail")
    if not ACCESS_CODE:
        log.warning("ACCESS_CODE not set - anyone who finds the URL can use your API quota")
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
