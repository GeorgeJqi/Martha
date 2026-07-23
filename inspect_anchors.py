import urllib.request
import urllib.parse
import re

def inspect_anchors():
    url = "https://html.duckduckgo.com/html/?q=AI+agents"
    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
    )
    try:
        with urllib.request.urlopen(req) as response:
            html = response.read().decode('utf-8')
            anchors = re.findall(r'<a\s+[^>]*class="([^"]+)"[^>]*>', html)
            print("Found unique anchor classes:", set(anchors))
            
            # Print a few examples of anchors
            all_anchors = re.findall(r'<a\s+[^>]*href="[^"]+"[^>]*>.*?</a>', html, re.DOTALL)
            print(f"\nFound {len(all_anchors)} total anchors. Examples:")
            for a in all_anchors[:15]:
                if 'result' in a:
                    print(a[:150] + "...")
    except Exception as e:
        print("Error:", e)

inspect_anchors()
