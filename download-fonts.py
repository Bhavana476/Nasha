"""Bundle the Google Fonts Latin subsets so the site renders offline."""
from pathlib import Path
from urllib.request import Request, urlopen
import re

ROOT = Path(__file__).resolve().parent
AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

def fetch(url):
    with urlopen(Request(url, headers={'User-Agent': AGENT}), timeout=30) as response:
        return response.read()

css = fetch('https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=DM+Sans:wght@400;500;600;700&display=swap').decode('utf-8')
blocks = re.findall(r'/\* latin \*/\s*(@font-face\s*\{.*?\})', css, re.S)
assert len(blocks) >= 2, 'Latin subsets were not found in the font stylesheet'
assets = {}
local = []
for block in blocks:
    url = re.search(r'url\((https://[^)]+)\)', block).group(1)
    if url not in assets:
        data = fetch(url)
        assert data.startswith(b'wOF2'), 'Expected a WOFF2 font'
        filename = f'font-{len(assets) + 1}.woff2'
        (ROOT / 'assets' / filename).write_bytes(data)
        assets[url] = filename
    local.append(block.replace(url, 'assets/' + assets[url]))
(ROOT / 'fonts.css').write_text('/* Manrope and DM Sans: SIL Open Font License; see assets licenses. */\n' + '\n'.join(local), encoding='utf-8')
for family in ['manrope', 'dmsans']:
    license_text = fetch(f'https://raw.githubusercontent.com/google/fonts/main/ofl/{family}/OFL.txt')
    (ROOT / 'assets' / f'{family}-OFL.txt').write_bytes(license_text)
print(f'Bundled {len(assets)} font files and both font licenses.')
