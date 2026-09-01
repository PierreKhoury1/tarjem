# Tarjem · ترجم

Real-time Arabic ⇄ English interpreter that runs in the browser and on a free Render web service. Nothing is processed on your machine.

- **Speech → text:** Groq-hosted Whisper large-v3 (free tier). Auto-detects Arabic vs English, or force a direction.
- **Translation:** free Groq LLMs (gpt-oss-120b → Qwen 3.8 27B → Qwen 3.6 27B → gpt-oss-20b fallback chain) with conversation context, or Gemini 2.5 Flash if you set a Gemini key.
- **Live preview:** while you are still talking a partial transcript + translation is shown every ~3 s; the final sentence is re-transcribed with the full model when you pause.
- **Voice out:** optional edge-tts playback of every translation (mic auto-mutes while it speaks).
- **Endpointing:** Silero VAD v5 in the browser (vendored under `static/vad/`, no CDN).

## Run locally (still uses the cloud APIs)

```
set GROQ_API_KEY=gsk_...
set ACCESS_CODE=choose-something
python server.py
```

Open http://localhost:8096.

## Deploy on Render (free)

1. Push this folder to a GitHub repo.
2. Render → New → Blueprint → pick the repo. `render.yaml` defines the service.
3. Set `GROQ_API_KEY` (free at https://console.groq.com/keys) and `ACCESS_CODE` in the dashboard.
4. Open the URL, enter the access code, tap the mic.

## Groq free-tier limits (per model)

| Model | Requests/min | Requests/day |
|---|---|---|
| whisper-large-v3 (final sentences) | 20 | 2000 |
| whisper-large-v3-turbo (live preview) | 20 | 2000 |
| each translation LLM | 30–60 | 1000 |

Turn off "Live preview" to halve the request rate if you hit 429s.

## Endpoints

- `POST /api/transcribe` – multipart `audio` (16 kHz mono WAV), `kind=interim|final`, `mode=auto|ar|en`, `context` JSON → `{text, lang, target, translation}`
- `POST /api/translate` – `{text, source, target, context}`
- `GET /api/tts?text=&lang=ar|en` – MP3
- `GET /api/health`

All API routes require the `X-Access-Code` header when `ACCESS_CODE` is set.
