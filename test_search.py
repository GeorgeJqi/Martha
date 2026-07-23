import urllib.request
import urllib.parse
import re
from html.parser import HTMLParser

class DDGHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.results = []
        self.in_result = False
        self.in_snippet = False
        self.in_title_link = False
        self.current_result = {}
        self.temp_text = ""

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        # Check for result container or specific elements
        if tag == 'div' and 'result' in attrs_dict.get('class', ''):
            self.current_result = {'title': '', 'link': '', 'snippet': ''}
            self.in_result = True
        elif self.in_result:
            if tag == 'a' and 'result__snippet' in attrs_dict.get('class', ''):
                self.in_snippet = True
                self.temp_text = ""
            elif tag == 'a' and 'result__url' in attrs_dict.get('class', ''):
                # Sometimes links are here
                pass
            elif tag == 'a' and 'result__snippet' not in attrs_dict.get('class', '') and 'result__url' not in attrs_dict.get('class', ''):
                # Check if it's the title link
                if 'href' in attrs_dict:
                    self.current_result['link'] = attrs_dict['href']
                    self.in_title_link = True
                    self.temp_text = ""

    def handle_endtag(self, tag):
        if self.in_result:
            if tag == 'div' and self.in_result and not self.in_snippet and not self.in_title_link:
                # End of result container? Actually DDG html results are often styled differently.
                # Let's close result if we have a title and snippet
                if self.current_result.get('title') and self.current_result.get('snippet'):
                    self.results.append(self.current_result)
                    self.in_result = False
            elif tag == 'a' and self.in_snippet:
                self.current_result['snippet'] = self.temp_text.strip()
                self.in_snippet = False
            elif tag == 'a' and self.in_title_link:
                self.current_result['title'] = self.temp_text.strip()
                self.in_title_link = False

    def handle_data(self, data):
        if self.in_snippet or self.in_title_link:
            self.temp_text += data

def search_ddg(query):
    url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote_plus(query)
    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
    )
    try:
        with urllib.request.urlopen(req) as response:
            html = response.read().decode('utf-8')
            # Fallback regex search if parser is too complex
            # DDG HTML format:
            # <a class="result__snippet" href="...">snippet text</a>
            # Let's inspect the HTML or use a simpler regex parsing
            print("Successfully fetched HTML. Length:", len(html))
            
            # Simple regex search is often more robust for DDG HTML
            # Results are in divs: <div class="web-result ..."> or similar
            # Let's find results:
            # We can search for titles and snippets
            # A typical result in ddg html:
            # <a class="result__url" href="URL">
            # <a class="result__snippet" ...>Snippet</a>
            
            # Let's print a small chunk of the html to see the format
            snippet_index = html.find("class=\"result__snippet\"")
            if snippet_index != -1:
                print("Found snippet tag around index:", snippet_index)
                print(html[max(0, snippet_index-300):snippet_index+300])
            else:
                print("Snippet class not found in HTML. Printing first 1000 chars:")
                print(html[:1000])
    except Exception as e:
        print("Error fetching DDG:", e)

if __name__ == "__main__":
    search_ddg("AI agents")
