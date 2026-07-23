# Martha

Martha is an open-source, 100% local voice AI assistant alternative to Amazon Alexa and Google Assistant.

## Features

- 🗣️ **Local Offline Text-To-Speech (TTS)**: Uses system voice engines (macOS `say`, Windows `SAPI5`, Linux `espeak` / Web Speech API) — zero cloud API keys required.
- 🤖 **In-Browser Local AI**: Runs local LLMs via Transformers.js (Qwen/Llama) or connects to local Ollama instance.
- 🔍 **Web Research**: Conducts real-time web searches and synthesizes clean responses with citations.
- 🎙️ **Wake Word & Voice Commands**: Continuous listening for "Martha" with interactive visual orb UI and local Web Audio synthesized sound chimes.

## Quickstart

Run the backend server:

```bash
python martha.py
```

Then open your browser at `http://localhost:8000`.
