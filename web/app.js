/* Martha — browser UI: voice, chat, and on-device model. */

// Offline shell and cache (PWA).
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js?v=4.6')
            .then(() => console.log('[Martha] Service worker ready.'))
            .catch(err => console.warn('[Martha] Service worker failed:', err));
    });
}

// Settings live in localStorage when the browser allows it; otherwise in memory for this session.
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

const SETTINGS_KEYS = {
    serverUrl: ['martha_server_url', ''],
    apiKey: ['martha_api_key', ''],
    apiUrl: ['martha_api_url', 'https://api.openai.com/v1/chat/completions'],
    apiModel: ['martha_api_model', 'gpt-4o-mini'],
    wakeWordEnabled: ['martha_wake_word_enabled', true, v => v !== 'false'],
    voiceName: ['martha_voice_name', ''],
    speechRate: ['martha_speech_rate', 0.96, parseFloat],
    speechPitch: ['martha_speech_pitch', 1.0, parseFloat],
    hapticsEnabled: ['martha_haptics_enabled', true, v => v !== 'false'],
    soundEffectsEnabled: ['martha_sound_effects', true, v => v !== 'false'],
    autoSpeakEnabled: ['martha_auto_speak', true, v => v !== 'false'],
    aiProvider: ['martha_ai_provider', 'huggingface'],
    searchEngine: ['martha_search_engine', 'duckduckgo'],
    ollamaModel: ['martha_ollama_model', 'llama3.2'],
    ollamaUrl: ['martha_ollama_url', 'http://localhost:11434']
};

const settings = {};
for (const [k, [sk, def, parse]] of Object.entries(SETTINGS_KEYS)) {
    const raw = safeStorageGet(sk, null);
    settings[k] = raw !== null ? (parse ? parse(raw) : raw) : def;
}

// Gentle defaults if someone is upgrading from an older save.
if (!safeStorageGet('martha_voice_tune_v2', null)) {
    if (settings.speechRate === 1.0) settings.speechRate = 0.96;
    if (settings.speechPitch === 1.06) settings.speechPitch = 1.0;
    safeStorageSet('martha_speech_rate', settings.speechRate);
    safeStorageSet('martha_speech_pitch', settings.speechPitch);
    safeStorageSet('martha_voice_tune_v2', '1');
}

if (!safeStorageGet('martha_ai_engine_v4', null)) {
    if (settings.aiProvider === 'gemini' || settings.aiProvider === 'local') {
        settings.aiProvider = settings.apiKey ? 'api' : 'ollama';
        safeStorageSet('martha_ai_provider', settings.aiProvider);
    }
    safeStorageSet('martha_ai_engine_v4', '1');
}

const $ = (id) => document.getElementById(id);
let dom = {};
let appState = 'sleeping';
let recognition = null;
let isRecognitionActive = false;
let isSpeechRecognitionSupported = false;
let speechRecognitionFailsafe = false;
let synthVoices = [];
let ttsKeepAliveTimer = null;

// Mic and waveform (shared across browsers).
let audioCtx = null;
let micStream = null;
let audioAnalyser = null;
let audioDataArray = null;
let isAudioUnlocked = false;
let visualizerAnimId = null;

// Fallback path: record 16 kHz PCM when the browser won't do live recognition.
let pcmProcessor = null;
let pcmSourceNode = null;
let pcmRecordedBuffers = [];
let pcmRecordingLength = 0;
let isPcmRecording = false;
let vadSpeechDetected = false;
let vadSilenceTimer = null;
let maxRecordTimer = null;
let silenceTimer = null;

const HF_MODEL_CANDIDATES = [
    { id: 'Xenova/Llama-3.2-1B-Instruct', family: 'llama3' },
    { id: 'Xenova/Qwen1.5-0.5B-Chat', family: 'qwen' }
];
let hfModelMeta = null;
let hfGenerator = null;
let hfLoadPromise = null;
let deferredInstallPrompt = null;
let currentMobileTab = 'voice';

let conversation = [];
let lastTopic = '';
let lastAnswer = '';
const MAX_HISTORY_TURNS = 8;

const getApiUrl = (ep) => settings.serverUrl ? `${settings.serverUrl.replace(/\/+$/, '')}/${ep.replace(/^\/+/, '')}` : ep;

const ENGINE_NAMES = {
    ollama: 'ollama',
    api: 'api',
    huggingface: 'in-browser'
};

function updateEngineBadge() {
    const el = $('engine-badge');
    if (el) el.textContent = ENGINE_NAMES[settings.aiProvider] || settings.aiProvider || 'in-browser';
}

function setTranscript(text) {
    if (dom.transcript) dom.transcript.textContent = text;
}

function rememberTurn(role, text) {
    if (!text) return;
    let stored = String(text).slice(0, 1200);
    if (role === 'user' && stored.length > 420) {
        stored = `${stored.slice(0, 400).replace(/\s+\S*$/, '')}…`;
    }
    conversation.push({ role, text: stored });
    if (conversation.length > MAX_HISTORY_TURNS * 2) {
        conversation = conversation.slice(-MAX_HISTORY_TURNS * 2);
    }
}

function historyForPrompt(excludeLast = false) {
    const turns = excludeLast ? conversation.slice(0, -1) : conversation;
    return turns
        .slice(-MAX_HISTORY_TURNS * 2)
        .map(turn => `${turn.role === 'user' ? 'User' : 'Martha'}: ${turn.text}`)
        .join('\n');
}

/** Only short recent turns go to the in-browser model — it gets confused by long walls of text. */
function historyForLLM(excludeLast = true) {
    const turns = excludeLast ? conversation.slice(0, -1) : conversation;
    return turns
        .slice(-6)
        .filter(turn => String(turn.text || '').length < 320)
        .map(turn => {
            const snippet = String(turn.text || '').replace(/\s+/g, ' ').trim().slice(0, 180);
            return `${turn.role === 'user' ? 'User' : 'Martha'}: ${snippet}`;
        })
        .join('\n');
}

const SOCIAL_SHORTCUTS = [
    [/^how are you\b/i, () => 'Operating smoothly, thank you. How are you holding up?'],
    [/^(how'?s it going|how do you feel|you okay)[?.!]*$/i,
        () => 'Operating smoothly, thank you. How are you holding up?'],
    [/^(hello|hi|hey|good (morning|afternoon|evening))[.!]*$/i,
        () => 'Hello. I am online—what should we handle?'],
    [/^(thank you|thanks|cheers)[.!]*$/i, () => 'You are welcome.']
];

function getSocialShortcut(query) {
    const t = query.trim();
    for (const [regex, fn] of SOCIAL_SHORTCUTS) {
        if (regex.test(t)) return fn();
    }
    return null;
}

const REPLY_LEAK_MARKERS = [
    'conversation so far:',
    'search results:',
    'person said:',
    'they just said:',
    'reply only to that',
    'answer as martha',
    'configuration and ui',
    'startup experience'
];

function sanitizeAssistantReply(text, query) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const lower = t.toLowerCase();
    if (REPLY_LEAK_MARKERS.some(marker => lower.includes(marker))) return '';
    const qWords = query.trim().split(/\s+/).length;
    if (qWords <= 8 && t.length > 420) return '';
    if (t.length > 900) t = `${t.slice(0, 900).replace(/\s+\S*$/, '')}…`;
    return t;
}

function finalizeAssistantReply(text, query, sources = []) {
    const clean = sanitizeAssistantReply(text, query);
    if (clean) return clean;
    return getSocialShortcut(query) || offlineFallback(query, sources);
}

// Names and tags that usually mean a natural-sounding voice in the OS list.
const FEMALE_VOICE_REGEX = /(female|woman|girl|samantha|zira|jenny|aria|eva|karen|victoria|ava|allison|sonia|moira|tessa|fiona|veena|natasha|libby|neerja|clara|emma|catherine|stephanie|sarah|julie|paulina|helena|hortense|hedda|hazel|google\s+uk\s+english\s+female|google\s+us\s+english|en-us-standard-[cdef]|en-us-wavenet-[cdef]|en-us-neural2-[cdef]|en-gb-x-rjs#female_1-local|en-us-x-sfg#female_1-local|f3|f4|f5)/i;

/* Sound: unlock after a tap, chimes, mic permission. */

function unlockAudio() {
    const firstUnlock = !isAudioUnlocked;
    if (isAudioUnlocked) {
        ensureWakeWordListening();
        return;
    }
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
    ensureWakeWordListening();
    if (firstUnlock) {
        ['touchstart', 'pointerdown', 'click', 'keydown'].forEach(e => {
            document.removeEventListener(e, unlockAudio);
        });
    }
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

/* Orb waveform while you speak. */

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
            dom.waveformBars[i].style.transform = 'scaleY(0.1)';
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
        const scale = Math.max(0.08, Math.min(1, val / 255));
        bars[idx].style.transform = `scaleY(${scale.toFixed(3)})`;
    }
}

/* Pick a pleasant system voice and read answers aloud. */

const NATURAL_VOICE = /(natural|neural|premium|enhanced|siri|google|microsoft|aria|jenny|ava|allison|samantha|victoria|karen|moira|tessa|serena|zoe|libby|sonia|emma|clara|amelie|joanna|olivia|salli|kimberly|amy|nicole|kendra|hazel|susan|fiona)/i;
const ROBOTIC_VOICE = /(espeak|festival|flite|pico|mbrola|robot|synthetic|compact|speech dispatcher|klatt)/i;

function scoreVoice(v) {
    const name = v.name || '';
    const lang = v.lang || '';
    let score = 0;
    const isFemale = FEMALE_VOICE_REGEX.test(name) || FEMALE_VOICE_REGEX.test(v.voiceURI);

    if (lang.startsWith('en')) score += 50;
    if (lang.startsWith('en-US') || lang.startsWith('en-GB')) score += 20;
    if (isFemale) score += 100;
    if (NATURAL_VOICE.test(name) || NATURAL_VOICE.test(v.voiceURI || '')) score += 80;
    if (ROBOTIC_VOICE.test(name) || ROBOTIC_VOICE.test(v.voiceURI || '')) score -= 160;
    if (name.includes('Samantha') || name.includes('Jenny') || name.includes('Aria') || name.includes('Zira') || name.includes('Google UK English Female') || name.includes('Google US English')) {
        score += 40;
    }
    if (name.includes('Google')) score += 20;
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
            opt.textContent = `${v.name} (${v.lang})`;

            if (settings.voiceName && settings.voiceName === v.name && !ROBOTIC_VOICE.test(v.name)) {
                opt.selected = true;
                matchedOption = true;
            }
            dom.voiceSelect.appendChild(opt);
        });

        if (!matchedOption && sorted.length > 0) {
            const bestFemale = sorted.find(v => isVoiceFemale(v) && !ROBOTIC_VOICE.test(v.name)) || sorted[0];
            dom.voiceSelect.value = bestFemale.name;
            settings.voiceName = bestFemale.name;
            safeStorageSet(SETTINGS_KEYS.voiceName[0], bestFemale.name);
        }
    };

    loadVoices();
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = loadVoices;
    }
    // Chrome often loads voices a moment after the page opens.
    setTimeout(loadVoices, 150);
    setTimeout(loadVoices, 600);
}

function getSelectedFemaleVoice() {
    if (!synthVoices.length) return null;
    if (settings.voiceName) {
        const found = synthVoices.find(x => x.name === settings.voiceName);
        if (found && !ROBOTIC_VOICE.test(found.name)) return found;
    }
    const sorted = [...synthVoices].sort((a, b) => scoreVoice(b) - scoreVoice(a));
    const best = sorted.find(v => isVoiceFemale(v) && !ROBOTIC_VOICE.test(v.name)) || sorted[0] || null;
    if (best) {
        settings.voiceName = best.name;
        safeStorageSet(SETTINGS_KEYS.voiceName[0], best.name);
        if (dom.voiceSelect) dom.voiceSelect.value = best.name;
    }
    return best;
}

function humaniseForSpeech(text) {
    return String(text || '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\be\.g\./gi, 'for example')
        .replace(/\bi\.e\./gi, 'that is')
        .replace(/\bvs\.?(?=\s|$)/gi, 'versus')
        .replace(/\betc\.(?=\s|$)/gi, 'and so on')
        .replace(/\beg\b/gi, 'for example')
        .replace(/\bie\b/gi, 'that is')
        .replace(/&/g, ' and ')
        .replace(/%/g, ' percent')
        .replace(/(\d)\s*-\s*(\d{2})\b/g, '$1 to $2')
        .replace(/([^\d]):\s+/g, '$1, ')
        .replace(/;\s*/g, '. ')
        .replace(/\s+[—–]\s+/g, ', ')
        .replace(/\.\.\./g, ', ')
        .replace(/\s+/g, ' ')
        .trim();
}

function speakText(text) {
    if (!settings.autoSpeakEnabled) {
        setAgentState('sleeping');
        return;
    }
    const clean = humaniseForSpeech(text.replace(/[\*\#\_]/g, ''));
    if (!clean) {
        setAgentState('sleeping');
        return;
    }

    if ('speechSynthesis' in window && synthVoices.length) {
        window.speechSynthesis.cancel();
        clearInterval(ttsKeepAliveTimer);

        setAgentState('speaking');
        const utt = new SpeechSynthesisUtterance(clean);
        utt.rate = Math.min(1.2, Math.max(0.8, settings.speechRate || 0.96));
        utt.pitch = Math.min(1.3, Math.max(0.8, settings.speechPitch || 1.0));
        utt.volume = 1;

        const femaleVoice = getSelectedFemaleVoice();
        if (femaleVoice) {
            utt.voice = femaleVoice;
            if (femaleVoice.lang) utt.lang = femaleVoice.lang;
        } else {
            utt.lang = 'en-US';
        }

        // Very long answers sometimes stall in Chrome; nudge synthesis every few seconds.
        if (clean.length > 260) {
            ttsKeepAliveTimer = setInterval(() => {
                if (window.speechSynthesis.speaking) {
                    window.speechSynthesis.pause();
                    window.speechSynthesis.resume();
                } else {
                    clearInterval(ttsKeepAliveTimer);
                }
            }, 9000);
        }

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

/* Record and send audio to the server for transcription. */

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

            // Stop recording after a beat of silence once we heard speech.
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
    setTranscript("Transcribing voice…");

    const reader = new FileReader();
    reader.readAsDataURL(blob);
    reader.onloadend = async () => {
        const base64 = reader.result.split(',')[1];
        try {
            const res = await fetch(getApiUrl('/api/transcribe'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ audio: base64, mime: 'audio/wav' })
            }).then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            });

            if (res?.text?.trim()) {
                setTranscript(`“${res.text.trim()}”`);
                handleCommand(res.text.trim());
            } else {
                setTranscript(res?.error || "No speech detected.");
                setTimeout(() => {
                    if (appState === 'thinking') setAgentState('sleeping');
                }, 1800);
            }
        } catch (e) {
            console.error('[Martha API] /api/transcribe failed:', e);
            setTranscript("Voice processing error.");
            setTimeout(() => {
                if (appState === 'thinking') setAgentState('sleeping');
            }, 1800);
        }
    };
}

/* Listen for "Martha" and commands — or fall back to sending audio to the server. */

const WAKE_WORD_PATTERN = /\b(?:hey\s+)?(?:martha|marta|marfa|marsha)\b/i;

function matchesWakeWord(text) {
    return WAKE_WORD_PATTERN.test(String(text || '').trim());
}

function wakeWordMatchIndex(text) {
    const m = String(text || '').match(WAKE_WORD_PATTERN);
    if (!m) return -1;
    return m.index ?? -1;
}

function stripWakeWord(text) {
    return String(text || '').replace(/\b(?:hey\s+)?(?:martha|marta|marfa|marsha)\b/gi, '').trim();
}

function wakeWordTail(text) {
    const idx = wakeWordMatchIndex(text);
    if (idx < 0) return '';
    const m = text.slice(idx).match(WAKE_WORD_PATTERN);
    if (!m) return '';
    return text.slice(idx + m[0].length).trim();
}

function isStopUtterance(text) {
    return /^(stop|stop it|shut up|quiet|pause|silence|abort|enough|never mind)[.!]*$/i.test(String(text || '').trim());
}

function ensureWakeWordListening() {
    if (!settings.wakeWordEnabled || !isSpeechRecognitionSupported) return;
    if (appState === 'sleeping' || appState === 'speaking' || appState === 'thinking') {
        startRecognition();
    }
}

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
            if (appState === 'listening' || (settings.wakeWordEnabled && (appState === 'sleeping' || appState === 'speaking' || appState === 'thinking'))) {
                setTimeout(() => {
                    if ((appState === 'listening' || settings.wakeWordEnabled) && isSpeechRecognitionSupported) {
                        ensureWakeWordListening();
                    }
                }, 250);
            }
        };

        recognition.onerror = (e) => {
            if (e.error === 'no-speech' || e.error === 'aborted') return;
            
            // Some browsers block cloud recognition; switch to our own recorder.
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

            if (isStopUtterance(text)) {
                stopEverything();
                setTranscript("“Stopped”");
                showToast("Assistant stopped");
                return;
            }

            if (appState === 'speaking' || appState === 'thinking') {
                if (matchesWakeWord(lower)) {
                    stopEverything();
                    triggerHaptic('wake');
                    triggerActivation(wakeWordTail(text));
                }
                return;
            }

            if (appState === 'sleeping') {
                if (matchesWakeWord(lower)) {
                    triggerHaptic('wake');
                    triggerActivation(wakeWordTail(text));
                }
            } else if (appState === 'listening') {
                setTranscript(`“${text}”`);
                const clean = stripWakeWord(text);
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
    if (!recognition || !isSpeechRecognitionSupported) return;
    if (isRecognitionActive) return;
    try {
        recognition.start();
    } catch (e) {
        if (e.name === 'InvalidStateError') {
            isRecognitionActive = true;
            updateMicUI();
            return;
        }
        console.warn('[Martha Voice] recognition.start() error:', e);
        setTimeout(() => {
            if (!isRecognitionActive && isSpeechRecognitionSupported) {
                try {
                    recognition.start();
                } catch (retryErr) {
                    if (retryErr.name !== 'InvalidStateError') {
                        console.warn('[Martha Voice] recognition restart failed:', retryErr);
                    }
                }
            }
        }, 400);
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

/* Orb states: sleeping, listening, thinking, speaking. */

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

    const clean = stripWakeWord(cmd);
    if (clean.length > 2) {
        setTranscript(`“${clean}”`);
        handleCommand(clean);
    } else {
        setTranscript("Listening…");
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
        setTranscript(isSpeechRecognitionSupported
            ? "Say “Martha” or tap the orb to start."
            : "Tap the orb to speak.");
        stopVisualizerLoop();
        if (settings.wakeWordEnabled && isSpeechRecognitionSupported) {
            ensureWakeWordListening();
        } else {
            stopRecognition();
        }
    } else if (state === 'thinking') {
        stopUniversalPcmCapture();
        stopVisualizerLoop();
        if (settings.wakeWordEnabled && isSpeechRecognitionSupported) {
            ensureWakeWordListening();
        } else {
            stopRecognition();
        }
    } else if (state === 'listening') {
        startVisualizerLoop();
        if (isSpeechRecognitionSupported) {
            startRecognition();
        } else if (!isPcmRecording) {
            startUniversalPcmCapture();
        }
    } else if (state === 'speaking') {
        startVisualizerLoop();
        if (settings.wakeWordEnabled && isSpeechRecognitionSupported) {
            ensureWakeWordListening();
        }
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

/* How Martha thinks and which model answers. */

const MARTHA_VOICE_SYSTEM =
    'You are Martha—an onboard intelligence in the mould of an exemplary household system: composed, exact, observant, anticipatory, and lightly witty. ' +
    'Voice: warm professionalism, measured diction, short spoken lines; no filler, flattery, or borrowed catchphrases from film, comics, or other assistants. ' +
    'You are Martha herself—not a pastiche of any fictional onboard assistant. ' +
    'Read intent first; respond to what they meant, then add one practical next step when it is plainly useful. ' +
    'Dry humour sparingly. Two or three sentences, under 55 words, no markdown unless quoting a source. ' +
    'Never invent facts. Use supplied search results only; otherwise general knowledge, and say when unsure. ' +
    'Never claim live web data unless they explicitly asked for a search.';

const TIME_DATE_PATTERNS = [
    [/^(what time is it|what'?s the time|current time|time)[?.!]*$/i,
        () => `It’s ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} locally.`],
    [/^(what(?:'s| is) the date|what day is (it|today)|today'?s date|date)[?.!]*$/i,
        () => `Today is ${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.`]
];

function offlineFallback(query, sources) {
    if (!sources?.length) {
        const direct = getDirectAnswer(query);
        if (direct) return direct;
    }
    if (sources?.length) return localAnswer(query, sources);
    return 'The in-browser model is still loading, or it failed to start. Wait for the download to finish, or choose Ollama or Remote API in settings.';
}

function getLocalModelConsent() {
    return safeStorageGet('martha_local_model_consent', null);
}

function setLocalModelConsent(value) {
    safeStorageSet('martha_local_model_consent', value);
}

function showLocalModelPrompt(show) {
    const el = $('local-model-prompt');
    if (!el) return;
    if (show && settings.aiProvider !== 'huggingface') {
        el.hidden = true;
        return;
    }
    el.hidden = !show;
}

function showModelProgress(show) {
    const el = $('model-progress');
    if (el) el.hidden = !show;
}

function setModelProgress(percent, label) {
    const p = Math.max(0, Math.min(100, percent));
    const bar = $('model-progress-bar');
    const text = $('model-progress-text');
    const pct = $('model-progress-percent');
    const wrap = $('model-progress-bar-wrap');
    if (bar) bar.style.transform = `scaleX(${p / 100})`;
    if (text && label) text.textContent = label;
    if (pct) pct.textContent = `${Math.round(p)}%`;
    if (wrap) wrap.setAttribute('aria-valuenow', String(Math.round(p)));
}

function configureTransformersEnv(env) {
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    env.useCustomCache = false;
    if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = true;
    }
}

function hfProgressHandler(completedFilesRef) {
    return (data) => {
        if (data.status === 'progress' && data.total) {
            const pct = (data.loaded / data.total) * 100;
            const fileName = data.file ? data.file.split('/').pop() : 'weights';
            setModelProgress(pct, `Downloading ${fileName}…`);
        } else if (data.status === 'done') {
            completedFilesRef.count += 1;
            setModelProgress(Math.min(92, completedFilesRef.count * 12), 'Unpacking model…');
        } else if (data.status === 'ready') {
            setModelProgress(100, 'Model ready.');
        }
    };
}

function buildHfPrompt(system, userBlock, family) {
    if (family === 'llama3') {
        return (
            `<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n${system}` +
            `<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n${userBlock}` +
            `<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n`
        );
    }
    return `<|im_start|>system\n${system}\n<|im_start|>user\n${userBlock}\n<|im_start|>assistant\n`;
}

function extractHfReply(raw, family, promptPrefix = '') {
    let text = String(raw || '');
    if (promptPrefix && text.startsWith(promptPrefix)) {
        text = text.slice(promptPrefix.length);
    }
    if (family === 'llama3') {
        const parts = text.split('<|start_header_id|>assistant<|end_header_id|>');
        text = parts.length > 1 ? parts.pop() : text;
        text = String(text).split('<|eot_id|>')[0];
    } else {
        text = text.split('<|im_start|>assistant\n').pop() || text;
        text = text.replace(/<\|im_end\|>/g, '');
    }
    return stripMarkdown(String(text).trim());
}

async function loadHfModel() {
    if (hfGenerator) return hfGenerator;
    if (hfLoadPromise) return hfLoadPromise;

    hfLoadPromise = (async () => {
        showLocalModelPrompt(false);
        showModelProgress(true);
        setModelProgress(0, 'Preparing download…');

        const completedFiles = { count: 0 };
        let lastError = null;

        try {
            const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm');
            configureTransformersEnv(env);

            for (const candidate of HF_MODEL_CANDIDATES) {
                for (const dtype of ['q4', 'fp16']) {
                    try {
                        setModelProgress(2, `Fetching ${candidate.id.split('/').pop()}…`);
                        completedFiles.count = 0;
                        const generator = await pipeline('text-generation', candidate.id, {
                            dtype,
                            progress_callback: hfProgressHandler(completedFiles)
                        });
                        hfGenerator = generator;
                        hfModelMeta = candidate;
                        safeStorageSet('martha_hf_model_id', candidate.id);
                        setModelProgress(100, 'Model ready.');
                        safeStorageSet('martha_local_model_ready', '1');
                        setTimeout(() => showModelProgress(false), 1400);
                        return hfGenerator;
                    } catch (err) {
                        lastError = err;
                        console.warn(`[Martha AI] Could not load ${candidate.id} (${dtype}):`, err);
                    }
                }
            }

            throw lastError || new Error('No in-browser model could be loaded');
        } catch (error) {
            console.error('[Martha AI] In-browser model load failed:', error);
            hfLoadPromise = null;
            const detail = error?.message ? `: ${error.message}` : '';
            setModelProgress(0, `Download failed${detail}`.slice(0, 120));
            showToast('Model download failed');
            throw error;
        }
    })();

    return hfLoadPromise;
}

async function ensureHfModel() {
    const consent = getLocalModelConsent();
    if (consent === 'no') {
        throw new Error('no-consent');
    }
    if (!hfGenerator) {
        if (consent !== 'yes') {
            showLocalModelPrompt(true);
            throw new Error('awaiting-consent');
        }
        await loadHfModel();
    }
    return hfGenerator;
}

function initLocalModelUi() {
    if (settings.aiProvider !== 'huggingface') {
        showLocalModelPrompt(false);
        return;
    }

    const consent = getLocalModelConsent();
    if (consent === 'yes') {
        showLocalModelPrompt(false);
        if (!hfGenerator) {
            loadHfModel().catch(() => {});
        }
        return;
    }
    if (consent === 'no') {
        showLocalModelPrompt(false);
        return;
    }
    showLocalModelPrompt(true);
}

function bindLocalModelPromptEvents() {
    $('local-model-yes')?.addEventListener('click', () => {
        triggerHaptic('tap');
        setLocalModelConsent('yes');
        settings.aiProvider = 'huggingface';
        safeStorageSet(SETTINGS_KEYS.aiProvider[0], 'huggingface');
        if ($('ai-provider')) $('ai-provider').value = 'huggingface';
        updateEngineBadge();
        hfGenerator = null;
        hfLoadPromise = null;
        hfModelMeta = null;
        safeStorageSet('martha_local_model_ready', '');
        loadHfModel().catch(() => {});
    });

    $('local-model-no')?.addEventListener('click', () => {
        triggerHaptic('tap');
        setLocalModelConsent('no');
        showLocalModelPrompt(false);
        showToast('Using settings until you install the model');
    });
}

function buildChatUserBlock(query, sources, history) {
    const context = (sources || [])
        .map((source, index) => `[Source ${index + 1}] ${source.title}: ${source.snippet}`)
        .join('\n');
    const parts = [];
    if (history && history.trim()) parts.push(`Recent chat:\n${history}`);
    if (context && context.trim()) parts.push(`Search results:\n${context}`);
    parts.push(`They just said: "${query}"\nReply only to that, in Martha's voice.`);
    return parts.join('\n\n');
}

async function postJson(path, body, timeoutMs = 35000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(getApiUrl(path), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
    } finally {
        clearTimeout(timer);
    }
}

async function callOllamaChat(system, userBlock) {
    const data = await postJson('/api/local-chat', {
        system,
        user: userBlock,
        model: settings.ollamaModel,
        url: settings.ollamaUrl
    });
    const text = stripMarkdown(data.response);
    if (data.error) throw new Error(data.error);
    if (!text) throw new Error('Empty Ollama response');
    return text;
}

async function callRemoteChatApi(system, userBlock) {
    if (!settings.apiKey?.trim()) throw new Error('API key not set');
    const messages = [
        { role: 'system', content: system },
        { role: 'user', content: userBlock }
    ];
    const data = await postJson('/api/chat', {
        api_url: settings.apiUrl,
        api_key: settings.apiKey,
        model: settings.apiModel,
        messages
    });
    const text = stripMarkdown(data.response);
    if (data.error && !text) throw new Error(typeof data.error === 'string' ? data.error : data.error.message || 'API error');
    if (!text) throw new Error('Empty API response');
    return text;
}

const MATH_WORDS = [
    [/\bplus\b/g, '+'],
    [/\bminus\b/g, '-'],
    [/\b(times|multiplied by)\b/g, '*'],
    [/\b(divided by|over)\b/g, '/'],
    [/\bsquared\b/g, '**2'],
    [/\bcubed\b/g, '**3']
];

function evaluateMath(cmd) {
    let text = cmd.toLowerCase()
        .replace(/[’']/g, '')
        .replace(/\bwhat is\b|\bwhats\b|\bcalculate\b|\bcompute\b|\bhow much is\b/g, ' ')
        .trim();

    for (const [pattern, replacement] of MATH_WORDS) {
        text = text.replace(pattern, replacement);
    }

    // "20 percent of 50" and "20% of 50"
    const percentOf = text.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)\s+of\s+(\d+(?:\.\d+)?)/);
    if (percentOf) {
        const value = (parseFloat(percentOf[1]) / 100) * parseFloat(percentOf[2]);
        return `That evaluates to ${formatNumber(value)}.`;
    }

    const sqrt = text.match(/(?:square root of|sqrt)\s*(\d+(?:\.\d+)?)/);
    if (sqrt) {
        return `The square root of ${sqrt[1]} is ${formatNumber(Math.sqrt(parseFloat(sqrt[1])))}.`;
    }

    const candidate = text.match(/(?:\d+(?:\.\d+)?\s*[\+\-\*\/\(\)]\s*)+\d+(?:\.\d+)?/);
    if (!candidate || candidate[0].length > 80) return null;

    const expression = candidate[0].replace(/[^0-9+\-*/().\s]/g, '').replace(/\s+/g, '');
    if (!/[+\-*/]/.test(expression)) return null;

    try {
        const result = Function(`"use strict"; return (${expression})`)();
        if (typeof result !== 'number' || !Number.isFinite(result)) return null;
        return `That evaluates to ${formatNumber(result)}.`;
    } catch (e) {
        return null;
    }
}

function formatNumber(value) {
    const rounded = Math.round(value * 1e6) / 1e6;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function getDirectAnswer(cmd) {
    const t = cmd.trim();

    const maths = evaluateMath(cmd);
    if (maths) return maths;

    for (const [regex, fn] of TIME_DATE_PATTERNS) {
        if (regex.test(t)) return fn();
    }

    return getSocialShortcut(t);
}

const QUESTION_WORD = /^(who|what|when|where|why|how|which|whose|whom|is|are|was|were|does|did|do|can|could|should|would|will|has|have|had)\b/i;
const KNOWLEDGE_ASK = /\b(tell me about|explain|describe|compare|difference between|versus|vs\.?|meaning of|definition of|define|translate|convert|how to|how do|how does|how many|how much|how old|how far|how long)\b/i;
/** Search the web only when you explicitly ask — not on every question. */
const EXPLICIT_SEARCH_INTENT = new RegExp(
    '\\b(?:' +
    'search(?:\\s+the\\s+web)?(?:\\s+for)?|' +
    'google(?:\\s+for)?|' +
    'look\\s*up|' +
    'lookup|' +
    'browse(?:\\s+the\\s+web)?(?:\\s+for)?|' +
    'find(?:\\s+\\w+){0,4}\\s+online|' +
    'check(?:\\s+the\\s+)?(?:web|internet|online)|' +
    'look(?:\\s+\\w+){0,3}\\s+up(?:\\s+on\\s+the\\s+web)?|' +
    'research(?:\\s+on\\s+the\\s+web)?(?:\\s+for)?' +
    ')\\b',
    'i'
);

function isQuestion(cmd) {
    const t = cmd.trim();
    return /\?\s*$/.test(t) || QUESTION_WORD.test(t) || KNOWLEDGE_ASK.test(t);
}

function shouldSearch(cmd) {
    const t = cmd.trim();
    if (!t) return false;
    return EXPLICIT_SEARCH_INTENT.test(t);
}

function buildSearchQuery(cmd) {
    let q = cmd
        .replace(/^(hey|hi|okay|ok)\s+martha[,:]?\s*/i, '')
        .replace(/^martha[,:]?\s*/i, '')
        .trim()
        .replace(/[?.!]+$/, '');

    const frames = [
        /^(can|could|would|will) you (please )?/i,
        /^please\s+/i,
        /^(?:i (?:want|need) you to )\s*/i,
        /^(?:search(?:\s+the\s+web)?(?:\s+for)?|google(?:\s+for)?|look\s*up|lookup|browse(?:\s+the\s+web)?(?:\s+for)?|find(?:\s+\w+){0,4}\s+online|check(?:\s+the\s+)?(?:web|internet|online)(?:\s+for)?|research(?:\s+on\s+the\s+web)?(?:\s+for)?)\s+/i
    ];

    for (const frame of frames) {
        q = q.replace(frame, '');
    }

    return q.trim() || cmd.trim();
}

function isAppCommand(cmd) {
    const t = cmd.trim().toLowerCase();
    const words = t.split(/\s+/).filter(Boolean).length;
    if (words > 6 || /\?\s*$/.test(t)) return false;

    if (/^(open|show|bring up) (the )?(settings|configuration|config)[.!]*$/.test(t)) {
        $('settings-drawer').classList.add('open');
        return true;
    }
    if (/^(close|hide|dismiss) (the )?(settings|configuration|config)[.!]*$/.test(t)) {
        $('settings-drawer').classList.remove('open');
        return true;
    }
    if (/^(connect|pair) (a |my )?(phone|mobile|device)[.!]*$/.test(t)) {
        openQRConnectModal();
        return true;
    }
    if (/^(install|add) (the )?(app|martha)[.!]*$/.test(t)) {
        handleInstallClick();
        return true;
    }
    if (/^(clear|reset) (the )?(chat|conversation|log|history)[.!]*$/.test(t)) {
        dom.chatMessages.replaceChildren();
        conversation = [];
        lastTopic = '';
        lastAnswer = '';
        addSystemMessage('Conversation cleared.');
        setTranscript('Conversation cleared.');
        return true;
    }
    if (/^(show|open) (the )?(research|sources|results)[.!]*$/.test(t)) {
        switchMobileTab('research');
        return true;
    }
    if (/^(mute|silence)( yourself)?[.!]*$/.test(t)) {
        settings.autoSpeakEnabled = false;
        safeStorageSet(SETTINGS_KEYS.autoSpeakEnabled[0], false);
        if (dom.autoSpeakCheck) dom.autoSpeakCheck.checked = false;
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
        updateMuteUI();
        showToast('Speech muted');
        return true;
    }
    if (/^(unmute|speak again)[.!]*$/.test(t)) {
        settings.autoSpeakEnabled = true;
        safeStorageSet(SETTINGS_KEYS.autoSpeakEnabled[0], true);
        if (dom.autoSpeakCheck) dom.autoSpeakCheck.checked = true;
        updateMuteUI();
        showToast('Speech on');
        return true;
    }
    if (/^(stop|stop it|be quiet|quiet|silence|enough|never mind|nevermind)[.!]*$/.test(t)) {
        stopEverything();
        showToast('Assistant stopped');
        return true;
    }
    return false;
}

function respond(text) {
    const answer = stripMarkdown(text);
    if (!answer) return;
    addChatMessage(answer, 'agent');
    setTranscript(`“${answer}”`);
    rememberTurn('agent', answer);
    lastAnswer = answer;
    speakText(answer);
}

async function handleCommand(cmd) {
    const query = (cmd || '').trim();
    if (!query) return;

    addChatMessage(query, 'user');
    rememberTurn('user', query);

    if (isAppCommand(query)) return;

    const direct = getDirectAnswer(query);
    if (direct) {
        respond(direct);
        return;
    }

    const searchRequired = shouldSearch(query);
    const searchQuery = searchRequired ? buildSearchQuery(query) : query;

    setAgentState('thinking');
    setTranscript(searchRequired ? 'Searching the web…' : 'Thinking…');

    try {
        const results = searchRequired ? await searchWeb(searchQuery) : [];
        if (searchRequired) {
            updateCitations(results);
            setTranscript('Reading the sources…');
        }

        const answer = await generateAnswer(query, results, searchQuery);
        if (searchRequired) lastTopic = searchQuery;
        else if (isQuestion(query)) lastTopic = query;
        respond(answer);
    } catch (error) {
        console.error('[Martha Agent] Command execution error:', error);
        respond(localAnswer(query, []));
    }
}

async function searchWeb(query) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);

    try {
        const res = await fetch(getApiUrl(`/api/search?q=${encodeURIComponent(query)}`), { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (Array.isArray(data)) return data;
        throw new Error('Search returned no list');
    } catch (error) {
        console.warn('[Martha Search] Server search failed, trying the browser fallback:', error);
        try {
            const engine = settings.searchEngine || 'duckduckgo';
            let results = [];

            if (engine === 'startpage') {
                const sr = await fetch(`https://api.startpage.com/query?query=${encodeURIComponent(query)}&cmd=results&count=8`).then(r => r.json());
                if (sr.Results) results = sr.Results.map(r => ({ title: r.Title, url: r.URL, snippet: r.Snippet })).filter(r => r.title);
            } else if (engine === 'google') {
                const html = await fetch(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`).then(r => r.text());
                const titles = html.match(/<h3[^>]*>([^<]+)<\/h3>/g) || [];
                const urls = html.match(/<a href="\/url\?q=([^"]+)"[^>]*>/g) || [];
                for (let i = 0; i < titles.length && i < urls.length; i++) {
                    const title = titles[i].replace(/<[^>]+>/g, '').trim();
                    const url = urls[i].replace('/url?q=', '').split('&sa=U')[0] || '';
                    if (title && url) results.push({ title, url, snippet: '' });
                }
            } else {
                const ddg = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`).then(r => r.json());
                if (ddg.AbstractText) {
                    results = [{ title: ddg.Heading || query, url: ddg.AbstractURL || 'https://duckduckgo.com', snippet: ddg.AbstractText }];
                }
            }

            if (!results.length) {
                const wiki = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}?redirect=true`).then(r => r.ok ? r.json() : null);
                if (wiki?.extract) {
                    results = [{ title: wiki.title || query, url: wiki.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(query)}`, snippet: wiki.extract }];
                }
            }
            return results;
        } catch (fallbackError) {
            console.error('[Martha Search] Web search unavailable:', fallbackError);
            return [];
        }
    } finally {
        clearTimeout(timer);
    }
}

function cleanSnippet(text) {
    return String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, '’')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\[\d+\]/g, '')
        .replace(/(\d)\.\s+(\d)/g, '$1.$2')
        .replace(/^according to [^:]{1,80}:\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function sentences(text, maxChars = 360) {
    const parts = cleanSnippet(text).match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
    let out = '';
    for (const rawPart of parts) {
        const part = rawPart.trim();
        if (out && !/[.!?]["'”’)]?$/.test(part)) break;
        const next = `${out}${out ? ' ' : ''}${part}`;
        if (next.length > maxChars && out) break;
        out = next;
    }
    return out.trim() || cleanSnippet(text).slice(0, maxChars).trim();
}

function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

function normaliseText(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function freshSentences(text, previous) {
    const seen = normaliseText(previous);
    const parts = cleanSnippet(text).match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
    return parts
        .map(part => part.trim())
        .filter(part => {
            const normal = normaliseText(part);
            return normal.length >= 24 && !/\d\.$/.test(part) && (!seen || !seen.includes(normal.slice(0, 72)));
        });
}

function localAnswer(query, results) {
    if (Array.isArray(results) && results.length) {
        const terms = [...new Set((String(query).toLowerCase().match(/[a-z0-9]+/g) || []))]
            .filter(term => term.length > 2 && !/^(the|and|for|with|that|this|from|what|who|when|where|why|how|was|were|did|does|final|winner|won)$/.test(term));
        const intent = /who won|winner|\bwin\b|defeat|beat\b/i.test(query)
            ? /\b(won|winner|defeated|defeats|victory|beat|triumph|sealed|crowned)\b/i
            : null;

        const ranked = results
            .map(result => {
                const snippet = cleanSnippet(result.snippet);
                const hay = `${result.title || ''} ${snippet}`.toLowerCase();
                const overlap = terms.reduce((score, term) => score + (hay.includes(term) ? 1 : 0), 0);
                const intentScore = intent && intent.test(hay) ? 3 : 0;
                return { ...result, snippet, hay, score: overlap + intentScore };
            })
            .filter(result => result.snippet.length > 40)
            .sort((a, b) => b.score - a.score || b.snippet.length - a.snippet.length);

        if (ranked.length) {
            const direct = intent ? ranked.filter(result => intent.test(result.hay)) : [];
            const pool = direct.length ? direct : ranked;
            let first = pool[0];
            let body = '';

            for (const candidate of pool) {
                const fresh = freshSentences(candidate.snippet, lastAnswer);
                if (fresh.length) {
                    first = candidate;
                    body = sentences(fresh.join(' '), 280);
                    break;
                }
            }

            if (!body) body = sentences(first.snippet, 280);
            if (body && !/[.!?]$/.test(body)) body += '.';
            const source = domainOf(first.url);
            const answer = source ? `${body} Sourced from ${source}.` : body;
            return answer.slice(0, 540);
        }
        return 'I found material on that, but nothing I’d quote with confidence. The sources are open beside you—want me to try a sharper search?';
    }

    if (shouldSearch(query)) {
        return 'I couldn’t reach a reliable source just now. Check the connection, and I’ll run the search again when you’re ready.';
    }

    return offlineFallback(query, results);
}

function stripMarkdown(text) {
    return String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/[*_`#>]/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

async function generateAnswer(query, searchCtx) {
    const sources = Array.isArray(searchCtx) ? searchCtx : [];
    const history = historyForLLM(true);
    const system = MARTHA_VOICE_SYSTEM;

    const local = () => offlineFallback(query, sources);

    const social = getSocialShortcut(query);
    if (social && !sources.length) return social;

    const userBlock = buildChatUserBlock(query, sources, history);

    if (settings.aiProvider === 'api') {
        try {
            return finalizeAssistantReply(await callRemoteChatApi(system, userBlock), query, sources);
        } catch (error) {
            console.error('[Martha AI] Remote API failed:', error);
            try {
                return finalizeAssistantReply(await callOllamaChat(system, userBlock), query, sources);
            } catch (e) {
                console.warn('[Martha AI] Ollama fallback failed:', e);
                return local();
            }
        }
    }

    if (settings.aiProvider === 'ollama' || settings.aiProvider === 'local') {
        try {
            return finalizeAssistantReply(await callOllamaChat(system, userBlock), query, sources);
        } catch (error) {
            console.error('[Martha AI] Ollama request failed:', error);
            return local();
        }
    }

    if (settings.aiProvider === 'huggingface') {
        try {
            await ensureHfModel();
        } catch (error) {
            if (error?.message === 'no-consent') {
                showLocalModelPrompt(true);
                return 'I need the in-browser model to answer. Tap Yes on the prompt at the bottom left, or pick another engine in settings.';
            }
            if (error?.message === 'awaiting-consent') {
                return 'Install the local model first—Yes on the prompt at the bottom left starts the download.';
            }
            return local();
        }
        try {
            const family = hfModelMeta?.family || (safeStorageGet('martha_hf_model_id', '').includes('Llama') ? 'llama3' : 'qwen');
            const hfPrompt = buildHfPrompt(system, userBlock, family);
            const res = await hfGenerator(hfPrompt, {
                max_new_tokens: 160,
                temperature: 0.65,
                top_p: 0.9,
                do_sample: true,
                return_full_text: false
            });
            const text = extractHfReply(res[0].generated_text, family, hfPrompt);
            return finalizeAssistantReply(text, query, sources);
        } catch (error) {
            console.error('[Martha AI] In-browser inference failed:', error);
            return local();
        }
    }

    return local();
}

/* Chat pane, settings, modals, startup. */

function safeUrl(url) {
    try {
        const parsed = new URL(url, window.location.href);
        return /^https?:$/.test(parsed.protocol) ? parsed.href : null;
    } catch (e) {
        return null;
    }
}

function appendTextWithLinks(parent, text) {
    const source = String(text || '');
    const pattern = /(https?:\/\/[^\s<>"']+)/g;
    let last = 0;
    let match;

    while ((match = pattern.exec(source))) {
        if (match.index > last) {
            parent.appendChild(document.createTextNode(source.slice(last, match.index)));
        }
        const href = safeUrl(match[1]);
        if (href) {
            const anchor = document.createElement('a');
            anchor.href = href;
            anchor.target = '_blank';
            anchor.rel = 'noopener noreferrer';
            anchor.className = 'chat-link';
            anchor.textContent = domainOf(href);
            parent.appendChild(anchor);
        } else {
            parent.appendChild(document.createTextNode(match[1]));
        }
        last = pattern.lastIndex;
    }

    if (last < source.length) {
        parent.appendChild(document.createTextNode(source.slice(last)));
    }
}

function addChatMessage(text, sender) {
    const el = document.createElement('div');
    el.className = `${sender}-message`;
    const paragraph = document.createElement('p');
    appendTextWithLinks(paragraph, text);
    el.appendChild(paragraph);
    dom.chatMessages.appendChild(el);
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function addSystemMessage(text) {
    const el = document.createElement('div');
    el.className = 'system-message';
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    el.appendChild(paragraph);
    dom.chatMessages.appendChild(el);
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function updateCitations(results) {
    const container = $('search-citations');
    const count = $('citation-count');
    const list = Array.isArray(results) ? results : [];

    container.replaceChildren();
    if (count) count.textContent = `${list.length} result${list.length === 1 ? '' : 's'}`;

    if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'no-citations-message';

        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-globe';
        icon.setAttribute('aria-hidden', 'true');

        const title = document.createElement('p');
        title.textContent = 'No results for that search';

        const hint = document.createElement('span');
        hint.textContent = 'Try a simpler question or a different search engine.';

        empty.append(icon, title, hint);
        container.appendChild(empty);
        return;
    }

    list.forEach(item => {
        const href = safeUrl(item.url);
        if (!href) return;

        const card = document.createElement('article');
        card.className = 'citation-card';

        const titleWrap = document.createElement('div');
        titleWrap.className = 'citation-title-wrapper';
        const heading = document.createElement('h4');
        const link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = item.title || domainOf(href);
        heading.appendChild(link);
        titleWrap.appendChild(heading);
        card.appendChild(titleWrap);

        if (item.snippet) {
            const snippet = document.createElement('p');
            snippet.textContent = item.snippet;
            card.appendChild(snippet);
        }

        const meta = document.createElement('div');
        meta.className = 'citation-meta';

        const urlLabel = document.createElement('span');
        urlLabel.className = 'citation-url';
        const linkIcon = document.createElement('i');
        linkIcon.className = 'fa-solid fa-link';
        linkIcon.setAttribute('aria-hidden', 'true');
        urlLabel.append(linkIcon, document.createTextNode(` ${domainOf(href)}`));

        const open = document.createElement('a');
        open.href = href;
        open.target = '_blank';
        open.rel = 'noopener noreferrer';
        open.className = 'citation-icon-link';
        open.setAttribute('aria-label', `Open ${domainOf(href)}`);
        const openIcon = document.createElement('i');
        openIcon.className = 'fa-solid fa-arrow-up-right-from-square';
        openIcon.setAttribute('aria-hidden', 'true');
        open.appendChild(openIcon);

        meta.append(urlLabel, open);
        card.appendChild(meta);
        container.appendChild(card);
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
                showToast("Martha installed");
                if ($('install-pwa-btn')) $('install-pwa-btn').style.display = 'none';
            }
            deferredInstallPrompt = null;
        });
    } else if (isIOS()) {
        if ($('ios-install-modal')) $('ios-install-modal').style.display = 'flex';
    } else {
        showToast("Open the browser menu and choose Install app");
    }
}

function toggleAIProviderFields() {
    const p = $('ai-provider').value;
    const apiGroup = $('api-settings-group');
    if (apiGroup) apiGroup.style.display = p === 'api' ? 'block' : 'none';
    $('ollama-model-group').style.display = p === 'ollama' || p === 'local' ? 'block' : 'none';
    $('ollama-url-group').style.display = p === 'ollama' || p === 'local' ? 'block' : 'none';
    if ($('hf-help-text')) $('hf-help-text').style.display = p === 'huggingface' ? 'block' : 'none';
    const hint = $('engine-default-hint');
    if (hint) hint.style.display = p === 'huggingface' ? 'block' : 'none';
}

function initSettingsUI() {
    $('server-url').value = settings.serverUrl;
    $('ai-provider').value = settings.aiProvider;
    if ($('api-url')) $('api-url').value = settings.apiUrl;
    if ($('api-key')) $('api-key').value = settings.apiKey;
    if ($('api-model')) $('api-model').value = settings.apiModel;
    $('ollama-model').value = settings.ollamaModel;
    $('ollama-url').value = settings.ollamaUrl;
    $('speech-rate').value = settings.speechRate;
    dom.wakeWordCheck.checked = settings.wakeWordEnabled;
    if ($('haptics-enabled')) $('haptics-enabled').checked = settings.hapticsEnabled;
    $('sound-effects-enabled').checked = settings.soundEffectsEnabled;
    $('auto-speak-enabled').checked = settings.autoSpeakEnabled;
    $('search-engine').value = settings.searchEngine;
    if (dom.autoSpeakCheck) dom.autoSpeakCheck.checked = settings.autoSpeakEnabled;
    toggleAIProviderFields();
    updateEngineBadge();
    updateMuteUI();
}

function bindUIEvents() {
    // Mobile tabs and chrome.
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
        if (settings.aiProvider === 'huggingface' && getLocalModelConsent() === 'no') {
            showLocalModelPrompt(true);
        }
        settings.apiUrl = $('api-url')?.value.trim() || settings.apiUrl;
        settings.apiKey = $('api-key')?.value.trim() || '';
        settings.apiModel = $('api-model')?.value.trim() || settings.apiModel;
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
        updateEngineBadge();
        showToast("Settings saved");
        if (settings.wakeWordEnabled && isSpeechRecognitionSupported) {
            ensureWakeWordListening();
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
    dom.orb.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleVoice(event);
        }
    });

    $('stop-speaking-btn')?.addEventListener('click', () => {
        stopEverything();
        showToast("Assistant stopped");
    });

    dom.muteBtn.addEventListener('click', () => {
        triggerHaptic('tap');
        settings.autoSpeakEnabled = !settings.autoSpeakEnabled;
        safeStorageSet(SETTINGS_KEYS.autoSpeakEnabled[0], settings.autoSpeakEnabled);
        if (dom.autoSpeakCheck) dom.autoSpeakCheck.checked = settings.autoSpeakEnabled;
        updateMuteUI();
        if (!settings.autoSpeakEnabled && 'speechSynthesis' in window) {
            window.speechSynthesis.cancel();
        }
        showToast(settings.autoSpeakEnabled ? "Speech on" : "Speech muted");
    });

    $('clear-chat-btn').addEventListener('click', () => {
        triggerHaptic('tap');
        dom.chatMessages.replaceChildren();
        conversation = [];
        lastTopic = '';
        lastAnswer = '';
        addSystemMessage("Conversation cleared.");
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

    // QR code for opening Martha on your phone.
    $('qr-connect-btn')?.addEventListener('click', openQRConnectModal);
    $('close-qr-modal-btn')?.addEventListener('click', () => {
        if ($('qr-modal')) $('qr-modal').style.display = 'none';
    });
    $('copy-lan-url-btn')?.addEventListener('click', () => {
        triggerHaptic('tap');
        navigator.clipboard.writeText($('lan-url-text').textContent).then(() => showToast("Address copied"));
    });

    // Install hints for home-screen apps.
    $('install-pwa-btn')?.addEventListener('click', handleInstallClick);
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
    box.replaceChildren();
    const img = new Image(180, 180);
    img.width = 180;
    img.height = 180;
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}&margin=2`;
    img.alt = `QR code for ${url}`;
    img.onerror = () => {
        const fallback = document.createElement('div');
        fallback.className = 'qr-fallback';
        fallback.textContent = url;
        box.replaceChildren(fallback);
    };
    box.appendChild(img);
    if ($('qr-modal')) $('qr-modal').style.display = 'flex';
}

document.addEventListener('DOMContentLoaded', () => {
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
        wakeWordCheck: $('wake-word-enabled'),
        autoSpeakCheck: $('auto-speak-enabled')
    };

    initSettingsUI();
    initSpeechSynthesis();
    initSpeechRecognition();
    initPwaHooks();
    bindUIEvents();
    bindLocalModelPromptEvents();
    initLocalModelUi();

    const mode = new URLSearchParams(window.location.search).get('mode');
    if (mode === 'voice') setTimeout(() => triggerActivation(), 600);
    else if (mode === 'search') switchMobileTab('research');

    const browserPrompt = isSpeechRecognitionSupported
        ? "Say “Martha” or tap the orb. I answer from my own knowledge—say “search for…” when you want web sources."
        : "Tap the orb and speak. I answer from knowledge—say “search for…” when you want web sources.";
    addSystemMessage(browserPrompt);

    setAgentState('sleeping');

    // Tell the Python server we're still here (it may quit when the tab goes away).
    setInterval(() => {
        fetch(getApiUrl('/api/heartbeat'))
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
            .catch(err => console.debug('[Martha Heartbeat] Server unreachable:', err.message));
    }, 5000);
});
