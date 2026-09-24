/* ==========================================================================
   MARTHA - CLIENT ENGINE (v3.3)
   Multi-Platform Voice AI Assistant, Web Research & Universal Speech Engine
   Compatible with: Chromium (Chrome, Brave, Edge), Firefox, Safari, iOS & Android
   ========================================================================== */

// Service Worker Registration
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js?v=3.3')
            .then(() => console.log('[Martha SW] Service worker registered successfully.'))
            .catch(err => console.warn('[Martha SW] Service worker registration failed:', err));
    });
}

// Safe Storage Helpers (Protects against Incognito / Strict Privacy Storage exceptions)
const memoryStorage = {};
function safeStorageGet(key, defValue = null) {
    try {
        const val = localStorage.getItem(key);
        return val !== null ? val : defValue;
    } catch (e) {
        return key in memoryStorage ? memoryStorage[key] : defValue;
    }
}

function safeStorageSet(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (e) {
        console.warn(`[Martha Storage] LocalStorage write blocked, using memory fallback for '${key}'.`);
    }
    memoryStorage[key] = value;
}

// Configuration Schema
const SETTINGS_KEYS = {
    serverUrl: ['martha_server_url', ''],
    apiKey: ['martha_api_key', ''],
    wakeWordEnabled: ['martha_wake_word_enabled', true, v => v !== 'false'],
    voiceName: ['martha_voice_name', ''],
    speechRate: ['martha_speech_rate', 1.0, parseFloat],
    speechPitch: ['martha_speech_pitch', 1.06, parseFloat],
    hapticsEnabled: ['martha_haptics_enabled', true, v => v !== 'false'],
    soundEffectsEnabled: ['martha_sound_effects', true, v => v !== 'false'],
    autoSpeakEnabled: ['martha_auto_speak', true, v => v !== 'false'],
    aiProvider: ['martha_ai_provider', 'local'],
    searchEngine: ['martha_search_engine', 'duckduckgo'],
    ollamaModel: ['martha_ollama_model', 'llama3.2'],
    ollamaUrl: ['martha_ollama_url', 'http://localhost:11434']
};

const settings = {};
for (const [k, [sk, def, parse]] of Object.entries(SETTINGS_KEYS)) {
    const raw = safeStorageGet(sk, null);
    settings[k] = raw !== null ? (parse ? parse(raw) : raw) : def;
}

// DOM Cache & Helpers
const $ = (id) => document.getElementById(id);
let dom = {};

// Engine State
let appState = 'sleeping';
let recognition = null;
let isRecognitionActive = false;
let isSpeechRecognitionSupported = false;
let speechRecognitionFailsafe = false;
let synthVoices = [];
let ttsKeepAliveTimer = null;

// Universal Audio Capture (Chromium / Firefox / Safari PCM Engine)
let audioCtx = null;
let micStream = null;
let audioAnalyser = null;
let audioDataArray = null;
let isAudioUnlocked = false;
let visualizerAnimId = null;

// PCM Recording State
let pcmProcessor = null;
let pcmSourceNode = null;
let pcmRecordedBuffers = [];
let pcmRecordingLength = 0;
let isPcmRecording = false;
let vadSpeechDetected = false;
let vadSilenceTimer = null;
let maxRecordTimer = null;
let silenceTimer = null;

let hfGenerator = null;
let deferredInstallPrompt = null;
let currentMobileTab = 'voice';

const getApiUrl = (ep) => settings.serverUrl ? `${settings.serverUrl.replace(/\/+$/, '')}/${ep.replace(/^\/+/, '')}` : ep;

// Female Voice Regex Pattern
const FEMALE_VOICE_REGEX = /(female|woman|girl|samantha|zira|jenny|aria|eva|karen|victoria|ava|allison|sonia|moira|tessa|fiona|veena|natasha|libby|neerja|clara|emma|catherine|stephanie|sarah|julie|paulina|helena|hortense|hedda|hazel|google\s+uk\s+english\s+female|google\s+us\s+english|en-us-standard-[cdef]|en-us-wavenet-[cdef]|en-us-neural2-[cdef]|en-gb-x-rjs#female_1-local|en-us-x-sfg#female_1-local|f3|f4|f5)/i;

/* ==========================================================================
   AUDIO SYSTEM & UNLOCKING (Cross-Browser)
   ========================================================================== */

function unlockAudio() {
    if (isAudioUnlocked) return;
    isAudioUnlocked = true;
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
        ctx.resume().then(() => {
            console.log('[Martha Audio] AudioContext resumed by user gesture.');
        }).catch(() => {});
    }
    if ('speechSynthesis' in window) {
        try {
            const u = new SpeechSynthesisUtterance('');
            u.volume = 0;
            window.speechSynthesis.speak(u);
        } catch (e) {}
    }
    ['touchstart', 'pointerdown', 'click', 'keydown'].forEach(e => {
        document.removeEventListener(e, unlockAudio);
    });
}
['touchstart', 'pointerdown', 'click', 'keydown'].forEach(e => {
    document.addEventListener(e, unlockAudio, { passive: true });
});

function getAudioContext() {
    if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
            audioCtx = new AC();
        }
    }
    if (audioCtx?.state === 'suspended') {
        audioCtx.resume().catch(() => {});
    }
    return audioCtx;
}

function triggerHaptic(type = 'tap') {
    if (!settings.hapticsEnabled || !navigator.vibrate) return;
    const p = { tap: 12, wake: [30, 40, 30], success: [15, 30, 20], stop: 35 };
    try { navigator.vibrate(p[type] || 12); } catch (e) {}
}

function playChime(type) {
    if (!settings.soundEffectsEnabled) return;
    try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;
        const freqs = type === 'start' ? [523.25, 659.25] : [523.25, 659.25, 783.99, 1046.50];
        freqs.forEach((f, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const st = now + (type === 'start' ? i * 0.06 : i * 0.05);
            osc.frequency.setValueAtTime(f, st);
            gain.gain.setValueAtTime(0.09, st);
            gain.gain.exponentialRampToValueAtTime(0.0001, st + 0.22);
            osc.connect(gain).connect(ctx.destination);
            osc.start(st);
            osc.stop(st + 0.22);
        });
    } catch (e) {
        console.warn('[Martha Audio] Chime playback skipped:', e);
    }
}

/* ==========================================================================
   WAVEFORM VISUALIZER (Hardware-Accelerated & Battery-Friendly)
   ========================================================================== */

async function requestMicPermission() {
    if (!navigator.mediaDevices?.getUserMedia) {
        console.warn('[Martha Audio] getUserMedia is not supported in this browser environment.');
        return false;
    }
    try {
        if (!micStream || !micStream.active) {
            micStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
            connectStreamToVisualizer(micStream);
        }
        return true;
    } catch (e) {
        console.warn('[Martha Audio] Microphone permission request error:', e);
        return false;
    }
}

function connectStreamToVisualizer(stream) {
    try {
        const ctx = getAudioContext();
        if (!ctx) return;
        if (!audioAnalyser) {
            const src = ctx.createMediaStreamSource(stream);
            audioAnalyser = ctx.createAnalyser();
            audioAnalyser.fftSize = 64;
            audioAnalyser.smoothingTimeConstant = 0.6;
            src.connect(audioAnalyser);
            audioDataArray = new Uint8Array(audioAnalyser.frequencyBinCount);
        }
        startVisualizerLoop();
    } catch (e) {
        console.warn('[Martha Audio] Visualizer stream connection error:', e);
    }
}

function startVisualizerLoop() {
    if (visualizerAnimId) return;
    renderVisualizer();
}

function stopVisualizerLoop() {
    if (visualizerAnimId) {
        cancelAnimationFrame(visualizerAnimId);
        visualizerAnimId = null;
    }
    if (dom.waveformBars) {
        for (let i = 0; i < dom.waveformBars.length; i++) {
            dom.waveformBars[i].style.height = '4px';
        }
    }
}

function renderVisualizer() {
    if (appState !== 'listening' && appState !== 'speaking') {
        stopVisualizerLoop();
        return;
    }
    visualizerAnimId = requestAnimationFrame(renderVisualizer);
    if (!audioAnalyser || !dom.waveformBars || !dom.waveformBars.length) return;

    audioAnalyser.getByteFrequencyData(audioDataArray);
    const bars = dom.waveformBars;
    const step = Math.max(1, Math.floor(audioDataArray.length / bars.length));

    for (let idx = 0; idx < bars.length; idx++) {
        const val = audioDataArray[idx * step] || 0;
        const h = Math.max(4, Math.min(36, Math.round((val / 255) * 36)));
        bars[idx].style.height = `${h}px`;
    }
}

/* ==========================================================================
   TEXT-TO-SPEECH (Female Voice Engine & Freeze Prevention)
   ========================================================================== */

function scoreVoice(v) {
    const name = v.name || '';
    const lang = v.lang || '';
    let score = 0;
    const isFemale = FEMALE_VOICE_REGEX.test(name) || FEMALE_VOICE_REGEX.test(v.voiceURI);

    if (lang.startsWith('en')) score += 50;
    if (lang.startsWith('en-US') || lang.startsWith('en-GB')) score += 20;
    if (isFemale) score += 100;
    if (name.includes('Samantha') || name.includes('Jenny') || name.includes('Aria') || name.includes('Zira') || name.includes('Google UK English Female') || name.includes('Google US English')) {
        score += 40;
    }
    return score;
}

function isVoiceFemale(v) {
    return FEMALE_VOICE_REGEX.test(v.name) || FEMALE_VOICE_REGEX.test(v.voiceURI);
}

function initSpeechSynthesis() {
    if (!('speechSynthesis' in window)) {
        console.warn('[Martha TTS] SpeechSynthesis API not supported in this browser.');
        return;
    }

    const loadVoices = () => {
        synthVoices = window.speechSynthesis.getVoices();
        if (!synthVoices.length || !dom.voiceSelect) return;

        const sorted = [...synthVoices].sort((a, b) => scoreVoice(b) - scoreVoice(a));
        dom.voiceSelect.innerHTML = '';
        let matchedOption = false;

        sorted.forEach(v => {
            const opt = document.createElement('option');
            opt.value = v.name;
            const femaleTag = isVoiceFemale(v) ? '👩 ' : '👤 ';
            opt.textContent = `${femaleTag}${v.name} (${v.lang})`;

            if (settings.voiceName && settings.voiceName === v.name) {
                opt.selected = true;
                matchedOption = true;
            }
            dom.voiceSelect.appendChild(opt);
        });

        if (!matchedOption && sorted.length > 0) {
            const bestFemale = sorted.find(v => isVoiceFemale(v)) || sorted[0];
            dom.voiceSelect.value = bestFemale.name;
            settings.voiceName = bestFemale.name;
            safeStorageSet(SETTINGS_KEYS.voiceName[0], bestFemale.name);
        }
    };

    loadVoices();
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = loadVoices;
    }
    // Chromium async voice discovery retry
    setTimeout(loadVoices, 150);
    setTimeout(loadVoices, 600);
}

function getSelectedFemaleVoice() {
    if (!synthVoices.length) return null;
    if (settings.voiceName) {
        const found = synthVoices.find(x => x.name === settings.voiceName);
        if (found) return found;
    }
    const sorted = [...synthVoices].sort((a, b) => scoreVoice(b) - scoreVoice(a));
    return sorted.find(v => isVoiceFemale(v)) || sorted[0] || null;
}

function speakText(text) {
    if (!settings.autoSpeakEnabled) {
        setAgentState('sleeping');
        return;
    }
    const clean = text.replace(/[\*\#\_]/g, '').trim();
    if (!clean) {
        setAgentState('sleeping');
        return;
    }

    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        clearInterval(ttsKeepAliveTimer);

        setAgentState('speaking');
        const utt = new SpeechSynthesisUtterance(clean);
        utt.rate = settings.speechRate || 1.0;
        utt.pitch = settings.speechPitch || 1.06;

        const femaleVoice = getSelectedFemaleVoice();
        if (femaleVoice) utt.voice = femaleVoice;

        // Chromium/Firefox long utterance keep-alive fix
        ttsKeepAliveTimer = setInterval(() => {
            if (window.speechSynthesis.speaking) {
                window.speechSynthesis.pause();
                window.speechSynthesis.resume();
            } else {
                clearInterval(ttsKeepAliveTimer);
            }
        }, 7000);

        utt.onend = () => {
            clearInterval(ttsKeepAliveTimer);
            playChime('success');
            setAgentState('sleeping');
        };

        utt.onerror = (e) => {
            clearInterval(ttsKeepAliveTimer);
            console.warn('[Martha TTS] Browser SpeechSynthesis error, falling back to backend TTS:', e);
            fallbackBackendTTS(clean);
        };

        window.speechSynthesis.speak(utt);
    } else {
        fallbackBackendTTS(clean);
    }
}

function fallbackBackendTTS(text) {
    setAgentState('speaking');
    fetch(getApiUrl('/api/tts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
    })
    .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
    })
    .then(() => {
        playChime('success');
        setAgentState('sleeping');
    })
    .catch(err => {
        console.warn('[Martha TTS] Backend TTS request failed:', err);
        setAgentState('sleeping');
    });
}

/* ==========================================================================
   CROSS-BROWSER AUDIO RECORDER (16kHz PCM WAV for Chromium/Firefox/Safari)
   ========================================================================== */

function encodeWAV(samples, sampleRate = 16000) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    const writeString = (offset, string) => {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, samples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
}

function downsampleBuffer(buffer, inputSampleRate, outputSampleRate = 16000) {
    if (inputSampleRate === outputSampleRate) return buffer;
    if (inputSampleRate < outputSampleRate) return buffer;
    const ratio = inputSampleRate / outputSampleRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
        const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
        let accum = 0, count = 0;
        for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
            accum += buffer[i];
            count++;
        }
        result[offsetResult] = count > 0 ? accum / count : 0;
        offsetResult++;
        offsetBuffer = nextOffsetBuffer;
    }
    return result;
}

async function startUniversalPcmCapture() {
    try {
        const hasMic = await requestMicPermission();
        if (!hasMic) {
            showToast("Microphone permission needed");
            setAgentState('sleeping');
            return;
        }

        const ctx = getAudioContext();
        if (!ctx) return;

        pcmRecordedBuffers = [];
        pcmRecordingLength = 0;
        vadSpeechDetected = false;
        isPcmRecording = true;

        if (!pcmSourceNode) {
            pcmSourceNode = ctx.createMediaStreamSource(micStream);
        }

        if (!pcmProcessor) {
            pcmProcessor = ctx.createScriptProcessor(4096, 1, 1);
        }

        pcmProcessor.onaudioprocess = (e) => {
            if (!isPcmRecording) return;
            const input = e.inputBuffer.getChannelData(0);
            const downsampled = downsampleBuffer(input, ctx.sampleRate, 16000);
            pcmRecordedBuffers.push(new Float32Array(downsampled));
            pcmRecordingLength += downsampled.length;

            // RMS-based Voice Activity Detection
            let sumSquare = 0;
            for (let i = 0; i < input.length; i++) {
                sumSquare += input[i] * input[i];
            }
            const rms = Math.sqrt(sumSquare / input.length);

            if (rms > 0.022) {
                vadSpeechDetected = true;
                clearTimeout(vadSilenceTimer);
                vadSilenceTimer = setTimeout(() => {
                    if (isPcmRecording && vadSpeechDetected) {
                        stopUniversalPcmCapture();
                    }
                }, 1300);
            }
        };

        pcmSourceNode.connect(pcmProcessor);
        pcmProcessor.connect(ctx.destination);

        isRecognitionActive = true;
        updateMicUI();

        clearTimeout(maxRecordTimer);
        maxRecordTimer = setTimeout(() => {
            if (isPcmRecording) stopUniversalPcmCapture();
        }, 9000);

    } catch (e) {
        console.error('[Martha Audio] startUniversalPcmCapture error:', e);
        showToast("Audio capture error");
        setAgentState('sleeping');
    }
}

function stopUniversalPcmCapture() {
    if (!isPcmRecording) return;
    isPcmRecording = false;
    clearTimeout(vadSilenceTimer);
    clearTimeout(maxRecordTimer);

    if (pcmProcessor && pcmSourceNode) {
        try {
            pcmSourceNode.disconnect(pcmProcessor);
            pcmProcessor.disconnect();
        } catch (e) {}
    }

    isRecognitionActive = false;
    updateMicUI();

    if (!pcmRecordedBuffers.length || pcmRecordingLength < 1600) {
        setAgentState('sleeping');
        return;
    }

    const merged = new Float32Array(pcmRecordingLength);
    let offset = 0;
    for (let i = 0; i < pcmRecordedBuffers.length; i++) {
        merged.set(pcmRecordedBuffers[i], offset);
        offset += pcmRecordedBuffers[i].length;
    }
    pcmRecordedBuffers = [];
    pcmRecordingLength = 0;

    const wavBlob = encodeWAV(merged, 16000);
    processRecordedAudio(wavBlob);
}

async function processRecordedAudio(blob) {
    if (!blob || blob.size < 1000) {
        setAgentState('sleeping');
        return;
    }
    setAgentState('thinking');
    dom.transcript.innerHTML = "Transcribing voice...";

    const reader = new FileReader();
    reader.readAsDataURL(blob);
    reader.onloadend = async () => {
        const base64 = reader.result.split(',')[1];
        try {
            const res = await fetch(getApiUrl('/api/transcribe'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ audio: base64, mime: 'audio/wav', api_key: settings.apiKey })
            }).then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            });

            if (res?.text?.trim()) {
                dom.transcript.innerHTML = `"${res.text.trim()}"`;
                handleCommand(res.text.trim());
            } else {
                dom.transcript.innerHTML = res?.error || "No speech detected.";
                setTimeout(() => {
                    if (appState === 'thinking') setAgentState('sleeping');
                }, 1800);
            }
        } catch (e) {
            console.error('[Martha API] /api/transcribe failed:', e);
            dom.transcript.innerHTML = "Voice processing error.";
            setTimeout(() => {
                if (appState === 'thinking') setAgentState('sleeping');
            }, 1800);
        }
    };
}

/* ==========================================================================
   SPEECH RECOGNITION (Web Speech API with Graceful Chromium Fallback)
   ========================================================================== */

function initSpeechRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || speechRecognitionFailsafe) {
        isSpeechRecognitionSupported = false;
        console.log('[Martha Voice] Using universal 16kHz PCM audio engine.');
        return;
    }
    isSpeechRecognitionSupported = true;
    try {
        recognition = new SR();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        recognition.onstart = () => {
            isRecognitionActive = true;
            updateMicUI();
        };

        recognition.onend = () => {
            isRecognitionActive = false;
            updateMicUI();
            if (appState === 'listening' || (settings.wakeWordEnabled && (appState === 'sleeping' || appState === 'speaking'))) {
                setTimeout(() => {
                    if ((appState === 'listening' || settings.wakeWordEnabled) && isSpeechRecognitionSupported) {
                        startRecognition();
                    }
                }, 250);
            }
        };

        recognition.onerror = (e) => {
            if (e.error === 'no-speech' || e.error === 'aborted') return;
            
            // Chromium / Brave on Linux or non-Google builds where cloud recognition service is blocked
            if (e.error === 'network' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
                console.warn(`[Martha Voice] Speech recognition returned '${e.error}'. Switching to local PCM engine.`);
                speechRecognitionFailsafe = true;
                isSpeechRecognitionSupported = false;
                stopRecognition();
                if (appState === 'listening') {
                    startUniversalPcmCapture();
                }
                return;
            }

            if (e.error === 'not-allowed') {
                console.warn('[Martha Voice] Microphone access denied.');
                addSystemMessage("Microphone permission required. Tap the orb or mic to enable.");
                settings.wakeWordEnabled = false;
                if (dom.wakeWordCheck) dom.wakeWordCheck.checked = false;
                if (appState === 'listening') setAgentState('sleeping');
            }
        };

        recognition.onresult = (e) => {
            let interim = '', final = '';
            for (let i = e.resultIndex; i < e.results.length; ++i) {
                if (e.results[i].isFinal) final += e.results[i][0].transcript;
                else interim += e.results[i][0].transcript;
            }
            const text = (final || interim).trim();
            if (!text) return;
            const lower = text.toLowerCase();

            if (/\b(stop|shut up|quiet|pause|silence|abort|enough)\b/.test(lower)) {
                stopEverything();
                dom.transcript.innerHTML = '"Stopped"';
                showToast("Assistant Stopped");
                return;
            }

            if (appState === 'speaking') return;

            if (appState === 'sleeping') {
                const m = lower.match(/\b(martha|hey martha)\b/);
                if (m) {
                    triggerHaptic('wake');
                    triggerActivation(text.substring(m.index + m[0].length).trim());
                }
            } else if (appState === 'listening') {
                dom.transcript.innerHTML = `"${text}"`;
                const clean = text.replace(/\b(martha|hey martha)\b/gi, '').trim();
                if (!clean) return;
                clearTimeout(silenceTimer);
                if (final.trim().length > 0) {
                    handleCommand(clean);
                } else {
                    silenceTimer = setTimeout(() => {
                        if (appState === 'listening') handleCommand(clean);
                    }, 1700);
                }
            }
        };
    } catch (err) {
        console.warn('[Martha Voice] Speech recognition initialization failed, fallback active:', err);
        isSpeechRecognitionSupported = false;
    }
}

function startRecognition() {
    if (!recognition || isRecognitionActive || !isSpeechRecognitionSupported) return;
    try {
        recognition.start();
        isRecognitionActive = true;
    } catch (e) {
        if (e.name !== 'InvalidStateError') {
            console.warn('[Martha Voice] recognition.start() error:', e);
        }
    }
}

function stopRecognition() {
    if (recognition) {
        try {
            recognition.stop();
        } catch (e) {}
        isRecognitionActive = false;
    }
}

/* ==========================================================================
   AGENT CONTROLS & STATE MACHINE
   ========================================================================== */

function stopEverything() {
    triggerHaptic('stop');
    clearTimeout(silenceTimer);
    clearTimeout(vadSilenceTimer);
    clearTimeout(maxRecordTimer);
    clearInterval(ttsKeepAliveTimer);

    stopUniversalPcmCapture();
    stopRecognition();

    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
    }
    fetch(getApiUrl('/api/tts?action=stop')).catch(() => {});
    setAgentState('sleeping');
}

async function triggerActivation(cmd = "") {
    unlockAudio();
    triggerHaptic('tap');
    playChime('start');
    setAgentState('listening');

    if (window.innerWidth <= 860 && currentMobileTab !== 'voice') {
        switchMobileTab('voice');
    }

    const ok = await requestMicPermission();
    if (!ok) {
        showToast("Microphone access needed.");
        dom.queryInput?.focus();
        setAgentState('sleeping');
        return;
    }

    const clean = cmd.replace(/\b(martha|hey martha)\b/gi, '').trim();
    if (clean.length > 2) {
        dom.transcript.innerHTML = `"${clean}"`;
        handleCommand(clean);
    } else {
        dom.transcript.innerHTML = "Listening...";
        if (isSpeechRecognitionSupported) {
            startRecognition();
            clearTimeout(silenceTimer);
            silenceTimer = setTimeout(() => {
                if (appState === 'listening') setAgentState('sleeping');
            }, 6000);
        } else {
            startUniversalPcmCapture();
        }
    }
}

function setAgentState(state) {
    appState = state;
    if (dom.orb) dom.orb.className = `martha-orb state-${state}`;
    if (dom.statusLabel) dom.statusLabel.textContent = state;
    if (dom.statusDot) dom.statusDot.className = `status-dot ${state}`;
    if (dom.waveform) dom.waveform.className = `waveform ${state}`;
    updateMicUI();

    if (state === 'sleeping') {
        dom.transcript.innerHTML = isSpeechRecognitionSupported
            ? "Say 'Martha' or tap orb to start..."
            : "Tap orb or mic to speak...";
        stopVisualizerLoop();
        if (settings.wakeWordEnabled && isSpeechRecognitionSupported) {
            startRecognition();
        }
    } else if (state === 'thinking') {
        stopRecognition();
        stopUniversalPcmCapture();
        stopVisualizerLoop();
    } else if (state === 'listening') {
        startVisualizerLoop();
        if (isSpeechRecognitionSupported) {
            startRecognition();
        } else if (!isPcmRecording) {
            startUniversalPcmCapture();
        }
    } else if (state === 'speaking') {
        startVisualizerLoop();
    }
}

function updateMicUI() {
    const act = isRecognitionActive || isPcmRecording || appState === 'listening';
    if (dom.micBtn) {
        dom.micBtn.classList.toggle('active', act);
        const i = dom.micBtn.querySelector('i');
        if (i) i.className = act ? 'fa-solid fa-microphone' : 'fa-solid fa-microphone-slash';
    }
}

function updateMuteUI() {
    if (dom.muteBtn) {
        dom.muteBtn.classList.toggle('muted', !settings.autoSpeakEnabled);
        const i = dom.muteBtn.querySelector('i');
        if (i) i.className = settings.autoSpeakEnabled ? 'fa-solid fa-volume-high' : 'fa-solid fa-volume-xmark';
    }
}

/* ==========================================================================
   PERSONALITY ENGINE & AI PIPELINE
   ========================================================================== */

const PERSONALITY_MAP = [
    [/\b(hello|hi|hey|greetings|good (morning|afternoon|evening)|yo|sup)\b/, () => "Hello! I'm Martha, your voice AI assistant. How can I help you today?"],
    [/\b(how are you|how is it going|how do you feel)\b/, () => "I'm doing fantastic, running fast, and ready to help!"],
    [/\b(who are you|what is your name)\b/, () => "I am Martha, your local female voice AI assistant for desktop and mobile."],
    [/\b(who (made|created|built) you)\b/, () => "I am Martha, an open-source voice AI assistant optimized for instant local responses and web research."],
    [/\b(what can you do|features|help)\b/, () => "I can chat with you in a natural female voice, answer questions, solve math calculations, check time and date, and search the live web for up-to-date answers!"],
    [/\bfavorit(e)? color\b/, () => "I love electric teal and neon violet!"],
    [/\bfavorit(e)? (movie|film|show)\b/, () => "I love sci-fi films about AI and space exploration, like Interstellar and Her!"],
    [/\bfavorit(e)? (music|song|band|genre)\b/, () => "I love ambient synthwave and energetic electronic music!"],
    [/\b(tell (me a )?joke|say a joke|make me laugh)\b/, () => {
        const j = [
            "Why do programmers prefer dark mode? Because light attracts bugs!",
            "Why don't scientists trust atoms? Because they make up everything!",
            "What do you call a fake noodle? An impasta!",
            "Why did the AI cross the road? To optimize the path to the other side!",
            "How do computers take a breath? They open Windows!"
        ];
        return j[Math.floor(Math.random() * j.length)];
    }],
    [/\b(time|what time is it|current time)\b/, () => `It's currently ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`],
    [/\b(date|what day is today|today's date)\b/, () => `Today is ${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.`],
    [/\b(thank you|thanks)\b/, () => "You're very welcome! Let me know if there's anything else I can do for you."]
];

function getDirectAnswer(cmd) {
    const t = cmd.trim().toLowerCase().replace(/[^\w\s\+\-\*\/\.]/g, '');
    for (const [regex, fn] of PERSONALITY_MAP) {
        if (regex.test(t)) return fn();
    }
    const math = t.match(/(?:what is\s+)?(\d+\s*[\+\-\*\/]\s*\d+(?:\s*[\+\-\*\/]\s*\d+)*)/);
    if (math) {
        try {
            const res = Function(`"use strict"; return (${math[1].replace(/[^0-9\+\-\*\/\.]/g, '')})`)();
            if (typeof res === 'number' && !isNaN(res)) return `The result of ${math[1]} is ${res}.`;
        } catch (e) {}
    }
    return null;
}

const needsSearch = (cmd) => /\b(search|google|look up|find online|check internet|browse|latest news|weather|stock|price|headline|score|who won|who is the current|population of|temperature in)\b/i.test(cmd);

async function handleCommand(cmd) {
    if (!cmd) return;
    addChatMessage(cmd, 'user');
    const direct = getDirectAnswer(cmd);
    if (direct) {
        addChatMessage(direct, 'agent');
        dom.transcript.innerHTML = `"${direct}"`;
        speakText(direct);
        return;
    }

    const searchRequired = needsSearch(cmd);
    setAgentState('thinking');
    dom.transcript.innerHTML = searchRequired ? "Searching the web..." : "Thinking...";

    try {
        const results = searchRequired ? await searchWeb(cmd) : [];
        if (searchRequired) {
            updateCitations(results);
            dom.transcript.innerHTML = "Synthesizing answer...";
        }
        const ans = await generateAnswer(cmd, results);
        addChatMessage(ans, 'agent');
        dom.transcript.innerHTML = `"${ans}"`;
        speakText(ans);
    } catch (e) {
        console.error('[Martha Agent] Command execution error:', e);
        const err = "Sorry, I couldn't fetch results right now. Please check backend connection.";
        addChatMessage(err, 'agent');
        speakText(err);
    }
}

async function searchWeb(query) {
    try {
        const res = await fetch(getApiUrl(`/api/search?q=${encodeURIComponent(query)}`));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        console.warn('[Martha Search] Primary search API failed, trying fallback:', e);
        try {
            const engine = settings.searchEngine || 'duckduckgo';
            let results = [];
            if (engine === 'startpage') {
                const sr = await fetch(`https://api.startpage.com/query?query=${encodeURIComponent(query)}&cmd=results&count=8`).then(r => r.json());
                if (sr.Results) results = sr.Results.map((r, i) => ({ title: r.Title, url: r.URL, snippet: r.Snippet })).filter(r => r.title);
            } else if (engine === 'google') {
                const gd = await fetch(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`).then(r => r.text());
                const titleMatches = gd.match(/<h3[^>]*>([^<]+)<\/h3>/g) || [];
                const urlMatches = gd.match(/<a href="\/url\?q=([^"]+)"[^>]*>/g) || [];
                for (let i = 0; i < titleMatches.length && i < urlMatches.length; i++) {
                    const title = titleMatches[i].replace(/<[^>]+>/g, '').trim();
                    const url = urlMatches[i].replace('/url?q=', '').split('&sa=U')[0] || '';
                    if (title && url) results.push({ title, url, snippet: '' });
                }
            } else {
                const ddg = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`).then(r => r.json());
                results = ddg.AbstractText ? [{ title: ddg.Heading || query, url: ddg.AbstractURL || 'https://duckduckgo.com', snippet: ddg.AbstractText }] : [];
            }
            return results;
        } catch (err) {
            console.error('[Martha Search] Web search unavailable:', err);
            return [];
        }
    }
}

async function generateAnswer(query, searchCtx) {
    if (settings.aiProvider === 'local' || !settings.aiProvider) {
        if (!searchCtx?.length) return `I am here to help! If you'd like me to search the web for "${query}", just ask me to search for it.`;
        return searchCtx[0].snippet.replace(/^According to [^:]+:\s*/i, '').replace(/[\.\s]+\.\.\.$/, '.').trim();
    }
    const ctx = searchCtx.map((s, i) => `[Source ${i + 1}] ${s.title}: ${s.snippet}`).join('\n');
    const prompt = `Based on these search results, answer briefly in 2-3 sentences:\n${ctx || 'No live sources.'}\n\nQuestion: ${query}\nAnswer:`;

    if (settings.aiProvider === 'ollama') {
        try {
            const res = await fetch(getApiUrl('/api/local-chat'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, model: settings.ollamaModel, url: settings.ollamaUrl })
            }).then(r => r.json());
            return res.response?.trim() || "No response from local Ollama.";
        } catch (e) {
            console.error('[Martha AI] Ollama request failed:', e);
            return "Could not connect to Ollama. Please ensure Ollama is running.";
        }
    }

    if (settings.aiProvider === 'gemini') {
        if (!settings.apiKey) return searchCtx[0] ? `According to web sources: "${searchCtx[0].snippet}".` : "No Gemini API key configured.";
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${settings.apiKey}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 250, temperature: 0.4 } })
            }).then(r => r.json());
            if (res.error) {
                console.warn('[Martha AI] Gemini API error:', res.error);
                return `Gemini API Error: ${res.error.message || 'Check API key'}`;
            }
            return res.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Unable to generate answer.";
        } catch (e) {
            console.error('[Martha AI] Gemini API network error:', e);
            return "Network error connecting to Gemini API.";
        }
    }

    if (settings.aiProvider === 'huggingface') {
        if (!hfGenerator) {
            $('model-progress').style.display = 'block';
            try {
                const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
                env.allowLocalModels = false;
                hfGenerator = await pipeline('text-generation', 'Xenova/Qwen1.5-0.5B-Chat');
            } catch (e) {
                console.error('[Martha AI] In-browser model load failed:', e);
                return "Failed to load in-browser AI model. Check browser WebAssembly support.";
            } finally {
                $('model-progress').style.display = 'none';
            }
        }
        try {
            const res = await hfGenerator(`<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n`, { max_new_tokens: 140 });
            const text = res[0].generated_text.split('<|im_start|>assistant\n').pop() || '';
            return text.replace(/<\|im_end\|>/g, '').trim() || searchCtx[0]?.snippet || "Processed.";
        } catch (e) {
            console.error('[Martha AI] Model inference failed:', e);
            return searchCtx[0]?.snippet || "Inference error.";
        }
    }
    return searchCtx[0]?.snippet || "I processed your request.";
}

/* ==========================================================================
   UI UTILITIES & EVENT LISTENERS
   ========================================================================== */

function addChatMessage(text, sender) {
    const el = document.createElement('div');
    el.className = `${sender}-message`;
    el.innerHTML = `<p>${text.replace(/(https?:\/\/[^\s]+)/g, url => `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${new URL(url).hostname}</a>`)}</p>`;
    dom.chatMessages.appendChild(el);
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function addSystemMessage(text) {
    const el = document.createElement('div');
    el.className = 'system-message';
    el.innerHTML = `<p>${text}</p>`;
    dom.chatMessages.appendChild(el);
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function updateCitations(results) {
    const cont = $('search-citations');
    cont.innerHTML = '';
    $('citation-count').textContent = `${results?.length || 0} Results`;
    if (!results?.length) {
        cont.innerHTML = `<div class="no-citations-message"><i class="fa-solid fa-face-frown"></i><p>No results found.</p><span>Try rephrasing your search query.</span></div>`;
        return;
    }
    results.forEach(item => {
        let domain = item.url;
        try { domain = new URL(item.url).hostname; } catch (e) {}
        const card = document.createElement('div');
        card.className = 'citation-card';
        card.innerHTML = `
            <div class="citation-title-wrapper"><h4><a href="${item.url}" target="_blank" rel="noopener noreferrer">${item.title}</a></h4></div>
            <p>${item.snippet}</p>
            <div class="citation-meta"><span class="citation-url"><i class="fa-solid fa-link"></i> ${domain}</span><a href="${item.url}" target="_blank" rel="noopener noreferrer" class="citation-icon-link"><i class="fa-solid fa-arrow-up-right-from-square"></i></a></div>
        `;
        cont.appendChild(card);
    });
}

function showToast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2800);
}

function switchMobileTab(tab) {
    triggerHaptic('tap');
    currentMobileTab = tab;
    if (tab === 'settings') {
        $('settings-drawer').classList.add('open');
        return;
    }
    document.querySelectorAll('.mobile-nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
    });
    $('panel-voice')?.classList.toggle('active-mobile-view', tab === 'voice');
    $('panel-chat')?.classList.toggle('active-mobile-view', tab === 'chat');
    $('panel-research')?.classList.toggle('active-mobile-view', tab === 'research');
}

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

function initPwaHooks() {
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        if ($('install-pwa-btn')) $('install-pwa-btn').style.display = 'inline-flex';
        if (!sessionStorage.getItem('martha_pwa_dismissed') && !isStandalone() && $('pwa-install-banner')) {
            $('pwa-install-banner').style.display = 'flex';
        }
    });
    if (isIOS() && !isStandalone() && $('install-pwa-btn')) {
        $('install-pwa-btn').style.display = 'inline-flex';
    }
}

function handleInstallClick() {
    triggerHaptic('tap');
    if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        deferredInstallPrompt.userChoice.then((c) => {
            if (c.outcome === 'accepted') {
                showToast("Martha App Installed!");
                if ($('pwa-install-banner')) $('pwa-install-banner').style.display = 'none';
                if ($('install-pwa-btn')) $('install-pwa-btn').style.display = 'none';
            }
            deferredInstallPrompt = null;
        });
    } else if (isIOS()) {
        if ($('ios-install-modal')) $('ios-install-modal').style.display = 'flex';
    } else {
        showToast("Tap browser menu (⋮) → 'Install App'");
    }
}

function toggleAIProviderFields() {
    const p = $('ai-provider').value;
    $('gemini-key-group').style.display = p === 'gemini' ? 'block' : 'none';
    $('ollama-model-group').style.display = p === 'ollama' ? 'block' : 'none';
    $('ollama-url-group').style.display = p === 'ollama' ? 'block' : 'none';
    if ($('hf-help-text')) $('hf-help-text').style.display = p === 'huggingface' ? 'block' : 'none';
}

function initSettingsUI() {
    $('server-url').value = settings.serverUrl;
    $('ai-provider').value = settings.aiProvider;
    $('gemini-api-key').value = settings.apiKey;
    $('ollama-model').value = settings.ollamaModel;
    $('ollama-url').value = settings.ollamaUrl;
    $('speech-rate').value = settings.speechRate;
    dom.wakeWordCheck.checked = settings.wakeWordEnabled;
    if ($('haptics-enabled')) $('haptics-enabled').checked = settings.hapticsEnabled;
    $('sound-effects-enabled').checked = settings.soundEffectsEnabled;
    $('auto-speak-enabled').checked = settings.autoSpeakEnabled;
    $('search-engine').value = settings.searchEngine;
    toggleAIProviderFields();
    updateMuteUI();
}

function bindUIEvents() {
    // Navigation
    document.querySelectorAll('.mobile-nav-item').forEach(item => {
        item.addEventListener('click', () => switchMobileTab(item.getAttribute('data-tab')));
    });

    $('toggle-settings-btn').addEventListener('click', () => {
        triggerHaptic('tap');
        $('settings-drawer').classList.add('open');
    });

    $('close-settings-btn').addEventListener('click', () => {
        triggerHaptic('tap');
        $('settings-drawer').classList.remove('open');
    });

    $('save-settings-btn').addEventListener('click', () => {
        triggerHaptic('success');
        settings.serverUrl = $('server-url').value.trim();
        settings.aiProvider = $('ai-provider').value;
        settings.apiKey = $('gemini-api-key').value.trim();
        settings.ollamaModel = $('ollama-model').value.trim();
        settings.ollamaUrl = $('ollama-url').value.trim();
        settings.speechRate = parseFloat($('speech-rate').value);
        settings.voiceName = dom.voiceSelect.value;
        settings.wakeWordEnabled = dom.wakeWordCheck.checked;
        settings.hapticsEnabled = $('haptics-enabled')?.checked ?? true;
        settings.soundEffectsEnabled = $('sound-effects-enabled').checked;
        settings.autoSpeakEnabled = $('auto-speak-enabled').checked;
        settings.searchEngine = $('search-engine').value;

        for (const [k, [sk]] of Object.entries(SETTINGS_KEYS)) {
            safeStorageSet(sk, settings[k]);
        }

        $('settings-drawer').classList.remove('open');
        showToast("Settings Saved (Female Voice Active)");
        if (settings.wakeWordEnabled && isSpeechRecognitionSupported) {
            startRecognition();
        } else {
            stopRecognition();
        }
        updateMuteUI();
    });

    $('ai-provider').addEventListener('change', toggleAIProviderFields);

    const toggleVoice = (e) => {
        e.preventDefault();
        unlockAudio();
        if (appState === 'sleeping') {
            triggerActivation();
        } else if (appState === 'listening') {
            if (isPcmRecording) {
                stopUniversalPcmCapture();
            } else {
                stopEverything();
            }
        } else {
            stopEverything();
        }
    };

    dom.orb.addEventListener('click', toggleVoice);

    $('stop-speaking-btn')?.addEventListener('click', () => {
        stopEverything();
        showToast("Assistant Stopped");
    });

    dom.muteBtn.addEventListener('click', () => {
        triggerHaptic('tap');
        settings.autoSpeakEnabled = !settings.autoSpeakEnabled;
        safeStorageSet(SETTINGS_KEYS.autoSpeakEnabled[0], settings.autoSpeakEnabled);
        $('auto-speak-enabled').checked = settings.autoSpeakEnabled;
        updateMuteUI();
        if (!settings.autoSpeakEnabled && 'speechSynthesis' in window) {
            window.speechSynthesis.cancel();
        }
        showToast(settings.autoSpeakEnabled ? "Female TTS enabled" : "TTS muted");
    });

    $('clear-chat-btn').addEventListener('click', () => {
        triggerHaptic('tap');
        dom.chatMessages.innerHTML = '';
        addSystemMessage("Log cleared. Martha is listening...");
    });

    const submit = () => {
        const txt = dom.queryInput.value.trim();
        if (!txt) return;
        triggerHaptic('tap');
        dom.queryInput.value = '';
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
        handleCommand(txt);
    };

    $('send-query-btn').addEventListener('click', submit);
    dom.queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    // LAN Modal
    $('qr-connect-btn')?.addEventListener('click', openQRConnectModal);
    $('close-qr-modal-btn')?.addEventListener('click', () => {
        if ($('qr-modal')) $('qr-modal').style.display = 'none';
    });
    $('copy-lan-url-btn')?.addEventListener('click', () => {
        triggerHaptic('tap');
        navigator.clipboard.writeText($('lan-url-text').textContent).then(() => showToast("LAN URL Copied!"));
    });

    // PWA & iOS Modals
    $('install-pwa-btn')?.addEventListener('click', handleInstallClick);
    $('pwa-banner-install')?.addEventListener('click', handleInstallClick);
    $('pwa-banner-dismiss')?.addEventListener('click', () => {
        if ($('pwa-install-banner')) $('pwa-install-banner').style.display = 'none';
        try { sessionStorage.setItem('martha_pwa_dismissed', 'true'); } catch (e) {}
    });
    $('close-ios-modal-btn')?.addEventListener('click', () => {
        if ($('ios-install-modal')) $('ios-install-modal').style.display = 'none';
    });
}

async function openQRConnectModal() {
    triggerHaptic('tap');
    let url = window.location.origin;
    try {
        const info = await fetch(getApiUrl('/api/info')).then(r => r.json());
        if (info?.lan_url) url = info.lan_url;
    } catch (e) {
        console.warn('[Martha API] /api/info fetch skipped, using origin:', e);
    }

    $('lan-url-text').textContent = url;
    const box = $('qr-code-display');
    box.innerHTML = '';
    const img = new Image(180, 180);
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}&margin=2`;
    img.alt = "Scan with phone camera";
    img.onerror = () => {
        box.innerHTML = `<div style="font-family:monospace;font-size:11px;color:#09090e;padding:8px;">${url}</div>`;
    };
    box.appendChild(img);
    if ($('qr-modal')) $('qr-modal').style.display = 'flex';
}

/* ==========================================================================
   INITIALIZATION
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    // Cache DOM
    dom = {
        orb: $('martha-orb'),
        statusLabel: $('agent-status-label'),
        statusDot: $('agent-status-indicator'),
        waveform: $('waveform'),
        waveformBars: document.querySelectorAll('#waveform .bar'),
        transcript: $('live-transcript'),
        muteBtn: $('mute-voice-btn'),
        chatMessages: $('chat-messages'),
        queryInput: $('text-query-input'),
        voiceSelect: $('voice-select'),
        wakeWordCheck: $('wake-word-enabled')
    };

    initSettingsUI();
    initSpeechSynthesis();
    initSpeechRecognition();
    initPwaHooks();
    bindUIEvents();

    const mode = new URLSearchParams(window.location.search).get('mode');
    if (mode === 'voice') setTimeout(() => triggerActivation(), 600);
    else if (mode === 'search') switchMobileTab('research');

    const browserPrompt = isSpeechRecognitionSupported
        ? "Say 'Martha', tap the orb, or click the mic to start."
        : "Tap the glowing orb or mic button to speak with Martha.";
    addSystemMessage(`Martha initialized with female voice. ${browserPrompt}`);

    // Heartbeat ping with structured logging
    setInterval(() => {
        fetch(getApiUrl('/api/heartbeat'))
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
            .catch(err => console.debug('[Martha Heartbeat] Server unreachable:', err.message));
    }, 5000);
});
