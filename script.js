'use strict';

const toggle = document.querySelector('.nav-toggle');
const navigation = document.querySelector('#navigation');
function closeNavigation() {
  navigation?.classList.remove('open');
  toggle?.setAttribute('aria-expanded', 'false');
  toggle?.setAttribute('aria-label', 'Open navigation');
}
toggle?.addEventListener('click', () => {
  const open = navigation.classList.toggle('open');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
});
navigation?.querySelectorAll('a').forEach(link => link.addEventListener('click', closeNavigation));
document.addEventListener('click', event => {
  if (!event.target.closest('.header')) closeNavigation();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && navigation?.classList.contains('open')) {
    closeNavigation();
    toggle.focus();
  }
});
document.querySelectorAll('[data-filter]').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-filter]').forEach(item => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll('.menu-card[data-category]').forEach(card => {
      card.hidden = button.dataset.filter !== 'all' && card.dataset.category !== button.dataset.filter;
    });
  });
});
window.matchMedia('(min-width: 761px)').addEventListener('change', closeNavigation);
const year = document.querySelector('#year');
if (year) year.textContent = new Date().getFullYear();

let toastTimer;
function announce(message) {
  const toast = document.querySelector('#toast');
  if (!toast) return;
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}

async function copyText(text) {
  try {
    if (!navigator.clipboard || !window.isSecureContext) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
    announce('Copied. You’re ready to make a plan.');
    return true;
  } catch {
    // A selectable fallback works for file previews and blocked clipboard access.
    let dialog = document.querySelector('#copy-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'copy-dialog';
      dialog.setAttribute('aria-labelledby', 'copy-dialog-title');
      dialog.innerHTML = '<h2 id="copy-dialog-title">Copy your details</h2><p>Automatic copying is unavailable. Select and copy the text below.</p><label class="sr-only" for="manual-copy">Text to copy</label><textarea id="manual-copy" rows="8" readonly></textarea><form method="dialog"><button class="button cream">Done</button></form>';
      document.body.append(dialog);
    }
    dialog.querySelector('textarea').value = text;
    dialog.showModal();
    dialog.querySelector('textarea').select();
    return false;
  }
}

// On-device image fallback, including images that fail before this script runs.
document.querySelectorAll('img').forEach(img => {
  const fallback = () => {
    if (!img.src.endsWith('/assets/image-fallback.svg')) img.src = 'assets/image-fallback.svg';
  };
  img.addEventListener('error', fallback, { once: true });
  if (img.getAttribute('src') && img.complete && img.naturalWidth === 0) fallback();
});

// Search, dietary preferences and a persistent personal shortlist.
// Runs again whenever site.js replaces the dishes with the live menu, so listeners are tied to a signal.
let menuAbort;
function initMenu() {
  const menuBrowser = document.querySelector('[data-menu-browser]');
  if (!menuBrowser) return;
  menuAbort?.abort();
  menuAbort = new AbortController();
  const signal = menuAbort.signal;
  const cards = [...menuBrowser.querySelectorAll('[data-menu-item]')];
  const filters = [...menuBrowser.querySelectorAll('[data-menu-filter]')];
  const search = document.querySelector('#menu-search');
  const preference = document.querySelector('#diet-filter');
  const storageKey = 'nasha-saved-dishes-v1';
  const validIds = new Set(cards.map(card => card.dataset.id));
  let category = 'all';
  let saved = new Set();
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (Array.isArray(stored)) saved = new Set(stored.filter(id => validIds.has(id)));
  } catch { /* Browsing still works when storage is disabled or invalid. */ }

  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify([...saved])); }
    catch { announce('Saved for this visit. Browser storage is unavailable.'); }
  }
  function renderMenu() {
    const query = search.value.trim().toLocaleLowerCase();
    let visible = 0;
    cards.forEach(card => {
      const categoryMatches = category === 'all' || (category === 'saved' ? saved.has(card.dataset.id) : card.dataset.category === category);
      const dietMatches = preference.value === 'all' || card.dataset.diet === preference.value;
      const queryMatches = (card.dataset.name + ' ' + card.querySelector('.dish-category').textContent).toLocaleLowerCase().includes(query);
      card.hidden = !(categoryMatches && dietMatches && queryMatches);
      if (!card.hidden) visible++;
      const button = card.querySelector('[data-save]');
      const selected = saved.has(card.dataset.id);
      button.setAttribute('aria-pressed', String(selected));
      button.setAttribute('aria-label', `${selected ? 'Unsave' : 'Save'} ${card.dataset.name}`);
      button.textContent = selected ? '✓' : '＋';
    });
    // Dishes are grouped into one card per category; once every dish in a card is filtered out, hide the
    // card too, so filtering never leaves an empty category heading on screen.
    menuBrowser.querySelectorAll('.dish-group').forEach(group => {
      group.hidden = ![...group.querySelectorAll('[data-menu-item]')].some(card => !card.hidden);
    });
    filters.forEach(button => {
      const active = button.dataset.menuFilter === category;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
      if (button.dataset.menuFilter === 'saved') button.textContent = `Saved (${saved.size})`;
    });
    document.querySelector('#result-count').textContent = `${visible} ${visible === 1 ? 'item' : 'items'}`;
    document.querySelector('#menu-empty').hidden = visible !== 0;
    document.querySelector('#clear-filters').hidden = category === 'all' && !query && preference.value === 'all';
    document.querySelector('#shortlist').hidden = saved.size === 0;
    document.querySelector('#shortlist-summary').textContent = cards.filter(card => saved.has(card.dataset.id)).map(card => card.dataset.name).join(' · ');
  }
  function resetFilters() {
    category = 'all'; search.value = ''; preference.value = 'all'; renderMenu();
  }
  filters.forEach(button => button.addEventListener('click', () => { category = button.dataset.menuFilter; renderMenu(); }, { signal }));
  search.addEventListener('input', renderMenu, { signal });
  preference.addEventListener('change', renderMenu, { signal });
  cards.forEach(card => card.querySelector('[data-save]').addEventListener('click', () => {
    const id = card.dataset.id;
    if (saved.has(id)) saved.delete(id); else saved.add(id);
    persist(); renderMenu();
  }, { signal }));
  document.querySelector('#clear-filters').addEventListener('click', resetFilters, { signal });
  document.querySelector('#empty-reset').addEventListener('click', () => { resetFilters(); search.focus(); }, { signal });
  document.querySelector('#clear-saved').addEventListener('click', () => { saved.clear(); persist(); renderMenu(); }, { signal });
  document.querySelector('#copy-shortlist').addEventListener('click', () => {
    const names = cards.filter(card => saved.has(card.dataset.id)).map(card => `• ${card.dataset.name}`);
    copyText(`Our Nasha wish list\n${names.join('\n')}\n\nPlease check current prices and availability with the restaurant. This is not an order.`);
  }, { signal });
  renderMenu();
}
initMenu();

// Native modal photo viewer with keyboard navigation and focus restoration.
// Also re-run by site.js after it loads the gallery the owner manages.
let galleryAbort;
function initGallery() {
  const lightbox = document.querySelector('#lightbox');
  if (!lightbox) return;
  galleryAbort?.abort();
  galleryAbort = new AbortController();
  const signal = galleryAbort.signal;
  const tiles = [...document.querySelectorAll('[data-photo-index]')];
  const filters = [...document.querySelectorAll('[data-gallery-filter]')];
  let galleryCategory = 'all';
  let currentIndex = 0;
  let opener;
  const visibleTiles = () => tiles.filter(tile => galleryCategory === 'all' || tile.dataset.galleryCategory === galleryCategory);
  function showPhoto(index) {
    const visible = visibleTiles();
    currentIndex = (index + visible.length) % visible.length;
    const tile = visible[currentIndex];
    const img = tile.querySelector('img');
    const large = document.querySelector('#lightbox-image');
    large.src = img.src;
    large.alt = img.alt;
    document.querySelector('#lightbox-caption').textContent = [tile.dataset.caption, tile.dataset.note].filter(Boolean).join(' · ');
    document.querySelector('#photo-counter').textContent = `${currentIndex + 1} / ${visible.length}`;
    document.querySelector('#previous-photo').disabled = visible.length < 2;
    document.querySelector('#next-photo').disabled = visible.length < 2;
  }
  tiles.forEach(tile => tile.addEventListener('click', () => {
    opener = tile;
    showPhoto(visibleTiles().indexOf(tile));
    lightbox.showModal();
    document.body.classList.add('modal-open');
    document.querySelector('#close-lightbox').focus();
  }, { signal }));
  filters.forEach(button => button.addEventListener('click', () => {
    galleryCategory = button.dataset.galleryFilter;
    filters.forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
    tiles.forEach(tile => { tile.hidden = galleryCategory !== 'all' && tile.dataset.galleryCategory !== galleryCategory; });
  }, { signal }));
  document.querySelector('#close-lightbox').addEventListener('click', () => lightbox.close(), { signal });
  document.querySelector('#previous-photo').addEventListener('click', () => showPhoto(currentIndex - 1), { signal });
  document.querySelector('#next-photo').addEventListener('click', () => showPhoto(currentIndex + 1), { signal });
  lightbox.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); showPhoto(currentIndex - 1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); showPhoto(currentIndex + 1); }
  }, { signal });
  lightbox.addEventListener('click', event => {
    const box = lightbox.getBoundingClientRect();
    if (event.target === lightbox && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) lightbox.close();
  }, { signal });
  lightbox.addEventListener('close', () => { document.body.classList.remove('modal-open'); opener?.focus(); }, { signal });
}
initGallery();

// Sections ease in as they scroll into view. Skipped when the visitor prefers reduced motion.
if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.documentElement.classList.add('reveal-on');
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (entry.isIntersecting) { entry.target.classList.add('in'); observer.unobserve(entry.target); }
  }), { rootMargin: '0px 0px -6% 0px' });
  document.querySelectorAll('main > section:not(.hero):not(.page-hero):not(.page-plain)').forEach(section => { section.classList.add('reveal'); observer.observe(section); });
}

// Shared with site.js, which adds everything that talks to the restaurant's server.
window.Nasha = { announce, copyText, initMenu, initGallery };

document.querySelector('#copy-address')?.addEventListener('click', event => copyText(event.currentTarget.dataset.address));
document.querySelector('#load-map')?.addEventListener('click', () => {
  const frame = document.createElement('iframe');
  frame.title = 'Nasha Resto Bar in BTM 2nd Stage on Google Maps';
  // site.js sets the query for the branch the visitor has chosen.
  const place = document.querySelector('#map-container').dataset.query || 'Nasha the Resto Bar BTM 2nd Stage Bengaluru';
  frame.src = `https://maps.google.com/maps?q=${encodeURIComponent(place)}&output=embed`;
  frame.referrerPolicy = 'no-referrer-when-downgrade';
  frame.allowFullscreen = true;
  document.querySelector('#map-container').replaceChildren(frame);
});
