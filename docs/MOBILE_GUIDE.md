# Martha — Android & iOS Mobile Guide

Martha can run on your smartphone or tablet (**Android** & **iOS**) with full offline/local voice support, responsive cybernetic UI, tactile haptics, and automated web research.

---

## 3 Ways to Use Martha on Mobile

### Method 1: Instant Progressive Web App (PWA) — Recommended
No app store downloads or developer tools needed! Install directly from your mobile browser:

#### On Android (Chrome / Edge / Firefox / Samsung Internet)
1. Open the Martha URL (e.g. `http://<YOUR_PC_IP>:8000` or your hosted URL) in **Chrome** or **Firefox**.
2. Tap the **"Install App"** prompt banner at the bottom, or tap the menu in the top-right and select **"Install app"** (or *"Add to Home screen"*).
3. Martha will be installed as a standalone app with a full-screen UI, custom icon, and offline caching.

#### On iPhone & iPad (Safari)
1. Open the Martha URL in **Safari**.
2. Tap the **Share** button in the bottom toolbar.
3. Scroll down and tap **"Add to Home Screen"**.
4. Tap **"Add"** in the top right.
5. Martha now launches in full-screen standalone mode with no browser address bar or controls!

---

## Method 2: Wi-Fi Pairing with Local PC / Server (Zero-Cloud LAN Mode)

Run Martha's backend on your PC, Mac, or home server and interact with it from any phone in the same house over Wi-Fi:

1. On your computer, run:
   ```bash
   python martha.py
   ```
2. Look at the terminal output. It will display your computer's local Wi-Fi IP address:
   ```text
   ================================================================
     MARTHA VOICE AI ASSISTANT — MULTI-PLATFORM SERVER
   ================================================================
     Desktop Access : http://localhost:8000
     Mobile (Wi-Fi) : http://192.168.1.150:8000
   ================================================================
   ```
3. On your Android or iPhone, connect to the same Wi-Fi network and open `http://192.168.1.150:8000` (or tap **"Mobile Connect"** in the desktop web UI to scan the instant QR code with your camera).
4. Both devices will stay in sync!

---

## Method 3: Native Android APK & iOS Xcode Build (Capacitor)

If you wish to compile a native Android `.apk`/`.aab` package or iOS `.ipa` Xcode project:

### Prerequisites
- Node.js installed (`node >= 18`)
- **Android**: Android Studio & Android SDK
- **iOS**: macOS & Xcode

### Build Steps
```bash
# 1. Install Capacitor dependencies
npm install

# 2. Add native platforms
npx cap add android
npx cap add ios

# 3. Sync web assets into native wrapper
npx cap sync

# 4. Open in native IDE
npx cap open android    # Opens Android Studio (Build APK / Run on Device)
npx cap open ios        # Opens Xcode (Build to iPhone / iPad)
```

### Native Permissions Configured
- **Android (`AndroidManifest.xml`)**:
  - `RECORD_AUDIO` — Voice wake-word and microphone input.
  - `INTERNET` & `ACCESS_NETWORK_STATE` — Web research and LAN sync.
  - `MODIFY_AUDIO_SETTINGS` — Local speech synthesis.
- **iOS (`Info.plist`)**:
  - `NSMicrophoneUsageDescription`: *"Martha needs microphone access for voice assistant commands."*
  - `NSSpeechRecognitionUsageDescription`: *"Martha uses speech recognition to understand your voice commands."*

---

## Mobile Tips & Features

- **Tap-to-Talk Orb**: Tap the central glowing orb or the microphone button anytime to start voice input.
- **Mobile Tabs**: Easily switch between **Voice Orb**, **Session Chat**, **Web Research**, and **Settings** using the bottom navigation bar.
- **Haptic Feedback**: Enjoy tactile vibration pulses on Android and iOS when activating the mic or completing research.
- **Safe Area Insets**: Native notch and home indicator support for all modern iPhone and Android edge-to-edge displays.
