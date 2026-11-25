# 🤖 Intelligent Enterprise Assistant (IEA)

A **RAG-based (Retrieval-Augmented Generation) HR & IT chatbot** for employees. It answers questions from company policy documents only — never guesses. Delivered through a **web chat UI** (browser) and optionally **WhatsApp** (Twilio sandbox).

---

## 📋 Table of Contents

1. [What It Does](#what-it-does)
2. [How It Works – Architecture](#how-it-works--architecture)
3. [Where It Runs – Deployment](#where-it-runs--deployment)
4. [Frontend vs Backend](#frontend-vs-backend)
5. [How to Access It](#how-to-access-it)
6. [WhatsApp Setup](#whatsapp-setup)
7. [API Keys & Configuration](#api-keys--configuration)
8. [Starting the App](#starting-the-app)
9. [Project File Structure](#project-file-structure)
10. [Known Limitations](#known-limitations)

---

## What It Does

IEA answers employee questions like:

| Question | Source |
|---|---|
| "How many sick leaves do I get?" | HR leave-policy.txt |
| "How do I reset my password?" | IT password-reset-sop.txt |
| "What is the reimbursement deadline?" | HR reimbursement-policy.txt |
| "How do I request VPN access?" | IT vpn-access-sop.txt |

**It does NOT:**
- Approve leave requests
- Make policy decisions
- Answer from general knowledge (only from company documents)
- Carry forward rules it cannot find in documents

---

## How It Works – Architecture

```
User (Web browser / WhatsApp)
        │
        ▼
┌───────────────────────────────────────────────────────┐
│                   IEA Server (Node.js)                 │
│                   http://localhost:3000                │
│                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │  Web Chat UI  │  │  REST API    │  │  WhatsApp   │  │
│  │ (WebSocket)  │  │  POST /ask   │  │  /whatsapp  │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬──────┘  │
│         └─────────────────┴─────────────────┘         │
│                            │                          │
│                    ┌───────▼────────┐                 │
│                    │   PIPELINE     │                 │
│                    │  1. Filter     │  ← blocks bad input
│                    │  2. Cache?     │  ← exact/semantic
│                    │  3. Retrieve   │  ← vector search
│                    │  4. Generate   │  ← Gemini LLM
│                    │  5. Validate   │  ← 2nd LLM check
│                    │  6. Cache Save │                 │
│                    │  7. Log        │  ← SQLite DB    │
│                    └───────┬────────┘                 │
└────────────────────────────┼──────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
     ┌─────────────┐  ┌────────────┐  ┌──────────┐
     │  ChromaDB   │  │   Gemini   │  │  Redis   │
     │ (Vectors)   │  │   API      │  │ (Cache)  │
     └─────────────┘  └────────────┘  └──────────┘
```

### The 7-Step Pipeline (every question goes through this):

1. **Filter** — blocks profanity, prompt injection, empty/too-long input
2. **Cache Check** — returns instantly if same/similar question was asked before
3. **Retrieve** — embeds the question, finds top-4 matching document chunks
4. **Generate** — Gemini LLM answers using ONLY the retrieved document text
5. **Validate** — a second Gemini call checks every claim has an exact quote from context
6. **Cache Write** — saves validated answers for future reuse
7. **Log** — records everything to SQLite (question, answer, timing, verdict)

---

## Where It Runs – Deployment

> **This is a local development setup.** The server runs on **your own laptop**, not on any cloud.

| Component | Where it runs |
|---|---|
| Node.js server | `localhost:3000` on your PC |
| Vector store | In-memory on your PC (vectors saved to `chroma_data/vectors.json`) |
| Cache | In-memory (Redis mock, resets on restart) |
| Database logs | `logs/iea.sqlite` on your PC |
| **Public access** | Via **ngrok tunnel** — generates a temporary public HTTPS URL |
| WhatsApp | Twilio sandbox → ngrok URL → your local server |

**To make it accessible from outside your laptop** (for WhatsApp to reach it), you need ngrok running. When ngrok is stopped, WhatsApp stops working — but the web chat still works locally.

---

## Frontend vs Backend

| | Details |
|---|---|
| **Frontend** | `public/index.html` — a single HTML file served by the same Express server. It's a dark-themed chat UI with a department dropdown. Connects to the backend over WebSocket. |
| **Backend** | Everything in `src/` — Express + WebSocket server, Gemini API calls, vector search, validation, caching, logging. |
| **Same server?** | Yes. Both frontend and backend run on the same Node.js process at `http://localhost:3000`. You don't need to run them separately. |

---

## How to Access It

### Option 1: Web Browser (simplest)

1. Start the server (see below)
2. Open **http://localhost:3000** in your browser
3. Select department (HR or IT), type your question, press Enter

That's it — no app installation, no WhatsApp needed.

### Option 2: REST API (for developers / integrations)

```bash
# Ask a question
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"How many sick leaves do I get?","department":"HR"}'

# Health check
curl http://localhost:3000/health
```

### Option 3: WhatsApp (requires ngrok running)

1. Start ngrok (see below)
2. Copy the ngrok HTTPS URL
3. Update `.env` → `PUBLIC_BASE_URL=https://your-ngrok-url.ngrok-free.app`
4. Set Twilio webhook to `https://your-ngrok-url.ngrok-free.app/whatsapp`
5. Send a WhatsApp message to `+1 415 523 8886` (Twilio sandbox)

WhatsApp flow:
- New user → bot replies "Reply 1 for HR, 2 for IT"
- After selection → ask questions in plain text
- Send "menu" → resets department selection

---

## WhatsApp Setup

**Step 1 — Join the Twilio sandbox**

Send this WhatsApp message to `+1 415 523 8886`:
```
join <your-sandbox-word>
```
(Find your sandbox word at: https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn)

**Step 2 — Start ngrok**

```powershell
# In a separate terminal
ngrok http 3000
```

Copy the HTTPS URL shown, e.g. `https://abc123.ngrok-free.app`

**Step 3 — Update .env**

```env
PUBLIC_BASE_URL=https://abc123.ngrok-free.app
```

**Step 4 — Set Twilio webhook**

In Twilio Console → Messaging → Try it out → WhatsApp → Sandbox Settings:
- **When a message comes in:** `https://abc123.ngrok-free.app/whatsapp`
- Method: `HTTP POST`

**Step 5 — Restart server**

```powershell
npm start
```

---

## API Keys & Configuration

All secrets live in `.env` (never committed to git):

```env
# ── Google Gemini ──────────────────────────────────────
GEMINI_API_KEY=your_gemini_api_key_here
GEN_MODEL=gemini-2.0-flash-lite       # Main answer model
VALIDATOR_MODEL=gemini-2.0-flash-lite # Hallucination checker
EMBED_MODEL=gemini-embedding-001      # Turns text into vectors

# ── Twilio WhatsApp ────────────────────────────────────
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886

# ── Infrastructure ─────────────────────────────────────
REDIS_URL=redis://localhost:6379      # Using in-memory fallback (no Redis server needed)
CHROMA_URL=http://localhost:8000      # Using local file fallback (no Docker needed)
PORT=3000
PUBLIC_BASE_URL=https://your-ngrok-url.ngrok-free.app  # Update when ngrok restarts

# ── Pipeline tuning ────────────────────────────────────
CACHE_TTL_SECONDS=86400      # Cache answers for 24 hours
CACHE_SIM_THRESHOLD=0.92     # Semantic similarity threshold (0-1)
RETRIEVAL_TOP_K=4            # Return top 4 document chunks
RETRIEVAL_MIN_SCORE=0.5      # Minimum relevance score
VALIDATE_REQUESTS=true       # Enable hallucination validator
```

### ⚠️ Important: ngrok URL changes every restart

Every time you run `ngrok http 3000`, you get a **new URL**. You must:
1. Copy the new URL from ngrok output
2. Update `PUBLIC_BASE_URL` in `.env`
3. Update the webhook URL in Twilio Console
4. Restart the server (`npm start`)

---

## Starting the App

### Every time you want to use IEA:

**Terminal 1 — Start the server:**
```powershell
cd "c:\Users\Vaibhavi Kahar\OneDrive\Desktop\certification\IEA"
npm start
```
Wait for:
```
[server] ✓ IEA running   → http://localhost:3000
```

**Terminal 2 — (Only for WhatsApp) Start ngrok:**
```powershell
ngrok http 3000
```

**Open browser:**
```
http://localhost:3000
```

### Other useful commands:

```powershell
# Re-ingest documents (after adding new .txt/.pdf files to docs/)
npm run ingest

# Ask a question from the command line
node scripts/ask-cli.js "How many sick leaves?" --dept HR

# Run evaluation test suite (23 questions)
npm run eval

# Load test
npm run loadtest
```

---

## Project File Structure

```
IEA/
├── .env                          # All secrets (never share this)
├── .env.example                  # Template showing what keys are needed
├── package.json                  # Node.js dependencies
├── docker-compose.yml            # Optional: for ChromaDB + Redis via Docker
│
├── docs/                         # Company policy documents (knowledge base)
│   ├── hr/
│   │   ├── leave-policy.txt      # 12 sick leaves/year, NO carry-forward
│   │   ├── reimbursement-policy.txt  # 30-day claim deadline
│   │   └── code-of-conduct.txt
│   └── it/
│       ├── password-reset-sop.txt
│       ├── vpn-access-sop.txt
│       └── hardware-request-sop.txt
│
├── src/
│   ├── config.js                 # Loads + validates .env on startup
│   ├── server.js                 # Express + WebSocket server bootstrap
│   ├── pipeline.js               # Main orchestrator (filter→cache→retrieve→generate→validate→log)
│   │
│   ├── routes/
│   │   ├── ask.js                # POST /ask, GET /health
│   │   └── whatsapp.js           # POST /whatsapp (Twilio webhook)
│   │
│   ├── services/
│   │   ├── llm.js               # Gemini API wrapper (generate + embed)
│   │   ├── vectorStore.js       # Vector DB (ChromaDB or in-memory fallback)
│   │   ├── retriever.js         # Embeds query, searches for matching chunks
│   │   ├── generator.js         # Builds RAG prompt, generates answer
│   │   ├── validator.js         # 2nd LLM call: checks every claim has evidence
│   │   ├── cache.js             # Redis exact + semantic cache
│   │   ├── session.js           # WhatsApp phone → department mapping
│   │   ├── filter.js            # Profanity + prompt injection blocker
│   │   └── logger.js            # SQLite request logger
│   │
│   └── ws/
│       └── chat.js              # WebSocket handler (web chat real-time)
│
├── scripts/
│   ├── ingest.js                # Load docs → chunk → embed → store in vector DB
│   ├── ask-cli.js               # Terminal tool: ask questions from command line
│   ├── eval.js                  # Run 23 test questions, compare with/without validator
│   └── loadtest.js              # Autocannon stress test
│
├── public/
│   └── index.html               # Web chat UI (dark theme, served by Express)
│
├── tests/
│   └── questions.json           # 23 eval questions (answerable, trap, cross-dept)
│
├── logs/
│   └── iea.sqlite               # SQLite database: every question ever asked
│
└── chroma_data/
    └── vectors.json             # Persisted document embeddings (auto-created)
```

---

## Known Limitations

| Limitation | Detail |
|---|---|
| **Free-tier API quota** | Google Gemini free tier limits: ~5-20 requests/minute per model. If you hit it, requests wait or fail. Use different model names across GEN/VALIDATOR to spread load. |
| **No persistent Redis** | Cache is in-memory only. Resets every time server restarts. To fix: install Redis or run Docker. |
| **No persistent ChromaDB** | Vectors are saved to `chroma_data/vectors.json` and loaded on start. To use real ChromaDB: run `chroma run --path ./chroma_data --port 8000` before `npm start`. |
| **ngrok URL changes** | Free ngrok gives a new URL every restart. Must update `.env` and Twilio each time. |
| **Local deployment only** | App runs on your laptop. Not deployed to a cloud server. To make permanent: deploy to Render, Railway, or a VPS. |
| **Twilio signature validation** | Currently relaxed (no strict VALIDATE_TWILIO_SIG check) to allow local testing. Enable for production. |

---

## Quick Reference: Verified API Status

| Service | Status | Model / Endpoint |
|---|---|---|
| Gemini Generate | ✅ Working | `gemini-3.5-flash-lite` |
| Gemini Validator | ✅ Working | `gemini-3.1-flash-lite` |
| Gemini Embeddings | ✅ Working | `gemini-embedding-001` (3072 dims) |
| Twilio SID/Token | ✅ Configured | Set via `TWILIO_ACCOUNT_SID` env var |
| ngrok | ✅ Authenticated | Token saved |
| Vector Store | ✅ Working | In-memory + file persistence |
| Cache | ✅ Working | In-memory (Redis mock) |
| SQLite Logger | ✅ Working | `logs/iea.sqlite` |
| Web Chat UI | ✅ Working | `http://localhost:3000` |
| POST /ask | ✅ Working | Validated PASS on HR & IT questions |
| POST /whatsapp | ✅ Working | Responds 200, sends reply async |
| WebSocket | ✅ Working | `ws://localhost:3000/ws` |

---

*Built with Node.js 24, Google Gemini API, ChromaDB (in-memory fallback), Redis (in-memory fallback), Twilio, ngrok.*
