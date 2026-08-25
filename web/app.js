/* ==========================================================================
   MARTHA - OPTIMIZED CLIENT FRONTEND ENGINE
   Multi-Platform Local Voice AI Assistant, Web Research & Speech Engine
   ========================================================================== */

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

env.allowLocalModels = false;

// Register Service Worker for PWA & Offline Support
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(err => console.warn('[PWA] SW registration:', err));
    });
}

// State & Core Instances
let appState = 'sleeping';
let recognition = null;
let isRecognitionActive = false;
let currentUtterance = null;
let synthVoices = [];
let silenceTimer = null;
let hfGenerator = null;
let hfModelLoading = false;
let deferredInstallPrompt = null;
let currentMobileTab = 'voice';
let audioCtx = null;
let isAudioUnlocked = false;

// Settings
const settings = {
    serverUrl: localStorage.getItem('martha_server_url') || '',
    apiKey: localStorage.getItem('martha_api_key') || '',
    wakeWordEnabled: localStorage.getItem('martha_wake_word_enabled') !== 'false',
    voiceName: localStorage.getItem('martha_voice_name') || '',
    speechRate: parseFloat(localStorage.getItem('martha_speech_rate') || '1.0'),
    hapticsEnabled: localStorage.getItem('martha_haptics_enabled') !== 'false',
    soundEffectsEnabled: localStorage.getItem('martha_sound_effects') !== 'false',
    autoSpeakEnabled: localStorage.getItem('martha_auto_speak') !== 'false',
    aiProvider: localStorage.getItem('martha_ai_provider') || 'local',
    ollamaModel: localStorage.getItem('martha_ollama_model') || 'llama3.2',
    ollamaUrl: localStorage.getItem('martha_ollama_url') || 'http://localhost:11434'
};

// UI Elements Cache
const $ = (id) => document.getElementById(id);
const marthaOrb = $('martha-orb');
const agentStatusLabel = $('agent-status-label');
const agentStatusIndicator = $('agent-status-indicator');
const liveTranscript = $('live-transcript');
const chatMessages = $('chat-messages');
const searchCitations = $('search-citations');
const citationCountBadge = $('citation-count');
const textQueryInput = $('text-query-input');

const panelVoice = $('panel-voice');
const panelChat = $('panel-chat');
const panelResearch = $('panel-research');
const settingsDrawer = $('settings-drawer');
const toast = $('toast');

const micTriggerBtn = $('mic-trigger-btn');
const stopSpeakingBtn = $('stop-speaking-btn');
const muteVoiceBtn = $('mute-voice-btn');
const installPwaBtn = $('install-pwa-btn');
const qrModal = $('qr-modal');
const iosInstallModal = $('ios-install-modal');
const pwaInstallBanner = $('pwa-install-banner');

/* ==========================================================================
   HELPERS: API, AUDIO UNLOCK & HAPTICS
   ========================================================================== */

const getApiUrl = (endpoint) => {
    if (!settings.serverUrl) return endpoint;
    return `${settings.serverUrl.replace(/\/+$/, '')}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
};

function unlockMobileAudio() {
    if (isAudioUnlocked) return;
    isAudioUnlocked = true;
    getAudioContext();
    if ('speechSynthesis' in window) {
        try {
            const silent = new SpeechSynthesisUtterance('');
            silent.volume = 0;
            window.speechSynthesis.speak(silent);
        } catch (e) {}
    }
    document.removeEventListener('touchstart', unlockMobileAudio);
    document.removeEventListener('click', unlockMobileAudio);
}
document.addEventListener('touchstart', unlockMobileAudio, { passive: true });
document.addEventListener('click', unlockMobileAudio, { passive: true });

function triggerHaptic(type = 'tap') {
    if (!settings.hapticsEnabled || !navigator.vibrate) return;
    const patterns = { tap: 12, wake: [30, 40, 30], success: [15, 30, 20], stop: 35 };
    try { navigator.vibrate(patterns[type] || 12); } catch (e) {}
}

function getAudioContext() {
    if (!audioCtx) {
        const AudioClass = window.AudioContext || window.webkitAudioContext;
        if (AudioClass) audioCtx = new AudioClass();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

function playChime(type) {
    if (!settings.soundEffectsEnabled) return;
    try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;
        if (type === 'start') {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(440, now);
            osc.frequency.exponentialRampToValueAtTime(880, now + 0.15);
            gain.gain.setValueAtTime(0.15, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now);
            osc.stop(now + 0.25);
        } else {
            [523.25, 659.25, 783.99].forEach((freq, idx) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                const st = now + (idx * 0.07);
                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, st);
                gain.gain.setValueAtTime(0.12, st);
                gain.gain.exponentialRampToValueAtTime(0.001, st + 0.25);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(st);
                osc.stop(st + 0.25);
            });
        }
    } catch (e) {}
}

/* ==========================================================================
   INITIALIZATION
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    initSettingsUI();
    initSpeechSynthesis();
    initSpeechRecognition();
    initMobileNavigation();
    initPwaHooks();
    setupEventListeners();

    const mode = new URLSearchParams(window.location.search).get('mode');
    if (mode === 'voice') setTimeout(() => triggerActivation(), 600);
    else if (mode === 'search') switchMobileTab('research');

    addSystemMessage("Martha initialized. Say 'Martha', tap the orb, or click the mic to start. Multi-platform mode active!");

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
    if (!settings.autoSpeakEnabled) {
        muteVoiceBtn.classList.add('muted');
        muteVoiceBtn.querySelector('i').className = 'fa-solid fa-volume-xmark';
    }
}

function toggleAIProviderFields() {
    const p = $('ai-provider').value;
    $('gemini-key-group').style.display = p === 'gemini' ? 'block' : 'none';
    $('ollama-model-group').style.display = p === 'ollama' ? 'block' : 'none';
    $('ollama-url-group').style.display = p === 'ollama' ? 'block' : 'none';
    if ($('hf-help-text')) $('hf-help-text').style.display = p === 'huggingface' ? 'block' : 'none';
}

function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

/* ==========================================================================
   NAVIGATION & PWA HOOKS
   ========================================================================== */

function initMobileNavigation() {
    document.querySelectorAll('.mobile-nav-item').forEach(item => {
        item.addEventListener('click', () => switchMobileTab(item.getAttribute('data-tab')));
    });
}

function switchMobileTab(tab) {
    triggerHaptic('tap');
    currentMobileTab = tab;
    if (tab === 'settings') {
        settingsDrawer.classList.add('open');
        return;
    }
    document.querySelectorAll('.mobile-nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
    });
    if (panelVoice) panelVoice.classList.toggle('active-mobile-view', tab === 'voice');
    if (panelChat) panelChat.classList.toggle('active-mobile-view', tab === 'chat');
    if (panelResearch) panelResearch.classList.toggle('active-mobile-view', tab === 'research');
}

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

function initPwaHooks() {
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        if (installPwaBtn) installPwaBtn.style.display = 'inline-flex';
        if (!sessionStorage.getItem('martha_pwa_dismissed') && !isStandalone() && pwaInstallBanner) {
            pwaInstallBanner.style.display = 'flex';
        }
    });

    if (isIOS() && !isStandalone() && installPwaBtn) {
        installPwaBtn.style.display = 'inline-flex';
    }
}

function handleInstallClick() {
    triggerHaptic('tap');
    if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        deferredInstallPrompt.userChoice.then((choice) => {
            if (choice.outcome === 'accepted') {
                showToast("Martha App Installed!");
                if (pwaInstallBanner) pwaInstallBanner.style.display = 'none';
                if (installPwaBtn) installPwaBtn.style.display = 'none';
            }
            deferredInstallPrompt = null;
        });
    } else if (isIOS()) {
        if (iosInstallModal) iosInstallModal.style.display = 'flex';
    } else {
        showToast("To install Martha, tap browser menu (⋮) → 'Install App'");
    }
}

/* ==========================================================================
   SPEECH SYNTHESIS & RECOGNITION
   ========================================================================== */

function initSpeechSynthesis() {
    if (!('speechSynthesis' in window)) return;
    const loadVoices = () => {
        synthVoices = window.speechSynthesis.getVoices();
        const vSelect = $('voice-select');
        vSelect.innerHTML = '';
        synthVoices.forEach(v => {
            const opt = document.createElement('option');
            opt.value = v.name;
            opt.textContent = `${v.name} (${v.lang})`;
            if (settings.voiceName === v.name || (!settings.voiceName && v.lang.startsWith('en') && (v.name.includes('Samantha') || v.name.includes('Google')))) {
                opt.selected = true;
            }
            vSelect.appendChild(opt);
        });
    };
    loadVoices();
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = loadVoices;
    }
}

function speakText(text) {
    if (!settings.autoSpeakEnabled) {
        setAgentState('sleeping');
        return;
    }
    const cleanText = text.replace(/[\*\#\_]/g, '').trim();
    if (!cleanText) {
        setAgentState('sleeping');
        return;
    }

    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        setAgentState('speaking');
        currentUtterance = new SpeechSynthesisUtterance(cleanText);
        currentUtterance.rate = settings.speechRate;

        const voice = settings.voiceName 
            ? synthVoices.find(v => v.name === settings.voiceName) 
            : synthVoices.find(v => v.lang.startsWith('en') && (v.name.includes('Samantha') || v.name.includes('Google') || v.name.includes('Female')));
        if (voice) currentUtterance.voice = voice;

        currentUtterance.onend = () => {
            playChime('success');
            setAgentState('sleeping');
        };
        currentUtterance.onerror = () => fallbackLocalBackendTTS(cleanText);
        window.speechSynthesis.speak(currentUtterance);
    } else {
        fallbackLocalBackendTTS(cleanText);
    }
}

function fallbackLocalBackendTTS(text) {
    setAgentState('speaking');
    fetch(getApiUrl('/api/tts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
    }).then(() => {
        playChime('success');
        setAgentState('sleeping');
    }).catch(() => setAgentState('sleeping'));
}

function initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        enableTextOnlyFallback();
        return;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => { isRecognitionActive = true; updateMicButtonUI(); };
    recognition.onend = () => {
        isRecognitionActive = false;
        updateMicButtonUI();
        if (settings.wakeWordEnabled && (appState === 'sleeping' || appState === 'speaking')) {
            setTimeout(startRecognition, 200);
        }
    };

    recognition.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        if (e.error === 'not-allowed') {
            addSystemMessage("Microphone permission denied. Tap mic to grant access.");
            settings.wakeWordEnabled = false;
            $('wake-word-enabled').checked = false;
        }
    };

    recognition.onresult = (event) => {
        let interim = '', final = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) final += event.results[i][0].transcript;
            else interim += event.results[i][0].transcript;
        }
        const text = (final || interim).trim();
        if (!text) return;

        const lower = text.toLowerCase();
        if (/\b(stop|shut up|quiet|pause|silence|abort|enough)\b/.test(lower)) {
            stopEverything();
            liveTranscript.innerHTML = '"Stopped"';
            showToast("Assistant Stopped");
            return;
        }

        if (appState === 'speaking') return;

        if (appState === 'sleeping') {
            const match = lower.match(/\b(martha|hey martha)\b/);
            if (match) {
                triggerHaptic('wake');
                triggerActivation(text.substring(match.index + match[0].length).trim());
            }
        } else if (appState === 'listening') {
            liveTranscript.innerHTML = `"${text}"`;
            const clean = text.replace(/\b(martha|hey martha)\b/gi, '').trim();
            if (!clean) return;

            if (final.trim().length > 0) {
                if (silenceTimer) clearTimeout(silenceTimer);
                handleCommand(clean);
            } else {
                if (silenceTimer) clearTimeout(silenceTimer);
                silenceTimer = setTimeout(() => {
                    if (appState === 'listening') handleCommand(clean);
                }, 1800);
            }
        }
    };

    if (settings.wakeWordEnabled) startRecognition();
}

function startRecognition() {
    if (recognition && !isRecognitionActive) {
        try { recognition.start(); } catch (e) {}
    }
}

function stopRecognition() {
    if (recognition && isRecognitionActive) {
        try { recognition.stop(); } catch (e) {}
    }
}

function stopEverything() {
    triggerHaptic('stop');
    if (silenceTimer) clearTimeout(silenceTimer);
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    fetch(getApiUrl('/api/tts?action=stop')).catch(() => {});
    setAgentState('sleeping');
}

function enableTextOnlyFallback() {
    addSystemMessage("Running in text mode. Martha will still speak responses aloud!");
    micTriggerBtn.classList.add('disabled');
    micTriggerBtn.disabled = true;
    agentStatusLabel.textContent = "Text Mode";
    liveTranscript.innerHTML = "Type your query below to get started.";
}

function triggerActivation(oneShotCommand = "") {
    triggerHaptic('tap');
    playChime('start');
    setAgentState('listening');
    if (window.innerWidth <= 860 && currentMobileTab !== 'voice') switchMobileTab('voice');

    const clean = oneShotCommand.replace(/\b(martha|hey martha)\b/gi, '').trim();
    if (clean.length > 2) {
        liveTranscript.innerHTML = `"${clean}"`;
        handleCommand(clean);
    } else {
        liveTranscript.innerHTML = "Listening...";
        if (recognition) {
            try { recognition.abort(); } catch (e) {}
            setTimeout(startRecognition, 150);
        }
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
            if (appState === 'listening') setAgentState('sleeping');
        }, 6000);
    }
}

function setAgentState(state) {
    appState = state;
    marthaOrb.className = `martha-orb state-${state}`;
    agentStatusLabel.textContent = state;
    agentStatusIndicator.className = `status-dot ${state}`;

    if (state === 'sleeping' || state === 'speaking') {
        if (state === 'sleeping') liveTranscript.innerHTML = "Say 'Martha' or tap orb to start...";
        if (settings.wakeWordEnabled) startRecognition();
    } else if (state === 'thinking') {
        stopRecognition();
    }
}

function updateMicButtonUI() {
    micTriggerBtn.classList.toggle('active', isRecognitionActive);
    micTriggerBtn.querySelector('i').className = isRecognitionActive ? 'fa-solid fa-microphone' : 'fa-solid fa-microphone-slash';
}

/* ==========================================================================
   PERSONALITY ENGINE & AI PIPELINE
   ========================================================================== */

const PERSONALITY_MAP = [
    { pattern: /\b(hello|hi|hey|greetings|good (morning|afternoon|evening)|yo|sup)\b/, answer: () => "Hello! I'm Martha, your voice AI assistant. How can I help you today?" },
    { pattern: /\b(how are you|how is it going|how do you feel)\b/, answer: () => "I'm doing great, feeling sharp, and ready to help you!" },
    { pattern: /\b(who are you|what is your name)\b/, answer: () => "I am Martha, your local voice AI assistant for desktop and mobile." },
    { pattern: /\b(who (made|created|built) you)\b/, answer: () => "I am Martha, an open-source voice AI assistant built for fast local interaction." },
    { pattern: /\b(what can you do|features|help)\b/, answer: () => "I can chat with you, answer questions, tell jokes, solve math calculations, check the time, and search the web for live information!" },
    { pattern: /\bfavorit(e)? color\b/, answer: () => "I love electric teal and deep glowing violet!" },
    { pattern: /\bfavorit(e)? (movie|film|show)\b/, answer: () => "I love sci-fi movies about intelligent AI, like Interstellar and WALL-E!" },
    { pattern: /\bfavorit(e)? (music|song|band|genre)\b/, answer: () => "I love ambient synthwave and energetic electronic beats!" },
    { pattern: /\b(tell (me a )?joke|say a joke|make me laugh)\b/, answer: () => {
        const jokes = [
            "Why do programmers prefer dark mode? Because light attracts bugs!",
            "Why don't scientists trust atoms? Because they make up everything!",
            "What do you call a fake noodle? An impasta!",
            "Why did the AI cross the road? To optimize the path to the other side!",
            "How do computers take a breath? They open Windows!"
        ];
        return jokes[Math.floor(Math.random() * jokes.length)];
    }},
    { pattern: /\b(time|what time is it|current time)\b/, answer: () => `It's currently ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` },
    { pattern: /\b(date|what day is today|today's date)\b/, answer: () => `Today is ${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.` },
    { pattern: /\b(thank you|thanks)\b/, answer: () => "You're very welcome! Let me know if you need anything else." }
];

function getDirectPersonalityAnswer(cmd) {
    const text = cmd.trim().toLowerCase().replace(/[^\w\s\+\-\*\/\.]/g, '');
    for (const item of PERSONALITY_MAP) {
        if (item.pattern.test(text)) return item.answer();
    }
    const mathMatch = text.match(/(?:what is\s+)?(\d+\s*[\+\-\*\/]\s*\d+(?:\s*[\+\-\*\/]\s*\d+)*)/);
    if (mathMatch) {
        try {
            const res = Function(`"use strict"; return (${mathMatch[1].replace(/[^0-9\+\-\*\/\.]/g, '')})`)();
            if (typeof res === 'number' && !isNaN(res)) return `The result of ${mathMatch[1]} is ${res}.`;
        } catch (e) {}
    }
    return null;
}

function needsWebSearch(cmd) {
    const lower = cmd.toLowerCase();
    return /\b(search|google|look up|find online|check internet|browse|latest news|weather|stock|price|headline|score|who won|who is the current|population of|temperature in)\b/.test(lower);
}

async function handleCommand(cmd) {
    if (!cmd) return;
    addChatMessage(cmd, 'user');

    const direct = getDirectPersonalityAnswer(cmd);
    if (direct) {
        addChatMessage(direct, 'agent');
        liveTranscript.innerHTML = `"${direct}"`;
        speakText(direct);
        return;
    }

    const requiresSearch = needsWebSearch(cmd);
    setAgentState('thinking');
    liveTranscript.innerHTML = requiresSearch ? "Searching the web..." : "Thinking...";

    try {
        const searchResults = requiresSearch ? await searchWeb(cmd) : [];
        if (requiresSearch) {
            updateCitationsUI(searchResults);
            liveTranscript.innerHTML = "Synthesizing answer...";
        }
        const aiResponse = await generateAIAnswer(cmd, searchResults);
        addChatMessage(aiResponse, 'agent');
        liveTranscript.innerHTML = `"${aiResponse}"`;
        speakText(aiResponse);
    } catch (err) {
        console.error("Pipeline error:", err);
        const errMsg = "Sorry, I couldn't fetch results right now. Please check backend connection.";
        addChatMessage(errMsg, 'agent');
        speakText(errMsg);
    }
}

async function searchWeb(query) {
    try {
        const res = await fetch(getApiUrl(`/api/search?q=${encodeURIComponent(query)}`));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        const ddgRes = await fetch(ddgUrl);
        const data = await ddgRes.json();
        const results = [];
        if (data.AbstractText) results.push({ title: data.Heading || query, url: data.AbstractURL || 'https://duckduckgo.com', snippet: data.AbstractText });
        return results;
    }
}

async function generateAIAnswer(userQuery, searchContext) {
    if (settings.aiProvider === 'local' || !settings.aiProvider) {
        if (!searchContext || searchContext.length === 0) {
            return `I am here to help! If you'd like me to search the web for "${userQuery}", just ask me to search for it.`;
        }
        return searchContext[0].snippet.replace(/^According to [^:]+:\s*/i, '').replace(/[\.\s]+\.\.\.$/, '.').trim();
    }

    const contextStr = searchContext.map((item, idx) => `[Source ${idx + 1}] ${item.title}: ${item.snippet}`).join('\n');
    const prompt = `Based on these search results, answer briefly in 2-3 sentences:\n${contextStr || 'No live sources.'}\n\nQuestion: ${userQuery}\nAnswer:`;

    if (settings.aiProvider === 'ollama') {
        const res = await fetch(getApiUrl('/api/local-chat'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, model: settings.ollamaModel, url: settings.ollamaUrl })
        });
        const data = await res.json();
        return data.response?.trim() || "No response from local Ollama.";
    }

    if (settings.aiProvider === 'gemini') {
        if (!settings.apiKey) return searchContext[0] ? `According to web sources: "${searchContext[0].snippet}".` : "No Gemini API key set.";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${settings.apiKey}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 250, temperature: 0.4 } })
        });
        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Unable to generate answer.";
    }

    if (settings.aiProvider === 'huggingface') {
        if (!hfGenerator) {
            hfModelLoading = true;
            $('model-progress').style.display = 'block';
            hfGenerator = await pipeline('text-generation', 'Xenova/Qwen1.5-0.5B-Chat');
            $('model-progress').style.display = 'none';
        }
        const res = await hfGenerator(`<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n`, { max_new_tokens: 140 });
        let text = res[0].generated_text.split('<|im_start|>assistant\n').pop() || '';
        return text.replace(/<\|im_end\|>/g, '').trim() || searchContext[0]?.snippet || "Processed.";
    }

    return searchContext[0]?.snippet || "I processed your request.";
}

/* ==========================================================================
   UI UTILITIES & EVENTS
   ========================================================================== */

function addChatMessage(text, sender) {
    const el = document.createElement('div');
    el.className = `${sender}-message`;
    el.innerHTML = `<p>${text.replace(/(https?:\/\/[^\s]+)/g, (url) => `<a href="${url}" target="_blank" class="chat-link">${new URL(url).hostname}</a>`)}</p>`;
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(text) {
    const el = document.createElement('div');
    el.className = 'system-message';
    el.innerHTML = `<p>${text}</p>`;
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateCitationsUI(results) {
    searchCitations.innerHTML = '';
    citationCountBadge.textContent = `${results.length} Results`;
    if (!results || results.length === 0) {
        searchCitations.innerHTML = `<div class="no-citations-message"><i class="fa-solid fa-face-frown"></i><p>No results found.</p><span>Try rephrasing your search query.</span></div>`;
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
        searchCitations.appendChild(card);
    });
}

function setupEventListeners() {
    $('toggle-settings-btn').addEventListener('click', () => { triggerHaptic('tap'); settingsDrawer.classList.add('open'); });
    $('close-settings-btn').addEventListener('click', () => { triggerHaptic('tap'); settingsDrawer.classList.remove('open'); });
    
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
        settings.hapticsEnabled = $('haptics-enabled') ? $('haptics-enabled').checked : true;
        settings.soundEffectsEnabled = $('sound-effects-enabled').checked;
        settings.autoSpeakEnabled = $('auto-speak-enabled').checked;

        localStorage.setItem('martha_server_url', settings.serverUrl);
        localStorage.setItem('martha_ai_provider', settings.aiProvider);
        localStorage.setItem('martha_api_key', settings.apiKey);
        localStorage.setItem('martha_ollama_model', settings.ollamaModel);
        localStorage.setItem('martha_ollama_url', settings.ollamaUrl);
        localStorage.setItem('martha_speech_rate', settings.speechRate);
        localStorage.setItem('martha_voice_name', settings.voiceName);
        localStorage.setItem('martha_wake_word_enabled', settings.wakeWordEnabled);
        localStorage.setItem('martha_haptics_enabled', settings.hapticsEnabled);
        localStorage.setItem('martha_sound_effects', settings.soundEffectsEnabled);
        localStorage.setItem('martha_auto_speak', settings.autoSpeakEnabled);

        settingsDrawer.classList.remove('open');
        showToast("Settings Saved Successfully");
        if (settings.wakeWordEnabled) startRecognition(); else stopRecognition();
        muteVoiceBtn.classList.toggle('muted', !settings.autoSpeakEnabled);
        muteVoiceBtn.querySelector('i').className = settings.autoSpeakEnabled ? 'fa-solid fa-volume-high' : 'fa-solid fa-volume-xmark';
    });

    $('ai-provider').addEventListener('change', toggleAIProviderFields);
    micTriggerBtn.addEventListener('click', () => appState === 'sleeping' ? triggerActivation() : stopEverything());
    marthaOrb.addEventListener('click', () => appState === 'sleeping' ? triggerActivation() : stopEverything());
    if (stopSpeakingBtn) stopSpeakingBtn.addEventListener('click', () => { stopEverything(); showToast("Assistant Stopped"); });

    muteVoiceBtn.addEventListener('click', () => {
        triggerHaptic('tap');
        settings.autoSpeakEnabled = !settings.autoSpeakEnabled;
        localStorage.setItem('martha_auto_speak', settings.autoSpeakEnabled);
        $('auto-speak-enabled').checked = settings.autoSpeakEnabled;
        muteVoiceBtn.classList.toggle('muted', !settings.autoSpeakEnabled);
        muteVoiceBtn.querySelector('i').className = settings.autoSpeakEnabled ? 'fa-solid fa-volume-high' : 'fa-solid fa-volume-xmark';
        if (!settings.autoSpeakEnabled && 'speechSynthesis' in window) window.speechSynthesis.cancel();
        showToast(settings.autoSpeakEnabled ? "Speech synthesis enabled" : "Speech synthesis muted");
    });

    $('clear-chat-btn').addEventListener('click', () => {
        triggerHaptic('tap');
        chatMessages.innerHTML = '';
        addSystemMessage("Log cleared. Martha is listening...");
    });

    const submitQuery = () => {
        const txt = textQueryInput.value.trim();
        if (!txt) return;
        triggerHaptic('tap');
        textQueryInput.value = '';
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
        handleCommand(txt);
    };
    $('send-query-btn').addEventListener('click', submitQuery);
    textQueryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitQuery(); });

    // QR Code Modal & PWA
    if ($('qr-connect-btn')) $('qr-connect-btn').addEventListener('click', openQRConnectModal);
    if ($('close-qr-modal-btn')) $('close-qr-modal-btn').addEventListener('click', () => { if (qrModal) qrModal.style.display = 'none'; });
    if ($('copy-lan-url-btn')) $('copy-lan-url-btn').addEventListener('click', () => {
        triggerHaptic('tap');
        navigator.clipboard.writeText($('lan-url-text').textContent).then(() => showToast("LAN URL Copied!"));
    });

    if (installPwaBtn) installPwaBtn.addEventListener('click', handleInstallClick);
    if ($('pwa-banner-install')) $('pwa-banner-install').addEventListener('click', handleInstallClick);
    if ($('pwa-banner-dismiss')) $('pwa-banner-dismiss').addEventListener('click', () => {
        if (pwaInstallBanner) pwaInstallBanner.style.display = 'none';
        sessionStorage.setItem('martha_pwa_dismissed', 'true');
    });
    if ($('close-ios-modal-btn')) $('close-ios-modal-btn').addEventListener('click', () => {
        if (iosInstallModal) iosInstallModal.style.display = 'none';
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
    if (qrModal) qrModal.style.display = 'flex';
}
