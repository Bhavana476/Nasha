"""Check shipped pages for broken local links/assets and invalid metadata."""
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urlsplit, unquote
from collections import Counter
import json

ROOT = Path(__file__).resolve().parent
NAMES = ['index', 'about', 'menu', 'gallery', 'events', 'offers', 'order', 'visit', 'privacy', '404']

class PageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.links = []
        self.assets = []
        self.headings = 0
        self.schema = False
        self.schema_text = ''
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs: self.ids.append(attrs['id'])
        if tag == 'h1': self.headings += 1
        if tag == 'a': self.links.append(attrs.get('href', ''))
        if tag in ['img', 'script'] and attrs.get('src'): self.assets.append(attrs['src'])
        if tag == 'link' and attrs.get('href'): self.assets.append(attrs['href'])
        if tag == 'img': assert 'alt' in attrs, 'Image missing alt text'
        if tag == 'script' and attrs.get('type') == 'application/ld+json': self.schema = True
    def handle_endtag(self, tag):
        if tag == 'script': self.schema = False
    def handle_data(self, data):
        if self.schema: self.schema_text += data

pages = {}
for name in NAMES:
    parser = PageParser()
    source = (ROOT / f'{name}.html').read_text(encoding='utf-8')
    parser.feed(source)
    assert parser.headings == 1, f'{name}: needs exactly one h1'
    assert not [x for x,n in Counter(parser.ids).items() if n > 1], f'{name}: duplicate IDs'
    assert '\ufffd' not in source, f'{name}: broken character encoding'
    assert json.loads(parser.schema_text)['@type'] == 'Restaurant'
    pages[f'{name}.html'] = parser

for name, page in pages.items():
    for link in page.links + page.assets:
        url = urlsplit(link)
        if url.scheme or url.netloc: continue
        target = unquote(url.path) or name
        assert (ROOT / target).is_file(), f'{name}: missing local file {target}'
        if url.fragment and target in pages:
            assert unquote(url.fragment) in pages[target].ids, f'{name}: missing anchor {link}'

print(f'PASS: {len(pages)} pages; local links, anchors, assets, metadata, headings and IDs checked.')
