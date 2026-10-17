'use strict';

// Nasha admin panel. Everything on screen is built with h(), which sets text as text,
// so customer-supplied content can never run as markup.
const app = document.querySelector('#app');
const state = { user: null, settings: null, cleanup: [], lastOrder: null, sound: false };

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (typeof value !== 'string' && key in node) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat(3).filter(child => child !== null && child !== undefined && child !== false));
  return node;
}

class ApiError extends Error {}
async function api(method, path, body) {
  let response;
  try { response = await fetch('/api/admin/' + path, { method, headers: body ? { 'Content-Type': 'application/json', 'X-Nasha-Admin': '1' } : { 'X-Nasha-Admin': '1' }, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new ApiError('Could not reach the server. Check your connection and try again.'); }
  const data = await response.json().catch(() => null);
  if (response.status === 401 && state.user) { state.user = null; showLogin(); }
  if (!response.ok) throw new ApiError(data?.error || 'Something went wrong. Please try again.');
  return data;
}
const get = path => api('GET', path);

let toastTimer;
function toast(message, error = false) {
  const node = document.querySelector('#toast');
  clearTimeout(toastTimer);
  node.textContent = message;
  node.className = error ? 'toast error' : 'toast';
  node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, error ? 7000 : 3500);
}
// Runs an action and reports a failure to the person instead of leaving the screen unchanged.
async function attempt(action, done) {
  try { const result = await action(); if (done) toast(done); return result; }
  catch (error) { if (!(error instanceof ApiError)) console.error(error); toast(error.message, true); return undefined; }
}

// ---- Formatting ------------------------------------------------------------------------------
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const addDays = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const fmtDate = date => date ? new Date(date + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
const fmtTime = time => { if (!time) return ''; const [hour, minute] = time.split(':').map(Number); return `${(hour + 11) % 12 + 1}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'pm' : 'am'}`; };
const fmtStamp = stamp => stamp ? new Date(stamp).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '';
const rupees = amount => '₹' + Number(amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const title = value => String(value).charAt(0).toUpperCase() + String(value).slice(1);
const can = permission => state.user.permissions.includes('*') || state.user.permissions.includes(permission);
const TONES = { confirmed: 'good', completed: 'good', seated: 'good', approved: 'good', sent: 'good', paid: 'good', active: 'good', booked: 'good', delivered: 'good', attended: 'good', ready: 'good', pending: 'warn', new: 'warn', requested: 'warn', manual: 'warn', received: 'warn', quoted: 'warn', preparing: 'warn', cancelled: 'bad', 'no-show': 'bad', failed: 'bad', hidden: 'bad' };
const badge = status => h('span', { class: `badge ${TONES[status] || ''}` }, status === 'manual' ? 'To send' : title(status));
const waLink = (phone, text) => `https://wa.me/${String(phone).replace(/\D/g, '')}?text=${encodeURIComponent(text || '')}`;

// ---- Building blocks -----------------------------------------------------------------------------
function table(columns, rows, empty = 'Nothing here yet.') {
  return h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, columns.map(column => h('th', { class: column.num ? 'num' : '' }, column.label)))),
    h('tbody', null, rows.length ? rows.map(row => h('tr', null, columns.map(column => h('td', { class: [column.num ? 'num' : '', column.wrap ? 'wrap' : ''].join(' ').trim() }, column.cell(row))))) : h('tr', null, h('td', { class: 'empty', colSpan: columns.length }, empty)))));
}
const pick = (options, value, onchange, label) => {
  const select = h('select', { 'aria-label': label, onchange: event => onchange(event.target.value) }, options.map(option => h('option', { value: option }, title(option))));
  select.value = value;
  return select;
};
const button = (label, onclick, kind = '') => h('button', { type: 'button', class: `btn ${kind}`.trim(), onclick }, label);

async function uploadImage(file) {
  if (file.size > 5 * 1024 * 1024) throw new ApiError('Images must be 5 MB or smaller.');
  const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new ApiError('That file could not be read.')); reader.readAsDataURL(file); });
  return (await api('POST', 'upload', { data })).path;
}

let fieldCount = 0;
// Field types: text (default), textarea, number, date, time, tel, email, password, url, select, checkbox, checks, image.
function buildFields(fields, values = {}) {
  const readers = {};
  const nodes = fields.map(field => {
    const value = values[field.name] ?? field.value ?? '';
    const id = `field-${++fieldCount}`;
    let input;
    if (field.type === 'checkbox') {
      input = h('input', { type: 'checkbox', id, checked: value === true });
      readers[field.name] = () => input.checked;
      return h('label', { class: 'field check wide' }, input, h('span', null, field.label), field.hint && h('small', null, field.hint));
    }
    if (field.type === 'checks') {
      const chosen = new Set((Array.isArray(value) ? value : []).map(String));
      const boxes = field.options.map(([key, label]) => [key, h('input', { type: 'checkbox', checked: chosen.has(String(key)) }), label]);
      readers[field.name] = () => boxes.filter(([, box]) => box.checked).map(([key]) => key);
      return h('fieldset', { class: 'field wide', style: 'border:0;padding:0;margin:0' }, h('legend', { style: 'padding:0;margin-bottom:4px' }, field.label), h('div', { class: 'checks' }, boxes.map(([, box, label]) => h('label', null, box, label))), field.hint && h('small', null, field.hint));
    }
    if (field.type === 'image') {
      let current = value;
      const preview = h('img', { alt: '', hidden: !current, src: current ? (current.startsWith('/') ? current : '/' + current) : undefined });
      const remove = button('Remove', () => { current = ''; preview.hidden = true; remove.hidden = true; }, 'link');
      remove.hidden = !current;
      input = h('input', { type: 'file', id, accept: 'image/jpeg,image/png,image/webp', onchange: async () => {
        if (!input.files[0]) return;
        const path = await attempt(() => uploadImage(input.files[0]));
        if (path) { current = path; preview.src = path; preview.hidden = false; remove.hidden = false; }
        input.value = '';
      } });
      readers[field.name] = () => current;
      return h('div', { class: 'field wide' }, h('label', { for: id }, h('span', null, field.label)), h('div', { class: 'image-field' }, preview, input, remove), h('small', null, field.hint || 'JPG, PNG or WebP, up to 5 MB.'));
    }
    if (field.type === 'select') {
      input = h('select', { id }, field.options.map(([key, label]) => h('option', { value: key }, label)));
      input.value = String(value === '' ? field.options[0][0] : value);
    } else if (field.type === 'textarea') {
      input = h('textarea', { id, rows: field.rows || 3, maxLength: field.max });
      input.value = value ?? '';
    } else {
      input = h('input', { id, type: field.type || 'text', min: field.min, max: field.type === 'number' ? field.max : undefined, maxLength: field.type === 'number' ? undefined : field.max, step: field.step, placeholder: field.placeholder, autocomplete: field.autocomplete || 'off' });
      input.value = value ?? '';
    }
    input.required = Boolean(field.required);
    readers[field.name] = () => field.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value;
    return h('label', { class: `field${field.wide || field.type === 'textarea' ? ' wide' : ''}`, for: id }, h('span', null, field.label), input, field.hint && h('small', null, field.hint));
  });
  return { node: h('div', { class: 'fields' }, nodes), read: () => Object.fromEntries(Object.entries(readers).map(([name, reader]) => [name, reader()])) };
}

// A modal form. `save` receives the values; the dialog stays open and shows the message if it fails.
function formDialog({ heading, fields, values, save, saveLabel = 'Save', intro }) {
  return new Promise(resolve => {
    const built = buildFields(fields, values);
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const submit = h('button', { class: 'btn primary', type: 'submit' }, saveLabel);
    const dialog = h('dialog', null, h('form', { onsubmit: async event => {
      event.preventDefault();
      submit.disabled = true;
      error.hidden = true;
      try { const result = await save(built.read()); dialog.close(); resolve(result ?? true); }
      catch (failure) { error.textContent = failure.message; error.hidden = false; }
      finally { submit.disabled = false; }
    } }, h('h2', null, heading), intro && h('p', { class: 'muted' }, intro), built.node, error, h('div', { class: 'dialog-actions' }, button('Cancel', () => dialog.close()), submit)));
    dialog.addEventListener('close', () => { dialog.remove(); resolve(false); });
    document.body.append(dialog);
    dialog.showModal();
  });
}
function infoDialog(heading, ...content) {
  const dialog = h('dialog', null, h('div', { class: 'body' }, h('h2', null, heading), content, h('div', { class: 'dialog-actions' }, button('Close', () => dialog.close()))));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
function confirmDialog(message, label = 'Delete') {
  return new Promise(resolve => {
    const dialog = h('dialog', null, h('div', { class: 'body' }, h('h2', null, 'Are you sure?'), h('p', null, message), h('div', { class: 'dialog-actions' }, button('Cancel', () => dialog.close()), button(label, () => { resolve(true); dialog.close(); }, 'primary'))));
    dialog.addEventListener('close', () => { dialog.remove(); resolve(false); });
    document.body.append(dialog);
    dialog.showModal();
  });
}
const remove = async (path, message, after) => { if (await confirmDialog(message) && await attempt(() => api('DELETE', path), 'Deleted.')) after(); };

function saveCsv(name, rows) {
  const body = '﻿' + rows.map(row => row.map(cell => { const value = String(cell ?? ''); return `"${(/^[=+\-@]/.test(value) ? "'" + value : value).replace(/"/g, '""')}"`; }).join(',')).join('\r\n');
  const link = h('a', { href: URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' })), download: `${name}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
function sortable(container, selector, horizontal, onDrop) {
  let dragged = null;
  container.addEventListener('dragstart', event => { dragged = event.target.closest?.(selector); if (dragged) { event.dataTransfer.effectAllowed = 'move'; dragged.classList.add('dragging'); } });
  container.addEventListener('dragover', event => {
    const over = event.target.closest?.(selector);
    if (!dragged || !over || over === dragged || over.parentNode !== dragged.parentNode) return;
    event.preventDefault();
    const box = over.getBoundingClientRect();
    const after = horizontal ? event.clientX - box.left > box.width / 2 : event.clientY - box.top > box.height / 2;
    over.parentNode.insertBefore(dragged, after ? over.nextSibling : over);
  });
  container.addEventListener('dragend', () => { if (!dragged) return; dragged.classList.remove('dragging'); onDrop([...dragged.parentNode.querySelectorAll(selector)].map(node => node.dataset.id)); dragged = null; });
}
const reorder = (collection, ids) => attempt(() => api('POST', 'reorder', { collection, ids }), 'Order saved.');
const nudge = async (collection, list, index, step, after) => {
  const ids = list.map(entry => entry.id);
  if (index + step < 0 || index + step >= ids.length) return;
  [ids[index], ids[index + step]] = [ids[index + step], ids[index]];
  if (await reorder(collection, ids)) after();
};
// Like replaceChildren, but accepts nested lists and skips the false/null left by condition && node.
const render = (parent, ...children) => parent.replaceChildren(...children.flat(3).filter(child => child !== null && child !== undefined && child !== false));
const header = (heading, ...actions) => h('div', { class: 'head' }, h('h1', null, heading), h('div', { class: 'actions' }, actions));
const byOrder = (a, b) => a.order - b.order;
const lines = value => String(value || '').split('\n').map(line => line.trim()).filter(Boolean);

// ---- Sign-in -------------------------------------------------------------------------------------
function loginCard(heading, fields, label, submit, ...extra) {
  const built = buildFields(fields);
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const send = h('button', { class: 'btn primary', type: 'submit' }, label);
  app.replaceChildren(h('div', { class: 'login' }, h('div', { class: 'logo' }, 'NASHA'), h('form', { class: 'card', onsubmit: async event => {
    event.preventDefault();
    send.disabled = true;
    error.hidden = true;
    try { await submit(built.read()); } catch (failure) { error.textContent = failure.message; error.hidden = false; } finally { send.disabled = false; }
  } }, h('h2', null, heading), built.node, error, h('div', { class: 'dialog-actions' }, send), extra)));
  app.querySelector('input')?.focus();
}
function showLogin(message) {
  loginCard('Sign in to the admin panel', [{ name: 'identifier', label: 'Email or phone', required: true, autocomplete: 'username' }, { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'current-password' }], 'Sign in', async values => {
    const result = await api('POST', 'auth/login', values);
    if (result.twoFactor) return loginCard('Two-step sign-in', [{ name: 'code', label: '6-digit code from your authenticator app', required: true, autocomplete: 'one-time-code', placeholder: '123456' }], 'Verify', async code => enter((await api('POST', 'auth/2fa', code)).user), h('p', { class: 'small muted' }, button('Back to sign in', () => showLogin(), 'link')));
    enter(result.user);
  }, message && h('p', { class: 'notice' }, message), h('p', { class: 'small' }, button('Forgot password?', showForgot, 'link')));
}
function showForgot() {
  loginCard('Reset your password', [{ name: 'identifier', label: 'Email or phone', required: true }], 'Send reset link', async values => {
    await api('POST', 'auth/forgot', values);
    showLogin('If that account exists, a reset link valid for 30 minutes has been created. It is emailed when email sending is set up; otherwise the owner can find it in the server log or set a new password for you under Team.');
  }, h('p', { class: 'small' }, button('Back to sign in', () => showLogin(), 'link')));
}
function showReset(token) {
  loginCard('Choose a new password', [{ name: 'password', label: 'New password (at least 10 characters)', type: 'password', required: true, autocomplete: 'new-password' }], 'Save password', async values => {
    await api('POST', 'auth/reset', { token, ...values });
    history.replaceState(null, '', '/admin/');
    showLogin('Password changed. Sign in with your new password.');
  });
}
function showMustChange() {
  loginCard('Choose your own password', [{ name: 'current', label: 'Temporary password', type: 'password', required: true }, { name: 'password', label: 'New password (at least 10 characters)', type: 'password', required: true, autocomplete: 'new-password' }], 'Save and continue', async values => enter((await api('POST', 'auth/password', values)).user));
}
async function enter(user) {
  state.user = user;
  if (user.mustChangePassword) return showMustChange();
  state.settings = await get('settings');
  if (!location.hash.startsWith('#/')) location.hash = can('dashboard') ? '#/dashboard' : '#/reservations';
  drawShell();
  route();
}

// ---- Shell and navigation ---------------------------------------------------------------------------
const NAV = [
  ['dashboard', 'Dashboard', 'dashboard'], ['reservations', 'Reservations', 'reservations.read'], ['menu', 'Menu', 'menu'], ['events', 'Events & nightlife', 'events'], ['party', 'Party menu', 'events'],['offers', 'Offers & vouchers', 'offers'],
  ['customers', 'Customers', 'customers'], ['reviews', 'Reviews', 'reviews'], ['memories', 'Guest memories', 'memories'],
  ['content', 'Website content', 'content'], ['reports', 'Reports', 'reports'], ['settings', 'Settings', 'settings'], ['team', 'Team & activity', 'users'], ['account', 'My account', null],
];
function drawShell() {
  const side = h('aside', { class: 'side' },
    h('div', { class: 'top' }, h('div', { class: 'logo' }, 'NASHA', h('small', null, 'ADMIN')), h('a', { class: 'site-link', href: '/', target: '_blank' }, 'View website ↗'), h('button', { class: 'menu-toggle', onclick: () => side.classList.toggle('open') }, 'Menu')),
    h('nav', { 'aria-label': 'Admin sections' }, NAV.filter(([, , permission]) => !permission || can(permission)).map(([id, label]) => h('a', { href: `#/${id}`, 'data-nav': id, onclick: () => side.classList.remove('open') }, label, h('span', { class: 'count', 'data-count': id, hidden: true })))),
    h('div', { class: 'who' }, h('b', null, state.user.name), title(state.user.role)));
  app.replaceChildren(h('div', { class: 'shell' }, side, h('main', { id: 'main' })));
}
function setCount(id, count) {
  const node = document.querySelector(`[data-count="${id}"]`);
  if (node) { node.hidden = !count; node.textContent = count; }
}
async function route() {
  if (!state.user) return;
  state.cleanup.splice(0).forEach(stop => stop());
  const id = location.hash.slice(2).split('?')[0] || 'dashboard';
  const entry = NAV.find(([name, , permission]) => name === id && (!permission || can(permission)));
  const old = document.querySelector('#main');
  if (!old) return;
  // A fresh element each time, so listeners a previous section attached do not linger.
  const main = h('main', { id: 'main' });
  old.replaceWith(main);
  document.querySelectorAll('[data-nav]').forEach(link => link.toggleAttribute('aria-current', false));
  if (!entry) { render(main, header('Not available'), h('p', null, 'You do not have access to that section.')); return; }
  document.querySelector(`[data-nav="${id}"]`).setAttribute('aria-current', 'page');
  document.title = `${entry[1]} | Nasha admin`;
  try { await VIEWS[id](main); }
  catch (error) { if (!(error instanceof ApiError)) console.error(error); render(main, header(entry[1]), h('p', { class: 'notice error' }, error.message)); }
}
window.addEventListener('hashchange', route);

const VIEWS = {};

// ---- Dashboard -----------------------------------------------------------------------------------------
VIEWS.dashboard = async main => {
  const data = await get('dashboard');
  const tile = (value, label, detail, href) => h(href ? 'a' : 'div', { class: 'tile', href, style: href ? 'text-decoration:none;color:inherit' : null }, h('b', null, String(value)), h('span', null, label), detail && h('small', null, detail));
  setCount('reviews', data.pendingReviews);
  setCount('memories', data.pendingMemories);
  render(main, 
    header('Dashboard', can('reservations.write') && button('Add booking', () => bookingDialog(null, route), 'primary'), can('events') && button('Add event', () => eventDialog(null, route)), can('menu') && h('a', { class: 'btn', href: '#/menu' }, 'Edit menu')),
    h('div', { class: 'tiles' },
      tile(data.reservations.count, 'Reservations today', `${data.reservations.guests} guests`, '#/reservations'),
      tile(data.reservations.pending, 'Requests awaiting confirmation', null, '#/reservations'),
      can('reviews') && tile(data.pendingReviews, 'Reviews to check', null, '#/reviews'),
      can('memories') && tile(data.pendingMemories, 'Guest photos to check', null, '#/memories')),
    h('h2', null, 'Website visitors'),
    h('div', { class: 'tiles' }, [['day', 'Today'], ['week', 'Last 7 days'], ['month', 'Last 30 days']].map(([key, label]) => tile(data.visitors[key].visitors, label, `${data.visitors[key].views} page views`))),
    h('div', { class: 'grid' },
      h('section', { class: 'card' }, h('h2', null, `Today’s reservations · ${fmtDate(data.date)}`), data.reservations.list.length ? table([{ label: 'Time', cell: row => fmtTime(row.time) }, { label: 'Name', cell: row => row.name }, { label: 'Guests', num: true, cell: row => row.guests }, { label: 'Status', cell: row => badge(row.status) }], data.reservations.list) : h('p', { class: 'muted' }, 'No reservations for today yet.')),
      h('section', { class: 'card' }, h('h2', null, 'Upcoming events'), data.events.length ? table([{ label: 'Date', cell: row => fmtDate(row.date) }, { label: 'Event', cell: row => row.title }, { label: '', cell: row => row.published ? '' : badge('hidden') }], data.events) : h('p', { class: 'muted' }, 'No upcoming events.'))));
};

// ---- Reservations ----------------------------------------------------------------------------------------
const STATUSES = ['pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no-show'];
const branchName = id => (state.settings.branches.find(branch => branch.id === id) || state.settings.branches[0]).name;
const branchOptions = () => state.settings.branches.map(branch => [branch.id, branch.name]);
const reservationView = { mode: 'list', from: istToday(), to: '', status: '', time: '', q: '', branch: '', month: istToday().slice(0, 7) };
function bookingDialog(existing, after) {
  return formDialog({
    heading: existing ? `Edit booking ${existing.ref}` : 'Add a phone or walk-in booking',
    fields: [
      { name: 'name', label: 'Guest name', required: true, max: 80 }, { name: 'phone', label: 'Phone', type: 'tel', required: true },
      { name: 'date', label: 'Date', type: 'date', required: true }, { name: 'time', label: 'Time', type: 'time', required: true, step: 900 },
      { name: 'guests', label: 'Guests', type: 'number', min: 1, max: 500, required: true }, { name: 'email', label: 'Email (optional)', type: 'email' },
      existing ? { name: 'status', label: 'Status', type: 'select', options: STATUSES.map(status => [status, title(status)]) } : { name: 'source', label: 'Booked by', type: 'select', options: [['phone', 'Phone call'], ['walk-in', 'Walk-in']] },
      { name: 'branch', label: 'Branch', type: 'select', options: branchOptions() },
      { name: 'notes', label: 'Notes', type: 'textarea', max: 500 },
      !existing && { name: 'notify', label: 'Send the guest a confirmation message', type: 'checkbox' },
    ].filter(Boolean),
    values: existing || { date: istToday(), guests: 2, time: '20:00' },
    // Staff can always add a booking by hand, even on a blocked date or a full slot.
    save: values => existing ? api('PUT', `reservations/${existing.id}`, values) : api('POST', 'reservations', { ...values, status: 'confirmed', force: true }),
  }).then(saved => { if (saved) { toast('Booking saved.'); after(); } });
}
function bookingSettings(after) {
  const booking = state.settings.booking;
  return formDialog({
    heading: 'Table capacity and time slots',
    fields: [
      { name: 'firstSlot', label: 'First bookable time', type: 'time', required: true }, { name: 'lastSlot', label: 'Last bookable time', type: 'time', required: true },
      { name: 'slotMinutes', label: 'A slot every', type: 'select', options: [[15, '15 minutes'], [30, '30 minutes'], [60, '60 minutes']] }, { name: 'capacityPerSlot', label: 'Seats available per slot', type: 'number', min: 1, max: 2000, required: true, hint: 'Online requests stop once a slot reaches this many guests.' },
      { name: 'maxParty', label: 'Largest online booking (guests)', type: 'number', min: 1, max: 100, required: true }, { name: 'maxDaysAhead', label: 'Bookable days ahead', type: 'number', min: 1, max: 365, required: true },
      { name: 'autoConfirm', label: 'Confirm website bookings automatically', type: 'checkbox', hint: 'When off, each request waits as Pending until you confirm it.' },
      { name: 'blocked', label: 'Blocked dates (holidays, private events)', type: 'textarea', rows: 4, hint: 'One per line: date, then an optional reason. Example: 2026-12-31 Private event' },
    ],
    values: { ...booking, blocked: booking.blockedDates.map(entry => `${entry.date} ${entry.reason}`.trim()).join('\n') },
    save: async ({ blocked, ...values }) => { state.settings = await api('PUT', 'settings/booking', { ...values, blockedDates: lines(blocked).map(line => ({ date: line.slice(0, 10), reason: line.slice(10).trim() })) }); },
  }).then(saved => { if (saved) { toast('Booking settings saved.'); after(); } });
}
VIEWS.reservations = async main => {
  const view = reservationView, write = can('reservations.write');
  const reload = () => route();
  const set = (key, value) => { view[key] = value; reload(); };
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, [['list', 'List'], ['calendar', 'Calendar']].map(([mode, label]) => h('button', { role: 'tab', 'aria-selected': String(view.mode === mode), onclick: () => set('mode', mode) }, label)));
  const top = header('Reservations', write && button('Add booking', () => bookingDialog(null, reload), 'primary'), write && button('Capacity & blocked dates', () => bookingSettings(reload)));
  if (view.mode === 'calendar') {
    const first = `${view.month}-01`, days = new Date(Date.UTC(Number(view.month.slice(0, 4)), Number(view.month.slice(5)), 0)).getUTCDate(), last = `${view.month}-${String(days).padStart(2, '0')}`;
    const rows = await get(`reservations?from=${first}&to=${last}`);
    const blocked = new Set([...state.settings.booking.blockedDates, ...state.settings.holidays].map(entry => entry.date));
    const shift = months => { const date = new Date(Date.UTC(Number(view.month.slice(0, 4)), Number(view.month.slice(5)) - 1 + months, 1)); set('month', date.toISOString().slice(0, 7)); };
    const cells = Array.from({ length: (new Date(first + 'T00:00:00Z').getUTCDay() + 6) % 7 }, () => h('span'));
    for (let day = 1; day <= days; day++) {
      const date = `${view.month}-${String(day).padStart(2, '0')}`, list = rows.filter(row => row.date === date && row.status !== 'cancelled');
      cells.push(h('button', { class: [date === istToday() ? 'today' : '', blocked.has(date) ? 'blocked' : ''].join(' ').trim(), 'aria-label': `${fmtDate(date)}: ${list.length} bookings`, onclick: () => Object.assign(view, { mode: 'list', from: date, to: date, status: '', q: '', time: '' }) && reload() }, h('b', null, String(day)), list.length ? h('span', { class: 'has' }, `${list.length} booking${list.length === 1 ? '' : 's'}`) : null, list.length ? h('span', null, `${list.reduce((sum, row) => sum + row.guests, 0)} guests`) : null, blocked.has(date) && h('span', null, 'Blocked')));
    }
    render(main, top, tabs, h('div', { class: 'toolbar' }, button('← Previous', () => shift(-1)), h('strong', null, new Date(first + 'T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })), button('Next →', () => shift(1))), h('div', { class: 'card' }, h('div', { class: 'calendar' }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => h('div', { class: 'dow' }, day)), cells)));
    return;
  }
  const query = new URLSearchParams(Object.entries({ from: view.from, to: view.to, status: view.status, time: view.time, q: view.q, branch: view.branch }).filter(([, value]) => value));
  const rows = await get(`reservations?${query}`);
  setCount('reservations', rows.filter(row => row.status === 'pending').length);
  const search = h('input', { type: 'search', placeholder: 'Name, phone or reference', value: view.q, onchange: event => set('q', event.target.value) });
  render(main, top, tabs,
    h('div', { class: 'toolbar' },
      h('label', null, 'From', h('input', { type: 'date', value: view.from, onchange: event => set('from', event.target.value) })), h('label', null, 'To', h('input', { type: 'date', value: view.to, onchange: event => set('to', event.target.value) })),
      h('label', null, 'Time', h('input', { type: 'time', value: view.time, onchange: event => set('time', event.target.value) })),
      h('label', null, 'Status', (() => { const select = h('select', { onchange: event => set('status', event.target.value) }, h('option', { value: '' }, 'All'), STATUSES.map(status => h('option', { value: status }, title(status)))); select.value = view.status; return select; })()),
      h('label', null, 'Branch', (() => { const select = h('select', { onchange: event => set('branch', event.target.value) }, h('option', { value: '' }, 'All'), state.settings.branches.map(branch => h('option', { value: branch.id }, branch.name))); select.value = view.branch; return select; })()),
      search, button('Today', () => Object.assign(view, { from: istToday(), to: istToday() }) && reload()), button('All upcoming', () => Object.assign(view, { from: istToday(), to: '', status: '', time: '', q: '' }) && reload()),
      write && h('a', { class: 'btn', href: `/api/admin/reservations/export?${query}` }, 'Export to Excel')),
    h('p', { class: 'small muted' }, `${rows.length} booking${rows.length === 1 ? '' : 's'} · ${rows.filter(row => row.status !== 'cancelled').reduce((sum, row) => sum + row.guests, 0)} guests`),
    table([
      { label: 'Date', cell: row => fmtDate(row.date) }, { label: 'Time', cell: row => fmtTime(row.time) }, { label: 'Guests', num: true, cell: row => row.guests },
      { label: 'Guest', cell: row => [h('b', null, row.name), h('div', { class: 'small muted' }, `${row.ref} · ${row.source}`)] },
      { label: 'Branch', cell: row => branchName(row.branch) },
      { label: 'Phone', cell: row => [h('a', { href: `tel:${row.phone}` }, row.phone), ' ', h('a', { class: 'small', href: waLink(row.phone, `Hi ${row.name}, this is ${state.settings.info.name} about your booking ${row.ref}.`), target: '_blank', rel: 'noopener' }, 'WhatsApp')] },
      { label: 'Status', cell: row => write ? pick(STATUSES, row.status, async status => { await attempt(() => api('PUT', `reservations/${row.id}`, { status }), `Marked ${status}.`); reload(); }, `Status for ${row.name}`) : badge(row.status) },
      { label: 'Notes', wrap: true, cell: row => row.notes },
      { label: '', cell: row => write && h('div', { class: 'actions' }, button('Edit', () => bookingDialog(row, reload), 'link'), button('Delete', () => remove(`reservations/${row.id}`, `Delete the booking for ${row.name}?`, reload), 'link danger')) },
    ], rows, 'No bookings match these filters.'));
};

// ---- Menu ---------------------------------------------------------------------------------------------------
const BADGES = ['Chef’s Special', 'Bestseller', 'New'];
const DIETS = [['veg', 'Veg'], ['nonveg', 'Non-veg'], ['alcoholic', 'Alcoholic'], ['ask', 'No tag']];
// "Happy hours" categories are the 1+1 price list; "combo" items list what is included, separated by +.
const MENU_KINDS = [['food', 'Food'], ['drink', 'Drinks'], ['happy', 'Happy hours (1+1 list)'], ['combo', 'Happy hours combos']];
VIEWS.menu = async main => {
  const [categories, items] = await Promise.all([get('categories'), get('items')]);
  categories.sort(byOrder);
  items.sort(byOrder);
  const reload = () => route();
  const categoryDialog = existing => formDialog({ heading: existing ? 'Edit category' : 'Add category', fields: [{ name: 'name', label: 'Name', required: true, max: 40 }, { name: 'kind', label: 'Type', type: 'select', options: MENU_KINDS }, { name: 'note', label: 'Note under the name (optional)', max: 60, hint: 'Shown on happy hours cards, for example “5 pints + 1 starter”.' }, { name: 'photo', label: 'Photo for the happy hours card', type: 'image' }], values: existing || { kind: 'food' }, save: values => existing ? api('PUT', `categories/${existing.id}`, values) : api('POST', 'categories', values) }).then(saved => saved && reload());
  const itemDialog = (existing, categoryId) => formDialog({
    heading: existing ? `Edit ${existing.name}` : 'Add menu item',
    fields: [
      { name: 'name', label: 'Name', required: true, max: 80 }, { name: 'categoryId', label: 'Category', type: 'select', options: categories.map(category => [category.id, category.name]) },
      { name: 'price', label: 'Price (₹)', type: 'number', min: 0, step: 'any', hint: 'Leave empty to show “Ask for current price”.' }, { name: 'diet', label: 'Tag', type: 'select', options: DIETS },
      { name: 'description', label: 'Description', type: 'textarea', max: 300 }, { name: 'badges', label: 'Badges', type: 'checks', options: BADGES.map(name => [name, name]) },
      { name: 'photo', label: 'Photo', type: 'image' }, { name: 'available', label: 'Available (untick when out of stock)', type: 'checkbox' },
    ],
    values: existing || { categoryId, available: true, diet: 'veg' },
    save: values => existing ? api('PUT', `items/${existing.id}`, values) : api('POST', 'items', values),
  }).then(saved => saved && reload());
  const bulkPrice = () => formDialog({
    heading: 'Bulk price update', saveLabel: 'Update prices', intro: 'Raises or lowers every priced item in the chosen category. This cannot be undone automatically, but you can apply the opposite change.',
    fields: [{ name: 'categoryId', label: 'Apply to', type: 'select', options: [['all', 'All categories'], ...categories.map(category => [category.id, category.name])] }, { name: 'percent', label: 'Change (%)', type: 'number', step: 'any', min: -90, max: 500, required: true, hint: 'For example 5 for +5%, or -10 for 10% off.' }, { name: 'roundTo', label: 'Round to the nearest', type: 'select', options: [[1, '₹1'], [5, '₹5'], [10, '₹10']] }],
    save: async values => { const result = await api('POST', 'menu/bulk-price', values); toast(`${result.updated} prices updated.`); },
  }).then(saved => saved && reload());
  const qrDialog = () => {
    const base = state.settings.info.siteUrl || location.origin;
    const sheet = h('div', { class: 'qr-sheet' });
    const tables = h('input', { type: 'number', min: 0, max: 60, value: 0, 'aria-label': 'Number of tables' });
    const draw = () => {
      const count = Math.min(60, Number(tables.value) || 0);
      sheet.replaceChildren(...(count ? Array.from({ length: count }, (unused, index) => index + 1) : [null]).map(number => {
        const code = qrcode(0, 'M');
        code.addData(`${base}/menu.html${number ? `?table=${number}` : ''}`);
        code.make();
        const figure = h('figure', null, h('div'), h('figcaption', null, number ? `Table ${number}` : 'Scan for our menu'), h('div', { class: 'small muted' }, state.settings.info.name));
        figure.firstChild.innerHTML = code.createSvgTag({ cellSize: 5, margin: 8, scalable: false }); // Markup produced by the bundled QR library from a URL we built.
        return figure;
      }));
    };
    const dialog = infoDialog('QR code menu', h('p', null, 'Guests scan the code to open the live menu on their phone. It always shows your current items, prices and availability, so it never needs reprinting.'),
      /localhost|127\.0\.0\.1/.test(base) && h('p', { class: 'notice' }, 'These codes point to this computer. Set your public website address under Settings → Restaurant details before printing.'),
      h('div', { class: 'toolbar no-print' }, h('label', null, 'One code per table, tables 1 to', tables), button('Print', () => { document.body.classList.add('printing-dialog'); window.print(); document.body.classList.remove('printing-dialog'); }, 'primary')), sheet);
    tables.addEventListener('input', draw);
    dialog.style.width = 'min(900px, calc(100vw - 24px))';
    draw();
  };
  const sections = categories.map((category, index) => {
    const list = items.filter(item => item.categoryId === category.id);
    return h('section', { class: 'card', style: 'padding:0' },
      h('div', { class: 'cat-head' }, h('h2', null, category.name, h('span', { class: 'muted small' }, ` · ${list.length} item${list.length === 1 ? '' : 's'}`), ['happy', 'combo'].includes(category.kind) && h('span', { class: 'tag' }, MENU_KINDS.find(([key]) => key === category.kind)[1])),
        h('div', { class: 'actions' }, button('↑', () => nudge('categories', categories, index, -1, reload), 'tiny'), button('↓', () => nudge('categories', categories, index, 1, reload), 'tiny'), button('Add item', () => itemDialog(null, category.id), 'tiny'), button('Rename', () => categoryDialog(category), 'link'), button('Delete', () => remove(`categories/${category.id}`, `Delete the ${category.name} category?`, reload), 'link danger'))),
      list.length ? list.map((item, position) => h('div', { class: 'item-row', draggable: true, 'data-id': item.id },
        h('span', { class: 'grip', title: 'Drag to reorder', 'aria-hidden': 'true' }, '⠿'),
        h('div', { class: 'name' }, h('b', null, item.name, ' ', item.badges.map(name => h('span', { class: 'tag' }, name))), h('span', null, item.description)),
        h('span', null, h('span', { class: 'tag' }, DIETS.find(([key]) => key === item.diet)[1])),
        h('span', { style: 'font-weight:600' }, item.price === null ? h('span', { class: 'muted' }, 'No price') : rupees(item.price)),
        h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: item.available, onchange: async event => { await attempt(() => api('PUT', `items/${item.id}`, { available: event.target.checked }), event.target.checked ? `${item.name} is available.` : `${item.name} marked out of stock.`); reload(); } }), item.available ? 'Available' : 'Out of stock'),
        h('div', { class: 'actions' }, button('↑', () => nudge('items', list, position, -1, reload), 'tiny'), button('↓', () => nudge('items', list, position, 1, reload), 'tiny'), button('Edit', () => itemDialog(item), 'link'), button('Delete', () => remove(`items/${item.id}`, `Delete ${item.name} from the menu?`, reload), 'link danger')))) : h('p', { class: 'muted', style: 'padding:14px;margin:0' }, 'No items yet. Empty categories are hidden on the website.'));
  });
  render(main, header('Menu', button('Add item', () => itemDialog(null, categories[0]?.id), 'primary'), button('Add category', () => categoryDialog()), button('Bulk price update', bulkPrice), button('QR code menu', qrDialog)), h('p', { class: 'muted small' }, 'Drag items by the handle, or use the arrows, to change the order guests see. Changes appear on the website straight away. Categories tagged “Happy hours” make up the happy hours menu on the Food & drinks and Offers pages; for a combo, list what is included in its description, separated by +.'), sections);
  sortable(main, '.item-row', false, ids => reorder('items', ids));
};

// ---- Events ----------------------------------------------------------------------------------------------------
const EVENT_TYPES = [['dj', 'DJ night'], ['live', 'Live music'], ['karaoke', 'Karaoke'], ['sports', 'Sports screening'], ['other', 'Other']];
function eventDialog(existing, after) {
  return formDialog({
    heading: existing ? 'Edit event' : 'Add event',
    fields: [
      { name: 'title', label: 'Title', required: true, max: 100, wide: true }, { name: 'type', label: 'Type', type: 'select', options: EVENT_TYPES }, { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'time', label: 'Starts', type: 'time', required: true }, { name: 'endTime', label: 'Ends (optional)', type: 'time' },
      { name: 'entryFee', label: 'Entry fee per person (₹)', type: 'number', min: 0, step: 'any', hint: 'Empty = not shown. 0 = “Free entry”.' }, { name: 'bookingLimit', label: 'Booking limit (guests)', type: 'number', min: 1, hint: 'Empty = no limit.' },
      { name: 'description', label: 'Description', type: 'textarea', max: 800 }, { name: 'poster', label: 'Poster', type: 'image' }, { name: 'published', label: 'Show on the website', type: 'checkbox' },
    ],
    values: existing || { published: true, type: 'dj', date: istToday(), time: '20:00' },
    save: values => existing ? api('PUT', `events/${existing.id}`, values) : api('POST', 'events', values),
  }).then(saved => { if (saved) { toast('Event saved.'); after(); } });
}
let showPastEvents = false;
VIEWS.events = async main => {
  const [events, bookings] = await Promise.all([get('events'), get('event-bookings')]);
  const reload = () => route(), today = istToday();
  const booked = event => bookings.filter(entry => entry.eventId === event.id && entry.status !== 'cancelled').reduce((sum, entry) => sum + entry.guests, 0);
  const guestList = event => {
    const list = bookings.filter(entry => entry.eventId === event.id);
    const dialog = infoDialog(`Guest list · ${event.title}`, table([{ label: 'Name', cell: row => row.name }, { label: 'Phone', cell: row => h('a', { href: `tel:${row.phone}` }, row.phone) }, { label: 'Guests', num: true, cell: row => row.guests }, { label: 'Status', cell: row => pick(['booked', 'attended', 'cancelled'], row.status, status => attempt(() => api('PUT', `event-bookings/${row.id}`, { status }), `Marked ${status}.`), `Status for ${row.name}`) }], list, 'No one has booked yet.'), list.length > 0 && button('Download list', () => saveCsv(`guest-list-${event.date}`, [['Name', 'Phone', 'Guests', 'Status'], ...list.map(row => [row.name, row.phone, row.guests, row.status])])));
    dialog.addEventListener('close', reload);
  };
  const rows = events.filter(event => showPastEvents || event.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  render(main, header('Events & nightlife', button('Add event', () => eventDialog(null, reload), 'primary')),
    h('div', { class: 'toolbar' }, h('label', null, h('input', { type: 'checkbox', checked: showPastEvents, onchange: event => { showPastEvents = event.target.checked; reload(); } }), 'Show past events'), h('span', { class: 'small muted' }, 'Past events are hidden from the website automatically.')),
    table([
      { label: 'Date', cell: row => [fmtDate(row.date), row.date < today && h('div', null, h('span', { class: 'badge' }, 'Past'))] }, { label: 'Time', cell: row => fmtTime(row.time) },
      { label: 'Event', cell: row => [h('b', null, row.title), h('div', { class: 'small muted' }, EVENT_TYPES.find(([key]) => key === row.type)[1])] },
      { label: 'Entry', cell: row => row.entryFee === null ? '—' : row.entryFee === 0 ? 'Free' : rupees(row.entryFee) }, { label: 'Booked', num: true, cell: row => `${booked(row)}${row.bookingLimit ? ` / ${row.bookingLimit}` : ''}` },
      { label: 'Website', cell: row => badge(row.published ? 'active' : 'hidden') },
      { label: '', cell: row => h('div', { class: 'actions' }, button('Guest list', () => guestList(row), 'link'), button('Edit', () => eventDialog(row, reload), 'link'), button('Delete', () => remove(`events/${row.id}`, `Delete ${row.title} and its guest list?`, reload), 'link danger')) },
    ], rows, 'No upcoming events. Add one to show it on the website.'));
};

// ---- Party menu --------------------------------------------------------------------------------------------------
const PARTY_KINDS = [['package', 'Package'], ['course', 'Dishes to choose from'], ['terms', 'Terms & conditions']];
VIEWS.party = async main => {
  const entries = (await get('party')).sort((a, b) => a.order - b.order);
  const reload = () => route();
  const partyDialog = (existing, kind) => formDialog({
    heading: existing ? `Edit ${existing.name}` : `Add ${PARTY_KINDS.find(([key]) => key === kind)[1].toLowerCase()}`,
    fields: [
      { name: 'name', label: 'Name', required: true, max: 60 },
      kind === 'package' && { name: 'price', label: 'Price per guest (₹)', type: 'number', min: 0, step: 'any', required: true },
      { name: 'details', label: kind === 'package' ? 'What is included' : 'One per line', type: 'textarea', max: 4000, wide: true, hint: 'One entry per line. Start a line with “# ” to make it a heading, e.g. “# Beverages”.' },
    ].filter(Boolean),
    values: existing || { kind }, save: values => existing ? api('PUT', `party/${existing.id}`, { ...values, kind }) : api('POST', 'party', { ...values, kind }),
  }).then(saved => { if (saved) { toast('Party menu saved.'); reload(); } });
  const lineCount = row => row.details.split('\n').filter(line => line.trim() && !line.startsWith('# ')).length;
  const section = (kind, heading, addLabel) => {
    const rows = entries.filter(entry => entry.kind === kind);
    return [h('h2', null, heading), table([
      { label: 'Name', cell: row => h('b', null, row.name) },
      kind === 'package' && { label: 'Per guest', num: true, cell: row => rupees(row.price) },
      { label: 'Lines', num: true, cell: lineCount },
      { label: '', cell: row => h('div', { class: 'actions' }, button('Edit', () => partyDialog(row, kind), 'link'), button('Delete', () => remove(`party/${row.id}`, `Delete ${row.name} from the party menu?`, reload), 'link danger')) },
    ].filter(Boolean), rows, 'Nothing here yet.'), (kind !== 'terms' || !rows.length) && h('p', null, button(addLabel, () => partyDialog(null, kind)))];
  };
  render(main, header('Party menu'), h('p', { class: 'muted small' }, 'Shown on the Events page under “Party packages”. Changes appear on the website straight away.'),
    section('package', 'Packages', 'Add package'), section('course', 'Dishes guests choose from', 'Add dish list'), section('terms', 'Terms & conditions', 'Add terms'));
};

// ---- Offers, banner, coupons, vouchers ----------------------------------------------------------------------------
const WEEK = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
VIEWS.offers = async main => {
  const [offers, coupons, vouchers] = await Promise.all([get('offers'), get('coupons'), get('vouchers')]);
  const reload = () => route();
  const offerDialog = existing => formDialog({
    heading: existing ? 'Edit offer' : 'Add offer',
    fields: [
      { name: 'title', label: 'Title', required: true, max: 100, wide: true, placeholder: 'e.g. 1+1 on beer' }, { name: 'description', label: 'Details', type: 'textarea', max: 400 },
      { name: 'days', label: 'Days of the week', type: 'checks', options: WEEK, hint: 'Leave all unticked for every day.' },
      { name: 'startTime', label: 'From (time)', type: 'time' }, { name: 'endTime', label: 'Until (time)', type: 'time' }, { name: 'startDate', label: 'Starts on (optional)', type: 'date' }, { name: 'endDate', label: 'Ends on (optional)', type: 'date' },
      { name: 'branch', label: 'Runs at', type: 'select', options: [['', 'Both branches'], ...branchOptions()] }, { name: 'couponCode', label: 'Coupon code to show (optional)', max: 20 },
      { name: 'photo', label: 'Photo (optional)', type: 'image', hint: 'Shown on the offer card. Without one, the website picks a photo that suits the offer.' }, { name: 'active', label: 'Show on the website', type: 'checkbox' },
    ],
    values: existing || { active: true, days: [] }, save: values => existing ? api('PUT', `offers/${existing.id}`, values) : api('POST', 'offers', values),
  }).then(saved => saved && reload());
  const couponDialog = existing => formDialog({
    heading: existing ? 'Edit coupon' : 'Add coupon', intro: 'Coupons are applied by guests at checkout when online ordering is switched on.',
    fields: [
      { name: 'code', label: 'Code', required: true, max: 20, placeholder: 'NASHA10' }, { name: 'type', label: 'Discount type', type: 'select', options: [['percent', 'Percentage off'], ['flat', 'Fixed amount off (₹)']] },
      { name: 'value', label: 'Discount', type: 'number', min: 0, step: 'any', required: true }, { name: 'minOrder', label: 'Minimum order (₹)', type: 'number', min: 0, step: 'any' },
      { name: 'startDate', label: 'Valid from (optional)', type: 'date' }, { name: 'endDate', label: 'Valid until (optional)', type: 'date' }, { name: 'maxUses', label: 'Maximum uses', type: 'number', min: 0, hint: '0 or empty = unlimited.' }, { name: 'active', label: 'Active', type: 'checkbox' },
    ],
    values: existing || { active: true, type: 'percent' }, save: values => existing ? api('PUT', `coupons/${existing.id}`, values) : api('POST', 'coupons', values),
  }).then(saved => saved && reload());
  const voucherDialog = () => formDialog({ heading: 'Add gift voucher', intro: 'Use this for vouchers sold at the restaurant. Issue the code once payment has been received.', fields: [{ name: 'amount', label: 'Value (₹)', type: 'number', min: 100, max: 50000, required: true }, { name: 'recipientName', label: 'Recipient', required: true, max: 80 }, { name: 'buyerName', label: 'Buyer name', required: true, max: 80 }, { name: 'buyerPhone', label: 'Buyer phone', type: 'tel', required: true }, { name: 'message', label: 'Message', type: 'textarea', max: 300 }], save: values => api('POST', 'vouchers', values) }).then(saved => saved && reload());
  const voucherAction = async (voucher, action) => {
    if (action === 'redeem') return formDialog({ heading: `Redeem ${voucher.code}`, intro: `Balance: ${rupees(voucher.balance)}`, saveLabel: 'Redeem', fields: [{ name: 'amount', label: 'Amount used (₹)', type: 'number', min: 1, max: voucher.balance, step: 'any', required: true, value: voucher.balance }], save: values => api('PUT', `vouchers/${voucher.id}`, { action, ...values }) }).then(saved => saved && reload());
    if (action === 'cancel' && !await confirmDialog('Cancel this voucher? It can no longer be redeemed.', 'Cancel voucher')) return;
    if (action === 'issue' && !await confirmDialog(`Issue this ₹${voucher.amount} voucher? Only do this once payment has been received. The buyer is sent the code.`, 'Issue voucher')) return;
    if (await attempt(() => api('PUT', `vouchers/${voucher.id}`, { action }), 'Voucher updated.')) reload();
  };
  const banner = buildFields([
    { name: 'mode', label: 'Homepage announcement', type: 'select', options: [['off', 'Off'], ['bar', 'Bar across the top of every page'], ['popup', 'Pop-up, once per visit']] },
    { name: 'offerId', label: 'Offer to announce', type: 'select', options: [['', 'None (use the text below)'], ...offers.filter(offer => offer.active).map(offer => [offer.id, offer.title])] },
    { name: 'text', label: 'Custom text (optional)', max: 140, wide: true, hint: 'Leave empty to use the offer’s title and schedule.' },
  ], state.settings.banner);
  const schedule = offer => [offer.days.length && offer.days.length < 7 ? WEEK.filter(([day]) => offer.days.includes(day)).map(([, name]) => name).join(', ') : 'Every day', offer.startTime && offer.endTime ? `${fmtTime(offer.startTime)} – ${fmtTime(offer.endTime)}` : '', offer.startDate ? `from ${fmtDate(offer.startDate)}` : '', offer.endDate ? `until ${fmtDate(offer.endDate)}` : ''].filter(Boolean).join(' · ');
  render(main, header('Offers & vouchers', button('Add offer', () => offerDialog(), 'primary')),
    h('h2', null, 'Offers & happy hours'),
    table([{ label: 'Photo', cell: row => row.photo ? h('img', { class: 'offer-thumb', src: row.photo, alt: '' }) : h('span', { class: 'small muted' }, 'Auto') }, { label: 'Offer', cell: row => [h('b', null, row.title), h('div', { class: 'small muted' }, row.description)] }, { label: 'When', cell: schedule }, { label: 'Branch', cell: row => row.branch ? branchName(row.branch) : 'Both' }, { label: 'Code', cell: row => row.couponCode }, { label: 'Website', cell: row => badge(row.active ? (row.endDate && row.endDate < istToday() ? 'ended' : 'active') : 'hidden') }, { label: '', cell: row => h('div', { class: 'actions' }, button('Edit', () => offerDialog(row), 'link'), button('Delete', () => remove(`offers/${row.id}`, `Delete the offer “${row.title}”?`, reload), 'link danger')) }], offers, 'No offers yet.'),
    h('section', { class: 'card' }, h('h2', null, 'Homepage banner / pop-up'), banner.node, h('div', { class: 'dialog-actions' }, button('Save banner', async () => { const saved = await attempt(() => api('PUT', 'settings/banner', banner.read()), 'Banner saved.'); if (saved) state.settings = saved; }, 'primary'))),
    h('div', { class: 'head' }, h('h2', null, 'Coupon codes'), button('Add coupon', () => couponDialog())),
    table([{ label: 'Code', cell: row => h('b', null, row.code) }, { label: 'Discount', cell: row => row.type === 'percent' ? `${row.value}% off` : `${rupees(row.value)} off` }, { label: 'Minimum', cell: row => row.minOrder ? rupees(row.minOrder) : '—' }, { label: 'Valid', cell: row => [row.startDate && `from ${fmtDate(row.startDate)}`, row.endDate && `until ${fmtDate(row.endDate)}`].filter(Boolean).join(' ') || 'Always' }, { label: 'Used', num: true, cell: row => `${row.used}${row.maxUses ? ` / ${row.maxUses}` : ''}` }, { label: 'Status', cell: row => badge(row.active ? 'active' : 'hidden') }, { label: '', cell: row => h('div', { class: 'actions' }, button('Edit', () => couponDialog(row), 'link'), button('Delete', () => remove(`coupons/${row.id}`, `Delete coupon ${row.code}?`, reload), 'link danger')) }], coupons, 'No coupon codes yet.'),
    h('div', { class: 'head' }, h('h2', null, 'Gift vouchers'), button('Add voucher', voucherDialog)),
    table([{ label: 'Requested', cell: row => fmtStamp(row.createdAt) }, { label: 'Value', num: true, cell: row => rupees(row.amount) }, { label: 'For', cell: row => [row.recipientName, row.message && h('div', { class: 'small muted' }, row.message)] }, { label: 'Buyer', cell: row => [row.buyerName, h('div', { class: 'small' }, h('a', { href: `tel:${row.buyerPhone}` }, row.buyerPhone))] }, { label: 'Code', cell: row => row.code || '—' }, { label: 'Balance', num: true, cell: row => row.code ? rupees(row.balance) : '—' }, { label: 'Status', cell: row => badge(row.status) },
      { label: '', cell: row => h('div', { class: 'actions' }, row.status === 'requested' && button('Issue code', () => voucherAction(row, 'issue'), 'link'), row.status === 'active' && button('Redeem', () => voucherAction(row, 'redeem'), 'link'), ['requested', 'active'].includes(row.status) && button('Cancel', () => voucherAction(row, 'cancel'), 'link danger')) }], vouchers.slice().reverse(), 'No voucher requests yet.'));
};

// ---- Customers ---------------------------------------------------------------------------------------------------------
let customerSearch = '', customerTag = '';
VIEWS.customers = async main => {
  const customers = await get('customers');
  const reload = () => route(), today = istToday();
  const tags = [...new Set(customers.flatMap(customer => customer.tags))].sort();
  const customerDialog = existing => formDialog({
    heading: existing ? `Edit ${existing.name}` : 'Add customer',
    fields: [{ name: 'name', label: 'Name', required: true, max: 80 }, { name: 'phone', label: 'Phone', type: 'tel', required: true }, { name: 'email', label: 'Email', type: 'email' }, { name: 'tagText', label: 'Tags', hint: 'Separate with commas, e.g. VIP, Regular', value: existing?.tags.join(', ') },
      { name: 'birthday', label: 'Birthday', type: 'date' }, { name: 'anniversary', label: 'Anniversary', type: 'date' }, { name: 'notes', label: 'Notes', type: 'textarea', max: 600 }, { name: 'optIn', label: 'Has agreed to receive offers and promotions', type: 'checkbox' }],
    values: existing, save: ({ tagText, ...values }) => { const body = { ...values, tags: tagText.split(',').map(tag => tag.trim()).filter(Boolean) }; return existing ? api('PUT', `customers/${existing.id}`, body) : api('POST', 'customers', body); },
  }).then(saved => saved && reload());
  const toggleTag = async (customer, tag) => { const tagsNow = customer.tags.includes(tag) ? customer.tags.filter(entry => entry !== tag) : [...customer.tags, tag]; if (await attempt(() => api('PUT', `customers/${customer.id}`, { tags: tagsNow }), 'Tags updated.')) reload(); };
  const history = async customer => {
    const data = await attempt(() => get(`customers/${customer.id}/history`));
    if (!data) return;
    infoDialog(`${customer.name} · visit history`,
      h('h3', null, 'Table bookings'), table([{ label: 'Date', cell: row => fmtDate(row.date) }, { label: 'Time', cell: row => fmtTime(row.time) }, { label: 'Guests', num: true, cell: row => row.guests }, { label: 'Status', cell: row => badge(row.status) }], data.reservations, 'No bookings.'),
      data.orders.length > 0 && [h('h3', null, 'Online orders'), table([{ label: 'Order', cell: row => `#${row.number}` }, { label: 'When', cell: row => fmtStamp(row.createdAt) }, { label: 'Total', num: true, cell: row => rupees(row.total) }, { label: 'Status', cell: row => badge(row.status) }], data.orders)],
      data.inquiries.length > 0 && [h('h3', null, 'Party inquiries'), table([{ label: 'Occasion', cell: row => row.type }, { label: 'Date', cell: row => fmtDate(row.date) }, { label: 'Guests', num: true, cell: row => row.guests }, { label: 'Status', cell: row => badge(row.status) }], data.inquiries)],
      data.events.length > 0 && [h('h3', null, 'Events'), table([{ label: 'Event', cell: row => row.title }, { label: 'Guests', num: true, cell: row => row.guests }, { label: 'Status', cell: row => badge(row.status) }], data.events)]);
  };
  const promote = () => formDialog({
    heading: 'Send a promotion', saveLabel: 'Queue messages', intro: 'Promotions go only to customers who have agreed to receive offers. Write {name} to insert each person’s first name.',
    fields: [
      { name: 'audience', label: 'Send to', type: 'select', options: [['optin', 'Everyone who accepts offers'], ['tag', 'Customers with a tag'], ['birthday', 'Birthdays this month'], ['anniversary', 'Anniversaries this month']] }, { name: 'tag', label: 'Tag (when sending by tag)', type: 'select', options: [['', '—'], ...tags.map(tag => [tag, tag])] },
      { name: 'channel', label: 'Channel', type: 'select', options: [['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['email', 'Email']] }, { name: 'subject', label: 'Subject (email only)', max: 100 }, { name: 'message', label: 'Message', type: 'textarea', rows: 5, max: 1000, required: true, value: 'Hi {name}, ' },
    ],
    save: async values => {
      const { count } = await api('POST', 'promotions/preview', values);
      if (!count) throw new ApiError('No customers match that audience (only customers who accept offers are included).');
      if (!await confirmDialog(`Send this message to ${count} customer${count === 1 ? '' : 's'}?`, 'Send')) throw new ApiError('Not sent. You can edit the message and try again.');
      const result = await api('POST', 'promotions', values);
      toast(result.automatic ? `${result.queued} messages are being sent.` : `${result.queued} messages are saved. Connect a messaging provider under Settings → Notifications to send them.`);
    },
  });
  // Birthdays and anniversaries falling in the next 30 days, whatever the year.
  const upcoming = customers.flatMap(customer => [['Birthday', customer.birthday], ['Anniversary', customer.anniversary]].filter(([, date]) => date).map(([kind, date]) => { let next = today.slice(0, 5) + date.slice(5); if (next < today) next = (Number(today.slice(0, 4)) + 1) + next.slice(4); return { customer, kind, next }; })).filter(entry => entry.next <= addDays(today, 30)).sort((a, b) => a.next.localeCompare(b.next));
  const search = customerSearch.toLowerCase();
  const rows = customers.filter(customer => (!customerTag || customer.tags.includes(customerTag)) && (!search || `${customer.name} ${customer.phone} ${customer.email}`.toLowerCase().includes(search))).sort((a, b) => a.name.localeCompare(b.name));
  render(main, header('Customers', button('Add customer', () => customerDialog(), 'primary'), button('Send promotion', promote), h('a', { class: 'btn', href: '/api/admin/customers/export' }, 'Export to Excel')),
    upcoming.length > 0 && h('section', { class: 'card' }, h('h2', null, 'Birthdays & anniversaries in the next 30 days'), h('ul', { class: 'notes' }, upcoming.map(entry => h('li', null, h('b', null, entry.customer.name), ` · ${entry.kind} on ${fmtDate(entry.next)} · `, h('a', { href: waLink(entry.customer.phone, `Hi ${entry.customer.name.split(' ')[0]}, warm wishes from ${state.settings.info.name}!`), target: '_blank', rel: 'noopener' }, 'Send wishes'))))),
    h('div', { class: 'toolbar' }, h('input', { type: 'search', placeholder: 'Search name, phone or email', value: customerSearch, style: 'width:260px', onchange: event => { customerSearch = event.target.value; reload(); } }), h('label', null, 'Tag', (() => { const select = h('select', { onchange: event => { customerTag = event.target.value; reload(); } }, h('option', { value: '' }, 'All'), tags.map(tag => h('option', { value: tag }, tag))); select.value = customerTag; return select; })()), h('span', { class: 'small muted' }, `${rows.length} of ${customers.length} customers`)),
    table([
      { label: 'Customer', cell: row => [h('b', null, row.name), ' ', row.tags.map(tag => h('span', { class: 'tag' }, tag)), row.notes && h('div', { class: 'small muted' }, row.notes)] },
      { label: 'Contact', cell: row => [h('a', { href: `tel:${row.phone}` }, row.phone), row.email && h('div', { class: 'small' }, row.email)] },
      { label: 'Visits', num: true, cell: row => row.visits }, { label: 'Last visit', cell: row => row.lastVisit ? fmtDate(row.lastVisit) : '—' }, { label: 'Bookings', num: true, cell: row => row.bookings }, { label: 'Orders', num: true, cell: row => row.orders ? `${row.orders} · ${rupees(row.spend)}` : 0 },
      { label: 'Birthday', cell: row => row.birthday ? fmtDate(row.birthday).replace(/ \d{4}$/, '').replace(/^\w+, /, '') : '' }, { label: 'Offers', cell: row => row.optIn ? badge('active') : h('span', { class: 'muted small' }, 'No') },
      { label: '', cell: row => h('div', { class: 'actions' }, button(row.tags.includes('VIP') ? 'Remove VIP' : 'Mark VIP', () => toggleTag(row, 'VIP'), 'link'), button(row.tags.includes('Regular') ? 'Remove Regular' : 'Mark Regular', () => toggleTag(row, 'Regular'), 'link'), button('History', () => history(row), 'link'), button('Edit', () => customerDialog(row), 'link'), button('Delete', () => remove(`customers/${row.id}`, `Delete ${row.name} from your customer list? Their past bookings are kept.`, reload), 'link danger')) },
    ], rows, 'No customers yet. They are added automatically from bookings, inquiries, orders and sign-ups.'));
};

// ---- Messages ------------------------------------------------------------------------------------------------------------
VIEWS.messages = async main => {
  const messages = await get('messages');
  const reload = () => route(), config = state.settings.notifications;
  setCount('messages', messages.filter(message => message.status !== 'sent').length);
  const automatic = config.webhookUrl || (config.twilioSid && config.twilioTokenSet);
  const act = (message, action) => attempt(() => api('PUT', `messages/${message.id}`, { action }), action === 'retry' ? 'Tried again.' : 'Marked as sent.').then(reload);
  const sendLink = message => message.channel === 'email' ? `mailto:${message.to}?subject=${encodeURIComponent(message.subject)}&body=${encodeURIComponent(message.text)}` : message.channel === 'sms' ? `sms:${message.to}?body=${encodeURIComponent(message.text)}` : waLink(message.to, message.text);
  render(main, header('Messages'),
    h('p', { class: 'notice' }, automatic ? 'Messages are sent automatically through your messaging provider. Anything that fails is listed here to retry or send by hand.' : 'No messaging provider is connected yet, so confirmations and promotions wait here. Use “Open” to send each one from your own WhatsApp, SMS or email, then mark it as sent. Connect a provider under Settings → Notifications to send automatically.'),
    table([
      { label: 'When', cell: row => fmtStamp(row.at) }, { label: 'To', cell: row => [row.to, h('div', { class: 'small muted' }, `${title(row.channel)} · ${row.kind}`)] }, { label: 'Message', wrap: true, cell: row => row.text },
      { label: 'Status', cell: row => [badge(row.status), row.error && h('div', { class: 'small muted' }, row.error)] },
      { label: '', cell: row => row.status !== 'sent' && h('div', { class: 'actions' }, h('a', { class: 'btn link', href: sendLink(row), target: '_blank', rel: 'noopener' }, `Open in ${row.channel === 'email' ? 'email' : row.channel === 'sms' ? 'SMS' : 'WhatsApp'}`), button('Mark sent', () => act(row, 'sent'), 'link'), automatic && button('Retry', () => act(row, 'retry'), 'link')) },
    ], messages, 'No messages yet.'));
};

// ---- Reviews ---------------------------------------------------------------------------------------------------------------
VIEWS.reviews = async main => {
  const reviews = (await get('reviews')).reverse();
  const reload = () => route();
  setCount('reviews', reviews.filter(review => review.status === 'pending').length);
  const set = (review, status) => attempt(() => api('PUT', `reviews/${review.id}`, { status }), status === 'approved' ? 'Published on the website.' : 'Hidden from the website.').then(reload);
  const reply = review => formDialog({ heading: `Reply to ${review.name}`, intro: 'Your reply is shown under the review on the website.', fields: [{ name: 'reply', label: 'Reply', type: 'textarea', rows: 4, max: 600 }], values: review, save: values => api('PUT', `reviews/${review.id}`, values) }).then(saved => saved && reload());
  render(main, header('Reviews & feedback'), h('p', { class: 'muted small' }, 'Feedback sent from the website stays private until you approve it.'), table([
    { label: 'Received', cell: row => fmtStamp(row.createdAt) }, { label: 'From', cell: row => row.name }, { label: 'Rating', cell: row => h('span', { 'aria-label': `${row.rating} out of 5` }, '★'.repeat(row.rating) + '☆'.repeat(5 - row.rating)) },
    { label: 'Feedback', wrap: true, cell: row => [row.comment, row.reply && h('div', { class: 'small muted' }, `Your reply: ${row.reply}`)] }, { label: 'Status', cell: row => badge(row.status) },
    { label: '', cell: row => h('div', { class: 'actions' }, row.status !== 'approved' && button('Approve', () => set(row, 'approved'), 'link'), row.status !== 'hidden' && button('Hide', () => set(row, 'hidden'), 'link'), button(row.reply ? 'Edit reply' : 'Reply', () => reply(row), 'link'), button('Delete', () => remove(`reviews/${row.id}`, `Delete the feedback from ${row.name}?`, reload), 'link danger')) },
  ], reviews, 'No feedback yet. Guests can leave it on the Our story page.'));
};

// ---- Guest memories --------------------------------------------------------------------------------------------------------
// Photos guests send from the gallery page. A photo waiting for approval is not reachable on the website,
// so its preview is fetched through the admin API instead of from /uploads.
VIEWS.memories = async main => {
  const memories = (await get('memories')).sort((a, b) => (a.status === 'pending') - (b.status === 'pending') || a.createdAt.localeCompare(b.createdAt)).reverse();
  const reload = () => route();
  setCount('memories', memories.filter(memory => memory.status === 'pending').length);
  const set = (memory, status) => attempt(() => api('PUT', `memories/${memory.id}`, { status }), status === 'approved' ? 'Published on the website.' : 'Hidden from the website.').then(reload);
  const photo = memory => {
    const img = h('img', { alt: `Photo from ${memory.name}`, loading: 'lazy' });
    if (memory.image) img.src = memory.image;
    else get(`memories/${memory.id}/photo`).then(result => { img.src = result.data; }).catch(() => { img.alt = 'Photo could not be loaded'; });
    return img;
  };
  render(main, header('Guest memories'), h('p', { class: 'muted small' }, 'Photos guests share from the gallery page stay private until you approve them. Approved photos appear on the wall on the gallery page with the guest’s name and caption.'),
    memories.length ? h('div', { class: 'memory-grid' }, memories.map(memory => h('article', { class: 'card memory-item' }, photo(memory),
      h('div', { class: 'memory-meta' }, h('b', null, memory.name), memory.occasion && h('div', { class: 'small' }, memory.occasion), memory.caption && h('p', null, memory.caption), h('div', { class: 'small muted' }, fmtStamp(memory.createdAt)), badge(memory.status)),
      h('div', { class: 'actions' }, memory.status !== 'approved' && button('Approve', () => set(memory, 'approved'), 'link'), memory.status !== 'hidden' && button('Hide', () => set(memory, 'hidden'), 'link'), button('Delete', () => remove(`memories/${memory.id}`, `Delete the photo from ${memory.name}? This cannot be undone.`, reload), 'link danger'))))) : h('p', { class: 'muted' }, 'No photos yet. Guests can share them from the gallery page.'));
};

// ---- Website content ---------------------------------------------------------------------------------------------------------
let contentTab = 'home';
const PAGE_NAMES = { 'index.html': 'Home', 'about.html': 'Our story', 'menu.html': 'Menu', 'gallery.html': 'Gallery', 'events.html': 'Events', 'offers.html': 'Offers', 'order.html': 'Order online', 'visit.html': 'Visit & book' };
function saveCard(heading, fields, values, save, note) {
  const built = buildFields(fields, values);
  return h('form', { class: 'card', onsubmit: async event => { event.preventDefault(); await attempt(() => save(built.read()), 'Saved.'); } }, h('h2', null, heading), note && h('p', { class: 'muted small' }, note), built.node, h('div', { class: 'dialog-actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
}
VIEWS.content = async main => {
  const [content, gallery] = await Promise.all([get('content'), get('gallery')]);
  gallery.sort(byOrder);
  const reload = () => route();
  const photoDialog = existing => formDialog({ heading: existing ? 'Edit photo' : 'Add photo', fields: [{ name: 'image', label: 'Photo', type: 'image' }, { name: 'caption', label: 'Caption', required: true, max: 80 }, { name: 'category', label: 'Category', type: 'select', options: [['spaces', 'Interiors'], ['food', 'Food'], ['drinks', 'Bar & drinks'], ['events', 'Events']] }, { name: 'alt', label: 'Description for screen readers', max: 160, wide: true }], values: existing, save: values => existing ? api('PUT', `gallery/${existing.id}`, values) : api('POST', 'gallery', values) }).then(saved => saved && reload());
  const panels = {
    home: () => saveCard('Homepage banner', [{ name: 'eyebrow', label: 'Small heading', max: 80, placeholder: 'BTM 2ND STAGE, BENGALURU' }, { name: 'title', label: 'Headline', type: 'textarea', rows: 3, max: 120, hint: 'One line per row. The last line is shown in orange.' }, { name: 'description', label: 'Introduction', type: 'textarea', rows: 2, max: 240 }, { name: 'image', label: 'Background photo', type: 'image' }], content.hero, values => api('PUT', 'content/hero', values), 'Leave a field empty to keep the built-in text.'),
    about: () => saveCard('About us', [{ name: 'heading', label: 'Heading', type: 'textarea', rows: 2, max: 120 }, { name: 'body', label: 'Our story', type: 'textarea', rows: 6, max: 3000, hint: 'Leave a blank line between paragraphs.' }, { name: 'chefName', label: 'Chef’s name', max: 80 }, { name: 'chefPhoto', label: 'Chef’s photo', type: 'image' }, { name: 'chefBio', label: 'About the chef', type: 'textarea', rows: 4, max: 1200 }, { name: 'ambience', label: 'Ambience', type: 'textarea', rows: 4, max: 1200 }], content.about, values => api('PUT', 'content/about', values), 'The chef and ambience sections appear on the Our story page once filled in.'),
    gallery: () => h('section', { class: 'card' }, h('div', { class: 'head' }, h('h2', null, 'Gallery'), button('Add photo', () => photoDialog(), 'primary')), h('p', { class: 'muted small' }, 'Drag photos to reorder them.'), h('div', { class: 'gallery-admin' }, gallery.map((photo, index) => h('figure', { draggable: true, 'data-id': photo.id }, h('img', { src: photo.image.startsWith('/') ? photo.image : '/' + photo.image, alt: photo.alt }), h('figcaption', null, h('b', null, photo.caption), h('div', { class: 'actions' }, button('←', () => nudge('gallery', gallery, index, -1, reload), 'tiny'), button('→', () => nudge('gallery', gallery, index, 1, reload), 'tiny'), button('Edit', () => photoDialog(photo), 'link'), button('Delete', () => remove(`gallery/${photo.id}`, `Remove “${photo.caption}” from the gallery?`, reload), 'link danger'))))))),
    social: () => [saveCard('Social media & listing links', Object.entries({ instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', x: 'X (Twitter)', zomato: 'Zomato', swiggy: 'Swiggy', googleReviews: 'Google reviews / Business Profile', district: 'District' }).map(([name, label]) => ({ name, label, type: 'url', placeholder: 'https://' })), state.settings.social, async values => { state.settings = await api('PUT', 'settings/social', values); }, 'Links appear in the website footer, on the menu, and beside reviews.'),
      saveCard('Instagram posts', [{ name: 'posts', label: 'Post links (up to 6, one per line)', type: 'textarea', rows: 4, value: content.instagramPosts.join('\n'), hint: 'Example: https://www.instagram.com/p/XXXXXXXX/' }], {}, values => api('PUT', 'content/instagram', { posts: lines(values.posts) }), 'Chosen posts are shown on the Our story page.')],
    seo: () => {
      const inputs = Object.fromEntries(Object.keys(PAGE_NAMES).map(page => [page, { title: h('input', { maxLength: 70, value: content.seo[page]?.title || '', 'aria-label': `${PAGE_NAMES[page]} page title` }), description: h('textarea', { rows: 2, maxLength: 170, 'aria-label': `${PAGE_NAMES[page]} meta description` }) }]));
      for (const page of Object.keys(inputs)) inputs[page].description.value = content.seo[page]?.description || '';
      return h('section', { class: 'card' }, h('h2', null, 'Search engine settings'), h('p', { class: 'muted small' }, 'The title and description search engines show for each page. Leave empty to use the built-in wording. Aim for up to 60 characters for titles and 155 for descriptions.'),
        table([{ label: 'Page', cell: page => PAGE_NAMES[page] }, { label: 'Page title', cell: page => inputs[page].title }, { label: 'Meta description', cell: page => inputs[page].description }], Object.keys(PAGE_NAMES)),
        h('div', { class: 'dialog-actions' }, button('Save', () => attempt(() => api('PUT', 'content/seo', Object.fromEntries(Object.entries(inputs).map(([page, input]) => [page, { title: input.title.value, description: input.description.value }]))), 'Saved.'), 'primary')));
    },
  };
  render(main, header('Website content', h('a', { class: 'btn', href: '/', target: '_blank' }, 'View website ↗')),
    h('div', { class: 'tabs', role: 'tablist' }, [['home', 'Homepage'], ['about', 'About us'], ['gallery', 'Gallery'], ['social', 'Social links'], ['seo', 'SEO']].map(([id, label]) => h('button', { role: 'tab', 'aria-selected': String(contentTab === id), onclick: () => { contentTab = id; reload(); } }, label))),
    panels[contentTab](), contentTab !== 'gallery' && can('settings') && h('p', { class: 'muted small' }, 'Contact details and opening hours are under ', h('a', { href: '#/settings' }, 'Settings'), '.'));
  if (contentTab === 'gallery') sortable(main, 'figure', true, ids => reorder('gallery', ids));
};

// ---- Reports -------------------------------------------------------------------------------------------------------------------
const reportRange = { from: addDays(istToday(), -29), to: istToday(), period: 'daily' };
VIEWS.reports = async main => {
  const data = await get(`reports?from=${reportRange.from}&to=${reportRange.to}`);
  const reload = () => route(), bookings = data.bookings;
  // One measure per table, drawn as a bar beside its number so the table itself is the accessible view.
  const barTable = (heading, name, columns, rows, measure, empty) => {
    const highest = Math.max(1, ...rows.map(measure));
    return h('section', { class: 'card' }, h('div', { class: 'head', style: 'margin-bottom:10px' }, h('h2', { style: 'margin:0' }, heading), rows.length > 0 && button('Download Excel', () => saveCsv(`nasha-${name}-${data.from}-to-${data.to}`, [columns.map(column => column.label), ...rows.map(row => columns.map(column => column.value(row)))]), 'tiny no-print')),
      table([...columns.map(column => ({ label: column.label, num: column.num, cell: row => String(column.show ? column.show(row) : column.value(row)) })), { label: '', cell: row => h('div', { class: 'meter', title: `${measure(row)}` }, h('i', { style: `width:${Math.round(measure(row) / highest * 100)}%` })) }], rows, empty));
  };
  const count = [{ label: 'Bookings', num: true, value: row => row.count }, { label: 'Guests', num: true, value: row => row.guests }];
  const periodLabel = { daily: 'Day', weekly: 'Week starting', monthly: 'Month' }[reportRange.period];
  const preset = days => button(`Last ${days} days`, () => { Object.assign(reportRange, { to: istToday(), from: addDays(istToday(), -(days - 1)) }); reload(); });
  render(main, header('Reports & analytics', button('Print / save as PDF', () => window.print())),
    h('div', { class: 'toolbar' }, h('label', null, 'From', h('input', { type: 'date', value: reportRange.from, onchange: event => { reportRange.from = event.target.value; reload(); } })), h('label', null, 'To', h('input', { type: 'date', value: reportRange.to, onchange: event => { reportRange.to = event.target.value; reload(); } })), preset(7), preset(30), preset(90)),
    h('p', { class: 'muted small' }, `${fmtDate(data.from)} to ${fmtDate(data.to)}`),
    h('div', { class: 'tiles' },
      h('div', { class: 'tile' }, h('b', null, String(bookings.total)), h('span', null, 'Bookings'), h('small', null, `${bookings.guests} guests (excluding cancelled)`)),
      h('div', { class: 'tile' }, h('b', null, bookings.noShowRate === null ? '—' : `${bookings.noShowRate}%`), h('span', null, 'No-show rate'), h('small', null, `${bookings.noShows} no-shows vs ${bookings.arrived} arrived`)),
      h('div', { class: 'tile' }, h('b', null, String(data.visitors.reduce((sum, day) => sum + day.count, 0))), h('span', null, 'Website visitors'), h('small', null, `${data.visitors.reduce((sum, day) => sum + day.views, 0)} page views`))),
    h('div', { class: 'tabs no-print', role: 'tablist' }, [['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']].map(([period, label]) => h('button', { role: 'tab', 'aria-selected': String(reportRange.period === period), onclick: () => { reportRange.period = period; reload(); } }, label))),
    barTable(`Bookings report · ${reportRange.period}`, `bookings-${reportRange.period}`, [{ label: periodLabel, value: row => row.key, show: row => reportRange.period === 'monthly' ? new Date(row.key + '-01T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : fmtDate(row.key) }, ...count], bookings[reportRange.period], row => row.count, 'No bookings in this period.'),
    h('div', { class: 'grid' },
      barTable('Peak hours', 'peak-hours', [{ label: 'Time', value: row => row.key, show: row => fmtTime(row.key) }, ...count], bookings.peakHours, row => row.guests, 'No bookings in this period.'),
      barTable('Busiest days', 'busiest-days', [{ label: 'Day', value: row => row.key }, ...count], bookings.weekdays, row => row.guests),
      barTable('Bookings by status', 'booking-status', [{ label: 'Status', value: row => title(row.key) }, { label: 'Bookings', num: true, value: row => row.count }], bookings.byStatus, row => row.count),
      barTable('Event attendance', 'event-attendance', [{ label: 'Event', value: row => row.title }, { label: 'Date', value: row => row.date, show: row => fmtDate(row.date) }, { label: 'Booked', num: true, value: row => row.booked }, { label: 'Attended', num: true, value: row => row.attended }], data.events, row => row.booked, 'No events in this period.'),
      barTable('Website visitors', 'visitors', [{ label: 'Day', value: row => row.key, show: row => fmtDate(row.key) }, { label: 'Visitors', num: true, value: row => row.count }, { label: 'Page views', num: true, value: row => row.views }], data.visitors, row => row.count, 'No visits recorded in this period.')),
    h('p', { class: 'muted small' }, 'No-show rate = no-shows ÷ (no-shows + guests marked seated or completed). Mark bookings as Seated, Completed or No-show to keep it accurate. Attendance counts guests marked Attended on each event’s guest list.'));
};

// ---- Settings --------------------------------------------------------------------------------------------------------------------
VIEWS.settings = async main => {
  const settings = state.settings = await get('settings');
  const put = section => async values => { state.settings = await api('PUT', `settings/${section}`, values); };
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const hourRows = [1, 2, 3, 4, 5, 6, 0].map(day => { const entry = settings.hours[day]; return { day, open: h('input', { type: 'time', value: entry.open, 'aria-label': `${dayNames[day]} opens` }), close: h('input', { type: 'time', value: entry.close, 'aria-label': `${dayNames[day]} closes` }), closed: h('input', { type: 'checkbox', checked: entry.closed, 'aria-label': `${dayNames[day]} closed` }) }; });
  const notifications = settings.notifications, payments = settings.payments;
  render(main, header('Settings'),
    saveCard('Restaurant details', [{ name: 'name', label: 'Restaurant name', required: true, max: 80 }, { name: 'gst', label: 'GST number', max: 20 }, { name: 'address', label: 'Address', type: 'textarea', rows: 2, required: true }, { name: 'phone', label: 'Phone', type: 'tel', required: true }, { name: 'phoneDisplay', label: 'Phone as shown on the website', max: 30 }, { name: 'whatsapp', label: 'WhatsApp number', type: 'tel', hint: 'Adds “Chat on WhatsApp” buttons to the website.' }, { name: 'email', label: 'Public email', type: 'email' }, { name: 'mapsUrl', label: 'Google Maps link', type: 'url', hint: 'Use your Google Business Profile’s share link.' }, { name: 'siteUrl', label: 'Website address', type: 'url', placeholder: 'https://www.example.com', hint: 'Used in QR codes and password-reset links.' }, { name: 'logo', label: 'Logo', type: 'image' }], settings.info, put('info')),
    settings.branches.map((branch, index) => saveCard(`Branch: ${branch.name}`, [{ name: 'name', label: 'Branch name', required: true, max: 40, hint: 'Shown on the switch at the top of the website.' }, { name: 'phone', label: 'Phone', type: 'tel', required: true }, { name: 'address', label: 'Address', type: 'textarea', rows: 2, required: true }, { name: 'phoneDisplay', label: 'Phone as shown on the website', max: 30 }, { name: 'whatsapp', label: 'WhatsApp number', type: 'tel' }, { name: 'mapsUrl', label: 'Google Maps link', type: 'url' }, { name: 'instagram', label: 'Instagram link', type: 'url' }], branch, values => put('branches')({ branches: state.settings.branches.map((entry, position) => position === index ? { ...entry, ...values } : entry) }), index === 0 ? 'The website shows these details when a visitor chooses this branch. It is the branch shown first.' : 'The website shows these details when a visitor chooses this branch.')),
    h('form', { class: 'card', onsubmit: async event => { event.preventDefault(); const hours = dayNames.map((unused, day) => { const row = hourRows.find(entry => entry.day === day); return { open: row.open.value, close: row.close.value, closed: row.closed.checked }; }); await attempt(() => put('hours')({ hours }), 'Opening hours saved.'); } }, h('h2', null, 'Opening hours'), h('p', { class: 'muted small' }, 'A closing time earlier than the opening time means after midnight (for example 12:00 to 01:00).'),
      table([{ label: 'Day', cell: row => dayNames[row.day] }, { label: 'Opens', cell: row => row.open }, { label: 'Closes', cell: row => row.close }, { label: 'Closed all day', cell: row => row.closed }], hourRows), h('div', { class: 'dialog-actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save'))),
    saveCard('Holidays', [{ name: 'list', label: 'Days the restaurant is closed', type: 'textarea', rows: 4, value: settings.holidays.map(entry => `${entry.date} ${entry.note}`.trim()).join('\n'), hint: 'One per line: date, then an optional note. Example: 2026-10-02 Gandhi Jayanti (dry day)' }], {}, values => put('holidays')({ holidays: lines(values.list).map(line => ({ date: line.slice(0, 10), note: line.slice(10).trim() })) }), 'Holidays are shown on the Visit page and cannot be booked online.'),
    saveCard('Notifications', [
      { name: 'recipientText', label: 'Send new bookings, inquiries and orders to', type: 'textarea', rows: 2, value: notifications.recipients.join('\n'), hint: 'Staff phone numbers or email addresses, one per line.' },
      { name: 'customerChannel', label: 'Message customers by', type: 'select', options: [['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['email', 'Email (when they gave one)']] },
      { name: 'twilioSid', label: 'Twilio account SID', max: 60 }, { name: 'twilioToken', label: 'Twilio auth token', type: 'password', placeholder: notifications.twilioTokenSet ? 'Saved — leave empty to keep' : '', autocomplete: 'new-password' },
      { name: 'twilioSmsFrom', label: 'Twilio SMS sender number', type: 'tel' }, { name: 'twilioWhatsappFrom', label: 'Twilio WhatsApp sender number', type: 'tel' },
      { name: 'webhookUrl', label: 'Or: webhook address for another provider', type: 'url', hint: 'Each message is posted here as JSON, for MSG91, Interakt, Gupshup or an email service via your own connector.' }, { name: 'webhookSecret', label: 'Webhook signing secret', type: 'password', placeholder: notifications.webhookSecretSet ? 'Saved — leave empty to keep' : '', autocomplete: 'new-password' },
    ], notifications, ({ recipientText, ...values }) => put('notifications')({ ...values, recipients: lines(recipientText) }), 'Without a provider, messages wait under Messages for you to send by hand.'),
    saveCard('Age verification', [{ name: 'enabled', label: 'Ask visitors to confirm their age before entering the website', type: 'checkbox' }, { name: 'minAge', label: 'Minimum age', type: 'select', options: [[21, '21+'], [25, '25+'], [18, '18+']], hint: 'Use the legal drinking age for your state.' }], settings.ageGate, put('ageGate')));
};

// ---- Team, activity, account ---------------------------------------------------------------------------------------------------------
VIEWS.team = async main => {
  const [users, activity] = await Promise.all([get('users'), get('activity?limit=300')]);
  const reload = () => route();
  const userDialog = existing => formDialog({
    heading: existing ? `Edit ${existing.name}` : 'Add team member',
    fields: [{ name: 'name', label: 'Name', required: true, max: 80 }, { name: 'role', label: 'Role', type: 'select', options: [['owner', 'Owner – full access'], ['manager', 'Manager – bookings, menu, events, offers'], ['staff', 'Staff – view bookings only']] }, { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'password', label: existing ? 'Set a new password (optional)' : 'Temporary password', type: 'password', required: !existing, autocomplete: 'new-password', hint: 'At least 10 characters. They will be asked to choose their own at next sign-in.' },
      existing && { name: 'active', label: 'Can sign in', type: 'checkbox' }, existing?.totpEnabled && { name: 'resetTwoFactor', label: 'Turn off their two-step sign-in (lost phone)', type: 'checkbox' }].filter(Boolean),
    values: existing || { role: 'staff' }, save: values => existing ? api('PUT', `users/${existing.id}`, values) : api('POST', 'users', values),
  }).then(saved => saved && reload());
  render(main, header('Team & activity', button('Add team member', () => userDialog(), 'primary')),
    table([{ label: 'Name', cell: row => h('b', null, row.name) }, { label: 'Sign-in', cell: row => [row.email, row.phone && h('div', { class: 'small' }, row.phone)] }, { label: 'Role', cell: row => title(row.role) }, { label: 'Two-step', cell: row => row.totpEnabled ? badge('active') : h('span', { class: 'muted small' }, 'Off') }, { label: 'Last sign-in', cell: row => fmtStamp(row.lastLoginAt) || 'Never' }, { label: 'Status', cell: row => badge(row.active ? 'active' : 'hidden') },
      { label: '', cell: row => h('div', { class: 'actions' }, button('Edit', () => userDialog(row), 'link'), row.id !== state.user.id && button('Remove', () => remove(`users/${row.id}`, `Remove ${row.name}? They will no longer be able to sign in.`, reload), 'link danger')) }], users),
    h('h2', null, 'Activity log'), h('p', { class: 'muted small' }, 'Who changed what, and when. The most recent 300 actions are shown.'),
    table([{ label: 'When', cell: row => fmtStamp(row.at) }, { label: 'Who', cell: row => row.user }, { label: 'Action', cell: row => `${title(row.action)} ${row.entity}` }, { label: 'Details', wrap: true, cell: row => row.summary }], activity, 'No activity yet.'));
};
VIEWS.account = async main => {
  const user = state.user;
  const setup = async () => {
    const data = await attempt(() => api('POST', 'auth/2fa/setup', {}));
    if (!data) return;
    const code = qrcode(0, 'M');
    code.addData(data.uri);
    code.make();
    const figure = h('div');
    figure.innerHTML = code.createSvgTag({ cellSize: 5, margin: 8, scalable: false }); // Markup produced by the bundled QR library.
    formDialog({ heading: 'Turn on two-step sign-in', saveLabel: 'Turn on', intro: 'Scan this code with an authenticator app (Google Authenticator, Microsoft Authenticator, Authy), then enter the 6-digit code it shows.', fields: [{ name: 'code', label: '6-digit code', required: true, autocomplete: 'one-time-code', wide: true, hint: `Cannot scan? Enter this key in the app: ${data.secret}` }], save: async values => { state.user = (await api('POST', 'auth/2fa/enable', values)).user; } }).then(saved => saved && route());
    document.querySelector('dialog[open] .fields').before(figure);
  };
  const disable = () => formDialog({ heading: 'Turn off two-step sign-in', saveLabel: 'Turn off', fields: [{ name: 'password', label: 'Your password', type: 'password', required: true, wide: true }], save: async values => { state.user = (await api('POST', 'auth/2fa/disable', values)).user; } }).then(saved => saved && route());
  render(main, header('My account', button('Sign out', async () => { await attempt(() => api('POST', 'auth/logout', {})); clearInterval(state.orderTimer); state.user = null; location.hash = ''; showLogin(); })),
    h('section', { class: 'card' }, h('h2', null, user.name), h('p', { class: 'muted' }, `${title(user.role)} · ${user.email || user.phone}`)),
    saveCard('Change password', [{ name: 'current', label: 'Current password', type: 'password', required: true, autocomplete: 'current-password' }, { name: 'password', label: 'New password (at least 10 characters)', type: 'password', required: true, autocomplete: 'new-password' }], {}, values => api('POST', 'auth/password', values), 'Changing your password signs you out on other devices.'),
    h('section', { class: 'card' }, h('h2', null, 'Two-step sign-in (OTP)'), h('p', null, user.totpEnabled ? 'On. You are asked for a 6-digit code from your authenticator app each time you sign in.' : 'Off. Turn this on so that a stolen password alone is not enough to sign in.'), user.totpEnabled ? button('Turn off', disable) : button('Set up', setup, 'primary')));
};

// ---- Start -----------------------------------------------------------------------------------------------------------------------------
(async () => {
  const reset = /^#reset=([\w-]+)$/.exec(location.hash);
  if (reset) return showReset(reset[1]);
  try { await enter((await get('auth/me')).user); }
  catch { showLogin(); }
})();
