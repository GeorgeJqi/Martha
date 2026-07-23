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
const settings = {
    apiKey: localStorage.getItem('martha_api_key') || '',
    wakeWordEnabled: localStorage.getItem('martha_wake_word_enabled') !== 'false',
    voiceName: localStorage.getItem('martha_voice_name') || '',
    speechRate: parseFloat(localStorage.getItem('martha_speech_rate') || '1.0'),
    soundEffectsEnabled: localStorage.getItem('martha_sound_effects') !== 'false',
    autoSpeakEnabled: localStorage.getItem('martha_auto_speak') !== 'false',
    aiProvider: localStorage.getItem('martha_ai_provider') || 'huggingface',
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

// Toast & Chime
const toast = document.getElementById('toast');
const chimeStart = document.getElementById('chime-start');
const chimeSuccess = document.getElementById('chime-success');

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
    if (!('speechSynthesis' in window) || !settings.autoSpeakEnabled) {
        setAgentState('sleeping');
        return;
    }

    window.speechSynthesis.cancel();
    const cleanText = text.replace(/[\*\#\_]/g, '').trim();
    setAgentState('speaking');
    
    currentUtterance = new SpeechSynthesisUtterance(cleanText);
    currentUtterance.rate = settings.speechRate;

    if (settings.voiceName) {
        const voice = synthVoices.find(v => v.name === settings.voiceName);
        if (voice) currentUtterance.voice = voice;
    } else {
        const englishVoice = synthVoices.find(v => v.lang.startsWith('en') && (v.name.includes('Female') || v.name.includes('Zira') || v.name.includes('Google')));
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
        playChime(chimeSuccess);
        setAgentState('sleeping');
    };

    currentUtterance.onerror = (e) => {
        clearInterval(resumeSynthInterval);
        console.error('Speech synthesis error:', e);
        setAgentState('sleeping');
    };

    window.speechSynthesis.speak(currentUtterance);
}

function playChime(chimeElement) {
    if (settings.soundEffectsEnabled && chimeElement) {
        chimeElement.currentTime = 0;
        chimeElement.play().catch(e => console.log('Chime blocked by browser autoplay policy'));
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
        if (settings.wakeWordEnabled && appState === 'sleeping') {
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
        if (appState !== 'sleeping' && appState !== 'listening') return;

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

        liveTranscript.innerHTML = `"${currentText}"`;

        if (appState === 'sleeping') {
            const wakeMatch = currentText.toLowerCase().match(/\b(martha|hey martha|hay martha)\b/);
            if (wakeMatch) {
                const matchIndex = wakeMatch.index;
                const matchWord = wakeMatch[0];
                const commandPart = currentText.substring(matchIndex + matchWord.length).trim();
                liveTranscript.innerHTML = "";
                triggerActivation(commandPart);
            }
        } else if (appState === 'listening') {
            if (finalTranscript.trim().length > 0) {
                if (silenceTimer) clearTimeout(silenceTimer);
                handleCommand(finalTranscript.trim());
            } else {
                resetSilenceTimer(interimTranscript.trim());
            }
        }
    };

    if (settings.wakeWordEnabled) {
        startRecognition();
    }
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
    playChime(chimeStart);
    setAgentState('listening');
    
    if (oneShotCommand.length > 2) {
        liveTranscript.innerHTML = `"${oneShotCommand}"`;
        handleCommand(oneShotCommand);
    } else {
        liveTranscript.innerHTML = "Listening...";
        startRecognition();
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

    if (state === 'sleeping') {
        liveTranscript.innerHTML = "Say 'Martha' to start...";
        if (settings.wakeWordEnabled) {
            startRecognition();
        }
    } else {
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
   WEB SEARCH & AI PIPELINE
   ========================================================================== */

async function handleCommand(commandText) {
    if (!commandText) return;
    
    addChatMessage(commandText, 'user');
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
        const errorMsg = "Sorry, I encountered an error: " + error.message;
        addChatMessage(errorMsg, 'agent');
        speakText(errorMsg);
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
    const searchContextString = searchContext.map((item, index) => {
        return `[Source ${index + 1}] ${item.title}: ${item.snippet}`;
    }).join('\n');

    const fullPrompt = `Based on these web search results, answer the question briefly and conversationally in 2-3 sentences.

Search Results:
${searchContextString || 'No results found.'}

Question: ${userQuery}

Answer:`;

    // 1. HUGGING FACE IN-BROWSER LOCAL MODEL (DEFAULT)
    if (settings.aiProvider === 'huggingface') {
        return await generateHFAnswer(fullPrompt);
    }

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

    // 3. GEMINI CLOUD
    if (!settings.apiKey) {
        if (searchContext && searchContext.length > 0) {
            const topResult = searchContext[0];
            return `According to ${new URL(topResult.url).hostname}, "${topResult.snippet}".`;
        }
        return "No API key configured. Switch to 'In-Browser AI (Local)' in settings for zero-setup operation.";
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
        } else if (appState === 'listening') {
            setAgentState('sleeping');
        } else if (appState === 'speaking') {
            window.speechSynthesis.cancel();
            setAgentState('sleeping');
        }
    });

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
