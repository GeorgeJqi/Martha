/* ==========================================================================
   MARTHA - OPTIMIZED CLIENT ENGINE
   Multi-Platform Voice AI Assistant, Web Research & Speech Engine
   ========================================================================== */

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js?v=3.1').catch(() => {});
    });
}

// State & Core Instances
let appState = 'sleeping', recognition = null, isRecognitionActive = false, isSpeechSupported = false;
let mediaRecorder = null, recordedAudioChunks = [], vadTimeout = null, micStream = null;
let audioAnalyser = null, audioDataArray = null, synthVoices = [], silenceTimer = null;
let hfGenerator = null, deferredInstallPrompt = null, currentMobileTab = 'voice', audioCtx = null, isAudioUnlocked = false;

// Configuration Schema
const SETTINGS_KEYS = {
    serverUrl: ['martha_server_url', ''],
    apiKey: ['martha_api_key', ''],
    wakeWordEnabled: ['martha_wake_word_enabled', true, v => v !== 'false'],
    voiceName: ['martha_voice_name', ''],
    speechRate: ['martha_speech_rate', 1.0, parseFloat],
    hapticsEnabled: ['martha_haptics_enabled', true, v => v !== 'false'],
    soundEffectsEnabled: ['martha_sound_effects', true, v => v !== 'false'],
    autoSpeakEnabled: ['martha_auto_speak', true, v => v !== 'false'],
    aiProvider: ['martha_ai_provider', 'local'],
    ollamaModel: ['martha_ollama_model', 'llama3.2'],
    ollamaUrl: ['martha_ollama_url', 'http://localhost:11434']
};

const settings = {};
for (const [k, [sk, def, parse]] of Object.entries(SETTINGS_KEYS)) {
    const raw = localStorage.getItem(sk);
    settings[k] = raw !== null ? (parse ? parse(raw) : raw) : def;
}

const $ = (id) => document.getElementById(id);
const getApiUrl = (ep) => settings.serverUrl ? `${settings.serverUrl.replace(/\/+$/, '')}/${ep.replace(/^\/+/, '')}` : ep;

function unlockAudio() {
    if (isAudioUnlocked) return;
    isAudioUnlocked = true;
    getAudioContext();
    if ('speechSynthesis' in window) {
        try {
            const u = new SpeechSynthesisUtterance('');
            u.volume = 0;
            window.speechSynthesis.speak(u);
        } catch (e) {}
    }
    ['touchstart', 'click'].forEach(e => document.removeEventListener(e, unlockAudio));
}
['touchstart', 'click'].forEach(e => document.addEventListener(e, unlockAudio, { passive: true }));

function triggerHaptic(type = 'tap') {
    if (!settings.hapticsEnabled || !navigator.vibrate) return;
    const p = { tap: 12, wake: [30, 40, 30], success: [15, 30, 20], stop: 35 };
    try { navigator.vibrate(p[type] || 12); } catch (e) {}
}

function getAudioContext() {
    if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) audioCtx = new AC();
    }
    if (audioCtx?.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

function playChime(type) {
    if (!settings.soundEffectsEnabled) return;
    try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;
        const freqs = type === 'start' ? [440, 880] : [523.25, 659.25, 783.99];
        freqs.forEach((f, i) => {
            const osc = ctx.createOscillator(), gain = ctx.createGain();
            const st = now + (type === 'start' ? 0 : i * 0.07);
            osc.frequency.setValueAtTime(f, st);
            gain.gain.setValueAtTime(0.12, st);
            gain.gain.exponentialRampToValueAtTime(0.001, st + 0.25);
            osc.connect(gain).connect(ctx.destination);
            osc.start(st); osc.stop(st + 0.25);
        });
    } catch (e) {}
}

async function requestMicPermission() {
    if (!navigator.mediaDevices?.getUserMedia) return false;
    try {
        if (!micStream) {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            connectStreamToVisualizer(micStream);
        }
        return true;
    } catch (e) { return false; }
}

function connectStreamToVisualizer(stream) {
    try {
        const ctx = getAudioContext();
        if (!ctx || audioAnalyser) return;
        const src = ctx.createMediaStreamSource(stream);
        audioAnalyser = ctx.createAnalyser();
        audioAnalyser.fftSize = 64;
        audioAnalyser.smoothingTimeConstant = 0.5;
        src.connect(audioAnalyser);
        audioDataArray = new Uint8Array(audioAnalyser.frequencyBinCount);
        renderVisualizer();
    } catch (e) {}
}

function renderVisualizer() {
    requestAnimationFrame(renderVisualizer);
    if (!audioAnalyser || (appState !== 'listening' && appState !== 'speaking')) return;
    audioAnalyser.getByteFrequencyData(audioDataArray);
    const bars = document.querySelectorAll('#waveform .bar');
    if (!bars.length) return;
    const step = Math.max(1, Math.floor(audioDataArray.length / bars.length));
    let total = 0;
    bars.forEach((bar, idx) => {
        const val = audioDataArray[idx * step] || 0;
        total += val;
        bar.style.height = `${Math.max(4, Math.min(32, Math.round((val / 255) * 32)))}px`;
    });

    if (total > 300 && mediaRecorder?.state === 'recording' && appState === 'listening') {
        clearTimeout(vadTimeout);
        vadTimeout = setTimeout(() => {
            if (mediaRecorder?.state === 'recording' && appState === 'listening') stopFirefoxAudioCapture();
        }, 1800);
    }
}

// Lifecycle
document.addEventListener('DOMContentLoaded', () => {
    initSettingsUI();
    initSpeechSynthesis();
    initSpeechRecognition();
    initMobileNav();
    initPwaHooks();
    bindUIEvents();

    const mode = new URLSearchParams(window.location.search).get('mode');
    if (mode === 'voice') setTimeout(() => triggerActivation(), 600);
    else if (mode === 'search') switchMobileTab('research');

    addSystemMessage("Martha initialized. Say 'Martha', tap the orb, or click the mic to start.");
    setInterval(() => fetch(getApiUrl('/api/heartbeat')).catch(() => {}), 4000);
});

function initSettingsUI() {
    $('server-url').value = settings.serverUrl;
    $('ai-provider').value = settings.aiProvider;
    $('gemini-api-key').value = settings.apiKey;
    $('ollama-model').value = settings.ollamaModel;
    $('ollama-url').value = settings.ollamaUrl;
    $('speech-rate').value = settings.speechRate;
    $('wake-word-enabled').checked = settings.wakeWordEnabled;
    if ($('haptics-enabled')) $('haptics-enabled').checked = settings.hapticsEnabled;
    $('sound-effects-enabled').checked = settings.soundEffectsEnabled;
    $('auto-speak-enabled').checked = settings.autoSpeakEnabled;
    toggleAIProviderFields();
    updateMuteUI();
}

function toggleAIProviderFields() {
    const p = $('ai-provider').value;
    $('gemini-key-group').style.display = p === 'gemini' ? 'block' : 'none';
    $('ollama-model-group').style.display = p === 'ollama' ? 'block' : 'none';
    $('ollama-url-group').style.display = p === 'ollama' ? 'block' : 'none';
    if ($('hf-help-text')) $('hf-help-text').style.display = p === 'huggingface' ? 'block' : 'none';
}

function showToast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}

// Navigation & PWA
function initMobileNav() {
    document.querySelectorAll('.mobile-nav-item').forEach(item => {
        item.addEventListener('click', () => switchMobileTab(item.getAttribute('data-tab')));
    });
}

function switchMobileTab(tab) {
    triggerHaptic('tap');
    currentMobileTab = tab;
    if (tab === 'settings') { $('settings-drawer').classList.add('open'); return; }
    document.querySelectorAll('.mobile-nav-item').forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-tab') === tab));
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
    if (isIOS() && !isStandalone() && $('install-pwa-btn')) $('install-pwa-btn').style.display = 'inline-flex';
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

// Speech Synthesis (TTS)
function initSpeechSynthesis() {
    if (!('speechSynthesis' in window)) return;
    const loadVoices = () => {
        synthVoices = window.speechSynthesis.getVoices();
        const sel = $('voice-select');
        sel.innerHTML = '';
        synthVoices.forEach(v => {
            const opt = document.createElement('option');
            opt.value = v.name;
            opt.textContent = `${v.name} (${v.lang})`;
            if (settings.voiceName === v.name || (!settings.voiceName && v.lang.startsWith('en') && (v.name.includes('Samantha') || v.name.includes('Google')))) {
                opt.selected = true;
            }
            sel.appendChild(opt);
        });
    };
    loadVoices();
    if (window.speechSynthesis.onvoiceschanged !== undefined) window.speechSynthesis.onvoiceschanged = loadVoices;
}

function speakText(text) {
    if (!settings.autoSpeakEnabled) { setAgentState('sleeping'); return; }
    const clean = text.replace(/[\*\#\_]/g, '').trim();
    if (!clean) { setAgentState('sleeping'); return; }

    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        setAgentState('speaking');
        const utt = new SpeechSynthesisUtterance(clean);
        utt.rate = settings.speechRate;
        const v = settings.voiceName ? synthVoices.find(x => x.name === settings.voiceName) : synthVoices.find(x => x.lang.startsWith('en') && (x.name.includes('Samantha') || x.name.includes('Google')));
        if (v) utt.voice = v;
        utt.onend = () => { playChime('success'); setAgentState('sleeping'); };
        utt.onerror = () => fallbackBackendTTS(clean);
        window.speechSynthesis.speak(utt);
    } else {
        fallbackBackendTTS(clean);
    }
}

function fallbackBackendTTS(text) {
    setAgentState('speaking');
    fetch(getApiUrl('/api/tts'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
        .then(() => { playChime('success'); setAgentState('sleeping'); })
        .catch(() => setAgentState('sleeping'));
}

// Speech Recognition & Universal Audio Capture
function initSpeechRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { isSpeechSupported = false; return; }
    isSpeechSupported = true;
    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => { isRecognitionActive = true; updateMicUI(); };
    recognition.onend = () => {
        isRecognitionActive = false;
        updateMicUI();
        if (appState === 'listening' || (settings.wakeWordEnabled && (appState === 'sleeping' || appState === 'speaking'))) {
            setTimeout(() => { if (appState === 'listening' || settings.wakeWordEnabled) startRecognition(); }, 200);
        }
    };
    recognition.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            addSystemMessage("Microphone permission needed. Tap the mic button to grant access.");
            settings.wakeWordEnabled = false;
            $('wake-word-enabled').checked = false;
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
            $('live-transcript').innerHTML = '"Stopped"';
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
            $('live-transcript').innerHTML = `"${text}"`;
            const clean = text.replace(/\b(martha|hey martha)\b/gi, '').trim();
            if (!clean) return;
            clearTimeout(silenceTimer);
            if (final.trim().length > 0) handleCommand(clean);
            else silenceTimer = setTimeout(() => { if (appState === 'listening') handleCommand(clean); }, 1800);
        }
    };
}

async function startFirefoxAudioCapture() {
    try {
        const stream = micStream || await navigator.mediaDevices.getUserMedia({ audio: true });
        micStream = stream;
        connectStreamToVisualizer(stream);
        recordedAudioChunks = [];
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
        mediaRecorder = new MediaRecorder(stream, { mimeType });
        mediaRecorder.ondataavailable = (e) => { if (e.data?.size > 0) recordedAudioChunks.push(e.data); };
        mediaRecorder.onstop = async () => {
            if (!recordedAudioChunks.length) { setAgentState('sleeping'); return; }
            const blob = new Blob(recordedAudioChunks, { type: mediaRecorder.mimeType });
            recordedAudioChunks = [];
            await processRecordedAudio(blob, mediaRecorder.mimeType);
        };
        mediaRecorder.start(200);
        isRecognitionActive = true;
        updateMicUI();
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(stopFirefoxAudioCapture, 7000);
    } catch (e) {
        showToast("Microphone permission denied");
        setAgentState('sleeping');
    }
}

function stopFirefoxAudioCapture() {
    clearTimeout(silenceTimer);
    clearTimeout(vadTimeout);
    if (mediaRecorder?.state === 'recording') { try { mediaRecorder.stop(); } catch (e) {} }
    isRecognitionActive = false;
    updateMicUI();
}

async function processRecordedAudio(blob, mimeType) {
    if (!blob || blob.size < 600) { setAgentState('sleeping'); return; }
    setAgentState('thinking');
    $('live-transcript').innerHTML = "Transcribing voice...";
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    reader.onloadend = async () => {
        const base64 = reader.result.split(',')[1];
        try {
            const res = await fetch(getApiUrl('/api/transcribe'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ audio: base64, mime: mimeType, api_key: settings.apiKey })
            }).then(r => r.json());
            if (res?.text?.trim()) {
                $('live-transcript').innerHTML = `"${res.text.trim()}"`;
                handleCommand(res.text.trim());
            } else {
                $('live-transcript').innerHTML = "No speech detected.";
                setTimeout(() => { if (appState === 'thinking') setAgentState('sleeping'); }, 2000);
            }
        } catch (e) {
            $('live-transcript').innerHTML = "Voice processing error.";
            setTimeout(() => { if (appState === 'thinking') setAgentState('sleeping'); }, 2000);
        }
    };
}

function startRecognition() {
    if (!recognition || isRecognitionActive) return;
    try { recognition.start(); } catch (e) {}
}

function stopRecognition() {
    if (recognition && isRecognitionActive) {
        try { recognition.stop(); } catch (e) {}
    }
}

function stopEverything() {
    triggerHaptic('stop');
    clearTimeout(silenceTimer);
    clearTimeout(vadTimeout);
    stopFirefoxAudioCapture();
    stopRecognition();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    fetch(getApiUrl('/api/tts?action=stop')).catch(() => {});
    setAgentState('sleeping');
}

async function triggerActivation(cmd = "") {
    unlockAudio();
    triggerHaptic('tap');
    playChime('start');
    setAgentState('listening');
    if (window.innerWidth <= 860 && currentMobileTab !== 'voice') switchMobileTab('voice');

    const ok = await requestMicPermission();
    if (!ok) {
        showToast("Microphone access needed.");
        $('text-query-input').focus();
        setAgentState('sleeping');
        return;
    }

    const clean = cmd.replace(/\b(martha|hey martha)\b/gi, '').trim();
    if (clean.length > 2) {
        $('live-transcript').innerHTML = `"${clean}"`;
        handleCommand(clean);
    } else {
        $('live-transcript').innerHTML = "Listening...";
        if (isSpeechSupported) {
            startRecognition();
            clearTimeout(silenceTimer);
            silenceTimer = setTimeout(() => { if (appState === 'listening') setAgentState('sleeping'); }, 6000);
        } else {
            startFirefoxAudioCapture();
        }
    }
}

function setAgentState(state) {
    appState = state;
    $('martha-orb').className = `martha-orb state-${state}`;
    $('agent-status-label').textContent = state;
    $('agent-status-indicator').className = `status-dot ${state}`;
    const wf = $('waveform');
    if (wf) wf.className = `waveform ${state}`;
    updateMicUI();

    if (state === 'sleeping') {
        $('live-transcript').innerHTML = "Say 'Martha' or tap orb to start...";
        if (settings.wakeWordEnabled && isSpeechSupported) startRecognition();
    } else if (state === 'thinking') {
        stopRecognition(); stopFirefoxAudioCapture();
    } else if (state === 'listening') {
        if (isSpeechSupported) startRecognition();
        else if (mediaRecorder?.state !== 'recording') startFirefoxAudioCapture();
    }
}

function updateMicUI() {
    const act = isRecognitionActive || mediaRecorder?.state === 'recording' || appState === 'listening';
    $('mic-trigger-btn').classList.toggle('active', act);
    const i = $('mic-trigger-btn').querySelector('i');
    if (i) i.className = act ? 'fa-solid fa-microphone' : 'fa-solid fa-microphone-slash';
}

function updateMuteUI() {
    const b = $('mute-voice-btn');
    b.classList.toggle('muted', !settings.autoSpeakEnabled);
    const i = b.querySelector('i');
    if (i) i.className = settings.autoSpeakEnabled ? 'fa-solid fa-volume-high' : 'fa-solid fa-volume-xmark';
}

// Personality Engine & AI Pipeline
const PERSONALITY_MAP = [
    [/\b(hello|hi|hey|greetings|good (morning|afternoon|evening)|yo|sup)\b/, () => "Hello! I'm Martha, your voice AI assistant. How can I help you today?"],
    [/\b(how are you|how is it going|how do you feel)\b/, () => "I'm doing great, feeling sharp, and ready to help you!"],
    [/\b(who are you|what is your name)\b/, () => "I am Martha, your local voice AI assistant for desktop and mobile."],
    [/\b(who (made|created|built) you)\b/, () => "I am Martha, an open-source voice AI assistant built for fast local interaction."],
    [/\b(what can you do|features|help)\b/, () => "I can chat with you, answer questions, tell jokes, solve math calculations, check the time, and search the web for live information!"],
    [/\bfavorit(e)? color\b/, () => "I love electric teal and deep glowing violet!"],
    [/\bfavorit(e)? (movie|film|show)\b/, () => "I love sci-fi movies about intelligent AI, like Interstellar and WALL-E!"],
    [/\bfavorit(e)? (music|song|band|genre)\b/, () => "I love ambient synthwave and energetic electronic beats!"],
    [/\b(tell (me a )?joke|say a joke|make me laugh)\b/, () => {
        const j = ["Why do programmers prefer dark mode? Because light attracts bugs!", "Why don't scientists trust atoms? Because they make up everything!", "What do you call a fake noodle? An impasta!", "Why did the AI cross the road? To optimize the path to the other side!", "How do computers take a breath? They open Windows!"];
        return j[Math.floor(Math.random() * j.length)];
    }],
    [/\b(time|what time is it|current time)\b/, () => `It's currently ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`],
    [/\b(date|what day is today|today's date)\b/, () => `Today is ${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.`],
    [/\b(thank you|thanks)\b/, () => "You're very welcome! Let me know if you need anything else."]
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
        $('live-transcript').innerHTML = `"${direct}"`;
        speakText(direct);
        return;
    }

    const searchRequired = needsSearch(cmd);
    setAgentState('thinking');
    $('live-transcript').innerHTML = searchRequired ? "Searching the web..." : "Thinking...";

    try {
        const results = searchRequired ? await searchWeb(cmd) : [];
        if (searchRequired) {
            updateCitations(results);
            $('live-transcript').innerHTML = "Synthesizing answer...";
        }
        const ans = await generateAnswer(cmd, results);
        addChatMessage(ans, 'agent');
        $('live-transcript').innerHTML = `"${ans}"`;
        speakText(ans);
    } catch (e) {
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
        const ddg = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`).then(r => r.json());
        return ddg.AbstractText ? [{ title: ddg.Heading || query, url: ddg.AbstractURL || 'https://duckduckgo.com', snippet: ddg.AbstractText }] : [];
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
        const res = await fetch(getApiUrl('/api/local-chat'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, model: settings.ollamaModel, url: settings.ollamaUrl })
        }).then(r => r.json());
        return res.response?.trim() || "No response from local Ollama.";
    }

    if (settings.aiProvider === 'gemini') {
        if (!settings.apiKey) return searchCtx[0] ? `According to web sources: "${searchCtx[0].snippet}".` : "No Gemini API key set.";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${settings.apiKey}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 250, temperature: 0.4 } })
        }).then(r => r.json());
        return res.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Unable to generate answer.";
    }

    if (settings.aiProvider === 'huggingface') {
        if (!hfGenerator) {
            $('model-progress').style.display = 'block';
            try {
                const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
                env.allowLocalModels = false;
                hfGenerator = await pipeline('text-generation', 'Xenova/Qwen1.5-0.5B-Chat');
            } finally { $('model-progress').style.display = 'none'; }
        }
        const res = await hfGenerator(`<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n`, { max_new_tokens: 140 });
        const text = res[0].generated_text.split('<|im_start|>assistant\n').pop() || '';
        return text.replace(/<\|im_end\|>/g, '').trim() || searchCtx[0]?.snippet || "Processed.";
    }
    return searchCtx[0]?.snippet || "I processed your request.";
}

// UI Utilities & Event Listeners
function addChatMessage(text, sender) {
    const el = document.createElement('div');
    el.className = `${sender}-message`;
    el.innerHTML = `<p>${text.replace(/(https?:\/\/[^\s]+)/g, url => `<a href="${url}" target="_blank" class="chat-link">${new URL(url).hostname}</a>`)}</p>`;
    $('chat-messages').appendChild(el);
    $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
}

function addSystemMessage(text) {
    const el = document.createElement('div');
    el.className = 'system-message';
    el.innerHTML = `<p>${text}</p>`;
    $('chat-messages').appendChild(el);
    $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
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
            <div class="citation-title-wrapper"><h4><a href="${item.url}" target="_blank">${item.title}</a></h4></div>
            <p>${item.snippet}</p>
            <div class="citation-meta"><span class="citation-url"><i class="fa-solid fa-link"></i> ${domain}</span><a href="${item.url}" target="_blank" class="citation-icon-link"><i class="fa-solid fa-arrow-up-right-from-square"></i></a></div>
        `;
        cont.appendChild(card);
    });
}

function bindUIEvents() {
    $('toggle-settings-btn').addEventListener('click', () => { triggerHaptic('tap'); $('settings-drawer').classList.add('open'); });
    $('close-settings-btn').addEventListener('click', () => { triggerHaptic('tap'); $('settings-drawer').classList.remove('open'); });
    
    $('save-settings-btn').addEventListener('click', () => {
        triggerHaptic('success');
        settings.serverUrl = $('server-url').value.trim();
        settings.aiProvider = $('ai-provider').value;
        settings.apiKey = $('gemini-api-key').value.trim();
        settings.ollamaModel = $('ollama-model').value.trim();
        settings.ollamaUrl = $('ollama-url').value.trim();
        settings.speechRate = parseFloat($('speech-rate').value);
        settings.voiceName = $('voice-select').value;
        settings.wakeWordEnabled = $('wake-word-enabled').checked;
        settings.hapticsEnabled = $('haptics-enabled')?.checked ?? true;
        settings.soundEffectsEnabled = $('sound-effects-enabled').checked;
        settings.autoSpeakEnabled = $('auto-speak-enabled').checked;

        for (const [k, [sk]] of Object.entries(SETTINGS_KEYS)) localStorage.setItem(sk, settings[k]);

        $('settings-drawer').classList.remove('open');
        showToast("Settings Saved Successfully");
        if (settings.wakeWordEnabled) startRecognition(); else stopRecognition();
        updateMuteUI();
    });

    $('ai-provider').addEventListener('change', toggleAIProviderFields);

    const toggleVoice = (e) => {
        e.preventDefault();
        unlockAudio();
        if (appState === 'sleeping') triggerActivation();
        else if (appState === 'listening' && mediaRecorder?.state === 'recording') stopFirefoxAudioCapture();
        else stopEverything();
    };

    $('mic-trigger-btn').addEventListener('click', toggleVoice);
    $('martha-orb').addEventListener('click', toggleVoice);
    $('stop-speaking-btn')?.addEventListener('click', () => { stopEverything(); showToast("Assistant Stopped"); });

    $('mute-voice-btn').addEventListener('click', () => {
        triggerHaptic('tap');
        settings.autoSpeakEnabled = !settings.autoSpeakEnabled;
        localStorage.setItem(SETTINGS_KEYS.autoSpeakEnabled[0], settings.autoSpeakEnabled);
        $('auto-speak-enabled').checked = settings.autoSpeakEnabled;
        updateMuteUI();
        if (!settings.autoSpeakEnabled && 'speechSynthesis' in window) window.speechSynthesis.cancel();
        showToast(settings.autoSpeakEnabled ? "Speech synthesis enabled" : "Speech synthesis muted");
    });

    $('clear-chat-btn').addEventListener('click', () => {
        triggerHaptic('tap');
        $('chat-messages').innerHTML = '';
        addSystemMessage("Log cleared. Martha is listening...");
    });

    const submit = () => {
        const txt = $('text-query-input').value.trim();
        if (!txt) return;
        triggerHaptic('tap');
        $('text-query-input').value = '';
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
        handleCommand(txt);
    };

    $('send-query-btn').addEventListener('click', submit);
    $('text-query-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    $('qr-connect-btn')?.addEventListener('click', openQRConnectModal);
    $('close-qr-modal-btn')?.addEventListener('click', () => { if ($('qr-modal')) $('qr-modal').style.display = 'none'; });
    $('copy-lan-url-btn')?.addEventListener('click', () => {
        triggerHaptic('tap');
        navigator.clipboard.writeText($('lan-url-text').textContent).then(() => showToast("LAN URL Copied!"));
    });

    $('install-pwa-btn')?.addEventListener('click', handleInstallClick);
    $('pwa-banner-install')?.addEventListener('click', handleInstallClick);
    $('pwa-banner-dismiss')?.addEventListener('click', () => {
        if ($('pwa-install-banner')) $('pwa-install-banner').style.display = 'none';
        sessionStorage.setItem('martha_pwa_dismissed', 'true');
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
    } catch (e) {}

    $('lan-url-text').textContent = url;
    const box = $('qr-code-display');
    box.innerHTML = '';
    const img = new Image(180, 180);
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}&margin=2`;
    img.alt = "Scan with phone camera";
    img.onerror = () => { box.innerHTML = `<div style="font-family:monospace;font-size:11px;color:#09090e;padding:8px;">${url}</div>`; };
    box.appendChild(img);
    if ($('qr-modal')) $('qr-modal').style.display = 'flex';
}
