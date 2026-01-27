# DraftApply

Generate authentic, human-like answers to job application questions using your CV/resume as context.

## Overview

DraftApply helps job seekers quickly generate relevant, personalized answers to common application questions. It uses your CV as the primary context while allowing natural professional inference to create responses that sound genuinely human rather than AI-generated.

**No API key required!** DraftApply supports multiple free LLM providers.

## Supported LLM Providers

### Local (Free, Private, No API Key)

| Provider | Setup | Notes |
|----------|-------|-------|
| **Ollama** (default) | `brew install ollama` | Easiest local setup |
| **LM Studio** | [Download app](https://lmstudio.ai) | Nice GUI, many models |
| **LocalAI** | Docker container | OpenAI-compatible |

### Cloud (Free Tiers Available)

| Provider | Free Tier | Speed | Get Key |
|----------|-----------|-------|---------|
| **Groq** ⭐ | Very generous | Extremely fast | [console.groq.com](https://console.groq.com) |
| **Google Gemini** | 15 req/min | Good | [aistudio.google.com](https://aistudio.google.com/apikey) |
| **Mistral** | Limited | Good | [console.mistral.ai](https://console.mistral.ai) |
| **Together AI** | $5 credit | Good | [together.ai](https://together.ai) |
| **OpenAI** | Paid only | Good | [platform.openai.com](https://platform.openai.com) |

⭐ **Recommended cloud option**: Groq is fast, free, and easy to set up.

## Quick Start

### Option 1: Ollama (Local, Free, Private)

```bash
# 1. Install Ollama
brew install ollama

# 2. Pull a model
ollama pull llama3.2

# 3. Start Ollama
ollama serve

# 4. Run DraftApply
cd ~/project/DraftApply/backend
npm install
npm run dev
```

### Option 2: Groq (Cloud, Free, No Install)

```bash
# 1. Get free API key from https://console.groq.com

# 2. Configure DraftApply
cd ~/project/DraftApply/backend
cp .env.example .env

# 3. Edit .env:
#    LLM_PROVIDER=groq
#    GROQ_API_KEY=gsk_your_key_here

# 4. Run
npm install
npm run dev
```

### Open the App

Open `frontend/index.html` in your browser, or:

```bash
npx serve frontend -p 3000
```

Visit http://localhost:3000

## Usage

1. **Load your CV**: Upload a PDF/DOCX or paste the text
2. **Enter a question**: Copy a job application question
3. **Select length**: Choose short, medium, or long
4. **Generate**: Click to generate an answer
5. **Copy**: Use the answer in your application

## Configuration

Edit `backend/.env` to configure your provider:

```bash
# Use Ollama (default - local, free)
LLM_PROVIDER=ollama
OLLAMA_MODEL=llama3.2

# Or use Groq (cloud, free tier)
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_your_key_here
GROQ_MODEL=llama-3.3-70b-versatile

# Or use Gemini (cloud, free tier)
LLM_PROVIDER=gemini
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-1.5-flash
```

### All Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `ollama` | Provider to use (see list above) |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama3.2` | Ollama model |
| `GROQ_API_KEY` | - | Groq API key |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq model |
| `GEMINI_API_KEY` | - | Google Gemini API key |
| `GEMINI_MODEL` | `gemini-1.5-flash` | Gemini model |
| `MISTRAL_API_KEY` | - | Mistral API key |
| `TOGETHER_API_KEY` | - | Together AI API key |
| `OPENAI_API_KEY` | - | OpenAI API key |
| `PORT` | `3001` | Backend server port |

## Project Structure

```
DraftApply/
├── shared/                 # Reusable modules (web + extension)
│   ├── cv-parser.js       # CV text extraction and structuring
│   ├── prompt-builder.js  # LLM prompt construction
│   └── answer-generator.js # Main orchestration logic
├── backend/               # Express API server
│   ├── server.js         # API endpoints
│   ├── llm-providers.js  # Multi-provider LLM support
│   ├── package.json
│   └── .env.example
├── frontend/              # Web application
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── extension-ready/       # Chrome extension scaffold
    ├── manifest.json
    ├── background.js
    ├── content.js
    └── popup.html
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check with provider info |
| `/api/providers` | GET | List all available providers |
| `/api/llm-status` | GET | Check current LLM availability |
| `/api/cv/upload` | POST | Upload CV file (PDF, DOCX, TXT) |
| `/api/cv/text` | POST | Submit CV as plain text |
| `/api/generate` | POST | Generate answer |

## Chrome Extension

The `extension-ready/` directory contains a Chrome extension scaffold.

### To use:

1. Keep the backend running (`npm run dev`)
2. Go to `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked" and select the `extension-ready` folder
5. Click the extension icon to load your CV
6. On job application pages, highlight a question and right-click → "DraftApply"

## Features

- **Multiple free LLM providers** - Choose local or cloud
- **No API key required** for local providers
- **CV Ingestion**: Upload PDF, DOCX, or paste text
- **Smart Parsing**: Extracts roles, skills, achievements
- **Question-Type Detection**: Adapts tone automatically
- **Human-Like Output**: Anti-AI-speak prompting
- **Adjustable Length**: Short, medium, or long
- **Extension-Ready**: Works as Chrome extension

## Troubleshooting

**Ollama: "Not responding"**
```bash
ollama serve
```

**Ollama: "Model not found"**
```bash
ollama pull llama3.2
```

**Groq/Gemini: "API key required"**
- Get a free key from the provider's website
- Add it to `backend/.env`

**Backend: "Cannot connect"**
```bash
cd backend && npm run dev
```

## Why These Providers?

| Provider | Best For |
|----------|----------|
| **Ollama** | Privacy, offline use, no limits |
| **Groq** | Speed, generous free tier |
| **Gemini** | Free tier, good quality |
| **LM Studio** | GUI lovers, model flexibility |

## License

MIT
