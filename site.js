'use strict';

// Everything that depends on the restaurant's server: live content managed in the admin panel,
// and the forms that send bookings, enquiries, orders and feedback. Without the server
// (for example when a page is opened straight from disk) the built-in content stays as it is.
(() => {
  const { announce, initMenu, initGallery } = window.Nasha;
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const lines = value => esc(value).replace(/\r?\n/g, '<br>');
  const paragraphs = value => String(value).split(/\n\s*\n/).filter(part => part.trim()).map(part => `<p>${lines(part.trim())}</p>`).join('');
  const page = location.pathname.split('/').pop() || 'index.html';
  const rupees = amount => '₹' + Number(amount).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Works for this page view only. */ } },
  };

  async function api(path, body) {
    let response;
    try { response = await fetch('/api/public/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined); }
    catch { throw new Error('We could not reach the restaurant right now. Please check your connection, or call us.'); }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) throw new Error(data?.error || 'This is not available online right now. Please call us.');
    return data;
  }

  // The restaurant keeps India time wherever the visitor happens to be.
  function istNow() {
    const shifted = new Date(Date.now() + 330 * 60000);
    return { date: shifted.toISOString().slice(0, 10), time: shifted.toISOString().slice(11, 16), day: shifted.getUTCDay() };
  }
  const addDays = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  const niceDate = date => new Date(date + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  function niceTime(time) {
    const [hour, minute] = time.split(':').map(Number);
    if (minute === 0 && hour === 12) return '12 noon';
    if (minute === 0 && hour === 0) return '12 midnight';
    return `${(hour + 11) % 12 + 1}${minute ? ':' + String(minute).padStart(2, '0') : ''} ${hour >= 12 ? 'pm' : 'am'}`;
  }
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function dayLabel(days) {
    if (!days.length || days.length === 7) return 'Every day';
    const runs = [];
    for (const day of [1, 2, 3, 4, 5, 6, 0].filter(entry => days.includes(entry))) {
      const position = (day + 6) % 7, last = runs.at(-1);
      if (last && last.end === position - 1) last.end = position; else runs.push({ start: position, end: position });
    }
    const name = position => DAYS[(position + 1) % 7].slice(0, 3);
    return runs.map(run => run.start === run.end ? name(run.start) : `${name(run.start)}–${name(run.end)}`).join(', ');
  }

  // The branch the visitor has chosen with the switch at the top of the page.
  let branchId = '';
  let refreshSlots = () => {};

  // ---- Forms ----------------------------------------------------------------------------------
  function succeed(form, title, message) {
    form.innerHTML = `<div class="enquiry-result" tabindex="-1"><h3>${esc(title)}</h3><p>${esc(message)}</p></div>`;
    form.firstElementChild.focus();
  }
  function bindForm(form, endpoint, done, extra = () => ({})) {
    if (!form) return;
    const status = $('.form-status', form), button = $('button[type="submit"]', form);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const data = Object.fromEntries(new FormData(form));
      $$('input[type="checkbox"]', form).forEach(box => { data[box.name] = box.checked; });
      $$('input[type="number"]', form).forEach(input => { data[input.name] = Number(input.value); });
      $$('input[type="file"]', form).forEach(input => { delete data[input.name]; }); // Files are sent by `extra`, already prepared.
      button.disabled = true;
      status.hidden = true;
      try { await done(await api(typeof endpoint === 'function' ? endpoint() : endpoint, { ...data, ...await extra() }), data); }
      catch (error) { status.textContent = error.message; status.hidden = false; }
      finally { button.disabled = false; }
    });
  }

  bindForm($('[data-form="subscribe"]'), 'subscribe', (result, data) => succeed($('[data-form="subscribe"]'), 'You’re on the list', `Thanks${data.name ? ', ' + data.name : ''}. We’ll share offers and event news with you.`));
  bindForm($('[data-form="review"]'), 'reviews', () => succeed($('[data-form="review"]'), 'Thank you', 'Your feedback has been sent to the team. It may appear here once it has been reviewed.'));
  bindForm($('[data-form="voucher"]'), 'vouchers', () => succeed($('[data-form="voucher"]'), 'Request received', 'We’ll contact you to arrange payment, then send the voucher code. The voucher is valid once the code is issued.'));
  // A guest's photo is redrawn at up to 1600px before sending. That keeps uploads small and drops the
  // location and camera details a phone stores inside the original file.
  async function shrinkPhoto(file) {
    if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Choose a JPG, PNG or WebP photo.');
    if (file.size > 25 * 1024 * 1024) throw new Error('That photo is too large. Choose one under 25 MB.');
    const picture = await createImageBitmap(file).catch(() => { throw new Error('That photo could not be read. Try a different one.'); });
    const scale = Math.min(1, 1600 / Math.max(picture.width, picture.height));
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(picture.width * scale), height: Math.round(picture.height * scale) });
    canvas.getContext('2d').drawImage(picture, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  }
  const memoryForm = $('[data-form="memory"]');
  if (memoryForm) {
    const preview = $('.memory-preview', memoryForm);
    memoryForm.elements.photo.addEventListener('change', () => {
      const file = memoryForm.elements.photo.files[0];
      if (preview.src) URL.revokeObjectURL(preview.src);
      preview.hidden = !file;
      if (file) preview.src = URL.createObjectURL(file);
    });
  }
  bindForm(memoryForm, 'memories', () => succeed(memoryForm, 'Thank you for sharing', 'Your photo has been sent to the team. It will appear on the wall once it has been checked.'), async () => ({ data: await shrinkPhoto(memoryForm.elements.photo.files[0]) }));
  const inquiryForm = $('[data-form="inquiry"]');
  if (inquiryForm) inquiryForm.elements.date.min = istNow().date;
  bindForm(inquiryForm, 'inquiries', () => succeed(inquiryForm, 'Enquiry sent', 'Thank you. The team will call you back to discuss availability and arrangements. Nothing is booked until they confirm with you.'), () => ({ branch: branchId }));

  // ---- Table reservations -----------------------------------------------------------------------
  const reserveForm = $('#reserve-form');
  if (reserveForm) {
    const date = reserveForm.elements.date, time = reserveForm.elements.time, note = $('#slot-note');
    date.min = istNow().date;
    async function loadSlots() {
      if (!date.value) return;
      try {
        const day = await api(`availability?date=${encodeURIComponent(date.value)}&branch=${encodeURIComponent(branchId)}`);
        const chosen = time.value;
        time.innerHTML = '<option value="">Choose a time</option>' + day.slots.map(slot => `<option value="${slot.time}"${slot.left ? '' : ' disabled'}>${esc(slot.label)}${slot.left ? '' : ' (fully booked)'}</option>`).join('');
        if (day.slots.some(slot => slot.time === chosen && slot.left)) time.value = chosen;
        time.disabled = !day.open;
        note.textContent = day.reason;
      } catch { /* Keep the standard list of times; the server checks again when the request is sent. */ }
    }
    date.addEventListener('change', loadSlots);
    refreshSlots = loadSlots;
    bindForm(reserveForm, 'reservations', result => {
      const box = $('#reserve-result');
      const confirmed = result.status === 'confirmed';
      box.innerHTML = `<h3>${confirmed ? 'Table confirmed' : 'Request received'}</h3><p><strong>${esc(niceDate(result.date))} at ${esc(result.time)} · ${result.guests} ${result.guests === 1 ? 'guest' : 'guests'}</strong><br>Reference ${esc(result.ref)}</p><p>${confirmed ? 'Your table is booked. We look forward to seeing you.' : 'This is a request, not yet a confirmed booking. The team will confirm your table shortly by message or phone.'}</p>`;
      reserveForm.hidden = true;
      box.hidden = false;
      box.focus();
    }, () => ({ branch: branchId }));
  }

  // ---- Small renderers shared between pages ---------------------------------------------------------
  function offerNow(offer) {
    const now = istNow();
    if ((offer.startDate && now.date < offer.startDate) || (offer.endDate && now.date > offer.endDate)) return false;
    if (offer.days.length && !offer.days.includes(now.day)) return false;
    if (!offer.startTime || !offer.endTime) return true;
    return offer.startTime <= offer.endTime ? now.time >= offer.startTime && now.time < offer.endTime : now.time >= offer.startTime || now.time < offer.endTime;
  }
  const offerWhen = offer => [dayLabel(offer.days), offer.startTime && offer.endTime ? `${niceTime(offer.startTime)} – ${niceTime(offer.endTime)}` : '', offer.endDate ? `until ${niceDate(offer.endDate)}` : ''].filter(Boolean).join(' · ');
  // Each offer card carries a photo chosen from its wording, and where to centre it if the dish is off to one side; the first match wins.
  const OFFER_PHOTOS = [
    [/birthday|cake/i, 'nasha-0015'], [/corporate/i, 'nasha-0031'], [/\bdj\b|music|karaoke/i, 'nasha-0024'], [/biryani/i, 'nasha-0127', '86% 50%'], [/combo/i, 'nasha-0162'],
    [/cocktail/i, 'nasha-cocktail'], [/shooter|shot/i, 'nasha-shots'], [/beer|pitcher/i, 'nasha-beer'], [/drink|whisky|happy hour/i, 'nasha-whisky'],
  ];
  const SPRIG = '<svg class="offer-art" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 60 46 12M20 45c-7-1-10-6-9-12 6 1 10 5 9 12zM20 45c1-7 6-10 12-9-1 6-5 10-12 9zM28 35c-7-1-10-6-9-12 6 1 10 5 9 12zM28 35c1-7 6-10 12-9-1 6-5 10-12 9zM36 25c-7-1-10-6-9-12 6 1 10 5 9 12zM36 25c1-7 6-10 12-9-1 6-5 10-12 9z"/></svg>';
  const LINE = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const CHEERS = `<svg class="offer-cheers" viewBox="0 0 96 78" ${LINE}><g transform="translate(40 32) rotate(-12) scale(-1 1)"><rect y="8" width="22" height="28" rx="3"/><path d="M22 14h5a5 5 0 0 1 5 5v6a5 5 0 0 1-5 5h-5M-2 8a5 5 0 0 1 6-6 6 6 0 0 1 10-1 5 5 0 0 1 10 4v3zM7 16v14M15 16v14"/></g><g transform="translate(56 32) rotate(12)"><rect y="8" width="22" height="28" rx="3"/><path d="M22 14h5a5 5 0 0 1 5 5v6a5 5 0 0 1-5 5h-5M-2 8a5 5 0 0 1 6-6 6 6 0 0 1 10-1 5 5 0 0 1 10 4v3zM7 16v14M15 16v14"/></g><path d="M48 22V8M37 20l-7-10M59 20l7-10"/></svg>`;
  const SPARKS = `<svg class="offer-sparks" viewBox="0 0 48 48" ${LINE}><path d="M8 4v14M20 22l14-10M26 38h16"/></svg>`;
  function offerCard(offer) {
    // A photo uploaded for the offer in the admin panel comes first; otherwise one is picked from its wording.
    const [, guess, guessFocus] = OFFER_PHOTOS.find(([words]) => words.test(`${offer.title} ${offer.description}`)) || [null, 'nasha-0036'];
    const photo = offer.photo || `assets/${guess}.jpg`, focus = offer.photo ? '' : guessFocus;
    // "Monday Mood: 1+1 on cocktails" is set as a name with the deal picked out beneath it.
    const [name, ...deal] = offer.title.split(': ');
    const title = deal.length ? `${esc(name)}: <em>${esc(deal.join(': '))}</em>` : esc(name);
    return `<article class="offer-card"><img class="offer-photo" src="${esc(photo)}" alt="" loading="lazy"${focus ? ` style="object-position:${focus}"` : ''}><p class="offer-when">${esc(offerWhen(offer))}</p><h3>${title}</h3><p>${lines(offer.description)}</p>${offer.couponCode ? `<p class="offer-code">Use code <b>${esc(offer.couponCode)}</b></p>` : ''}${offerNow(offer) ? '<span class="offer-live">ON NOW</span>' : ''}${CHEERS}${SPARKS}${SPRIG}</article>`;
  }
  // Offers sit side by side in a row that slides on by one card every five seconds, by itself, and
  // starts again from the first after the last. A card can fill the whole row, so a resting mouse does
  // not stop it; it holds still only while someone is tabbing through it with the keyboard, so they can
  // finish reading. With reduced motion it changes without the glide.
  function carousel(track) {
    if (track.classList.contains('carousel')) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    track.classList.add('carousel');
    track.tabIndex = 0;
    track.setAttribute('role', 'region');
    track.setAttribute('aria-label', 'Offers, changing every five seconds');
    setInterval(() => {
      const end = track.scrollWidth - track.clientWidth;
      const reading = track.matches(':focus-visible') || !!track.querySelector(':focus-visible');
      if (reading || end < 5 || document.visibilityState !== 'visible') return;
      const card = track.firstElementChild.getBoundingClientRect().width + parseFloat(getComputedStyle(track).columnGap || 0);
      const next = (Math.round(track.scrollLeft / card) + 1) * card;
      track.scrollTo({ left: track.scrollLeft >= end - 5 ? 0 : Math.min(end, next), behavior: still ? 'auto' : 'smooth' });
    }, 5000);
  }

  const EVENT_TYPES = { dj: 'DJ NIGHT', live: 'LIVE MUSIC', karaoke: 'KARAOKE', sports: 'SPORTS SCREENING', other: 'SPECIAL EVENT' };
  const EVENT_PHOTOS = { dj: 'nasha-0021', live: 'nasha-0024', karaoke: 'nasha-0029', sports: 'nasha-0032', other: 'nasha-0015' };
  function eventCard(event) {
    const meta = [event.entryFee === 0 ? 'Free entry' : event.entryFee ? `Entry ${rupees(event.entryFee)}` : '', event.spotsLeft === null ? '' : event.spotsLeft ? `${event.spotsLeft} places left` : 'Fully booked'].filter(Boolean).join(' · ');
    // Without a poster the card shows a photo of the venue, so the line-up never looks empty.
    return `<article class="event-card">${event.poster ? `<img src="${esc(event.poster)}" alt="Poster for ${esc(event.title)}" loading="lazy">` : `<img src="assets/${EVENT_PHOTOS[event.type]}.jpg" alt="" loading="lazy">`}<div><p class="event-type">${EVENT_TYPES[event.type]}</p><h3>${esc(event.title)}</h3><p class="event-when">${esc(niceDate(event.date))} · ${esc(niceTime(event.time))}${event.endTime ? ' – ' + esc(niceTime(event.endTime)) : ''}</p><p>${lines(event.description)}</p>${meta ? `<p class="event-meta">${esc(meta)}</p>` : ''}${event.spotsLeft === 0 ? '' : `<button class="button cream" data-event="${esc(event.id)}">Reserve a spot <span aria-hidden="true">↗</span></button>`}</div></article>`;
  }
  const stars = rating => `<span class="stars" role="img" aria-label="${rating} out of 5 stars">${'★'.repeat(rating)}<span>${'★'.repeat(5 - rating)}</span></span>`;
  const reviewCard = review => `<article class="review-card">${stars(review.rating)}<p>${lines(review.comment)}</p><p class="review-by">${esc(review.name)} · ${esc(niceDate(review.date))}</p>${review.reply ? `<p class="review-reply"><b>Nasha replied:</b> ${lines(review.reply)}</p>` : ''}</article>`;
  const external = (url, label, classes = 'button outline') => `<a class="${classes}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} <span aria-hidden="true">↗</span></a>`;

  // ---- Basket (kept on this device) ------------------------------------------------------------------
  const cart = {
    read: () => store.get('nasha-cart-v1', {}),
    write(value) { store.set('nasha-cart-v1', value); },
    add(id) { const value = cart.read(); value[id] = Math.min(20, (value[id] || 0) + 1); cart.write(value); },
  };
  // Happy hours ("happy" and "combo") categories have their own section and are not part of the regular menu or ordering.
  const regularMenu = site => site.categories.filter(category => category.kind === 'food' || category.kind === 'drink');
  const orderable = (site, item) => site.ordering.enabled && item.available && item.price !== null && item.diet !== 'alcoholic' && regularMenu(site).some(category => category.id === item.categoryId);
  function cartLines(site) {
    const value = cart.read();
    return site.items.filter(item => value[item.id] && orderable(site, item)).map(item => ({ ...item, qty: value[item.id], total: item.price * value[item.id] }));
  }
  function drawCartBar(site) {
    const bar = $('#cart-bar');
    if (!bar) return;
    const list = cartLines(site), count = list.reduce((sum, line) => sum + line.qty, 0);
    bar.hidden = !count;
    bar.innerHTML = `<span>${count} ${count === 1 ? 'item' : 'items'} · ${rupees(list.reduce((sum, line) => sum + line.total, 0))}</span><b>Review order ↗</b>`;
  }

  // ---- Menu -------------------------------------------------------------------------------------------
  const DIETS = { veg: 'Vegetarian', nonveg: 'Non-vegetarian', alcoholic: 'Contains alcohol', ask: 'Ask the team' };
  // The happy hours list, as kept in the admin menu. The built-in copy stays if there is nothing to show.
  const HAPPY_FOCUS = { 'assets/drink-rum.jpg': '50% 30%', 'assets/nasha-beer.jpg': '50% 68%' }; // Same as build.py.
  const happyPhoto = photo => photo ? `<img class="happy-photo" src="${esc(photo)}" alt="" loading="lazy" width="900" height="600"${HAPPY_FOCUS[photo] ? ` style="object-position:${HAPPY_FOCUS[photo]}"` : ''}>` : '';
  // Party menu details are one entry per line; a line starting with "# " begins a new heading.
  const partyGroups = details => String(details || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).reduce((groups, line) => {
    if (line.startsWith('# ')) groups.push({ heading: line.slice(2), items: [] });
    else { if (!groups.length) groups.push({ heading: '', items: [] }); groups.at(-1).items.push(line); }
    return groups;
  }, []);
  const partyList = groups => groups.map(group => `${group.heading ? `<h4>${esc(group.heading)}</h4>` : ''}<ul>${group.items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`).join('');
  function drawParty(site) {
    const party = site.party || [];
    const packages = party.filter(entry => entry.kind === 'package'), courses = party.filter(entry => entry.kind === 'course'), terms = party.find(entry => entry.kind === 'terms');
    $$('[data-live="party-packages"]').forEach(node => { node.innerHTML = packages.map((entry, index) => `<article class="party-package tier-${index % 4}"><header><span>${esc(entry.name)} package</span><strong>${entry.price === null ? '' : rupees(entry.price)}</strong><small>per guest, all inclusive</small></header>${partyList(partyGroups(entry.details))}<a class="button" href="#enquiry">Plan with ${esc(entry.name)}</a></article>`).join(''); });
    $$('[data-live="party-courses"]').forEach(node => { node.innerHTML = courses.length ? `<h3>Choose your dishes</h3><div>${courses.map(entry => `<section><h4>${esc(entry.name)}</h4><ul>${partyGroups(entry.details).flatMap(group => group.items).map(item => `<li>${esc(item)}</li>`).join('')}</ul></section>`).join('')}</div>` : ''; });
    $$('[data-live="party-terms"]').forEach(node => { node.hidden = !terms; if (terms) $('ul', node).innerHTML = partyGroups(terms.details).flatMap(group => group.items).map(item => `<li>${esc(item)}</li>`).join(''); });
    $$('.party-menu').forEach(node => { node.hidden = !packages.length && !courses.length; });
  }

  function drawHappyHours(site) {
    // Combos need a price; happy hours food without one shows "Ask" instead.
    const listed = (kind, category) => category.kind === kind && site.items.some(item => item.categoryId === category.id && item.available && (kind === 'happy' || item.price !== null));
    const priced = category => site.items.filter(item => item.categoryId === category.id && item.available && item.price !== null);
    const offered = category => site.items.filter(item => item.categoryId === category.id && item.available);
    const groups = site.categories.filter(category => listed('happy', category));
    const combos = site.categories.filter(category => listed('combo', category)).flatMap(priced);
    if (!groups.length && !combos.length) return;
    // The 1+1 tag belongs to the printed happy hours drinks list (ids starting "hh-").
    $$('[data-live="happy-groups"]').forEach(node => { node.innerHTML = groups.map(group => `<article class="happy-group">${happyPhoto(group.photo)}<h3>${esc(group.name)}${group.id.startsWith('hh-') ? ' <span>1+1</span>' : ''}</h3>${group.note ? `<p class="happy-note">${esc(group.note)}</p>` : ''}<ul>${offered(group).map(item => `<li><span>${esc(item.name)}</span><i></i><b>${item.price === null ? 'Ask' : rupees(item.price)}</b></li>`).join('')}</ul></article>`).join(''); });
    $$('[data-live="happy-combos"]').forEach(node => { node.innerHTML = combos.map(combo => `<article class="happy-combo">${happyPhoto(combo.photo)}<div><p class="eyebrow">COMBO</p><h3>${esc(combo.name)}</h3></div><b>${rupees(combo.price)}</b><ul>${combo.description.split('+').map(part => part.trim()).filter(Boolean).map(part => `<li>${esc(part)}</li>`).join('')}</ul></article>`).join(''); });
  }

  function drawMenu(site) {
    const browser = $('[data-menu-browser]');
    if (!browser) return;
    const names = Object.fromEntries(regularMenu(site).map(category => [category.id, category.name]));
    const used = regularMenu(site).filter(category => site.items.some(item => item.categoryId === category.id));
    $('[data-live="menu-categories"]').innerHTML = [['all', 'All'], ...used.map(category => [category.id, category.name]), ['saved', 'Saved']].map(([id, label]) => `<button data-menu-filter="${esc(id)}" aria-pressed="false">${esc(label)}</button>`).join('');
    $('.dish-grid', browser).innerHTML = site.items.filter(item => names[item.categoryId]).map(item => `<article class="dish-card${item.available ? '' : ' sold-out'}" data-menu-item data-id="${esc(item.id)}" data-category="${esc(item.categoryId)}" data-diet="${esc(item.diet)}" data-name="${esc(item.name)}">${item.photo ? `<div class="dish-media"><img src="${esc(item.photo)}" alt="" loading="lazy" width="1600" height="1000"></div>` : '<div class="dish-media empty" aria-hidden="true"><span>n</span></div>'}<div class="dish-top"><span class="diet ${esc(item.diet)}">${DIETS[item.diet]}</span><button class="save-dish" data-save="${esc(item.id)}" aria-pressed="false" aria-label="Save ${esc(item.name)}">＋</button></div><p class="dish-category">${esc(names[item.categoryId])}</p><h2>${esc(item.name)}</h2>${item.badges.length ? `<p class="badges">${item.badges.map(badge => `<span>${esc(badge)}</span>`).join('')}</p>` : ''}<p>${esc(item.description)}</p><span class="dish-price">${!item.available ? 'Currently unavailable' : item.price === null ? 'Ask for current price' : `<b>${rupees(item.price)}</b>`}</span>${orderable(site, item) ? `<button class="plain-button add-to-order" data-add="${esc(item.id)}">Add to order ＋</button>` : ''}</article>`).join('');
    // Once the owner has priced the menu it is their own, so the "based on public listings" notes no longer apply.
    if (site.items.some(item => item.price !== null)) $$('[data-static-only]', browser).forEach(note => { note.hidden = true; });
    initMenu();
    $$('[data-add]', browser).forEach(button => button.addEventListener('click', () => { cart.add(button.dataset.add); drawCartBar(site); announce('Added to your order.'); }));
    const table = new URLSearchParams(location.search).get('table');
    if (table && /^[\w-]{1,10}$/.test(table)) {
      try { sessionStorage.setItem('nasha-table', table); } catch { /* Table number is optional. */ }
      Object.assign($('#table-chip'), { hidden: false, textContent: `Table ${table}` });
    }
    drawCartBar(site);
  }

  // ---- Online ordering -----------------------------------------------------------------------------------
  function drawOrder(site) {
    const app = $('#order-app');
    if (!app || !site.ordering.enabled) return;
    let coupon = null;
    const placed = store.get('nasha-last-order', null);
    if (placed) return trackOrder(app, placed);
    let table = '';
    try { table = sessionStorage.getItem('nasha-table') || ''; } catch { /* Optional. */ }
    app.innerHTML = `<div class="order-lines" id="order-lines"></div><form class="event-form" id="order-form"><div class="form-row"><label>Your name<input name="name" maxlength="80" autocomplete="name" required></label><label>Phone<input name="phone" type="tel" inputmode="tel" maxlength="20" autocomplete="tel" required placeholder="98765 43210"></label></div><div class="form-row"><label>How would you like it?<select name="type"><option value="pickup">${table ? `Serve at table ${esc(table)}` : 'I’ll collect it'}</option>${site.ordering.delivery && !table ? '<option value="delivery">Deliver to me</option>' : ''}</select></label><label>Payment<select name="payment"><option value="cod">${site.ordering.delivery ? 'Pay on collection or delivery' : 'Pay at the restaurant'}</option>${site.ordering.onlinePayment ? '<option value="online">Pay online now</option>' : ''}</select></label></div><label id="address-field" hidden>Delivery address<textarea name="address" rows="2" maxlength="300"></textarea></label><label>Notes for the kitchen <span class="optional">(optional)</span><textarea name="notes" rows="2" maxlength="300"></textarea></label><div class="coupon-row"><label>Coupon code <span class="optional">(optional)</span><input name="coupon" maxlength="20" autocomplete="off"></label><button type="button" class="button outline" id="apply-coupon">Apply</button></div><div class="trap" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div><dl class="order-totals" id="order-totals"></dl><button type="submit" class="button orange">Place order <span aria-hidden="true">↗</span></button><p class="form-status" role="alert" hidden></p><p class="small-copy">Alcoholic drinks are not sold online. Tell us about allergies in the notes.</p></form>`;
    const form = $('#order-form');
    function draw() {
      const list = cartLines(site), subtotal = list.reduce((sum, line) => sum + line.total, 0);
      const fee = form.elements.type.value === 'delivery' ? site.ordering.deliveryFee : 0;
      if (coupon && coupon.subtotal !== subtotal) coupon = null;
      $('#order-lines').innerHTML = list.length ? list.map(line => `<div class="order-line"><div><b>${esc(line.name)}</b><span>${rupees(line.price)} each</span></div><div class="qty"><button type="button" class="icon-button" data-change="-1" data-id="${esc(line.id)}" aria-label="One fewer ${esc(line.name)}">−</button><span aria-live="polite">${line.qty}</span><button type="button" class="icon-button" data-change="1" data-id="${esc(line.id)}" aria-label="One more ${esc(line.name)}">+</button></div><b>${rupees(line.total)}</b></div>`).join('') : '<div class="empty-state"><h2>Your order is empty.</h2><p>Add dishes from the menu to get started.</p><a class="button cream" href="menu.html">Go to the menu ↗</a></div>';
      form.hidden = !list.length;
      $('#address-field').hidden = form.elements.type.value !== 'delivery';
      form.elements.address.required = form.elements.type.value === 'delivery';
      $('#order-totals').innerHTML = `<div><dt>Subtotal</dt><dd>${rupees(subtotal)}</dd></div>${coupon ? `<div><dt>Coupon ${esc(coupon.code)}</dt><dd>−${rupees(coupon.discount)}</dd></div>` : ''}${fee ? `<div><dt>Delivery</dt><dd>${rupees(fee)}</dd></div>` : ''}<div class="grand"><dt>Total</dt><dd>${rupees(subtotal - (coupon?.discount || 0) + fee)}</dd></div>${site.ordering.minOrder > subtotal ? `<p class="small-copy">Minimum order ${rupees(site.ordering.minOrder)}.</p>` : ''}`;
      $$('[data-change]').forEach(button => button.addEventListener('click', () => {
        const value = cart.read();
        value[button.dataset.id] = Math.min(20, (value[button.dataset.id] || 0) + Number(button.dataset.change));
        if (value[button.dataset.id] <= 0) delete value[button.dataset.id];
        cart.write(value);
        draw();
      }));
    }
    form.elements.type.addEventListener('change', draw);
    $('#apply-coupon').addEventListener('click', async () => {
      const status = $('.form-status', form), subtotal = cartLines(site).reduce((sum, line) => sum + line.total, 0);
      status.hidden = true;
      try { coupon = { ...await api('coupon', { code: form.elements.coupon.value, subtotal }), subtotal }; announce('Coupon applied.'); }
      catch (error) { coupon = null; status.textContent = error.message; status.hidden = false; }
      draw();
    });
    bindForm(form, 'orders', async result => {
      const saved = { id: result.id, token: result.token };
      store.set('nasha-last-order', saved);
      cart.write({});
      if (result.checkout) await payOnline(site, result, saved);
      trackOrder(app, saved);
    }, () => ({ items: cartLines(site).map(line => ({ id: line.id, qty: line.qty })), coupon: coupon?.code || '', table, branch: branchId }));
    draw();
  }
  // Hands over to Razorpay's own payment window; card details never pass through this website.
  function payOnline(site, result, saved) {
    return new Promise(resolve => {
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.onerror = resolve;
      script.onload = () => new window.Razorpay({
        key: result.checkout.key, order_id: result.checkout.orderId, amount: result.checkout.amount, currency: 'INR', name: site.info.name, description: `Order #${result.number}`,
        handler: response => api(`orders/${saved.id}/paid`, { token: saved.token, paymentId: response.razorpay_payment_id, signature: response.razorpay_signature }).catch(error => announce(error.message)).finally(resolve),
        modal: { ondismiss: resolve },
      }).open();
      document.head.append(script);
    });
  }
  const ORDER_STEPS = { received: 'Order received. The kitchen will start on it shortly.', preparing: 'Your order is being prepared.', ready: 'Your order is ready.', delivered: 'Order completed. Enjoy!', cancelled: 'This order was cancelled. Please call us if this is unexpected.' };
  async function trackOrder(app, saved) {
    let order;
    try { order = await api(`orders/${saved.id}?token=${saved.token}`); }
    catch { store.set('nasha-last-order', null); location.reload(); return; }
    app.innerHTML = `<div class="enquiry-result order-status" tabindex="-1"><h3>Order #${order.number}</h3><p><strong>${esc(ORDER_STEPS[order.status])}</strong></p><p>${order.lines.map(line => `${line.qty} × ${esc(line.name)}`).join('<br>')}</p><p>Total ${rupees(order.total)} · ${order.paymentStatus === 'paid' ? 'Paid online' : order.paymentStatus === 'pending' ? 'Online payment not completed. You can pay at the restaurant.' : 'Pay at the restaurant or on delivery'}</p><button class="button outline" id="new-order">Start a new order</button></div>`;
    $('#new-order').addEventListener('click', () => { store.set('nasha-last-order', null); location.href = 'menu.html'; });
    if (!['delivered', 'cancelled'].includes(order.status)) setTimeout(() => { if (document.body.contains(app) && store.get('nasha-last-order', null)) trackOrder(app, saved); }, 20000);
  }

  // ---- Age check, announcements and floating actions ---------------------------------------------------------
  function ageGate(site) {
    const confirmedAt = store.get('nasha-age-ok', 0);
    if (!site.ageGate.enabled || page === 'privacy.html' || Date.now() - confirmedAt < 30 * 86400000) return Promise.resolve();
    return new Promise(resolve => {
      const gate = document.createElement('dialog');
      gate.className = 'age-gate';
      gate.setAttribute('aria-labelledby', 'age-title');
      gate.innerHTML = `<p class="brand">NASHA<span>THE RESTO BAR</span></p><h2 id="age-title">Are you ${site.ageGate.minAge} or older?</h2><p>This website is for a venue that serves alcohol. Please confirm you are of legal drinking age.</p><div class="age-actions"><button class="button orange" data-age="yes">Yes, I am ${site.ageGate.minAge}+</button><button class="button outline" data-age="no">No</button></div><p class="small-copy">Enjoy responsibly. <a class="inline-link" href="privacy.html">Privacy</a></p>`;
      document.body.append(gate);
      gate.addEventListener('cancel', event => event.preventDefault());
      $('[data-age="yes"]', gate).addEventListener('click', () => { store.set('nasha-age-ok', Date.now()); gate.close(); gate.remove(); resolve(); });
      $('[data-age="no"]', gate).addEventListener('click', () => { gate.innerHTML = `<p class="brand">NASHA<span>THE RESTO BAR</span></p><h2>See you in a few years.</h2><p>Sorry, you need to be ${site.ageGate.minAge} or older to view this website.</p>`; });
      gate.showModal();
    });
  }
  function banner(site) {
    const settings = site.banner, offer = site.offers.find(entry => entry.id === settings.offerId);
    const message = settings.text || (offer ? `${offer.title} · ${offerWhen(offer)}` : '');
    let dismissed = false;
    try { dismissed = sessionStorage.getItem('nasha-banner') === message; } catch { /* Shown again next page. */ }
    if (settings.mode === 'off' || !message || dismissed) return;
    const dismiss = () => { try { sessionStorage.setItem('nasha-banner', message); } catch { /* Fine. */ } };
    if (settings.mode === 'popup') {
      const popup = document.createElement('dialog');
      popup.className = 'offer-popup';
      popup.innerHTML = `<p class="eyebrow">${offer && offerNow(offer) ? 'ON NOW AT NASHA' : 'AT NASHA'}</p><h2>${esc(offer?.title || message)}</h2><p>${offer ? esc(offerWhen(offer)) + (offer.description ? '<br>' + lines(offer.description) : '') : ''}</p><div class="age-actions"><a class="button orange" href="${esc(settings.link)}">See details ↗</a><button class="button outline">Close</button></div>`;
      document.body.append(popup);
      popup.addEventListener('close', dismiss);
      $('button', popup).addEventListener('click', () => popup.close());
      popup.showModal();
      return;
    }
    const bar = document.createElement('div');
    bar.className = 'offer-bar';
    bar.innerHTML = `<a href="${esc(settings.link)}">${esc(message)} <span aria-hidden="true">↗</span></a><button aria-label="Dismiss announcement">×</button>`;
    $('button', bar).addEventListener('click', () => { dismiss(); bar.remove(); });
    document.body.prepend(bar);
  }
  const whatsappUrl = (number, message) => `https://wa.me/${number.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`;

  // ---- Apply everything the owner manages ----------------------------------------------------------------------
  function hoursSummary(hours) {
    const open = hours.filter(day => !day.closed);
    if (open.length === 7 && open.every(day => day.open === open[0].open && day.close === open[0].close)) return `Every day · ${niceTime(open[0].open)} – ${niceTime(open[0].close)}`;
    const today = hours.find(day => day.day === istNow().day);
    return today.closed ? 'Closed today' : `Today · ${niceTime(today.open)} – ${niceTime(today.close)}`;
  }
  // Everything that differs between branches: where it is and how to reach it.
  function applyBranch(site) {
    const { info, content } = site;
    const branch = site.branches.find(entry => entry.id === store.get('nasha-branch', '')) || site.branches[0];
    branchId = branch.id;
    const whatsapp = branch.whatsapp || info.whatsapp, maps = branch.mapsUrl || info.mapsUrl, instagram = branch.instagram || site.social.instagram;
    $$('[data-branch]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.branch === branch.id)));
    $$('[data-live="branch-name"]').forEach(node => { node.textContent = branch.name; });
    $$('[data-live="branch-label"]').forEach(node => { node.textContent = branch.name.toUpperCase(); });
    $$('[data-live="hero-eyebrow"]').forEach(node => { node.textContent = content.hero.eyebrow || `${branch.name.toUpperCase()}, BENGALURU`; });
    $$('[data-live="phone"]').forEach(link => { link.href = `tel:${branch.phone}`; link.textContent = link.dataset.template.replace('{phone}', branch.phoneDisplay); });
    $$('[data-live="phone-href"]').forEach(link => { link.href = `tel:${branch.phone}`; });
    $$('[data-live="address"]').forEach(node => { node.textContent = branch.address; });
    $$('[data-live="maps"]').forEach(link => { if (maps) link.href = maps; });
    const copyAddress = $('#copy-address');
    if (copyAddress) copyAddress.dataset.address = branch.address;
    const map = $('#map-container');
    if (map) {
      map.dataset.query = `${info.name} ${branch.address}`;
      const frame = $('iframe', map);
      if (frame) frame.src = `https://maps.google.com/maps?q=${encodeURIComponent(map.dataset.query)}&output=embed`;
    }
    const extra = $('[data-live="contact-extra"]');
    if (extra) extra.innerHTML = (whatsapp ? external(whatsappUrl(whatsapp, `Hi ${info.name} ${branch.name}, I’d like to book a table.`), 'Chat on WhatsApp', 'inline-link') : '') + (info.email ? `<a class="inline-link" href="mailto:${esc(info.email)}">${esc(info.email)}</a>` : '') + (instagram ? external(instagram, 'Instagram', 'inline-link') : '');
    $('.whatsapp-float')?.remove();
    if (whatsapp) {
      const float = document.createElement('a');
      Object.assign(float, { className: 'whatsapp-float', href: whatsappUrl(whatsapp, `Hi ${info.name} ${branch.name}!`), target: '_blank', rel: 'noopener noreferrer', textContent: 'WhatsApp us' });
      document.body.append(float);
    }
    // Offers for every branch, plus any that run only at the chosen one.
    $$('[data-live="offers"]').forEach(node => {
      const list = site.offers.filter(offer => !offer.branch || offer.branch === branch.id).slice(0, Number(node.dataset.limit) || 50);
      if (list.length) node.innerHTML = list.map(offerCard).join('');
      node.scrollLeft = 0;
      if (list.length > 1) carousel(node);
    });
  }
  function apply(site) {
    const { info, social, content } = site;
    $$('[data-live="hours-summary"]').forEach(node => { node.textContent = hoursSummary(site.hours); });
    const today = istNow().day;
    const hoursTable = $('[data-live="hours-table"]');
    if (hoursTable) hoursTable.innerHTML = `<table class="hours-table"><tbody>${[1, 2, 3, 4, 5, 6, 0].map(day => { const entry = site.hours.find(item => item.day === day); return `<tr${day === today ? ' class="today"' : ''}><th scope="row">${DAYS[day]}</th><td>${entry.closed ? 'Closed' : `${niceTime(entry.open)} – ${niceTime(entry.close)}`}</td></tr>`; }).join('')}</tbody></table>${site.holidays.length ? `<p class="holiday-note">${site.holidays.slice(0, 4).map(holiday => `Closed ${esc(niceDate(holiday.date))}${holiday.note ? ` (${esc(holiday.note)})` : ''}`).join('<br>')}</p>` : ''}`;
    const socialLinks = [['instagram', 'Instagram'], ['facebook', 'Facebook'], ['youtube', 'YouTube'], ['x', 'X'], ['zomato', 'Zomato'], ['swiggy', 'Swiggy']].filter(([key]) => social[key]);
    $$('[data-live="social"]').forEach(node => { node.innerHTML = socialLinks.map(([key, label]) => `<a href="${esc(social[key])}" target="_blank" rel="noopener noreferrer">${label}</a>`).join(''); });
    $$('[data-live="order-links"]').forEach(node => { node.innerHTML = [['swiggy', 'Order on Swiggy'], ['zomato', 'Find us on Zomato']].filter(([key]) => social[key]).map(([key, label]) => external(social[key], label)).join(''); });
    $$('[data-live="order-link"]').forEach(link => { link.hidden = !site.ordering.enabled; });
    $$('[data-live="review-links"]').forEach(node => { node.innerHTML = [['googleReviews', 'Reviews on Google'], ['zomato', 'Reviews on Zomato']].filter(([key]) => social[key]).map(([key, label]) => external(social[key], label, 'inline-link')).join(''); });

    const hero = content.hero;
    if (hero.title) $$('[data-live="hero-title"]').forEach(node => { const rows = hero.title.split('\n').map(esc); node.innerHTML = rows.map((row, index) => index === rows.length - 1 && rows.length > 1 ? `<em>${row}</em>` : row).join('<br>'); });
    if (hero.description) $$('[data-live="hero-description"]').forEach(node => { node.innerHTML = lines(hero.description); });
    if (hero.image) $$('[data-live="hero-image"]').forEach(image => { image.src = hero.image; image.alt = ''; });
    const about = content.about;
    if (about.heading) $$('[data-live="about-heading"]').forEach(node => { node.innerHTML = lines(about.heading); });
    if (about.body) $$('[data-live="about-body"]').forEach(node => { node.innerHTML = paragraphs(about.body); });
    if ($('#chef') && (about.chefName || about.chefBio)) {
      $('#chef').hidden = false;
      $('[data-live="chef-name"]').textContent = about.chefName || 'Our kitchen';
      $('[data-live="chef-bio"]').innerHTML = paragraphs(about.chefBio);
      $('[data-live="chef-photo"]').innerHTML = about.chefPhoto ? `<img src="${esc(about.chefPhoto)}" alt="${esc(about.chefName || 'The kitchen team')}" loading="lazy">` : '';
    }
    if ($('#ambience') && about.ambience) { $('#ambience').hidden = false; $('[data-live="ambience"]').innerHTML = paragraphs(about.ambience); }

    $$('[data-live="events"]').forEach(node => {
      const list = site.events.slice(0, Number(node.dataset.limit) || 50);
      if (list.length) node.innerHTML = list.map(eventCard).join('');
      if (node.closest('#home-events')) $('#home-events').hidden = !list.length;
    });
    $$('[data-live="memories"]').forEach(node => {
      const list = site.memories.slice(0, Number(node.dataset.limit) || 60);
      // The home page's wall keeps its blank "your photo here" prints until there are three real ones.
      node.blanks ??= $$('.story-blank', node).map(blank => blank.outerHTML);
      if (list.length) node.innerHTML = list.map(memory => `<figure class="memory-card"><img src="${esc(memory.image)}" alt="Photo shared by ${esc(memory.name)}" loading="lazy"><figcaption>${memory.occasion ? `<em>${esc(memory.occasion)}</em>` : ''}${memory.caption ? `<b>${lines(memory.caption)}</b>` : ''}<span>${esc(memory.name)} · ${esc(niceDate(memory.date))}</span></figcaption></figure>`).join('') + node.blanks.slice(0, Math.max(0, 3 - list.length)).join('');
    });
    $$('[data-live="reviews"]').forEach(node => {
      const list = site.reviews.slice().reverse().slice(0, Number(node.dataset.limit) || 30);
      node.innerHTML = list.map(reviewCard).join('');
      if (node.closest('#home-reviews')) $('#home-reviews').hidden = !list.length;
    });
    const dialog = $('#event-dialog');
    let chosen = '';
    $$('[data-event]').forEach(button => button.addEventListener('click', () => {
      const event = site.events.find(entry => entry.id === button.dataset.event);
      if (!dialog) { location.href = 'events.html#whats-on'; return; }
      chosen = event.id;
      $('#event-dialog-detail').textContent = `${event.title} · ${niceDate(event.date)}, ${niceTime(event.time)}${event.entryFee ? ` · Entry ${rupees(event.entryFee)} per person, payable at the venue` : ''}`;
      dialog.showModal();
    }));
    if (dialog) {
      const form = $('form', dialog);
      $('[data-close]', dialog).addEventListener('click', () => dialog.close());
      bindForm(form, () => `events/${chosen}/book`, result => succeed(form, 'You’re on the list', `We’ve saved your place for ${result.title}. Refresh the page to book for another event.`), () => ({ branch: branchId }));
    }

    const grid = $('.gallery-grid');
    if (grid && site.gallery.length) {
      grid.innerHTML = site.gallery.map((photo, index) => `<button class="gallery-tile" data-gallery-category="${esc(photo.category)}" data-photo-index="${index}" data-caption="${esc(photo.caption)}" aria-label="Enlarge: ${esc(photo.caption)}"><img src="${esc(photo.image)}" alt="${esc(photo.alt)}" loading="lazy" width="1200" height="800"><span><span>${esc(photo.caption)}</span><b aria-hidden="true">↗</b></span></button>`).join('');
      // Only offer filters that have photos behind them.
      $$('[data-gallery-filter]').forEach(button => { button.hidden = button.dataset.galleryFilter !== 'all' && !site.gallery.some(photo => photo.category === button.dataset.galleryFilter); });
      initGallery();
    }

    const instagram = $('#instagram');
    if (instagram && (social.instagram || content.instagramPosts.length)) {
      instagram.hidden = false;
      const link = $('[data-live="instagram-link"]');
      if (social.instagram) link.href = social.instagram; else link.hidden = true;
      if (!content.instagramPosts.length) $('[data-live="instagram"]').hidden = true;
      $('#load-instagram').addEventListener('click', () => {
        $('[data-live="instagram"]').innerHTML = content.instagramPosts.map(url => `<blockquote class="instagram-media" data-instgrm-permalink="${esc(url)}" data-instgrm-version="14"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">View this post on Instagram ↗</a></blockquote>`).join('');
        const script = document.createElement('script');
        script.src = 'https://www.instagram.com/embed.js';
        document.body.append(script);
      });
    }

    if (reserveForm) {
      reserveForm.elements.guests.max = site.booking.maxParty;
      reserveForm.elements.date.max = addDays(istNow().date, site.booking.maxDaysAhead);
    }
    const bar = $('[data-live="branch-bar"]');
    if (bar && site.branches.length > 1) {
      bar.hidden = false;
      $('[data-live="branches"]').innerHTML = site.branches.map(branch => `<button data-branch="${esc(branch.id)}" aria-pressed="false">${esc(branch.name)}</button>`).join('');
      $$('[data-branch]').forEach(button => button.addEventListener('click', () => {
        if (button.dataset.branch === branchId) return;
        store.set('nasha-branch', button.dataset.branch);
        applyBranch(site);
        refreshSlots();
        announce(`Showing ${info.name}, ${button.textContent}.`);
      }));
    }
    applyBranch(site);
    drawMenu(site);
    drawHappyHours(site);
    drawParty(site);
    drawOrder(site);
  }

  // Pages are marked once live content is in place (or known to be unavailable).
  api('site').then(site => {
    apply(site);
    document.documentElement.dataset.live = 'ready';
    ageGate(site).then(() => banner(site));
    fetch('/api/public/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page }), keepalive: true }).catch(() => {});
  }, () => {
    // No server: the built-in pages remain fully usable.
    document.documentElement.dataset.live = 'static';
  });
})();
