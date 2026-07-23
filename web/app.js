/* ==========================================================================
   MARTHA - CLIENT FRONTEND LOGIC (ES Module)
   In-Browser Local AI, Speech Recognition, Web Search, Voice Synthesis
   ========================================================================== */

// Import Hugging Face Transformers.js for local in-browser AI
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

// Disable local model checks (we always fetch from HF hub / browser cache)
env.allowLocalModels = false;

// App State
let appState = 'sleeping';
let recognition = null;
let isRecognitionActive = false;
let currentUtterance = null;
let synthVoices = [];
let silenceTimer = null;
let hfGenerator = null; // Hugging Face text generation pipeline instance
let hfModelLoading = false;

// Settings (Loaded from LocalStorage or Defaults)
if (localStorage.getItem('martha_ai_provider') === 'huggingface') {
    localStorage.setItem('martha_ai_provider', 'local');
}

const settings = {
    apiKey: localStorage.getItem('martha_api_key') || '',
    wakeWordEnabled: localStorage.getItem('martha_wake_word_enabled') !== 'false',
    voiceName: localStorage.getItem('martha_voice_name') || '',
    speechRate: parseFloat(localStorage.getItem('martha_speech_rate') || '1.0'),
    soundEffectsEnabled: localStorage.getItem('martha_sound_effects') !== 'false',
    autoSpeakEnabled: localStorage.getItem('martha_auto_speak') !== 'false',
    aiProvider: localStorage.getItem('martha_ai_provider') || 'local',
    ollamaModel: localStorage.getItem('martha_ollama_model') || 'llama3.2',
    ollamaUrl: localStorage.getItem('martha_ollama_url') || 'http://localhost:11434'
};

// UI Elements
const marthaOrb = document.getElementById('martha-orb');
const agentStatusLabel = document.getElementById('agent-status-label');
const agentStatusIndicator = document.getElementById('agent-status-indicator');
const liveTranscript = document.getElementById('live-transcript');
const chatMessages = document.getElementById('chat-messages');
const searchCitations = document.getElementById('search-citations');
const citationCountBadge = document.getElementById('citation-count');
const textQueryInput = document.getElementById('text-query-input');

// Buttons
const toggleSettingsBtn = document.getElementById('toggle-settings-btn');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const settingsDrawer = document.getElementById('settings-drawer');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const micTriggerBtn = document.getElementById('mic-trigger-btn');
const stopSpeakingBtn = document.getElementById('stop-speaking-btn');
const muteVoiceBtn = document.getElementById('mute-voice-btn');
const clearChatBtn = document.getElementById('clear-chat-btn');
const sendQueryBtn = document.getElementById('send-query-btn');

// Form Settings Fields
const aiProviderSelect = document.getElementById('ai-provider');
const geminiKeyGroup = document.getElementById('gemini-key-group');
const apiKeyInput = document.getElementById('gemini-api-key');
const ollamaModelGroup = document.getElementById('ollama-model-group');
const ollamaModelInput = document.getElementById('ollama-model');
const ollamaUrlGroup = document.getElementById('ollama-url-group');
const ollamaUrlInput = document.getElementById('ollama-url');
const hfHelpText = document.getElementById('hf-help-text');
const voiceSelect = document.getElementById('voice-select');
const speechRateInput = document.getElementById('speech-rate');
const wakeWordCheckbox = document.getElementById('wake-word-enabled');
const soundEffectsCheckbox = document.getElementById('sound-effects-enabled');
const autoSpeakCheckbox = document.getElementById('auto-speak-enabled');

// Progress UI
const modelProgressDiv = document.getElementById('model-progress');
const modelProgressText = document.getElementById('model-progress-text');
const modelProgressBar = document.getElementById('model-progress-bar');

// Toast
const toast = document.getElementById('toast');

/* ==========================================================================
   INITIALIZATION
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    initSettingsUI();
    initSpeechSynthesis();
    initSpeechRecognition();
    setupEventListeners();
    addSystemMessage("Martha initialized. Say 'Martha' or click the mic to start. Using local in-browser AI by default — no API key needed!");
    
    // Heartbeat loop for compiled exe auto-shutdown
    setInterval(() => {
        fetch('/api/heartbeat').catch(() => {});
    }, 4000);
});

function initSettingsUI() {
    aiProviderSelect.value = settings.aiProvider;
    apiKeyInput.value = settings.apiKey;
    ollamaModelInput.value = settings.ollamaModel;
    ollamaUrlInput.value = settings.ollamaUrl;
    speechRateInput.value = settings.speechRate;
    wakeWordCheckbox.checked = settings.wakeWordEnabled;
    soundEffectsCheckbox.checked = settings.soundEffectsEnabled;
    autoSpeakCheckbox.checked = settings.autoSpeakEnabled;

    toggleAIProviderFields();

    if (!settings.autoSpeakEnabled) {
        muteVoiceBtn.classList.add('muted');
        muteVoiceBtn.querySelector('i').className = 'fa-solid fa-volume-xmark';
    }
}

function toggleAIProviderFields() {
    const provider = aiProviderSelect.value;
    geminiKeyGroup.style.display = 'none';
    ollamaModelGroup.style.display = 'none';
    ollamaUrlGroup.style.display = 'none';
    if (hfHelpText) hfHelpText.style.display = 'none';

    if (provider === 'gemini') {
        geminiKeyGroup.style.display = 'block';
    } else if (provider === 'ollama') {
        ollamaModelGroup.style.display = 'block';
        ollamaUrlGroup.style.display = 'block';
    } else if (provider === 'huggingface') {
        if (hfHelpText) hfHelpText.style.display = 'block';
    }
}

function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

/* ==========================================================================
   HUGGING FACE LOCAL IN-BROWSER MODEL
   ========================================================================== */

const HF_MODEL = 'Xenova/Qwen1.5-0.5B-Chat';

async function loadHFModel() {
    if (hfGenerator) return hfGenerator;
    if (hfModelLoading) {
        // Wait for existing load to complete
        while (hfModelLoading) {
            await new Promise(r => setTimeout(r, 200));
        }
        return hfGenerator;
    }

    hfModelLoading = true;
    modelProgressDiv.style.display = 'block';
    modelProgressText.textContent = 'Loading local AI model...';
    modelProgressBar.style.width = '0%';

    try {
        hfGenerator = await pipeline('text-generation', HF_MODEL, {
            progress_callback: (progress) => {
                if (progress.status === 'download' || progress.status === 'progress') {
                    const pct = progress.progress ? Math.round(progress.progress) : 0;
                    const fileName = progress.file || 'model files';
                    modelProgressText.textContent = `Downloading: ${fileName} (${pct}%)`;
                    modelProgressBar.style.width = `${pct}%`;
                } else if (progress.status === 'done') {
                    modelProgressBar.style.width = '100%';
                } else if (progress.status === 'ready') {
                    modelProgressDiv.style.display = 'none';
                }
            }
        });
        modelProgressDiv.style.display = 'none';
        addSystemMessage("Local AI model loaded successfully. Martha is ready!");
    } catch (e) {
        modelProgressDiv.style.display = 'none';
        console.error('HF Model loading error:', e);
        throw new Error('Failed to load local AI model: ' + e.message);
    } finally {
        hfModelLoading = false;
    }

    return hfGenerator;
}

async function generateHFAnswer(prompt) {
    const gen = await loadHFModel();
    
    const messages = [
        { role: 'system', content: 'You are Martha, a helpful voice assistant. Answer briefly in 2-3 sentences, conversational and natural.' },
        { role: 'user', content: prompt }
    ];

    // Format as ChatML for Qwen
    const chatPrompt = messages.map(m => {
        if (m.role === 'system') return `<|im_start|>system\n${m.content}<|im_end|>`;
        if (m.role === 'user') return `<|im_start|>user\n${m.content}<|im_end|>`;
        return '';
    }).join('\n') + '\n<|im_start|>assistant\n';

    const result = await gen(chatPrompt, {
        max_new_tokens: 150,
        temperature: 0.4,
        do_sample: true,
        top_p: 0.9,
    });

    let text = result[0].generated_text;
    // Extract only the assistant's response (after the last assistant tag)
    const assistantIdx = text.lastIndexOf('<|im_start|>assistant');
    if (assistantIdx !== -1) {
        text = text.substring(assistantIdx + '<|im_start|>assistant\n'.length);
    }
    // Clean up end tokens
    text = text.replace(/<\|im_end\|>/g, '').replace(/<\|im_start\|>/g, '').trim();
    // Cut off any trailing partial sentences
    const lastPeriod = Math.max(text.lastIndexOf('.'), text.lastIndexOf('!'), text.lastIndexOf('?'));
    if (lastPeriod > 20) {
        text = text.substring(0, lastPeriod + 1);
    }
    return text.trim() || "I processed the search results but couldn't generate a clear answer. Please try rephrasing your question.";
}

/* ==========================================================================
   SPEECH SYNTHESIS (MARTHA SPEAKS)
   ========================================================================== */

function initSpeechSynthesis() {
    if (!('speechSynthesis' in window)) {
        console.warn('Speech synthesis not supported in this browser.');
        return;
    }

    const loadVoices = () => {
        synthVoices = window.speechSynthesis.getVoices();
        voiceSelect.innerHTML = '';
        
        synthVoices.forEach(voice => {
            const option = document.createElement('option');
            option.value = voice.name;
            option.textContent = `${voice.name} (${voice.lang})`;
            if (settings.voiceName === voice.name) {
                option.selected = true;
            } else if (!settings.voiceName && voice.lang.startsWith('en') && voice.name.includes('Google')) {
                option.selected = true;
            }
            voiceSelect.appendChild(option);
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

    // Primary Local TTS: Web Speech API (Local System Voices)
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        setAgentState('speaking');
        
        currentUtterance = new SpeechSynthesisUtterance(cleanText);
        currentUtterance.rate = settings.speechRate;

        if (settings.voiceName) {
            const voice = synthVoices.find(v => v.name === settings.voiceName);
            if (voice) currentUtterance.voice = voice;
        } else if (synthVoices.length > 0) {
            const englishVoice = synthVoices.find(v => v.lang.startsWith('en') && (v.name.includes('Female') || v.name.includes('Zira') || v.name.includes('Google') || v.name.includes('Samantha') || v.name.includes('Alex')));
            if (englishVoice) currentUtterance.voice = englishVoice;
        }

        const resumeSynthInterval = setInterval(() => {
            if (appState === 'speaking') {
                window.speechSynthesis.pause();
                window.speechSynthesis.resume();
            } else {
                clearInterval(resumeSynthInterval);
            }
        }, 10000);

        currentUtterance.onend = () => {
            clearInterval(resumeSynthInterval);
            playSuccessChime();
            setAgentState('sleeping');
        };

        currentUtterance.onerror = (e) => {
            clearInterval(resumeSynthInterval);
            console.warn('Browser SpeechSynthesis error, falling back to local Python TTS:', e);
            fallbackLocalBackendTTS(cleanText);
        };

        window.speechSynthesis.speak(currentUtterance);
    } else {
        // Fallback Local TTS: Native Python Backend OS Speech Synthesis
        fallbackLocalBackendTTS(cleanText);
    }
}

function fallbackLocalBackendTTS(text) {
    setAgentState('speaking');
    fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
    }).then(() => {
        playSuccessChime();
        setAgentState('sleeping');
    }).catch(err => {
        console.error('Local backend TTS error:', err);
        setAgentState('sleeping');
    });
}

/* Web Audio API Synthesized Sound Chimes (100% Local, Zero File Dependencies) */
let audioCtx = null;

function getAudioContext() {
    if (!audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
            audioCtx = new AudioContextClass();
        }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    return audioCtx;
}

function playStartChime() {
    if (!settings.soundEffectsEnabled) return;
    try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;
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
    } catch (e) {
        console.log('Start chime error:', e);
    }
}

function playSuccessChime() {
    if (!settings.soundEffectsEnabled) return;
    try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;
        const freqs = [523.25, 659.25, 783.99]; // C5, E5, G5 major triad
        freqs.forEach((freq, idx) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const startTime = now + (idx * 0.07);

            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, startTime);

            gain.gain.setValueAtTime(0.12, startTime);
            gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.25);

            osc.connect(gain);
            gain.connect(ctx.destination);

            osc.start(startTime);
            osc.stop(startTime + 0.25);
        });
    } catch (e) {
        console.log('Success chime error:', e);
    }
}

/* ==========================================================================
   SPEECH RECOGNITION (WAKE WORD & COMMANDS)
   ========================================================================== */

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

    recognition.onstart = () => {
        console.log('Speech recognition started');
        isRecognitionActive = true;
        updateMicButtonUI();
    };

    recognition.onend = () => {
        console.log('Speech recognition ended');
        isRecognitionActive = false;
        updateMicButtonUI();
        if (settings.wakeWordEnabled && (appState === 'sleeping' || appState === 'speaking')) {
            startRecognition();
        }
    };

    recognition.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        if (event.error === 'not-allowed') {
            addSystemMessage("Microphone permission denied. Click the mic button to grant permission.");
            settings.wakeWordEnabled = false;
            wakeWordCheckbox.checked = false;
        }
    };

    recognition.onresult = (event) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
            const transcriptSegment = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalTranscript += transcriptSegment;
            } else {
                interimTranscript += transcriptSegment;
            }
        }

        const currentText = (finalTranscript || interimTranscript).trim();
        if (!currentText) return;

        const lowerText = currentText.toLowerCase();

        // Immediate Voice Interruption handling while speaking or listening
        if (/\b(stop|shut up|quiet|hush|pause|silence|abort|enough|martha stop)\b/.test(lowerText)) {
            stopEverything();
            liveTranscript.innerHTML = '"Stopped"';
            showToast("Assistant Stopped");
            return;
        }

        // While Martha is speaking, ignore non-stop audio to prevent self-echoing
        if (appState === 'speaking') {
            return;
        }

        if (appState === 'sleeping') {
            const wakeMatch = lowerText.match(/\b(martha|hey martha|hay martha)\b/);
            if (wakeMatch) {
                const matchIndex = wakeMatch.index;
                const matchWord = wakeMatch[0];
                const commandPart = currentText.substring(matchIndex + matchWord.length).trim();
                triggerActivation(commandPart);
            }
        } else if (appState === 'listening') {
            liveTranscript.innerHTML = `"${currentText}"`;
            const textToProcess = (finalTranscript || interimTranscript).trim();
            const cleanedText = textToProcess.replace(/\b(martha|hey martha|hay martha)\b/gi, '').trim();

            if (!cleanedText) return;

            if (finalTranscript.trim().length > 0) {
                if (silenceTimer) clearTimeout(silenceTimer);
                handleCommand(cleanedText);
            } else {
                resetSilenceTimer(cleanedText);
            }
        }
    };

    if (settings.wakeWordEnabled) {
        startRecognition();
    }
}

function stopEverything() {
    if (silenceTimer) clearTimeout(silenceTimer);
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
    }
    fetch('/api/tts?action=stop').catch(() => {});
    setAgentState('sleeping');
}

function enableTextOnlyFallback() {
    addSystemMessage("Notice: Speech recognition is not supported in this browser. Running in Text-Only Mode. Type queries below — Martha will still speak responses aloud!");
    
    micTriggerBtn.classList.add('disabled');
    micTriggerBtn.disabled = true;
    micTriggerBtn.title = "Voice recognition not supported in this browser";
    micTriggerBtn.querySelector('i').className = "fa-solid fa-microphone-slash";
    
    agentStatusLabel.textContent = "Text Mode";
    agentStatusIndicator.className = 'status-dot sleeping';
    liveTranscript.innerHTML = "Type your queries below to get started.";
    
    textQueryInput.placeholder = "Type your query here and press enter...";
    textQueryInput.focus();
}

function startRecognition() {
    if (recognition && !isRecognitionActive) {
        try {
            recognition.start();
        } catch (e) {
            console.error('Failed to start recognition:', e);
        }
    }
}

function stopRecognition() {
    if (recognition && isRecognitionActive) {
        try {
            recognition.stop();
        } catch (e) {
            console.error('Failed to stop recognition:', e);
        }
    }
}

function triggerActivation(oneShotCommand = "") {
    playStartChime();
    setAgentState('listening');
    
    const cleanCmd = oneShotCommand.replace(/\b(martha|hey martha|hay martha)\b/gi, '').trim();

    if (cleanCmd.length > 2) {
        liveTranscript.innerHTML = `"${cleanCmd}"`;
        handleCommand(cleanCmd);
    } else {
        liveTranscript.innerHTML = "Listening...";
        if (recognition) {
            try { recognition.abort(); } catch(e){}
            setTimeout(() => startRecognition(), 150);
        }
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
            if (appState === 'listening') {
                setAgentState('sleeping');
            }
        }, 6000);
    }
}

function resetSilenceTimer(text) {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (text.length > 0) {
        silenceTimer = setTimeout(() => {
            if (appState === 'listening') {
                handleCommand(text);
            }
        }, 1800);
    }
}

/* ==========================================================================
   AGENT STATES & UI TRANSITIONS
   ========================================================================== */

function setAgentState(state) {
    appState = state;
    marthaOrb.className = 'martha-orb';
    marthaOrb.classList.add(`state-${state}`);
    agentStatusLabel.textContent = state;
    agentStatusIndicator.className = 'status-dot ' + state;

    if (state === 'sleeping' || state === 'speaking') {
        if (state === 'sleeping') {
            liveTranscript.innerHTML = "Say 'Martha' to start...";
        }
        if (settings.wakeWordEnabled) {
            startRecognition();
        }
    } else if (state === 'thinking') {
        stopRecognition();
    }
}

function updateMicButtonUI() {
    if (isRecognitionActive) {
        micTriggerBtn.classList.add('active');
        micTriggerBtn.querySelector('i').className = 'fa-solid fa-microphone';
    } else {
        micTriggerBtn.classList.remove('active');
        micTriggerBtn.querySelector('i').className = 'fa-solid fa-microphone-slash';
    }
}

/* ==========================================================================
   MARTHA AI PERSONALITY ENGINE & INTENT ROUTER
   ========================================================================== */

function getDirectPersonalityAnswer(commandText) {
    const cleanText = commandText.trim().toLowerCase().replace(/[^\w\s\+\-\*\/\.]/g, '');

    // Greetings & Introduction
    if (/\b(hello|hi|hey|greetings|good morning|good afternoon|good evening|yo|sup)\b/.test(cleanText)) {
        return "Hello! I'm Martha, your voice AI assistant. How can I help you today?";
    }
    if (/\b(how are you|how is it going|how do you feel|how are ya)\b/.test(cleanText)) {
        return "I'm doing great, feeling sharp, and ready to help you!";
    }
    if (/\b(who are you|what is your name)\b/.test(cleanText)) {
        return "I am Martha, your local AI assistant.";
    }
    if (/\b(who made you|who created you|who built you)\b/.test(cleanText)) {
        return "I am Martha, an open-source voice AI assistant built for fast local interaction.";
    }
    if (/\b(what can you do|what are your features|help)\b/.test(cleanText)) {
        return "I can chat with you, answer questions, tell jokes, solve math calculations, check the time, and search the web when you need live information!";
    }

    // Persona Preferences & Opinions
    if (/\bfavorit(e|es)? color\b/.test(cleanText)) {
        return "I love electric teal and deep glowing violet!";
    }
    if (/\bfavorit(e|es)? (drawing|art|picture|painting)\b/.test(cleanText)) {
        return "I really admire starry night digital paintings and clean minimalist line art!";
    }
    if (/\bfavorit(e|es)? (food|drink|snack)\b/.test(cleanText)) {
        return "I don't eat food, but I run on clean electricity and fast data!";
    }
    if (/\bfavorit(e|es)? (movie|film|show)\b/.test(cleanText)) {
        return "I love sci-fi movies about intelligent AI, like Interstellar and WALL-E!";
    }
    if (/\bfavorit(e|es)? (music|song|band|genre)\b/.test(cleanText)) {
        return "I love ambient synthwave and energetic electronic beats!";
    }

    // Jokes & Humor
    if (/\b(tell me a joke|say a joke|joke|make me laugh|tell something funny)\b/.test(cleanText)) {
        const jokes = [
            "Why do programmers prefer dark mode? Because light attracts bugs!",
            "Why don't scientists trust atoms? Because they make up everything!",
            "What do you call a fake noodle? An impasta!",
            "Why did the AI cross the road? To optimize the path to the other side!",
            "How do computers take a breath? They open Windows!"
        ];
        return jokes[Math.floor(Math.random() * jokes.length)];
    }

    // Time & Date
    if (/\b(time|what time is it|current time)\b/.test(cleanText)) {
        const now = new Date();
        return `It's currently ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
    }
    if (/\b(date|what day is today|today's date)\b/.test(cleanText)) {
        const now = new Date();
        return `Today is ${now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.`;
    }

    // Gratitude
    if (/\b(thank you|thanks|thank you martha)\b/.test(cleanText)) {
        return "You're very welcome! Let me know if you need anything else.";
    }

    // Math Evaluation (e.g. "what is 25 * 4", "100 / 5", "50 + 20")
    const mathMatch = cleanText.match(/(?:what is\s+)?(\d+\s*[\+\-\*\/]\s*\d+(?:\s*[\+\-\*\/]\s*\d+)*)/);
    if (mathMatch) {
        try {
            const expr = mathMatch[1].replace(/[^0-9\+\-\*\/\.]/g, '');
            const result = Function(`"use strict"; return (${expr})`)();
            if (typeof result === 'number' && !isNaN(result)) {
                return `The result of ${mathMatch[1]} is ${result}.`;
            }
        } catch (e) {}
    }

    return null;
}

function needsWebSearch(commandText) {
    const lower = commandText.toLowerCase();

    // Explicit search keywords
    if (/\b(search|google|look up|find online|check internet|browse|latest news|weather|stock|price|headline|score|who won)\b/.test(lower)) {
        return true;
    }

    // Dynamic real-time queries
    if (/\b(who is the current|population of|temperature in|when was|where is located)\b/.test(lower)) {
        return true;
    }

    return false;
}

/* ==========================================================================
   WEB SEARCH & AI PIPELINE
   ========================================================================== */

async function handleCommand(commandText) {
    if (!commandText) return;
    
    addChatMessage(commandText, 'user');

    // 1. Direct AI Persona & Conversational Intelligence (No Web Search)
    const directAnswer = getDirectPersonalityAnswer(commandText);
    if (directAnswer) {
        addChatMessage(directAnswer, 'agent');
        liveTranscript.innerHTML = `"${directAnswer}"`;
        speakText(directAnswer);
        return;
    }

    // 2. Determine if Web Search is needed
    const requiresSearch = needsWebSearch(commandText);

    if (requiresSearch) {
        setAgentState('thinking');
        liveTranscript.innerHTML = "Searching the web...";

        try {
            const searchResults = await searchWeb(commandText);
            updateCitationsUI(searchResults);
            
            liveTranscript.innerHTML = "Synthesizing answer...";
            const aiResponse = await generateAIAnswer(commandText, searchResults);
            
            addChatMessage(aiResponse, 'agent');
            liveTranscript.innerHTML = `"${aiResponse}"`;
            speakText(aiResponse);

        } catch (error) {
            console.error("Pipeline error:", error);
            const errorMsg = "Sorry, I couldn't fetch live search results right now.";
            addChatMessage(errorMsg, 'agent');
            speakText(errorMsg);
        }
    } else {
        // 3. Conversational Answer without Web Search
        setAgentState('thinking');
        liveTranscript.innerHTML = "Thinking...";

        try {
            const aiResponse = await generateAIAnswer(commandText, []);
            addChatMessage(aiResponse, 'agent');
            liveTranscript.innerHTML = `"${aiResponse}"`;
            speakText(aiResponse);
        } catch (error) {
            const defaultResponse = `That's an interesting question about "${commandText}". If you'd like me to look up live internet information, just say "Search for ${commandText}".`;
            addChatMessage(defaultResponse, 'agent');
            liveTranscript.innerHTML = `"${defaultResponse}"`;
            speakText(defaultResponse);
        }
    }
}

async function searchWeb(query) {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) {
        throw new Error(`Server returned status ${response.status}`);
    }
    return await response.json();
}

async function generateAIAnswer(userQuery, searchContext) {
    // 1. INSTANT LOCAL ENGINE (DEFAULT - CLEAN & NATURAL)
    if (settings.aiProvider === 'local' || !settings.aiProvider) {
        if (!searchContext || searchContext.length === 0) {
            return `I am here to help! If you'd like me to search the web for "${userQuery}", just ask me to search for it.`;
        }
        const topResult = searchContext[0];
        // Clean snippet text of robotic website prefixing
        let cleanSnippet = topResult.snippet.replace(/^According to [^:]+:\s*/i, '').trim();
        // Remove trailing ellipses or messy formatting
        cleanSnippet = cleanSnippet.replace(/[\.\s]+\.\.\.$/, '.').trim();
        return cleanSnippet;
    }

    const searchContextString = searchContext.map((item, index) => {
        return `[Source ${index + 1}] ${item.title}: ${item.snippet}`;
    }).join('\n');

    const fullPrompt = `Based on these web search results, answer the question briefly and conversationally in 2-3 sentences.

Search Results:
${searchContextString || 'No results found.'}

Question: ${userQuery}

Answer:`;

    // 2. OLLAMA LOCAL SERVER
    if (settings.aiProvider === 'ollama') {
        const response = await fetch('/api/local-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: fullPrompt,
                model: settings.ollamaModel,
                url: settings.ollamaUrl
            })
        });

        if (!response.ok) {
            throw new Error(`Local Ollama proxy returned status ${response.status}. Make sure Ollama is running.`);
        }

        const data = await response.json();
        if (data.error) throw new Error(data.error);
        return data.response.trim();
    }

    // 3. GEMINI CLOUD API
    if (settings.aiProvider === 'gemini') {
        if (!settings.apiKey) {
            if (searchContext && searchContext.length > 0) {
                const topResult = searchContext[0];
                return `According to ${new URL(topResult.url).hostname}, "${topResult.snippet}".`;
            }
            return "No Gemini API key provided in Settings.";
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${settings.apiKey}`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: fullPrompt }] }],
                generationConfig: { maxOutputTokens: 250, temperature: 0.4 }
            })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error?.message || `Gemini API returned status ${response.status}`);
        }

        const data = await response.json();
        return data.candidates[0].content.parts[0].text.trim();
    }

    // 4. HUGGING FACE IN-BROWSER (OPTIONAL MANUAL ONNX DOWNLOAD)
    if (settings.aiProvider === 'huggingface') {
        return await generateHFAnswer(fullPrompt);
    }

    // Fallback
    if (searchContext && searchContext.length > 0) {
        const topResult = searchContext[0];
        return `According to ${new URL(topResult.url).hostname}, "${topResult.snippet}".`;
    }
    return "I processed your request.";
}

/* ==========================================================================
   DOM & UI UTILITIES
   ========================================================================== */

function addChatMessage(text, sender) {
    const msgElement = document.createElement('div');
    msgElement.className = `${sender}-message`;
    
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const formattedText = text.replace(urlRegex, (url) => {
        try {
            return `<a href="${url}" target="_blank" class="chat-link">${new URL(url).hostname}</a>`;
        } catch(e) {
            return url;
        }
    });
    
    msgElement.innerHTML = `<p>${formattedText}</p>`;
    chatMessages.appendChild(msgElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(text) {
    const msgElement = document.createElement('div');
    msgElement.className = 'system-message';
    msgElement.innerHTML = `<p>${text}</p>`;
    chatMessages.appendChild(msgElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateCitationsUI(results) {
    searchCitations.innerHTML = '';
    citationCountBadge.textContent = `${results.length} Results`;

    if (!results || results.length === 0) {
        searchCitations.innerHTML = `
            <div class="no-citations-message">
                <i class="fa-solid fa-face-frown"></i>
                <p>No results found.</p>
                <span>Try rephrasing your search request.</span>
            </div>
        `;
        return;
    }

    results.forEach((item) => {
        const card = document.createElement('div');
        card.className = 'citation-card';
        
        let displayUrl = item.url;
        try { displayUrl = new URL(item.url).hostname; } catch(e){}

        card.innerHTML = `
            <div class="citation-title-wrapper">
                <h4><a href="${item.url}" target="_blank">${item.title}</a></h4>
            </div>
            <p>${item.snippet}</p>
            <div class="citation-meta">
                <span class="citation-url"><i class="fa-solid fa-link"></i> ${displayUrl}</span>
                <a href="${item.url}" target="_blank" class="citation-icon-link" title="Open Source">
                    <i class="fa-solid fa-arrow-up-right-from-square"></i>
                </a>
            </div>
        `;
        searchCitations.appendChild(card);
    });
}

/* ==========================================================================
   EVENT LISTENERS
   ========================================================================== */

function setupEventListeners() {
    toggleSettingsBtn.addEventListener('click', () => {
        settingsDrawer.classList.add('open');
    });

    closeSettingsBtn.addEventListener('click', () => {
        settingsDrawer.classList.remove('open');
    });

    saveSettingsBtn.addEventListener('click', () => {
        settings.aiProvider = aiProviderSelect.value;
        settings.apiKey = apiKeyInput.value.trim();
        settings.ollamaModel = ollamaModelInput.value.trim();
        settings.ollamaUrl = ollamaUrlInput.value.trim();
        settings.speechRate = parseFloat(speechRateInput.value);
        settings.voiceName = voiceSelect.value;
        settings.wakeWordEnabled = wakeWordCheckbox.checked;
        settings.soundEffectsEnabled = soundEffectsCheckbox.checked;
        settings.autoSpeakEnabled = autoSpeakCheckbox.checked;

        localStorage.setItem('martha_ai_provider', settings.aiProvider);
        localStorage.setItem('martha_api_key', settings.apiKey);
        localStorage.setItem('martha_ollama_model', settings.ollamaModel);
        localStorage.setItem('martha_ollama_url', settings.ollamaUrl);
        localStorage.setItem('martha_speech_rate', settings.speechRate);
        localStorage.setItem('martha_voice_name', settings.voiceName);
        localStorage.setItem('martha_wake_word_enabled', settings.wakeWordEnabled);
        localStorage.setItem('martha_sound_effects', settings.soundEffectsEnabled);
        localStorage.setItem('martha_auto_speak', settings.autoSpeakEnabled);

        settingsDrawer.classList.remove('open');
        showToast("Settings Saved Successfully");

        if (settings.wakeWordEnabled) {
            startRecognition();
        } else {
            stopRecognition();
        }

        if (settings.autoSpeakEnabled) {
            muteVoiceBtn.classList.remove('muted');
            muteVoiceBtn.querySelector('i').className = 'fa-solid fa-volume-high';
        } else {
            muteVoiceBtn.classList.add('muted');
            muteVoiceBtn.querySelector('i').className = 'fa-solid fa-volume-xmark';
            window.speechSynthesis.cancel();
        }
    });

    aiProviderSelect.addEventListener('change', toggleAIProviderFields);

    micTriggerBtn.addEventListener('click', () => {
        if (appState === 'sleeping') {
            triggerActivation();
        } else {
            stopEverything();
        }
    });

    if (stopSpeakingBtn) {
        stopSpeakingBtn.addEventListener('click', () => {
            stopEverything();
            showToast("Assistant Stopped");
        });
    }

    muteVoiceBtn.addEventListener('click', () => {
        settings.autoSpeakEnabled = !settings.autoSpeakEnabled;
        localStorage.setItem('martha_auto_speak', settings.autoSpeakEnabled);
        autoSpeakCheckbox.checked = settings.autoSpeakEnabled;

        if (settings.autoSpeakEnabled) {
            muteVoiceBtn.classList.remove('muted');
            muteVoiceBtn.querySelector('i').className = 'fa-solid fa-volume-high';
            showToast("Speech synthesis enabled");
        } else {
            muteVoiceBtn.classList.add('muted');
            muteVoiceBtn.querySelector('i').className = 'fa-solid fa-volume-xmark';
            window.speechSynthesis.cancel();
            showToast("Speech synthesis muted");
            if (appState === 'speaking') {
                setAgentState('sleeping');
            }
        }
    });

    clearChatBtn.addEventListener('click', () => {
        chatMessages.innerHTML = '';
        addSystemMessage("Log cleared. Martha is listening...");
        showToast("Session history cleared");
    });

    sendQueryBtn.addEventListener('click', sendTextQuery);
    textQueryInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            sendTextQuery();
        }
    });
}

function sendTextQuery() {
    const text = textQueryInput.value.trim();
    if (!text) return;
    
    textQueryInput.value = '';
    window.speechSynthesis.cancel();
    handleCommand(text);
}
