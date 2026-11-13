# Martha

Martha is a local-first voice assistant that runs on your own machine. She listens for her name, answers aloud from her configured model, and **searches the web only when you ask**—for example “search for…”, “look up…”, or “browse…”. Sources appear beside the conversation when she does.

Her voice is **Martha’s own**: the calm precision of a great onboard system—anticipatory, capable, dry wit in small doses, warm but professional. She is inspired by that *class* of assistant, not a copy of any character’s lines.

Martha runs as a small Python server with a browser-based interface. The desktop version requires no account, hosted backend, or build step.

**Privacy:** API keys and chat settings stay in your browser’s storage on your machine. The Python server does not write them to disk. Optional remote API calls send your key only from your browser to your chosen provider (via the local proxy when you use that mode). Do not commit `.env` files, keys, or personal recordings—see `.gitignore`.

## Features

- **Voice and chat:** Ask questions by typing or speaking. Martha can listen for its wake word and read answers aloud.
- **Web research on request:** Say “search”, “look up”, or “browse” to fetch pages; she does not search just because you asked a question.
- **Multiple AI engines:** **In-browser** model is the default (runs in the tab). Optional **Ollama** or **remote API** (OpenAI-compatible).
- **Local-first setup:** Run the server on your own machine. No account or hosted backend is required.
- **Mobile support:** Use Martha from a phone on the same Wi-Fi network or install it as a PWA.
- **Optional local speech:** Use Piper for local neural text-to-speech.

## Personality

Martha speaks like the intelligence you’d want at the console: composed, exact, quietly witty, proactive when a next step is obvious. She notices what you meant before she answers the literal words. She stays **Martha**—no “sir”, no Stark references, no catchphrases from fiction.

The default **in-browser** engine loads a small chat model into the browser on first use. Switch to **Ollama** or a **remote API** in settings for heavier models.

## Interface and voice

The interface is an open, three-column workbench: conversation on the left, the voice stage in the middle, and web sources on the right. Its blue-black background, warm text, and amber accent keep the presentation calm and readable. The Earthrise background image is optional and is not included in the repository.

Voice selection prioritizes natural, neural, premium, or enhanced voices over robotic-sounding options. Martha prefers enhanced voices on macOS and natural Microsoft voices on Windows where available. On Linux, the system fallback uses Speech Dispatcher. Piper can be used as an optional local neural voice engine.

Spoken answers receive small punctuation and abbreviation adjustments to sound more natural. The default speaking pace is slightly slower, and the pitch is not artificially raised.

## Quick start

You need Python 3.10 or newer and a modern browser.

```bash
python3 martha.py
```

Open the URL in your browser; the first question triggers a one-time model download. For **Ollama** (`ollama pull llama3.2`) or a **remote API**, change **AI engine** in settings.

