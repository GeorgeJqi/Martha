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

# Determine web assets directory (supports PyInstaller extract path if frozen)
if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
    DIRECTORY = os.path.join(sys._MEIPASS, "web")
else:
    DIRECTORY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

# Track heartbeat to auto-shutdown when browser window closes in app mode
last_heartbeat = time.time() + 15  # Initial 15 seconds grace period

class MarthaRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_GET(self):
        parsed_url = urllib.parse.urlparse(self.path)
        
        # Intercept Heartbeat API
        if parsed_url.path == '/api/heartbeat':
            global last_heartbeat
            last_heartbeat = time.time()
            self.send_json_response({"status": "alive"})
            return

        # Intercept Search API
        if parsed_url.path == '/api/search':
            self.handle_search(parsed_url.query)
        # Intercept Local TTS GET API
        elif parsed_url.path == '/api/tts':
            params = urllib.parse.parse_qs(parsed_url.query)
            action = params.get('action', [''])[0].strip()
            if action == 'stop':
                self.stop_speech_locally()
            else:
                text = params.get('text', [''])[0].strip()
                if text:
                    self.speak_locally(text)
            self.send_json_response({"status": "success"})
        else:
            # Fallback to standard static file serving
            super().do_GET()

    def do_POST(self):
        parsed_url = urllib.parse.urlparse(self.path)
        
        # Local TTS POST API (100% offline, native OS synthesis)
        if parsed_url.path == '/api/tts':
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length).decode('utf-8')
            try:
                req_data = json.loads(post_data)
                if req_data.get('action') == 'stop':
                    self.stop_speech_locally()
                else:
                    text = req_data.get('text', '').strip()
                    if text:
                        self.speak_locally(text)
                self.send_json_response({"status": "success"})
            except Exception as e:
                print(f"Local TTS error: {e}")
                self.send_json_response({"error": str(e)}, status=500)
            return

        # Proxy route for local Ollama LLM queries to bypass browser CORS rules
        if parsed_url.path == '/api/local-chat':
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length).decode('utf-8')
            
            try:
                req_data = json.loads(post_data)
                prompt = req_data.get('prompt', '')
                model = req_data.get('model', 'llama3.2')
                ollama_url = req_data.get('url', 'http://localhost:11434').rstrip('/')
                
                # Fetch response from local Ollama
                ollama_endpoint = f"{ollama_url}/api/generate"
                payload = json.dumps({
                    "model": model,
                    "prompt": prompt,
                    "stream": False
                }).encode('utf-8')
                
                req = urllib.request.Request(
                    ollama_endpoint,
                    data=payload,
                    headers={'Content-Type': 'application/json'}
                )
                
                with urllib.request.urlopen(req, timeout=20) as response:
                    res_data = json.loads(response.read().decode('utf-8'))
                    response_text = res_data.get('response', '')
                    self.send_json_response({"response": response_text})
                    
            except Exception as e:
                print(f"Ollama proxy error: {e}")
                self.send_json_response({"error": str(e)}, status=500)
        else:
            self.send_response(404)
            self.end_headers()

    def speak_locally(self, text):
        """Perform 100% offline local TTS using host operating system voices."""
        clean_text = re.sub(r'["\'\\]', '', text)
        if not clean_text:
            return
        print(f"Local OS TTS speaking: '{clean_text[:60]}...'")
        try:
            if sys.platform == 'darwin':
                subprocess.Popen(['say', clean_text])
            elif sys.platform == 'win32':
                cmd = f"Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('{clean_text}')"
                subprocess.Popen(['powershell', '-Command', cmd], creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, 'CREATE_NO_WINDOW') else 0)
            else:
                try:
                    subprocess.Popen(['espeak', clean_text])
                except Exception:
                    try:
                        subprocess.Popen(['spd-say', clean_text])
                    except Exception:
                        pass
        except Exception as e:
            print(f"Failed to execute local OS TTS: {e}")

    def stop_speech_locally(self):
        """Stop any active local OS speech process immediately."""
        try:
            if sys.platform == 'darwin':
                subprocess.Popen(['killall', 'say'])
            elif sys.platform == 'win32':
                subprocess.Popen(['taskkill', '/F', '/IM', 'powershell.exe'], creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, 'CREATE_NO_WINDOW') else 0)
            else:
                try:
                    subprocess.Popen(['killall', 'espeak'])
                except Exception:
                    pass
        except Exception:
            pass

    def handle_search(self, query_string):
        params = urllib.parse.parse_qs(query_string)
        query = params.get('q', [''])[0].strip()

        if not query:
            self.send_json_response({"error": "No query provided"}, status=400)
            return

        print(f"Searching web for: '{query}'")
        try:
            results = self.search_ddg(query)
            self.send_json_response(results)
        except Exception as e:
            print(f"Search error: {e}")
            self.send_json_response({"error": str(e)}, status=500)

    def send_json_response(self, data, status=200):
        try:
            response_bytes = json.dumps(data).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(response_bytes)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(response_bytes)
        except Exception as e:
            print(f"Error sending response: {e}")

    def search_ddg(self, query):
        url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote_plus(query)
        req = urllib.request.Request(
            url,
            headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        )
        
        with urllib.request.urlopen(req, timeout=8) as response:
            html = response.read().decode('utf-8', errors='ignore')
        
        # Regex patterns to extract class="result__a" and class="result__snippet"
        title_pattern = r'<a\s+[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>'
        snippet_pattern = r'<a\s+[^>]*class="result__snippet"[^>]*href="([^"]+)"[^>]*>(.*?)</a>'
        
        title_matches = list(re.finditer(title_pattern, html, re.DOTALL))
        snippet_matches = list(re.finditer(snippet_pattern, html, re.DOTALL))
        
        def clean_html(text):
            text = re.sub(r'<[^>]+>', '', text)
            text = text.replace('&amp;', '&').replace('&quot;', '"').replace('&#x27;', "'")
            text = text.replace('&lt;', '<').replace('&gt;', '>').replace('&nbsp;', ' ')
            return text.strip()
        
        results = []
        for i in range(min(len(title_matches), len(snippet_matches))):
            t_match = title_matches[i]
            s_match = snippet_matches[i]
            
            raw_url = t_match.group(1)
            url = raw_url
            if "uddg=" in raw_url:
                parsed_raw = urllib.parse.urlparse(raw_url)
                qp = urllib.parse.parse_qs(parsed_raw.query)
                if 'uddg' in qp:
                    url = qp['uddg'][0]
            
            title = clean_html(t_match.group(2))
            snippet = clean_html(s_match.group(2))
            
            if title and snippet:
                results.append({
                    'title': title,
                    'url': url,
                    'snippet': snippet
                })
        
        return results[:8]

def is_port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(('127.0.0.1', port)) == 0

def launch_browser():
    url = f"http://localhost:{PORT}"
    
    # Wait for server to start serving
    for _ in range(25):
        if is_port_in_use(PORT):
            break
        time.sleep(0.1)
        
    # Attempt App Mode (borderless layout) in Chrome, then Edge, then default browser
    try:
        subprocess.Popen(['cmd.exe', '/c', 'start', 'chrome', f'--app={url}', '--window-size=1200,800'], shell=True)
    except Exception:
        try:
            subprocess.Popen(['cmd.exe', '/c', 'start', 'msedge', f'--app={url}', '--window-size=1200,800'], shell=True)
        except Exception:
            webbrowser.open(url)

def monitor_heartbeat():
    # Loop that shuts down the server if no heartbeat is received from the browser
    time.sleep(15)  # Start monitoring after initial loading grace period
    while True:
        time.sleep(2)
        if time.time() - last_heartbeat > 12:
            print("No heartbeat detected for 12 seconds. Closing background server...")
            os._exit(0)

def run(server_class=HTTPServer, handler_class=MarthaRequestHandler):
    if not os.path.exists(DIRECTORY):
        os.makedirs(DIRECTORY)

    # If port is already in use, don't throw an error, just boot browser (if in executable mode)
    if is_port_in_use(PORT):
        print(f"Server is already running on port {PORT}.")
        return

    server_address = ('', PORT)
    httpd = server_class(server_address, handler_class)
    print(f"============================================================")
    print(f" Martha Assistant backend server is running!")
    print(f" Access URL: http://localhost:{PORT}")
    print(f" Directory served: {DIRECTORY}")
    print(f"============================================================")
    
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        sys.exit(0)

if __name__ == '__main__':
    # If compiled, start browser launcher and heartbeat shutdown routines
    is_frozen = getattr(sys, 'frozen', False)
    if is_frozen:
        threading.Thread(target=launch_browser, daemon=True).start()
        threading.Thread(target=monitor_heartbeat, daemon=True).start()

    run()
