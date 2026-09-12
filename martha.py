import os
import re
import sys
import json
import time
import socket
import threading
import subprocess
import webbrowser
import urllib.request
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT = 8000
DIRECTORY = os.path.join(sys._MEIPASS, "web") if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS') else os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
last_heartbeat = time.time() + 20

def get_lan_ip():
    """Detect local network IPv4 address for Wi-Fi mobile pairing."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except Exception:
        return '127.0.0.1'
    finally:
        s.close()

class MarthaRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        self.extensions_map = SimpleHTTPRequestHandler.extensions_map.copy()
        self.extensions_map.update({
            '.json': 'application/json',
            '.webmanifest': 'application/manifest+json',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.html': 'text/html'
        })
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_OPTIONS(self):
        """CORS pre-flight handler for mobile apps and standalone clients."""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        global last_heartbeat
        
        if parsed.path == '/api/heartbeat':
            last_heartbeat = time.time()
            return self.send_json({"status": "alive"})

        if parsed.path == '/api/info':
            ip = get_lan_ip()
            return self.send_json({
                "name": "Martha Voice AI",
                "version": "1.1",
                "status": "online",
                "lan_ip": ip,
                "lan_url": f"http://{ip}:{PORT}",
                "local_url": f"http://localhost:{PORT}",
                "mobile_supported": True
            })

        if parsed.path == '/api/search':
            q = urllib.parse.parse_qs(parsed.query).get('q', [''])[0].strip()
            return self.handle_search(q)

        if parsed.path == '/api/tts':
            params = urllib.parse.parse_qs(parsed.query)
            return self.handle_tts(params.get('text', [''])[0].strip(), params.get('action', [''])[0].strip())

        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode('utf-8') if length > 0 else '{}'
        
        try:
            data = json.loads(body)
        except Exception:
            data = {}

        if parsed.path == '/api/tts':
            return self.handle_tts(data.get('text', '').strip(), data.get('action', '').strip())

        if parsed.path == '/api/transcribe':
            try:
                import base64
                audio_b64 = data.get('audio', '')
                mime = data.get('mime', 'audio/wav')
                api_key = data.get('api_key', '')
                
                if not audio_b64:
                    return self.send_json({"error": "No audio payload provided"}, status=400)

                # Gemini Audio Transcription
                if api_key:
                    gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
                    raw_mime = mime.split(';')[0]
                    payload = json.dumps({
                        "contents": [{
                            "parts": [
                                {"text": "Transcribe the spoken audio words accurately. Return ONLY the transcribed text, nothing else."},
                                {"inline_data": {"mime_type": raw_mime, "data": audio_b64}}
                            ]
                        }]
                    }).encode('utf-8')
                    req = urllib.request.Request(gemini_url, data=payload, headers={'Content-Type': 'application/json'})
                    with urllib.request.urlopen(req, timeout=15) as res:
                        res_json = json.loads(res.read().decode('utf-8'))
                        text = res_json.get('candidates', [{}])[0].get('content', {}).get('parts', [{}])[0].get('text', '').strip()
                        return self.send_json({"text": text})

                # Google Speech Recognition fallback
                raw_bytes = base64.b64decode(audio_b64)
                try:
                    url = "https://www.google.com/speech-api/v2/recognize?output=json&lang=en-US&client=chromium"
                    req = urllib.request.Request(url, data=raw_bytes, headers={'Content-Type': f'{mime}; rate=16000;'})
                    with urllib.request.urlopen(req, timeout=8) as res:
                        for line in res.read().decode('utf-8', errors='ignore').split('\n'):
                            if line.strip():
                                parsed_line = json.loads(line)
                                if parsed_line.get('result'):
                                    text = parsed_line['result'][0]['alternative'][0]['transcript']
                                    return self.send_json({"text": text})
                except Exception:
                    pass

                return self.send_json({"text": "", "error": "Transcription unavailable"})
            except Exception as e:
                return self.send_json({"error": str(e), "text": ""}, status=500)

        if parsed.path == '/api/local-chat':
            try:
                ollama_url = data.get('url', 'http://localhost:11434').rstrip('/')
                payload = json.dumps({"model": data.get('model', 'llama3.2'), "prompt": data.get('prompt', ''), "stream": False}).encode('utf-8')
                req = urllib.request.Request(f"{ollama_url}/api/generate", data=payload, headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(req, timeout=20) as res:
                    res_json = json.loads(res.read().decode('utf-8'))
                    return self.send_json({"response": res_json.get('response', '')})
            except Exception as e:
                return self.send_json({"error": str(e)}, status=500)

        self.send_response(404)
        self.end_headers()

    def handle_tts(self, text, action):
        if action == 'stop':
            self.stop_speech()
        elif text:
            self.speak_text(text)
        self.send_json({"status": "success"})

    def speak_text(self, text):
        clean = re.sub(r'["\'\\]', '', text)
        if not clean: return
        print(f"Local TTS: '{clean[:50]}...'")
        try:
            if sys.platform == 'darwin':
                subprocess.Popen(['say', clean])
            elif sys.platform == 'win32':
                cmd = f"Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('{clean}')"
                subprocess.Popen(['powershell', '-Command', cmd], creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            else:
                for engine in ['spd-say', 'espeak']:
                    try:
                        subprocess.Popen([engine, clean])
                        break
                    except Exception: pass
        except Exception as e:
            print(f"TTS error: {e}")

    def stop_speech(self):
        try:
            if sys.platform == 'darwin': subprocess.Popen(['killall', 'say'])
            elif sys.platform == 'win32': subprocess.Popen(['taskkill', '/F', '/IM', 'powershell.exe'], creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            else: subprocess.Popen(['killall', 'espeak'])
        except Exception: pass

    def handle_search(self, query):
        if not query:
            return self.send_json({"error": "No query provided"}, status=400)
        try:
            url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote_plus(query)
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'})
            with urllib.request.urlopen(req, timeout=8) as response:
                html = response.read().decode('utf-8', errors='ignore')

            titles = list(re.finditer(r'<a\s+[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', html, re.DOTALL))
            snippets = list(re.finditer(r'<a\s+[^>]*class="result__snippet"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', html, re.DOTALL))
            
            clean = lambda t: re.sub(r'<[^>]+>', '', t).replace('&amp;', '&').replace('&quot;', '"').replace('&#x27;', "'").replace('&lt;', '<').replace('&gt;', '>').strip()
            results = []
            
            for i in range(min(len(titles), len(snippets))):
                raw_url = titles[i].group(1)
                final_url = raw_url
                if "uddg=" in raw_url:
                    qp = urllib.parse.parse_qs(urllib.parse.urlparse(raw_url).query)
                    if 'uddg' in qp: final_url = qp['uddg'][0]
                t_txt, s_txt = clean(titles[i].group(2)), clean(snippets[i].group(2))
                if t_txt and s_txt:
                    results.append({"title": t_txt, "url": final_url, "snippet": s_txt})
            
            self.send_json(results[:8])
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)

    def send_json(self, data, status=200):
        try:
            body = json.dumps(data).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.end_headers()
            self.wfile.write(body)
        except Exception: pass

def is_port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(('127.0.0.1', port)) == 0

def launch_browser():
    url = f"http://localhost:{PORT}"
    for _ in range(25):
        if is_port_in_use(PORT): break
        time.sleep(0.1)
    try:
        subprocess.Popen(['cmd.exe', '/c', 'start', 'chrome', f'--app={url}', '--window-size=1200,800'], shell=True)
    except Exception:
        webbrowser.open(url)

def monitor_heartbeat():
    time.sleep(20)
    while True:
        time.sleep(3)
        if time.time() - last_heartbeat > 15:
            print("Server auto-shutdown due to inactivity.")
            os._exit(0)

def run(server_class=HTTPServer, handler_class=MarthaRequestHandler):
    if not os.path.exists(DIRECTORY): os.makedirs(DIRECTORY)
    if is_port_in_use(PORT):
        print(f"Server is already running on port {PORT}.")
        return

    lan_ip = get_lan_ip()
    print("=" * 64)
    print("  ✨ MARTHA VOICE AI — MULTI-PLATFORM ASSISTANT")
    print("=" * 64)
    print(f"  💻 Desktop : http://localhost:{PORT}")
    print(f"  📱 Mobile  : http://{lan_ip}:{PORT}")
    print("=" * 64)
    print("  Press Ctrl+C to stop server.\n")
    
    httpd = server_class(('', PORT), handler_class)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        sys.exit(0)

if __name__ == '__main__':
    if getattr(sys, 'frozen', False):
        threading.Thread(target=launch_browser, daemon=True).start()
        threading.Thread(target=monitor_heartbeat, daemon=True).start()
    run()
