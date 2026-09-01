# Tarjem · ترجم

Real-time Arabic ⇄ English interpreter that runs in the browser and on a free Render web service. Nothing is processed on your machine.

- **Speech → text:** Groq-hosted Whisper large-v3 (free tier). Auto-detects Arabic vs English, or force a direction.
- **Translation:** free Groq LLMs (gpt-oss-120b → Qwen 3.8 27B → Qwen 3.6 27B → gpt-oss-20b fallback chain) with conversation context, or Gemini 2.5 Flash if you set a Gemini key.
- **Live preview:** while you are still talking a partial transcript + translation is shown every ~3 s; the final sentence is re-transcribed with the full model when you pause.
- **Voice out:** optional edge-tts playback of every translation (mic auto-mutes while it speaks).
- **Endpointing:** Silero VAD v5 in the browser (vendored under `static/vad/`, no CDN).
- **Conversations:** every session is saved as a conversation. Sidebar lists history; open any one to read it or keep recording into it; rename, delete, download one script or all scripts as .txt, or a full .json backup.

## Where conversations live

Three copies, so nothing is lost:

1. **Browser** (localStorage) - instant, works offline.
2. **Server** - `data/<sync-key>/` on a PC. On Render the disk is wiped at every redeploy, so add layer 3 there.
3. **Supabase Storage** (optional, free) - set `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` and the server keeps the same JSON files in a private bucket called `tarjem`. No tables, no SQL; the bucket is created automatically.

Conversations are keyed by a random **sync key** the browser generates (Settings → Sync key). Paste that key into another device to see the same history there. Nobody can read your conversations without the key.

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
