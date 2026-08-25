# Martha — Voice AI Assistant

Martha is an open-source, local voice AI assistant and automated web research agent for **Desktop (Windows, macOS, Linux)**, **Android**, and **iOS**.

---

## 🌟 Features

- **📱 Android & iOS Mobile Support**: Fully optimized mobile UI with bottom tab navigation, PWA standalone installation (*Add to Home Screen*), touch-to-talk glowing orb, tactile haptics, and Capacitor native builds.
- **📡 Home Wi-Fi Pairing & QR Code**: Run the backend on your PC/Mac and instantly connect mobile devices over Wi-Fi with camera QR code pairing.
- **🗣️ Local Offline Text-To-Speech (TTS)**: Uses system voice engines (macOS `say`, Windows `SAPI5`, Linux `spd-say`/`espeak`, and Web Speech API on mobile) — zero cloud API keys required.
- **🧠 In-Browser & Local AI**: Supports instant local intelligent persona, in-browser ONNX LLM via Transformers.js, local Ollama server, or cloud Gemini API.
- **🔍 Automated Web Research**: Conducts real-time DuckDuckGo searches and synthesizes clean responses with citations.
- **⚡️ Continuous Wake Word**: Continuous listening for *"Martha"* with cybernetic visual orb UI, real-time waveform visualizer, and local synthesized sound chimes.

---

## 🚀 Quickstart

Run the backend server:

```bash
python martha.py
```

Then open your browser at:
- **Desktop**: `http://localhost:8000`
- **Mobile (Wi-Fi)**: `http://<YOUR_LAN_IP>:8000` (printed in terminal)

For mobile installation instructions, see [docs/MOBILE_GUIDE.md](docs/MOBILE_GUIDE.md).

---

## 📱 Mobile App Setup

### Android (Chrome / Edge)
Open the mobile URL -> Tap the **"Install App"** banner or menu (⋮) -> **"Install App"**.

### iPhone & iPad (Safari)
Open the mobile URL in Safari -> Tap **Share** <i class="fa-solid fa-arrow-up-from-bracket"></i> -> **"Add to Home Screen"**.

### Native App Packaging (Capacitor)
```bash
npm install
npx cap add android   # or npx cap add ios
npx cap sync
npx cap open android  # or npx cap open ios
```
