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
            
            # Extract links and titles
            title_pattern = r'<a\s+[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>'
            title_matches = list(re.finditer(title_pattern, html, re.DOTALL))
            print("Found titles:", len(title_matches))
            
            # Extract snippets
            snippet_pattern = r'<a\s+[^>]*class="result__snippet"[^>]*href="([^"]+)"[^>]*>(.*?)</a>'
            snippet_matches = list(re.finditer(snippet_pattern, html, re.DOTALL))
            print("Found snippets:", len(snippet_matches))
            
            def clean_html(text):
                text = re.sub(r'<[^>]+>', '', text)
                text = text.replace('&amp;', '&').replace('&quot;', '"').replace('&#x27;', "'").replace('&lt;', '<').replace('&gt;', '>')
                return text.strip()
            
            results = []
            for i in range(min(len(title_matches), len(snippet_matches))):
                t_match = title_matches[i]
                s_match = snippet_matches[i]
                
                url = t_match.group(1)
                # Unquote URL if it's nested in DDG redirects
                if "uddg=" in url:
                    parsed_url = urllib.parse.urlparse(url)
                    query_params = urllib.parse.parse_qs(parsed_url.query)
                    if 'uddg' in query_params:
                        url = query_params['uddg'][0]
                
                title = clean_html(t_match.group(2))
                snippet = clean_html(s_match.group(2))
                
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
