import urllib.request
import urllib.parse
import re

def search_ddg(query):
    url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote_plus(query)
    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
    )
    try:
        with urllib.request.urlopen(req) as response:
            html = response.read().decode('utf-8')
            
            # Let's search for result elements
            # A typical result looks like:
            # <div class="web-result ...">
            #   ...
            #   <a class="result__a" href="url">Title</a>
            #   ...
            #   <a class="result__snippet" href="url">Snippet</a>
            # </div>
            
            # Let's extract matching results using regex
            results = []
            
            # Find all result elements.
            # Let's find result__a matches:
            # <a class="result__a" href="(?P<url>[^"]+)">(?P<title>.*?)</a>
            title_matches = list(re.finditer(r'<a\s+class="result__a"\s+href="([^"]+)"[^>]*>(.*?)</a>', html, re.DOTALL))
            print("Found titles:", len(title_matches))
            
            # Find result__snippets
            snippet_matches = list(re.finditer(r'<a\s+class="result__snippet"\s+href="([^"]+)"[^>]*>(.*?)</a>', html, re.DOTALL))
            print("Found snippets:", len(snippet_matches))
            
            # Let's pair them up. Usually they correspond 1-to-1 in order.
            # We can clean HTML tags (like <b>, </b>, etc.)
            def clean_html(text):
                text = re.sub(r'<[^>]+>', '', text)
                text = text.replace('&amp;', '&').replace('&quot;', '"').replace('&#x27;', "'").replace('&lt;', '<').replace('&gt;', '>')
                return text.strip()
            
            for i in range(min(len(title_matches), len(snippet_matches))):
                title_match = title_matches[i]
                snippet_match = snippet_matches[i]
                
                url = title_match.group(1)
                # Unquote URL if it goes through DDG redirect
                # Often DDG html urls are: //duckduckgo.com/l/?uddg=HTTPS_URL
                if "uddg=" in url:
                    parsed_url = urllib.parse.urlparse(url)
                    query_params = urllib.parse.parse_qs(parsed_url.query)
                    if 'uddg' in query_params:
                        url = query_params['uddg'][0]
                
                title = clean_html(title_match.group(2))
                snippet = clean_html(snippet_match.group(2))
                
                results.append({
                    'title': title,
                    'url': url,
                    'snippet': snippet
                })
            
            print("\nFirst 3 parsed results:")
            for idx, r in enumerate(results[:3]):
                print(f"[{idx+1}] Title: {r['title']}")
                print(f"    URL: {r['url']}")
                print(f"    Snippet: {r['snippet']}")
                print()
                
    except Exception as e:
        print("Error:", e)

if __name__ == "__main__":
    search_ddg("AI agents")
