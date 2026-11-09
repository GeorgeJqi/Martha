# Martha

Martha is a local-first voice assistant that runs on your own machine. It can listen for its name, answer questions aloud, search the web for current information, and keep the pages it reads alongside the conversation.

Martha runs as a small Python server with a browser-based interface. The desktop version requires no account, hosted backend, or build step.

## Features

- **Voice and chat:** Ask questions by typing or speaking. Martha can listen for its wake word and read answers aloud.
- **Web research:** Questions that need current information are searched automatically. Sources appear beside the conversation.
- **Multiple AI engines:** Choose the built-in local answer path, Google Gemini, Ollama, or an in-browser model.
- **Local-first setup:** Run the server on your own machine. No account or hosted backend is required.
- **Mobile support:** Use Martha from a phone on the same Wi-Fi network or install it as a PWA.
- **Optional local speech:** Use Piper for local neural text-to-speech.

## Interface and voice

The interface is an open, three-column workbench: conversation on the left, the voice stage in the middle, and web sources on the right. Its blue-black background, warm text, and amber accent keep the presentation calm and readable. The Earthrise background image is optional and is not included in the repository.

Voice selection prioritizes natural, neural, premium, or enhanced voices over robotic-sounding options. Martha prefers enhanced voices on macOS and natural Microsoft voices on Windows where available. On Linux, the system fallback uses Speech Dispatcher. Piper can be used as an optional local neural voice engine.

Spoken answers receive small punctuation and abbreviation adjustments to sound more natural. The default speaking pace is slightly slower, and the pitch is not artificially raised.

## Quick start

You need Python 3.10 or newer and a modern browser.

```bash
python3 martha.py

