// JSON API for the public website (/api/public) and the admin panel (/api/admin).
import { randomBytes, createHmac } from 'node:crypto';
import path from 'node:path';
import { db, save, newId, images, PAGES } from './store.mjs';
import * as sec from './security.mjs';
import { queue, deliver, notifyCustomer, notifyStaff } from './notify.mjs';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = message => { throw new HttpError(400, message); };

// ---- Validation helpers -------------------------------------------------------------------
const text = (value, max, label, required = false) => {
  const out = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  if (required && !out) bad(`${label} is required.`);
  if (out.length > max) bad(`${label} is too long (maximum ${max} characters).`);
  return out;
};
const int = (value, min, max, label) => {
  const number = Number(value);
  if (value === '' || value === null || !Number.isInteger(number) || number < min || number > max) bad(`${label} must be a whole number from ${min} to ${max}.`);
  return number;
};
const money = (value, label, optional = false) => {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const number = Math.round(Number(value) * 100) / 100;
  if (value === '' || value === null || !Number.isFinite(number) || number < 0 || number > 1e7) bad(`${label} must be an amount of 0 or more.`);
  return number;
};
const dateOf = (value, label, optional = false) => {
  if (optional && !value) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) bad(`${label} must be a valid date.`);
  return value;
};
const timeOf = (value, label, optional = false) => {
  if (optional && !value) return '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) bad(`${label} must be a valid time.`);
  return value;
};
const choice = (value, options, label) => {
  if (!options.includes(value)) bad(`${label} is not valid.`);
  return value;
};
const phoneOf = (value, required = true) => {
  let digits = String(value ?? '').replace(/[^\d+]/g, '');
  if (!digits && !required) return '';
  if (/^\d{10}$/.test(digits)) digits = '+91' + digits;
  else if (/^0\d{10}$/.test(digits)) digits = '+91' + digits.slice(1);
  else if (/^\d{11,15}$/.test(digits)) digits = '+' + digits;
  if (!/^\+\d{8,15}$/.test(digits)) bad('Enter a valid phone number, for example 98765 43210.');
  return digits;
};
const emailOf = (value, required = false) => {
  const email = text(value, 120, 'Email').toLowerCase();
  if (!email && !required) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('Enter a valid email address.');
  return email;
};
const imageOf = value => {
  const image = text(value, 200, 'Image');
  if (image && !/^(assets\/[\w-]+\.(jpg|svg)|\/uploads\/[\w-]+\.(jpg|png|webp))$/.test(image)) bad('Choose an uploaded image.');
  return image;
};
const urlOf = (value, label) => {
  const url = text(value, 300, label);
  if (url && !/^https:\/\/[^\s"'<>]+$/.test(url)) bad(`${label} must start with https://`);
  return url;
};

// ---- Dates (the restaurant runs on India time, which has no daylight saving) ----------------
const now = () => new Date().toISOString();
const ist = (date = new Date()) => {
  const shifted = new Date(date.getTime() + 330 * 60000).toISOString();
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 16) };
};
const today = () => ist().date;
const addDays = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const weekday = date => new Date(date + 'T00:00:00Z').getUTCDay();
const niceDate = date => new Date(date + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const niceTime = time => { const [hour, minute] = time.split(':').map(Number); return `${(hour + 11) % 12 + 1}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'pm' : 'am'}`; };

// ---- Shared business rules ----------------------------------------------------------------
const ROLES = {
  owner: ['*'],
  manager: ['dashboard', 'reservations.read', 'reservations.write', 'menu', 'events', 'offers', 'inquiries', 'orders', 'upload', 'memories'],
  staff: ['reservations.read'],
};
const can = (user, permission) => ROLES[user.role].includes('*') || ROLES[user.role].includes(permission);
const RESERVATION_STATUSES = ['pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no-show'];
const ACTIVE = ['pending', 'confirmed', 'seated'];
const INQUIRY_STATUSES = ['new', 'contacted', 'quoted', 'booked', 'closed'];
const ORDER_STATUSES = ['received', 'preparing', 'ready', 'delivered', 'cancelled'];

function find(collection, id) {
  const record = db[collection].find(entry => entry.id === id);
  if (!record) throw new HttpError(404, 'That record no longer exists.');
  return record;
}
function log(ctx, action, entity, summary = '') {
  db.activity.unshift({ id: newId(), at: now(), userId: ctx.user?.id || '', user: ctx.user?.name || 'Website', action, entity, summary: String(summary).slice(0, 200) });
  db.activity.length = Math.min(db.activity.length, 5000);
  save();
}
const nextOrder = collection => db[collection].reduce((highest, entry) => Math.max(highest, entry.order ?? 0), -1) + 1;
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);
// Bookings, enquiries and orders belong to one branch; anything unrecognised (or saved before branches
// existed) counts as the first branch.
const branchOf = id => db.settings.branches.find(branch => branch.id === id) || db.settings.branches[0];

function touchCustomer({ name, phone, email = '', optIn = false }) {
  let customer = db.customers.find(entry => entry.phone === phone);
  if (!customer) {
    customer = { id: newId(), name, phone, email, birthday: '', anniversary: '', tags: [], notes: '', optIn: false, createdAt: now() };
    db.customers.push(customer);
  }
  if (!customer.email && email) customer.email = email;
  if (optIn) customer.optIn = true;
  return customer;
}

function slotTimes() {
  const { firstSlot, lastSlot, slotMinutes } = db.settings.booking;
  const toMinutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const times = [];
  for (let minutes = toMinutes(firstSlot); minutes <= toMinutes(lastSlot); minutes += slotMinutes) times.push(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
  return times;
}
function availability(date, branch = db.settings.branches[0].id) {
  const booking = db.settings.booking;
  const current = ist();
  if (date < current.date) return { open: false, reason: 'That date has passed.', slots: [] };
  if (date > addDays(current.date, booking.maxDaysAhead)) return { open: false, reason: `Tables can be requested up to ${booking.maxDaysAhead} days ahead. Please call us for later dates.`, slots: [] };
  const blocked = booking.blockedDates.find(entry => entry.date === date);
  if (blocked) return { open: false, reason: `Online booking is closed on this date${blocked.reason ? ` (${blocked.reason})` : ''}. Please call us.`, slots: [] };
  const holiday = db.settings.holidays.find(entry => entry.date === date);
  if (holiday) return { open: false, reason: `We are closed on this date${holiday.note ? ` (${holiday.note})` : ''}.`, slots: [] };
  if (db.settings.hours.find(entry => entry.day === weekday(date))?.closed) return { open: false, reason: 'We are closed on this day of the week.', slots: [] };
  const taken = new Map();
  for (const reservation of db.reservations) if (reservation.date === date && branchOf(reservation.branch).id === branch && ACTIVE.includes(reservation.status)) taken.set(reservation.time, (taken.get(reservation.time) || 0) + reservation.guests);
  const slots = slotTimes().filter(time => date > current.date || time > current.time).map(time => ({ time, label: niceTime(time), left: Math.max(0, booking.capacityPerSlot - (taken.get(time) || 0)) }));
  return { open: slots.length > 0, reason: slots.length ? '' : 'No more tables can be requested online for today. Please call us.', slots };
}

function reservationMessage(reservation, kind) {
  const when = `${niceDate(reservation.date)} at ${niceTime(reservation.time)} for ${reservation.guests}`;
  const branch = branchOf(reservation.branch);
  const name = `${db.settings.info.name}, ${branch.name}`;
  if (kind === 'confirmed') return `Hi ${reservation.name}, your table at ${name} is confirmed: ${when}. Ref ${reservation.ref}. See you soon!`;
  if (kind === 'cancelled') return `Hi ${reservation.name}, your booking at ${name} (${when}, ref ${reservation.ref}) has been cancelled. Call ${branch.phoneDisplay} if this is unexpected.`;
  return `Hi ${reservation.name}, we have received your table request at ${name}: ${when}. Ref ${reservation.ref}. We will confirm shortly.`;
}

function createReservation(body, { source, status, force = false }) {
  const booking = db.settings.booking;
  const data = {
    name: text(body.name, 80, 'Name', true),
    phone: phoneOf(body.phone),
    email: emailOf(body.email),
    date: dateOf(body.date, 'Date'),
    time: timeOf(body.time, 'Time'),
    guests: int(body.guests, 1, force ? 500 : booking.maxParty, 'Guests'),
    notes: text(body.notes, 500, 'Notes'),
    branch: branchOf(body.branch).id,
  };
  if (!force) {
    const day = availability(data.date, data.branch);
    if (!day.open) bad(day.reason);
    const slot = day.slots.find(entry => entry.time === data.time);
    if (!slot) bad('Please choose one of the available times.');
    if (slot.left < data.guests) bad(slot.left ? `Only ${slot.left} seats are left at ${slot.label}. Try another time or call us.` : `${slot.label} is fully booked. Please try another time.`);
  }
  const reservation = { id: newId(), ref: `N${++db.meta.bookingSeq}`, ...data, status, source, createdAt: now(), updatedAt: now() };
  db.reservations.push(reservation);
  touchCustomer({ ...data, optIn: body.optIn === true });
  save();
  return reservation;
}

function couponDiscount(code, subtotal) {
  const coupon = db.coupons.find(entry => entry.code === String(code || '').trim().toUpperCase());
  const date = today();
  if (!coupon || !coupon.active) bad('That coupon code is not valid.');
  if ((coupon.startDate && date < coupon.startDate) || (coupon.endDate && date > coupon.endDate)) bad('That coupon is not active today.');
  if (coupon.maxUses && coupon.used >= coupon.maxUses) bad('That coupon has been fully used.');
  if (subtotal < coupon.minOrder) bad(`That coupon needs a minimum order of ₹${coupon.minOrder}.`);
  const discount = Math.min(subtotal, coupon.type === 'percent' ? Math.round(subtotal * coupon.value) / 100 : coupon.value);
  return { coupon, discount: Math.round(discount * 100) / 100 };
}

function priceOrder(body) {
  const ordering = db.settings.ordering;
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 40) bad('Your order is empty.');
  const lines = body.items.map(line => {
    const item = db.items.find(entry => entry.id === line.id);
    if (!item || !item.available || item.price === null) bad('Something in your order is no longer available. Please review your order.');
    if (item.diet === 'alcoholic') bad('Alcoholic drinks cannot be ordered online.');
    if (['happy', 'combo'].includes(db.categories.find(category => category.id === item.categoryId)?.kind)) bad('Happy hours offers are served at the restaurant only.');
    const qty = int(line.qty, 1, 20, 'Quantity');
    return { id: item.id, name: item.name, price: item.price, qty, total: Math.round(item.price * qty * 100) / 100 };
  });
  const subtotal = Math.round(lines.reduce((sum, line) => sum + line.total, 0) * 100) / 100;
  if (subtotal < ordering.minOrder) bad(`The minimum order is ₹${ordering.minOrder}.`);
  const type = choice(body.type, ordering.delivery ? ['pickup', 'delivery'] : ['pickup'], 'Order type');
  const { coupon, discount } = body.coupon ? couponDiscount(body.coupon, subtotal) : { coupon: null, discount: 0 };
  const deliveryFee = type === 'delivery' ? ordering.deliveryFee : 0;
  return { lines, subtotal, discount, deliveryFee, type, coupon, total: Math.round((subtotal - discount + deliveryFee) * 100) / 100 };
}
const paymentsReady = () => { const payments = db.settings.payments; return payments.gateway === 'razorpay' && Boolean(payments.keyId && payments.keySecret); };

function publicSite() {
  const { info, hours, holidays, social, ageGate, banner, booking, ordering } = db.settings;
  const date = today();
  const spotsLeft = event => event.bookingLimit ? Math.max(0, event.bookingLimit - db.eventBookings.filter(entry => entry.eventId === event.id && entry.status !== 'cancelled').reduce((sum, entry) => sum + entry.guests, 0)) : null;
  return {
    info: { name: info.name, logo: info.logo, address: info.address, phone: info.phone, phoneDisplay: info.phoneDisplay, email: info.email, whatsapp: info.whatsapp, mapsUrl: info.mapsUrl },
    branches: db.settings.branches, hours, holidays: holidays.filter(entry => entry.date >= date), social, ageGate, banner,
    booking: { maxParty: booking.maxParty, maxDaysAhead: booking.maxDaysAhead, autoConfirm: booking.autoConfirm },
    ordering: { ...ordering, onlinePayment: paymentsReady() },
    content: { hero: db.content.hero, about: db.content.about, instagramPosts: db.content.instagramPosts },
    categories: [...db.categories].sort(byOrder).map(({ id, name, kind, note, photo, branch }) => ({ id, name, kind, note: note || '', photo: photo || '', branch: branch || '' })),
    items: [...db.items].sort(byOrder).map(({ id, categoryId, name, description, price, photo, diet, badges, available }) => ({ id, categoryId, name, description, price, photo, diet, badges, available })),
    events: db.events.filter(event => event.published && event.date >= date).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map(({ id, title, type, date, time, endTime, poster, description, entryFee, bookingLimit }) => ({ id, title, type, date, time, endTime, poster, description, entryFee, bookingLimit, spotsLeft: spotsLeft({ id, bookingLimit }) })),
    offers: db.offers.filter(offer => offer.active && (!offer.endDate || offer.endDate >= date)).map(({ id, title, description, startDate, endDate, startTime, endTime, days, couponCode, branch, photo }) => ({ id, title, description, startDate, endDate, startTime, endTime, days, couponCode, branch: branch || '', photo: photo || '' })),
    reviews: db.reviews.filter(review => review.status === 'approved').map(({ id, name, rating, comment, reply, createdAt }) => ({ id, name, rating, comment, reply, date: createdAt.slice(0, 10) })),
    memories: db.memories.filter(memory => memory.status === 'approved').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 60).map(({ id, name, occasion, caption, image, createdAt }) => ({ id, name, occasion: occasion || '', caption, image, date: createdAt.slice(0, 10) })),
    party: [...db.party].sort(byOrder).map(({ id, kind, name, price, details }) => ({ id, kind, name, price, details })),
    gallery: [...db.gallery].sort(byOrder).map(({ id, image, caption, category, alt }) => ({ id, image, caption, category, alt })),
  };
}

// The server uses this to apply the owner's SEO settings when it serves a page.
export const seoFor = page => db.content.seo[page] || null;

// ---- Routing --------------------------------------------------------------------------------
const routes = [];
function route(method, pattern, permission, handler) {
  routes.push({ method, permission, handler, matcher: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });
}
// Public form posts share one small per-visitor allowance to keep spam and scripted abuse down.
function guard(ctx, name, max = 8) {
  if (ctx.body.website) throw new HttpError(400, 'Could not send. Please try again.'); // Hidden field only bots fill in.
  if (!sec.allow(`${name}:${ctx.ip}`, max, 10 * 60000)) throw new HttpError(429, 'Too many attempts. Please wait a few minutes or call us.');
}

// ---- Public website -------------------------------------------------------------------------
route('GET', '/api/public/site', 'public', () => publicSite());
route('GET', '/api/public/availability', 'public', ctx => availability(dateOf(ctx.query.date, 'Date'), branchOf(ctx.query.branch).id));

route('POST', '/api/public/reservations', 'public', ctx => {
  guard(ctx, 'reserve', 8);
  const status = db.settings.booking.autoConfirm ? 'confirmed' : 'pending';
  const reservation = createReservation(ctx.body, { source: 'website', status });
  notifyCustomer(reservation, reservationMessage(reservation, status === 'confirmed' ? 'confirmed' : 'received'), 'Table booking', reservation.ref);
  notifyStaff(`New table request ${reservation.ref}: ${reservation.name}, ${reservation.guests} guests, ${niceDate(reservation.date)} ${niceTime(reservation.time)}, ${reservation.phone}`, 'New booking', reservation.ref);
  return { ref: reservation.ref, status, date: reservation.date, time: niceTime(reservation.time), guests: reservation.guests };
});

route('POST', '/api/public/inquiries', 'public', ctx => {
  guard(ctx, 'inquiry', 5);
  const body = ctx.body;
  const inquiry = {
    id: newId(), createdAt: now(), status: 'new', notes: [], branch: branchOf(body.branch).id,
    name: text(body.name, 80, 'Name', true), phone: phoneOf(body.phone), email: emailOf(body.email),
    type: choice(body.type, ['Birthday', 'Private party', 'Corporate event', 'Team catch-up', 'Other celebration'], 'Occasion'),
    date: dateOf(body.date, 'Date'), time: timeOf(body.time, 'Time', true),
    guests: int(body.guests, 2, 500, 'Guests'), budget: text(body.budget, 60, 'Budget'), requirements: text(body.requirements, 1000, 'Requirements'),
  };
  if (inquiry.date < today()) bad('Choose a date in the future.');
  db.inquiries.push(inquiry);
  touchCustomer({ ...inquiry, optIn: body.optIn === true });
  save();
  notifyStaff(`New ${inquiry.type.toLowerCase()} inquiry: ${inquiry.name}, ${inquiry.guests} guests, ${niceDate(inquiry.date)}, ${inquiry.phone}`, 'New inquiry', inquiry.id);
  return { ok: true };
});

route('POST', '/api/public/events/:id/book', 'public', ctx => {
  guard(ctx, 'event', 5);
  const event = db.events.find(entry => entry.id === ctx.params.id && entry.published && entry.date >= today());
  if (!event) throw new HttpError(404, 'That event is no longer available.');
  const guests = int(ctx.body.guests, 1, 10, 'Guests');
  const booked = db.eventBookings.filter(entry => entry.eventId === event.id && entry.status !== 'cancelled').reduce((sum, entry) => sum + entry.guests, 0);
  if (event.bookingLimit && booked + guests > event.bookingLimit) bad(event.bookingLimit - booked > 0 ? `Only ${event.bookingLimit - booked} places are left for this event.` : 'This event is fully booked.');
  const booking = { id: newId(), eventId: event.id, branch: branchOf(ctx.body.branch).id, name: text(ctx.body.name, 80, 'Name', true), phone: phoneOf(ctx.body.phone), guests, status: 'booked', createdAt: now() };
  db.eventBookings.push(booking);
  touchCustomer({ ...booking, optIn: ctx.body.optIn === true });
  save();
  notifyCustomer(booking, `Hi ${booking.name}, you are on the list for ${event.title} at ${db.settings.info.name} on ${niceDate(event.date)}, ${niceTime(event.time)} (${guests} ${guests === 1 ? 'guest' : 'guests'}).${event.entryFee ? ` Entry ₹${event.entryFee} per person, payable at the venue.` : ''}`, 'Event booking', event.id);
  return { ok: true, title: event.title };
});

route('POST', '/api/public/reviews', 'public', ctx => {
  guard(ctx, 'review', 3);
  db.reviews.push({ id: newId(), createdAt: now(), status: 'pending', reply: '', name: text(ctx.body.name, 60, 'Name', true), rating: int(ctx.body.rating, 1, 5, 'Rating'), comment: text(ctx.body.comment, 800, 'Feedback', true) });
  save();
  return { ok: true };
});

// Guests share a photo of their evening. It is kept privately until approved in the admin panel.
route('POST', '/api/public/memories', 'public', async ctx => {
  guard(ctx, 'memory', 4);
  if (ctx.body.consent !== true) bad('Please confirm that everyone in the photo is happy for it to be shared.');
  const name = text(ctx.body.name, 60, 'Name', true), occasion = text(ctx.body.occasion, 60, 'Occasion'), caption = text(ctx.body.caption, 300, 'Memory');
  const { bytes, extension } = imageBytes(ctx.body.data);
  const file = `${randomBytes(10).toString('hex')}.${extension}`;
  await images.put(file, bytes, false);
  const memory = { id: newId(), createdAt: now(), status: 'pending', name, occasion, caption, file, image: '' };
  db.memories.push(memory);
  notifyStaff(`New guest photo from ${name} is waiting for approval under Guest memories.`, 'Guest memory', memory.id);
  return { ok: true };
});

route('POST', '/api/public/subscribe', 'public', ctx => {
  guard(ctx, 'subscribe', 5);
  const phone = phoneOf(ctx.body.phone, false), email = emailOf(ctx.body.email);
  if (!phone && !email) bad('Enter a WhatsApp number or an email address.');
  if (ctx.body.consent !== true) bad('Please tick the box to agree to receive offers.');
  const name = text(ctx.body.name, 80, 'Name');
  if (!db.subscribers.some(entry => (phone && entry.phone === phone) || (email && entry.email === email))) db.subscribers.push({ id: newId(), name, phone, email, createdAt: now() });
  if (phone) touchCustomer({ name: name || 'Subscriber', phone, email, optIn: true });
  save();
  return { ok: true };
});

route('POST', '/api/public/vouchers', 'public', ctx => {
  guard(ctx, 'voucher', 4);
  const voucher = { id: newId(), createdAt: now(), code: '', status: 'requested', balance: 0, amount: int(ctx.body.amount, 100, 50000, 'Amount'), buyerName: text(ctx.body.buyerName, 80, 'Your name', true), buyerPhone: phoneOf(ctx.body.buyerPhone), recipientName: text(ctx.body.recipientName, 80, 'Recipient name', true), message: text(ctx.body.message, 300, 'Message') };
  db.vouchers.push(voucher);
  save();
  notifyStaff(`Gift voucher request: ₹${voucher.amount} from ${voucher.buyerName} (${voucher.buyerPhone}) for ${voucher.recipientName}`, 'Voucher request', voucher.id);
  return { ok: true };
});

route('POST', '/api/public/coupon', 'public', ctx => {
  guard(ctx, 'coupon', 15);
  const { coupon, discount } = couponDiscount(ctx.body.code, money(ctx.body.subtotal, 'Subtotal'));
  return { code: coupon.code, discount };
});

route('POST', '/api/public/orders', 'public', async ctx => {
  guard(ctx, 'order', 6);
  if (!db.settings.ordering.enabled) bad('Online ordering is not open at the moment.');
  const body = ctx.body;
  const priced = priceOrder(body);
  const payment = choice(body.payment, paymentsReady() ? ['cod', 'online'] : ['cod'], 'Payment method');
  const order = {
    id: newId(), token: randomBytes(12).toString('hex'), number: ++db.meta.orderSeq, createdAt: now(), status: 'received',
    name: text(body.name, 80, 'Name', true), phone: phoneOf(body.phone), type: priced.type, branch: branchOf(body.branch).id,
    address: priced.type === 'delivery' ? text(body.address, 300, 'Delivery address', true) : '', table: text(body.table, 10, 'Table'), notes: text(body.notes, 300, 'Notes'),
    lines: priced.lines, subtotal: priced.subtotal, discount: priced.discount, coupon: priced.coupon?.code || '', deliveryFee: priced.deliveryFee, total: priced.total,
    payment, paymentStatus: payment === 'online' ? 'pending' : 'cod', gatewayOrderId: '', gatewayPaymentId: '',
  };
  let checkout = null;
  if (payment === 'online') {
    const { keyId, keySecret } = db.settings.payments;
    const response = await fetch('https://api.razorpay.com/v1/orders', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'), 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: Math.round(order.total * 100), currency: 'INR', receipt: `order-${order.number}` }), signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (!response?.ok) throw new HttpError(502, 'Online payment is unavailable right now. Please choose to pay at the restaurant.');
    order.gatewayOrderId = (await response.json()).id;
    checkout = { key: keyId, orderId: order.gatewayOrderId, amount: Math.round(order.total * 100) };
  }
  if (priced.coupon) priced.coupon.used++;
  db.orders.push(order);
  touchCustomer(order);
  save();
  notifyStaff(`New order #${order.number}: ${order.lines.map(line => `${line.qty}× ${line.name}`).join(', ')} – ₹${order.total} (${order.type}, ${order.name} ${order.phone})`, 'New order', String(order.number));
  return { id: order.id, token: order.token, number: order.number, total: order.total, status: order.status, paymentStatus: order.paymentStatus, checkout };
});

const publicOrder = ctx => {
  const order = db.orders.find(entry => entry.id === ctx.params.id && sec.safeEqual(entry.token, ctx.query.token ?? ctx.body?.token ?? ''));
  if (!order) throw new HttpError(404, 'Order not found.');
  return order;
};
route('GET', '/api/public/orders/:id', 'public', ctx => {
  const { number, status, paymentStatus, total, type, lines } = publicOrder(ctx);
  return { number, status, paymentStatus, total, type, lines };
});
route('POST', '/api/public/orders/:id/paid', 'public', ctx => {
  const order = publicOrder(ctx);
  const expected = createHmac('sha256', db.settings.payments.keySecret).update(`${order.gatewayOrderId}|${text(ctx.body.paymentId, 60, 'Payment', true)}`).digest('hex');
  if (!order.gatewayOrderId || !sec.safeEqual(expected, ctx.body.signature ?? '')) bad('We could not verify that payment. If money was deducted, please call us with your order number.');
  order.paymentStatus = 'paid';
  order.gatewayPaymentId = ctx.body.paymentId;
  save();
  return { paymentStatus: 'paid' };
});

route('POST', '/api/public/track', 'public', ctx => {
  const page = text(ctx.body.page, 40, 'Page') || 'index.html';
  if (!PAGES.includes(page) || !sec.allow(`track:${ctx.ip}`, 120, 600000)) return { ok: true };
  const date = today();
  const day = db.visits[date] ||= { views: 0, visitors: [], pages: {} };
  const visitor = sec.sha256(`${db.meta.secret}|${date}|${ctx.ip}|${ctx.request.headers['user-agent'] || ''}`).slice(0, 16);
  day.views++;
  day.pages[page] = (day.pages[page] || 0) + 1;
  if (!day.visitors.includes(visitor) && day.visitors.length < 20000) day.visitors.push(visitor);
  const oldest = addDays(date, -400);
  for (const key of Object.keys(db.visits)) if (key < oldest) delete db.visits[key];
  save();
  return { ok: true };
});

// ---- Admin: sign-in ---------------------------------------------------------------------------
const profile = user => ({ id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role, totpEnabled: user.totpEnabled, mustChangePassword: user.mustChangePassword, permissions: ROLES[user.role] });
const passwordOf = value => {
  const password = String(value ?? '');
  if (password.length < 10 || password.length > 200) bad('Choose a password of at least 10 characters.');
  return password;
};
function signIn(ctx, user) {
  user.lastLoginAt = now();
  ctx.setSession(sec.createSession(user.id));
  ctx.user = user;
  log(ctx, 'signed in', 'account');
  return { user: profile(user) };
}

route('POST', '/api/admin/auth/login', 'public', ctx => {
  const identifier = text(ctx.body.identifier, 120, 'Email or phone', true).toLowerCase();
  const key = `login:${ctx.ip}:${identifier}`;
  if (!sec.allow(key, 6, 15 * 60000)) throw new HttpError(429, 'Too many sign-in attempts. Try again in 15 minutes.');
  const digits = identifier.replace(/\D/g, '');
  const user = db.users.find(entry => entry.active && (entry.email === identifier || (digits.length >= 10 && entry.phone.endsWith(digits.slice(-10)))));
  if (!user || !sec.verifyPassword(ctx.body.password, user.passHash)) throw new HttpError(401, 'Incorrect email/phone or password.');
  sec.clearAttempts(key);
  if (user.totpEnabled) {
    ctx.setSession(sec.createSession(user.id, true));
    return { twoFactor: true };
  }
  return signIn(ctx, user);
});
route('POST', '/api/admin/auth/2fa', 'pending', ctx => {
  if (!sec.allow(`otp:${ctx.user.id}`, 6, 15 * 60000)) throw new HttpError(429, 'Too many incorrect codes. Try again in 15 minutes.');
  if (!sec.verifyTotp(ctx.user.totpSecret, ctx.body.code)) throw new HttpError(401, 'That code is not correct. Check your authenticator app and try again.');
  sec.clearAttempts(`otp:${ctx.user.id}`);
  sec.dropSession(ctx.token);
  return signIn(ctx, ctx.user);
});
route('POST', '/api/admin/auth/logout', 'self', ctx => { sec.dropSession(ctx.token); ctx.setSession(''); return { ok: true }; });
route('GET', '/api/admin/auth/me', 'self', ctx => ({ user: profile(ctx.user) }));
route('POST', '/api/admin/auth/password', 'self', ctx => {
  if (!sec.verifyPassword(ctx.body.current, ctx.user.passHash)) bad('Your current password is not correct.');
  ctx.user.passHash = sec.hashPassword(passwordOf(ctx.body.password));
  ctx.user.mustChangePassword = false;
  sec.dropUserSessions(ctx.user.id, ctx.token);
  log(ctx, 'changed password', 'account');
  return { user: profile(ctx.user) };
});
route('POST', '/api/admin/auth/forgot', 'public', ctx => {
  if (!sec.allow(`forgot:${ctx.ip}`, 4, 30 * 60000)) throw new HttpError(429, 'Too many requests. Try again later.');
  const identifier = text(ctx.body.identifier, 120, 'Email or phone', true).toLowerCase();
  const digits = identifier.replace(/\D/g, '');
  const user = db.users.find(entry => entry.active && (entry.email === identifier || (digits.length >= 10 && entry.phone.endsWith(digits.slice(-10)))));
  if (user) {
    const token = randomBytes(24).toString('base64url');
    db.resets = db.resets.filter(entry => entry.expires > Date.now() && entry.userId !== user.id);
    db.resets.push({ tokenHash: sec.sha256(token), userId: user.id, expires: Date.now() + 30 * 60000 });
    const link = `${ctx.origin}/admin/#reset=${token}`;
    const message = `Reset your ${db.settings.info.name} admin password (valid for 30 minutes): ${link}`;
    if (user.email) queue({ channel: 'email', to: user.email, subject: 'Reset your admin password', text: message, kind: 'Password reset' });
    console.log(`[password reset] ${user.email || user.phone}: ${link}`);
    save();
  }
  // The same answer either way, so this cannot be used to discover which accounts exist.
  return { ok: true };
});
route('POST', '/api/admin/auth/reset', 'public', ctx => {
  if (!sec.allow(`reset:${ctx.ip}`, 8, 30 * 60000)) throw new HttpError(429, 'Too many attempts. Try again later.');
  const entry = db.resets.find(reset => reset.tokenHash === sec.sha256(String(ctx.body.token ?? '')) && reset.expires > Date.now());
  const user = entry && db.users.find(candidate => candidate.id === entry.userId && candidate.active);
  if (!user) bad('This reset link is invalid or has expired. Request a new one.');
  user.passHash = sec.hashPassword(passwordOf(ctx.body.password));
  user.mustChangePassword = false;
  db.resets = db.resets.filter(reset => reset !== entry);
  sec.dropUserSessions(user.id);
  ctx.user = user;
  log(ctx, 'reset password', 'account');
  return { ok: true };
});
route('POST', '/api/admin/auth/2fa/setup', 'self', ctx => {
  ctx.user.totpPending = sec.newTotpSecret();
  save();
  const label = encodeURIComponent(`${db.settings.info.name}:${ctx.user.email || ctx.user.phone}`);
  return { secret: ctx.user.totpPending, uri: `otpauth://totp/${label}?secret=${ctx.user.totpPending}&issuer=${encodeURIComponent(db.settings.info.name)}` };
});
route('POST', '/api/admin/auth/2fa/enable', 'self', ctx => {
  if (!ctx.user.totpPending || !sec.verifyTotp(ctx.user.totpPending, ctx.body.code)) bad('That code is not correct. Scan the QR code again and enter the current 6-digit code.');
  Object.assign(ctx.user, { totpSecret: ctx.user.totpPending, totpPending: '', totpEnabled: true });
  log(ctx, 'turned on two-step sign-in', 'account');
  return { user: profile(ctx.user) };
});
route('POST', '/api/admin/auth/2fa/disable', 'self', ctx => {
  if (!sec.verifyPassword(ctx.body.password, ctx.user.passHash)) bad('Your password is not correct.');
  Object.assign(ctx.user, { totpSecret: '', totpPending: '', totpEnabled: false });
  log(ctx, 'turned off two-step sign-in', 'account');
  return { user: profile(ctx.user) };
});

// ---- Admin: team ------------------------------------------------------------------------------
const teamMember = user => ({ id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role, active: user.active, totpEnabled: user.totpEnabled, lastLoginAt: user.lastLoginAt });
const activeOwners = () => db.users.filter(user => user.role === 'owner' && user.active).length;
function userFields(body, existing) {
  const fields = { name: text(body.name, 80, 'Name', true), email: emailOf(body.email), phone: phoneOf(body.phone, false), role: choice(body.role, Object.keys(ROLES), 'Role'), active: body.active !== false };
  if (!fields.email && !fields.phone) bad('Add an email address or phone number to sign in with.');
  if (db.users.some(user => user !== existing && ((fields.email && user.email === fields.email) || (fields.phone && user.phone === fields.phone)))) bad('Another team member already uses that email or phone.');
  return fields;
}
route('GET', '/api/admin/users', 'users', () => db.users.map(teamMember));
route('POST', '/api/admin/users', 'users', ctx => {
  const user = { id: newId(), ...userFields(ctx.body, null), passHash: sec.hashPassword(passwordOf(ctx.body.password)), totpSecret: '', totpPending: '', totpEnabled: false, mustChangePassword: true, createdAt: now(), lastLoginAt: '' };
  db.users.push(user);
  log(ctx, 'added', 'team member', `${user.name} (${user.role})`);
  return teamMember(user);
});
route('PUT', '/api/admin/users/:id', 'users', ctx => {
  const user = find('users', ctx.params.id);
  const fields = userFields({ ...teamMember(user), ...ctx.body }, user);
  if (user.role === 'owner' && user.active && (fields.role !== 'owner' || !fields.active) && activeOwners() === 1) bad('There must always be at least one active owner.');
  Object.assign(user, fields);
  if (ctx.body.password) { user.passHash = sec.hashPassword(passwordOf(ctx.body.password)); user.mustChangePassword = user.id !== ctx.user.id; sec.dropUserSessions(user.id, ctx.token); }
  if (ctx.body.resetTwoFactor === true) Object.assign(user, { totpSecret: '', totpPending: '', totpEnabled: false });
  if (!user.active) sec.dropUserSessions(user.id);
  log(ctx, 'updated', 'team member', `${user.name} (${user.role}${user.active ? '' : ', deactivated'})`);
  return teamMember(user);
});
route('DELETE', '/api/admin/users/:id', 'users', ctx => {
  const user = find('users', ctx.params.id);
  if (user.id === ctx.user.id) bad('You cannot remove your own account.');
  if (user.role === 'owner' && user.active && activeOwners() === 1) bad('There must always be at least one active owner.');
  db.users = db.users.filter(entry => entry !== user);
  sec.dropUserSessions(user.id);
  log(ctx, 'removed', 'team member', user.name);
  return { ok: true };
});
route('GET', '/api/admin/activity', 'activity', ctx => db.activity.slice(0, Math.min(Number(ctx.query.limit) || 300, 2000)));

// ---- Admin: generic add / edit / delete --------------------------------------------------------
function crud(pathname, collection, permission, label, clean, { beforeDelete, describe = record => record.name || record.title || record.code || record.caption || record.id } = {}) {
  route('GET', pathname, permission, () => db[collection]);
  route('POST', pathname, permission, ctx => {
    const record = { id: newId(), createdAt: now(), ...clean(ctx.body, null) };
    db[collection].push(record);
    log(ctx, 'added', label, describe(record));
    return record;
  });
  route('PUT', `${pathname}/:id`, permission, ctx => {
    const record = find(collection, ctx.params.id);
    Object.assign(record, clean({ ...record, ...ctx.body }, record));
    log(ctx, 'updated', label, describe(record));
    return record;
  });
  route('DELETE', `${pathname}/:id`, permission, ctx => {
    const record = find(collection, ctx.params.id);
    beforeDelete?.(record);
    db[collection] = db[collection].filter(entry => entry !== record);
    log(ctx, 'deleted', label, describe(record));
    return { ok: true };
  });
}

// ---- Admin: menu ----------------------------------------------------------------------------------
const BADGES = ['Chef’s Special', 'Bestseller', 'New'];
crud('/api/admin/categories', 'categories', 'menu', 'menu category', (body, existing) => ({
  // "happy" and "combo" categories make up the happy hours list; the note and photo are shown on its cards.
  name: text(body.name, 40, 'Category name', true), kind: choice(body.kind, ['food', 'drink', 'happy', 'combo'], 'Type'), note: text(body.note, 60, 'Note'), photo: imageOf(body.photo), order: existing ? existing.order : nextOrder('categories'),
  // Empty means the category is shown at every branch.
  branch: db.settings.branches.some(branch => branch.id === body.branch) ? body.branch : '',
}), { beforeDelete: category => { if (db.items.some(item => item.categoryId === category.id)) bad('Move or delete the items in this category first.'); } });
crud('/api/admin/items', 'items', 'menu', 'menu item', (body, existing) => {
  find('categories', body.categoryId);
  return {
    categoryId: body.categoryId, name: text(body.name, 80, 'Item name', true), description: text(body.description, 300, 'Description'), price: money(body.price, 'Price', true), photo: imageOf(body.photo),
    diet: choice(body.diet, ['veg', 'nonveg', 'alcoholic', 'ask'], 'Tag'), badges: (Array.isArray(body.badges) ? body.badges : []).filter(badge => BADGES.includes(badge)), available: body.available !== false,
    order: existing ? existing.order : nextOrder('items'),
  };
});
route('POST', '/api/admin/reorder', 'self', ctx => {
  const collection = choice(ctx.body.collection, ['categories', 'items', 'gallery'], 'List');
  if (!can(ctx.user, collection === 'gallery' ? 'content' : 'menu')) throw new HttpError(403, 'You do not have access to do that.');
  const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids : [];
  // Positions are swapped among the listed records only, so reordering one category leaves the others alone.
  const positions = ids.map(id => find(collection, id).order).sort((a, b) => a - b);
  ids.forEach((id, index) => { find(collection, id).order = positions[index]; });
  log(ctx, 'reordered', collection === 'gallery' ? 'gallery' : `menu ${collection}`);
  return { ok: true };
});
route('POST', '/api/admin/menu/bulk-price', 'menu', ctx => {
  const percent = Number(ctx.body.percent);
  if (!Number.isFinite(percent) || percent === 0 || percent < -90 || percent > 500) bad('Enter a percentage between -90 and 500.');
  const step = choice(Number(ctx.body.roundTo), [1, 5, 10], 'Rounding');
  const category = ctx.body.categoryId === 'all' ? null : find('categories', ctx.body.categoryId);
  const affected = db.items.filter(item => item.price !== null && (!category || item.categoryId === category.id));
  for (const item of affected) item.price = Math.max(0, Math.round(item.price * (1 + percent / 100) / step) * step);
  log(ctx, 'bulk price update', 'menu', `${percent > 0 ? '+' : ''}${percent}% on ${category ? category.name : 'all items'} (${affected.length} items)`);
  return { updated: affected.length };
});

// ---- Admin: reservations ----------------------------------------------------------------------------
function filterReservations(query) {
  const search = String(query.q || '').toLowerCase();
  return db.reservations.filter(entry => (!query.branch || branchOf(entry.branch).id === query.branch) && (!query.from || entry.date >= query.from) && (!query.to || entry.date <= query.to) && (!query.status || entry.status === query.status) && (!query.time || entry.time === query.time) && (!search || `${entry.name} ${entry.phone} ${entry.ref}`.toLowerCase().includes(search)))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}
// Cells that a spreadsheet would run as a formula are neutralised with a leading apostrophe.
const csv = rows => '﻿' + rows.map(row => row.map(cell => { const value = String(cell ?? ''); return `"${(/^[=+\-@\t\r]/.test(value) ? "'" + value : value).replace(/"/g, '""')}"`; }).join(',')).join('\r\n');
const download = (name, rows) => ({ download: { name: `${name}-${today()}.csv`, body: csv(rows) } });

route('GET', '/api/admin/reservations', 'reservations.read', ctx => filterReservations(ctx.query));
route('GET', '/api/admin/reservations/export', 'reservations.write', ctx => {
  const rows = filterReservations(ctx.query);
  log(ctx, 'exported', 'reservations', `${rows.length} bookings`);
  return download('nasha-bookings', [['Reference', 'Branch', 'Date', 'Time', 'Guests', 'Name', 'Phone', 'Email', 'Status', 'Source', 'Notes', 'Created'], ...rows.map(entry => [entry.ref, branchOf(entry.branch).name, entry.date, entry.time, entry.guests, entry.name, entry.phone, entry.email, entry.status, entry.source, entry.notes, entry.createdAt])]);
});
route('GET', '/api/admin/availability', 'reservations.read', ctx => availability(dateOf(ctx.query.date, 'Date'), branchOf(ctx.query.branch).id));
route('POST', '/api/admin/reservations', 'reservations.write', ctx => {
  const reservation = createReservation(ctx.body, { source: choice(ctx.body.source, ['phone', 'walk-in'], 'Source'), status: choice(ctx.body.status || 'confirmed', RESERVATION_STATUSES, 'Status'), force: ctx.body.force === true });
  if (reservation.status === 'confirmed' && ctx.body.notify === true) notifyCustomer(reservation, reservationMessage(reservation, 'confirmed'), 'Table booking', reservation.ref);
  log(ctx, 'added', 'reservation', `${reservation.ref} ${reservation.name}, ${reservation.guests} on ${reservation.date} ${reservation.time} (${reservation.source})`);
  return reservation;
});
route('PUT', '/api/admin/reservations/:id', 'reservations.write', ctx => {
  const reservation = find('reservations', ctx.params.id);
  const body = { ...reservation, ...ctx.body };
  const previous = reservation.status;
  Object.assign(reservation, {
    name: text(body.name, 80, 'Name', true), phone: phoneOf(body.phone), email: emailOf(body.email), date: dateOf(body.date, 'Date'), time: timeOf(body.time, 'Time'),
    guests: int(body.guests, 1, 500, 'Guests'), notes: text(body.notes, 500, 'Notes'), status: choice(body.status, RESERVATION_STATUSES, 'Status'), branch: branchOf(body.branch).id, updatedAt: now(),
  });
  if (reservation.status !== previous && ['confirmed', 'cancelled'].includes(reservation.status)) notifyCustomer(reservation, reservationMessage(reservation, reservation.status), 'Table booking', reservation.ref);
  log(ctx, reservation.status !== previous ? `marked ${reservation.status}` : 'updated', 'reservation', `${reservation.ref} ${reservation.name}`);
  return reservation;
});
route('DELETE', '/api/admin/reservations/:id', 'reservations.write', ctx => {
  const reservation = find('reservations', ctx.params.id);
  db.reservations = db.reservations.filter(entry => entry !== reservation);
  log(ctx, 'deleted', 'reservation', `${reservation.ref} ${reservation.name}`);
  return { ok: true };
});

// ---- Admin: events, offers, coupons, vouchers ---------------------------------------------------------
crud('/api/admin/events', 'events', 'events', 'event', body => ({
  title: text(body.title, 100, 'Title', true), type: choice(body.type, ['dj', 'live', 'karaoke', 'sports', 'other'], 'Event type'), date: dateOf(body.date, 'Date'), time: timeOf(body.time, 'Start time'), endTime: timeOf(body.endTime, 'End time', true),
  poster: imageOf(body.poster), description: text(body.description, 800, 'Description'), entryFee: money(body.entryFee, 'Entry fee', true), bookingLimit: body.bookingLimit ? int(body.bookingLimit, 1, 5000, 'Booking limit') : null, published: body.published !== false,
}), { beforeDelete: event => { db.eventBookings = db.eventBookings.filter(entry => entry.eventId !== event.id); } });
// The party menu: packages (with a price per guest), the dishes guests choose from, and the terms.
// Details are one line per entry; a line starting with "# " is a heading.
crud('/api/admin/party', 'party', 'events', 'party menu entry', (body, existing) => {
  const kind = choice(body.kind, ['package', 'course', 'terms'], 'Type');
  return { kind, name: text(body.name, 60, 'Name', true), price: kind === 'package' ? money(body.price, 'Price per guest') : null, details: text(body.details, 4000, 'Details'), order: existing ? existing.order : nextOrder('party') };
});
route('GET', '/api/admin/event-bookings', 'events', ctx => db.eventBookings.filter(entry => !ctx.query.eventId || entry.eventId === ctx.query.eventId));
route('PUT', '/api/admin/event-bookings/:id', 'events', ctx => {
  const booking = find('eventBookings', ctx.params.id);
  booking.status = choice(ctx.body.status, ['booked', 'attended', 'cancelled'], 'Status');
  log(ctx, `marked ${booking.status}`, 'event booking', booking.name);
  return booking;
});

crud('/api/admin/offers', 'offers', 'offers', 'offer', body => {
  const offer = {
    title: text(body.title, 100, 'Title', true), description: text(body.description, 400, 'Description'), startDate: dateOf(body.startDate, 'Start date', true), endDate: dateOf(body.endDate, 'End date', true),
    startTime: timeOf(body.startTime, 'Start time', true), endTime: timeOf(body.endTime, 'End time', true), days: [...new Set((Array.isArray(body.days) ? body.days : []).map(Number).filter(day => day >= 0 && day <= 6))].sort(),
    couponCode: text(body.couponCode, 20, 'Coupon code').toUpperCase(), active: body.active !== false,
    // Empty means the website picks a photo that suits the offer's wording.
    photo: imageOf(body.photo),
    // Empty means the offer runs at every branch.
    branch: db.settings.branches.some(branch => branch.id === body.branch) ? body.branch : '',
  };
  if (offer.startDate && offer.endDate && offer.endDate < offer.startDate) bad('The end date must be after the start date.');
  return offer;
});
crud('/api/admin/coupons', 'coupons', 'offers', 'coupon', (body, existing) => {
  const coupon = {
    code: text(body.code, 20, 'Code', true).toUpperCase(), type: choice(body.type, ['percent', 'flat'], 'Discount type'), value: money(body.value, 'Discount'), minOrder: money(body.minOrder || 0, 'Minimum order'),
    startDate: dateOf(body.startDate, 'Start date', true), endDate: dateOf(body.endDate, 'End date', true), maxUses: int(body.maxUses || 0, 0, 100000, 'Maximum uses'), active: body.active !== false, used: existing?.used || 0,
  };
  if (!/^[A-Z0-9]{3,20}$/.test(coupon.code)) bad('Codes use 3–20 letters and numbers, without spaces.');
  if (coupon.type === 'percent' && (coupon.value <= 0 || coupon.value > 100)) bad('A percentage discount must be between 1 and 100.');
  if (db.coupons.some(entry => entry !== existing && entry.code === coupon.code)) bad('That code already exists.');
  return coupon;
});
route('GET', '/api/admin/vouchers', 'offers', () => db.vouchers);
route('POST', '/api/admin/vouchers', 'offers', ctx => {
  const voucher = { id: newId(), createdAt: now(), code: '', status: 'requested', balance: 0, amount: int(ctx.body.amount, 100, 50000, 'Amount'), buyerName: text(ctx.body.buyerName, 80, 'Buyer name', true), buyerPhone: phoneOf(ctx.body.buyerPhone), recipientName: text(ctx.body.recipientName, 80, 'Recipient name', true), message: text(ctx.body.message, 300, 'Message') };
  db.vouchers.push(voucher);
  log(ctx, 'added', 'gift voucher', `₹${voucher.amount} for ${voucher.recipientName}`);
  return voucher;
});
route('PUT', '/api/admin/vouchers/:id', 'offers', ctx => {
  const voucher = find('vouchers', ctx.params.id);
  const action = choice(ctx.body.action, ['issue', 'redeem', 'cancel'], 'Action');
  if (action === 'issue') {
    if (voucher.status !== 'requested') bad('This voucher has already been issued.');
    const block = () => randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
    Object.assign(voucher, { code: `NASHA-${block()}-${block()}`, status: 'active', balance: voucher.amount, issuedAt: now() });
    notifyCustomer({ phone: voucher.buyerPhone }, `Your ${db.settings.info.name} gift voucher for ${voucher.recipientName} is ready. Code ${voucher.code}, value ₹${voucher.amount}. Show this code at the restaurant to redeem.`, 'Gift voucher', voucher.code);
  } else if (action === 'redeem') {
    if (voucher.status !== 'active') bad('Only active vouchers can be redeemed.');
    const amount = money(ctx.body.amount, 'Amount');
    if (amount <= 0 || amount > voucher.balance) bad(`Enter an amount up to the remaining balance of ₹${voucher.balance}.`);
    voucher.balance = Math.round((voucher.balance - amount) * 100) / 100;
    if (voucher.balance === 0) Object.assign(voucher, { status: 'redeemed', redeemedAt: now() });
  } else voucher.status = 'cancelled';
  log(ctx, `${action}${action === 'issue' ? 'd' : 'ed'}`.replace('canceled', 'cancelled'), 'gift voucher', voucher.code || `₹${voucher.amount} for ${voucher.recipientName}`);
  return voucher;
});

// ---- Admin: inquiries, reviews, orders ------------------------------------------------------------------
route('GET', '/api/admin/inquiries', 'inquiries', () => db.inquiries);
route('PUT', '/api/admin/inquiries/:id', 'inquiries', ctx => {
  const inquiry = find('inquiries', ctx.params.id);
  if (ctx.body.status && ctx.body.status !== inquiry.status) { inquiry.status = choice(ctx.body.status, INQUIRY_STATUSES, 'Status'); log(ctx, `marked ${inquiry.status}`, 'inquiry', inquiry.name); }
  const note = text(ctx.body.note, 1000, 'Note');
  if (note) { inquiry.notes.push({ at: now(), by: ctx.user.name, text: note }); log(ctx, 'added a note to', 'inquiry', inquiry.name); }
  return inquiry;
});
route('DELETE', '/api/admin/inquiries/:id', 'inquiries', ctx => {
  const inquiry = find('inquiries', ctx.params.id);
  db.inquiries = db.inquiries.filter(entry => entry !== inquiry);
  log(ctx, 'deleted', 'inquiry', inquiry.name);
  return { ok: true };
});

route('GET', '/api/admin/reviews', 'reviews', () => db.reviews);
route('PUT', '/api/admin/reviews/:id', 'reviews', ctx => {
  const review = find('reviews', ctx.params.id);
  if (ctx.body.status) review.status = choice(ctx.body.status, ['pending', 'approved', 'hidden'], 'Status');
  if ('reply' in ctx.body) review.reply = text(ctx.body.reply, 600, 'Reply');
  log(ctx, ctx.body.status ? `marked ${review.status}` : 'replied to', 'review', `${review.name} (${review.rating}★)`);
  return review;
});
route('DELETE', '/api/admin/reviews/:id', 'reviews', ctx => {
  const review = find('reviews', ctx.params.id);
  db.reviews = db.reviews.filter(entry => entry !== review);
  log(ctx, 'deleted', 'review', review.name);
  return { ok: true };
});

// Guest memories. Only an approved photo is public; hiding it makes it private again.
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
route('GET', '/api/admin/memories', 'memories', () => db.memories);
route('GET', '/api/admin/memories/:id/photo', 'memories', async ctx => {
  const memory = find('memories', ctx.params.id);
  const photo = await images.get(memory.file);
  if (!photo) bad('That photo file is missing.');
  return { data: `data:${MIME[path.extname(memory.file).slice(1)]};base64,${photo.bytes.toString('base64')}` };
});
route('PUT', '/api/admin/memories/:id', 'memories', async ctx => {
  const memory = find('memories', ctx.params.id);
  const status = choice(ctx.body.status, ['pending', 'approved', 'hidden'], 'Status');
  if ((status === 'approved') !== (memory.status === 'approved')) await images.setPublic(memory.file, status === 'approved');
  memory.status = status;
  memory.image = status === 'approved' ? `/uploads/${memory.file}` : '';
  log(ctx, `marked ${status}`, 'guest memory', memory.name);
  return memory;
});
route('DELETE', '/api/admin/memories/:id', 'memories', async ctx => {
  const memory = find('memories', ctx.params.id);
  await images.remove(memory.file);
  db.memories = db.memories.filter(entry => entry !== memory);
  log(ctx, 'deleted', 'guest memory', memory.name);
  return { ok: true };
});

const orderDay = order => ist(new Date(order.createdAt)).date;
route('GET', '/api/admin/orders', 'orders', ctx => {
  const date = ctx.query.date ? dateOf(ctx.query.date, 'Date') : '';
  const orders = db.orders.filter(order => !date || orderDay(order) === date).sort((a, b) => b.number - a.number).map(({ token, ...order }) => order);
  const counted = orders.filter(order => order.status !== 'cancelled');
  return { orders, latest: db.meta.orderSeq, summary: { count: counted.length, revenue: counted.reduce((sum, order) => sum + order.total, 0), paid: counted.filter(order => order.paymentStatus === 'paid').reduce((sum, order) => sum + order.total, 0), cod: counted.filter(order => order.paymentStatus === 'cod').reduce((sum, order) => sum + order.total, 0), unpaid: counted.filter(order => order.paymentStatus === 'pending').reduce((sum, order) => sum + order.total, 0) } };
});
route('PUT', '/api/admin/orders/:id', 'orders', ctx => {
  const order = find('orders', ctx.params.id);
  if (ctx.body.status) order.status = choice(ctx.body.status, ORDER_STATUSES, 'Status');
  if (ctx.body.paymentStatus) order.paymentStatus = choice(ctx.body.paymentStatus, ['cod', 'pending', 'paid'], 'Payment status');
  log(ctx, `marked ${ctx.body.status ? order.status : order.paymentStatus}`, 'order', `#${order.number}`);
  const { token, ...rest } = order;
  return rest;
});

// ---- Admin: customers and promotions -----------------------------------------------------------------------
function customerStats() {
  const stats = new Map();
  const of = phone => { if (!stats.has(phone)) stats.set(phone, { visits: 0, lastVisit: '', bookings: 0, orders: 0, spend: 0 }); return stats.get(phone); };
  for (const reservation of db.reservations) {
    const entry = of(reservation.phone);
    entry.bookings++;
    if (['seated', 'completed'].includes(reservation.status)) { entry.visits++; if (reservation.date > entry.lastVisit) entry.lastVisit = reservation.date; }
  }
  for (const order of db.orders) if (order.status !== 'cancelled') { const entry = of(order.phone); entry.orders++; entry.spend += order.total; }
  return stats;
}
const customerFields = (body, existing) => {
  const fields = {
    name: text(body.name, 80, 'Name', true), phone: phoneOf(body.phone), email: emailOf(body.email), birthday: dateOf(body.birthday, 'Birthday', true), anniversary: dateOf(body.anniversary, 'Anniversary', true),
    tags: [...new Set((Array.isArray(body.tags) ? body.tags : []).map(tag => text(tag, 20, 'Tag')).filter(Boolean))].slice(0, 8), notes: text(body.notes, 600, 'Notes'), optIn: body.optIn === true,
  };
  if (db.customers.some(entry => entry !== existing && entry.phone === fields.phone)) bad('Another customer already has that phone number.');
  return fields;
};
route('GET', '/api/admin/customers', 'customers', () => {
  const stats = customerStats();
  return db.customers.map(customer => ({ ...customer, ...(stats.get(customer.phone) || { visits: 0, lastVisit: '', bookings: 0, orders: 0, spend: 0 }) }));
});
route('GET', '/api/admin/customers/export', 'customers', ctx => {
  const stats = customerStats();
  log(ctx, 'exported', 'customers', `${db.customers.length} customers`);
  return download('nasha-customers', [['Name', 'Phone', 'Email', 'Tags', 'Birthday', 'Anniversary', 'Visits', 'Last visit', 'Bookings', 'Orders', 'Spend', 'Accepts offers', 'Notes'], ...db.customers.map(customer => { const entry = stats.get(customer.phone) || {}; return [customer.name, customer.phone, customer.email, customer.tags.join('; '), customer.birthday, customer.anniversary, entry.visits || 0, entry.lastVisit || '', entry.bookings || 0, entry.orders || 0, entry.spend || 0, customer.optIn ? 'Yes' : 'No', customer.notes]; })]);
});
route('GET', '/api/admin/customers/:id/history', 'customers', ctx => {
  const customer = find('customers', ctx.params.id);
  return {
    reservations: db.reservations.filter(entry => entry.phone === customer.phone).sort((a, b) => b.date.localeCompare(a.date)),
    orders: db.orders.filter(entry => entry.phone === customer.phone).map(({ number, createdAt, total, status }) => ({ number, createdAt, total, status })),
    inquiries: db.inquiries.filter(entry => entry.phone === customer.phone).map(({ type, date, guests, status }) => ({ type, date, guests, status })),
    events: db.eventBookings.filter(entry => entry.phone === customer.phone).map(entry => ({ title: db.events.find(event => event.id === entry.eventId)?.title || 'Event', guests: entry.guests, status: entry.status })),
  };
});
route('POST', '/api/admin/customers', 'customers', ctx => {
  const customer = { id: newId(), createdAt: now(), ...customerFields(ctx.body, null) };
  db.customers.push(customer);
  log(ctx, 'added', 'customer', customer.name);
  return customer;
});
route('PUT', '/api/admin/customers/:id', 'customers', ctx => {
  const customer = find('customers', ctx.params.id);
  Object.assign(customer, customerFields({ ...customer, ...ctx.body }, customer));
  log(ctx, 'updated', 'customer', customer.name);
  return customer;
});
route('DELETE', '/api/admin/customers/:id', 'customers', ctx => {
  const customer = find('customers', ctx.params.id);
  db.customers = db.customers.filter(entry => entry !== customer);
  log(ctx, 'deleted', 'customer', customer.name);
  return { ok: true };
});

function audience(body) {
  const type = choice(body.audience, ['optin', 'tag', 'birthday', 'anniversary'], 'Audience');
  const month = today().slice(5, 7);
  // Promotions only ever go to customers who agreed to receive offers.
  return db.customers.filter(customer => customer.optIn && (type === 'optin' || (type === 'tag' && customer.tags.includes(body.tag)) || (type === 'birthday' && customer.birthday.slice(5, 7) === month) || (type === 'anniversary' && customer.anniversary.slice(5, 7) === month)));
}
route('POST', '/api/admin/promotions/preview', 'customers', ctx => ({ count: audience(ctx.body).length }));
route('POST', '/api/admin/promotions', 'customers', ctx => {
  const channel = choice(ctx.body.channel, ['whatsapp', 'sms', 'email'], 'Channel');
  const message = text(ctx.body.message, 1000, 'Message', true);
  const batch = newId();
  let queued = 0;
  for (const customer of audience(ctx.body)) {
    const to = channel === 'email' ? customer.email : customer.phone;
    if (to && queue({ channel, to, subject: text(ctx.body.subject, 100, 'Subject') || `News from ${db.settings.info.name}`, text: message.replaceAll('{name}', customer.name.split(' ')[0]), kind: 'Promotion', batch })) queued++;
  }
  log(ctx, 'sent promotion', 'customers', `${queued} ${channel} messages`);
  return { queued, automatic: Boolean(db.settings.notifications.webhookUrl || (db.settings.notifications.twilioSid && channel !== 'email')) };
});
route('GET', '/api/admin/messages', 'messages', ctx => db.outbox.slice(0, Math.min(Number(ctx.query.limit) || 300, 3000)));
route('PUT', '/api/admin/messages/:id', 'messages', async ctx => {
  const message = find('outbox', ctx.params.id);
  if (ctx.body.action === 'retry') await deliver(message);
  else Object.assign(message, { status: 'sent', error: '', updatedAt: now() });
  save();
  return message;
});

// ---- Admin: website content, gallery, uploads -----------------------------------------------------------------
crud('/api/admin/gallery', 'gallery', 'content', 'gallery photo', (body, existing) => {
  const image = imageOf(body.image);
  if (!image) bad('Upload a photo first.');
  return { image, caption: text(body.caption, 80, 'Caption', true), alt: text(body.alt, 160, 'Description') || text(body.caption, 80, 'Caption'), category: choice(body.category, ['spaces', 'food', 'drinks', 'events'], 'Category'), order: existing ? existing.order : nextOrder('gallery') };
});
route('GET', '/api/admin/content', 'content', () => db.content);
route('PUT', '/api/admin/content/:section', 'content', ctx => {
  const body = ctx.body;
  const section = choice(ctx.params.section, ['hero', 'about', 'seo', 'instagram'], 'Section');
  if (section === 'hero') db.content.hero = { eyebrow: text(body.eyebrow, 80, 'Small heading'), title: text(body.title, 120, 'Headline'), description: text(body.description, 240, 'Introduction'), image: imageOf(body.image) };
  if (section === 'about') db.content.about = { heading: text(body.heading, 120, 'Heading'), body: text(body.body, 3000, 'Story'), chefName: text(body.chefName, 80, 'Chef name'), chefBio: text(body.chefBio, 1200, 'Chef introduction'), chefPhoto: imageOf(body.chefPhoto), ambience: text(body.ambience, 1200, 'Ambience') };
  if (section === 'seo') {
    const seo = {};
    for (const page of PAGES) {
      const title = text(body[page]?.title, 70, 'Page title'), description = text(body[page]?.description, 170, 'Meta description');
      if (title || description) seo[page] = { title, description };
    }
    db.content.seo = seo;
  }
  if (section === 'instagram') db.content.instagramPosts = (Array.isArray(body.posts) ? body.posts : []).map(url => text(url, 200, 'Post link')).filter(Boolean).slice(0, 6).map(url => { if (!/^https:\/\/www\.instagram\.com\/(p|reel)\/[\w-]+\/?$/.test(url)) bad('Instagram links look like https://www.instagram.com/p/XXXXXXXX/'); return url; });
  log(ctx, 'updated', 'website content', section);
  return db.content;
});

const SIGNATURES = [['jpg', [0xff, 0xd8, 0xff]], ['png', [0x89, 0x50, 0x4e, 0x47]], ['webp', [0x52, 0x49, 0x46, 0x46]]];
function imageBytes(data) {
  const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
  if (!match) bad('Upload a JPG, PNG or WebP image.');
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length > 5 * 1024 * 1024) bad('Images must be 5 MB or smaller.');
  // The file type is taken from the file's own contents, never from its name.
  const kind = SIGNATURES.find(([extension, signature]) => signature.every((byte, index) => bytes[index] === byte) && (extension !== 'webp' || bytes.subarray(8, 12).toString() === 'WEBP'));
  if (!kind) bad('That file is not a valid JPG, PNG or WebP image.');
  return { bytes, extension: kind[0] };
}
route('POST', '/api/admin/upload', 'upload', async ctx => {
  const { bytes, extension } = imageBytes(ctx.body.data);
  const name = `${randomBytes(10).toString('hex')}.${extension}`;
  await images.put(name, bytes, true);
  log(ctx, 'uploaded', 'image', name);
  return { path: `/uploads/${name}` };
});

// ---- Admin: settings ----------------------------------------------------------------------------------------
const SECRETS = { notifications: ['twilioToken', 'webhookSecret'], payments: ['keySecret'] };
function visibleSettings() {
  const settings = structuredClone(db.settings);
  for (const [section, keys] of Object.entries(SECRETS)) for (const key of keys) { settings[section][`${key}Set`] = Boolean(settings[section][key]); settings[section][key] = ''; }
  return settings;
}
const SECTIONS = {
  info: ['settings', body => ({ name: text(body.name, 80, 'Restaurant name', true), logo: imageOf(body.logo), gst: text(body.gst, 20, 'GST number').toUpperCase(), address: text(body.address, 300, 'Address', true), phone: phoneOf(body.phone), phoneDisplay: text(body.phoneDisplay, 30, 'Phone as shown') || phoneOf(body.phone), email: emailOf(body.email), whatsapp: phoneOf(body.whatsapp, false), mapsUrl: urlOf(body.mapsUrl, 'Google Maps link'), siteUrl: urlOf(body.siteUrl, 'Website address').replace(/\/+$/, '') })],
  branches: ['settings', (body, current) => current.map((branch, index) => {
    const entry = (Array.isArray(body.branches) ? body.branches : [])[index] || branch;
    // Zomato listings, one per line as "Name | link". A branch can have more than one (e.g. a second
    // listing under a different name at the same address).
    const zomatoLinks = (Array.isArray(entry.zomatoLinksText) ? entry.zomatoLinksText : String(entry.zomatoLinksText ?? '').split('\n'))
      .map(line => line.trim()).filter(Boolean).slice(0, 5)
      .map(line => { const [name, url] = line.split('|').map(part => part.trim()); return { name: text(name, 60, 'Zomato listing name'), url: urlOf(url, 'Zomato link') }; })
      .filter(entry => entry.url);
    return { id: branch.id, name: text(entry.name, 40, 'Branch name', true), address: text(entry.address, 300, 'Branch address', true), phone: phoneOf(entry.phone), phoneDisplay: text(entry.phoneDisplay, 30, 'Phone as shown') || phoneOf(entry.phone), whatsapp: phoneOf(entry.whatsapp, false), mapsUrl: urlOf(entry.mapsUrl, 'Google Maps link'), instagram: urlOf(entry.instagram, 'Instagram link'), heroImage: imageOf(entry.heroImage), zomatoLinks };
  })],
  hours: ['settings', body => {
    if (!Array.isArray(body.hours) || body.hours.length !== 7) bad('Opening hours are incomplete.');
    return body.hours.map((entry, day) => ({ day, open: timeOf(entry.open, 'Opening time'), close: timeOf(entry.close, 'Closing time'), closed: entry.closed === true }));
  }],
  holidays: ['settings', body => (Array.isArray(body.holidays) ? body.holidays : []).slice(0, 60).map(entry => ({ date: dateOf(entry.date, 'Holiday date'), note: text(entry.note, 80, 'Note') })).sort((a, b) => a.date.localeCompare(b.date))],
  social: ['content', body => Object.fromEntries(Object.keys(db.settings.social).map(key => [key, urlOf(body[key], `${key} link`)]))],
  ageGate: ['settings', body => ({ enabled: body.enabled === true, minAge: choice(Number(body.minAge), [18, 21, 25], 'Minimum age') })],
  booking: ['reservations.write', body => {
    const booking = { firstSlot: timeOf(body.firstSlot, 'First time slot'), lastSlot: timeOf(body.lastSlot, 'Last time slot'), slotMinutes: choice(Number(body.slotMinutes), [15, 30, 60], 'Slot length'), capacityPerSlot: int(body.capacityPerSlot, 1, 2000, 'Seats per time slot'), maxParty: int(body.maxParty, 1, 100, 'Largest online booking'), maxDaysAhead: int(body.maxDaysAhead, 1, 365, 'Days ahead'), autoConfirm: body.autoConfirm === true, blockedDates: (Array.isArray(body.blockedDates) ? body.blockedDates : []).slice(0, 120).map(entry => ({ date: dateOf(entry.date, 'Blocked date'), reason: text(entry.reason, 80, 'Reason') })).sort((a, b) => a.date.localeCompare(b.date)) };
    if (booking.lastSlot < booking.firstSlot) bad('The last time slot must be after the first.');
    return booking;
  }],
  notifications: ['settings', (body, current) => ({ recipients: (Array.isArray(body.recipients) ? body.recipients : []).map(entry => String(entry).includes('@') ? emailOf(entry, true) : phoneOf(entry)).slice(0, 10), customerChannel: choice(body.customerChannel, ['whatsapp', 'sms', 'email'], 'Customer channel'), twilioSid: text(body.twilioSid, 60, 'Twilio account SID'), twilioToken: text(body.twilioToken, 80, 'Twilio token') || current.twilioToken, twilioSmsFrom: phoneOf(body.twilioSmsFrom, false), twilioWhatsappFrom: phoneOf(body.twilioWhatsappFrom, false), webhookUrl: urlOf(body.webhookUrl, 'Webhook address'), webhookSecret: text(body.webhookSecret, 80, 'Webhook secret') || current.webhookSecret })],
  payments: ['settings', (body, current) => ({ gateway: choice(body.gateway, ['none', 'razorpay', 'payu', 'paytm'], 'Gateway'), keyId: text(body.keyId, 80, 'Key ID'), keySecret: text(body.keySecret, 120, 'Key secret') || current.keySecret })],
  ordering: ['settings', body => ({ enabled: body.enabled === true, delivery: body.delivery === true, deliveryFee: money(body.deliveryFee || 0, 'Delivery fee'), minOrder: money(body.minOrder || 0, 'Minimum order') })],
  banner: ['offers', body => ({ mode: choice(body.mode, ['off', 'bar', 'popup'], 'Banner style'), offerId: body.offerId ? find('offers', body.offerId).id : '', text: text(body.text, 140, 'Banner text'), link: choice(body.link || 'offers.html', PAGES, 'Banner link') })],
};
route('GET', '/api/admin/settings', 'reservations.read', () => visibleSettings());
route('PUT', '/api/admin/settings/:section', 'self', ctx => {
  const entry = SECTIONS[ctx.params.section];
  if (!entry) throw new HttpError(404, 'Unknown settings section.');
  if (!can(ctx.user, entry[0])) throw new HttpError(403, 'You do not have access to change that.');
  db.settings[ctx.params.section] = entry[1](ctx.body, db.settings[ctx.params.section]);
  log(ctx, 'updated', 'settings', ctx.params.section);
  return visibleSettings();
});

// ---- Admin: dashboard and reports -----------------------------------------------------------------------------------
function visitors(days) {
  const date = today();
  let unique = 0, views = 0;
  for (let offset = 0; offset < days; offset++) { const day = db.visits[addDays(date, -offset)]; if (day) { unique += day.visitors.length; views += day.views; } }
  return { visitors: unique, views };
}
route('GET', '/api/admin/dashboard', 'dashboard', ctx => {
  const date = today();
  const todays = db.reservations.filter(entry => entry.date === date && entry.status !== 'cancelled');
  return {
    date,
    reservations: { count: todays.length, guests: todays.reduce((sum, entry) => sum + entry.guests, 0), pending: db.reservations.filter(entry => entry.status === 'pending' && entry.date >= date).length, list: todays.sort((a, b) => a.time.localeCompare(b.time)).slice(0, 8) },
    events: db.events.filter(event => event.date >= date).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5).map(({ id, title, date: eventDate, time, type, published }) => ({ id, title, date: eventDate, time, type, published })),
    inquiries: can(ctx.user, 'inquiries') ? db.inquiries.filter(entry => entry.status === 'new').slice(-5).reverse().map(({ id, name, type, date: inquiryDate, guests }) => ({ id, name, type, date: inquiryDate, guests })) : [],
    newInquiries: db.inquiries.filter(entry => entry.status === 'new').length,
    pendingReviews: db.reviews.filter(entry => entry.status === 'pending').length,
    pendingMemories: db.memories.filter(entry => entry.status === 'pending').length,
    openOrders: db.orders.filter(order => ['received', 'preparing', 'ready'].includes(order.status)).length,
    voucherRequests: db.vouchers.filter(voucher => voucher.status === 'requested').length,
    unsentMessages: db.outbox.filter(message => message.status !== 'sent').length,
    visitors: { day: visitors(1), week: visitors(7), month: visitors(30) },
  };
});

route('GET', '/api/admin/reports', 'reports', ctx => {
  const to = dateOf(ctx.query.to || today(), 'End date'), from = dateOf(ctx.query.from || addDays(to, -29), 'Start date');
  if (from > to) bad('The start date must be before the end date.');
  const tally = (list, keyOf) => {
    const groups = new Map();
    for (const entry of list) { const key = keyOf(entry); const group = groups.get(key) || { key, count: 0, guests: 0 }; group.count++; group.guests += entry.guests || 0; groups.set(key, group); }
    return [...groups.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));
  };
  const all = db.reservations.filter(entry => entry.date >= from && entry.date <= to);
  const kept = all.filter(entry => entry.status !== 'cancelled');
  const count = status => all.filter(entry => entry.status === status).length;
  const arrived = count('seated') + count('completed'), noShows = count('no-show');
  const orders = db.orders.filter(order => order.status !== 'cancelled' && orderDay(order) >= from && orderDay(order) <= to);
  const items = new Map();
  for (const order of orders) for (const line of order.lines) { const item = items.get(line.name) || { name: line.name, qty: 0, revenue: 0 }; item.qty += line.qty; item.revenue += line.total; items.set(line.name, item); }
  const weekStart = date => addDays(date, -((weekday(date) + 6) % 7));
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return {
    from, to,
    bookings: {
      total: all.length, guests: kept.reduce((sum, entry) => sum + entry.guests, 0), byStatus: RESERVATION_STATUSES.map(status => ({ key: status, count: count(status) })),
      daily: tally(kept, entry => entry.date), weekly: tally(kept, entry => weekStart(entry.date)), monthly: tally(kept, entry => entry.date.slice(0, 7)),
      peakHours: tally(kept, entry => entry.time), weekdays: dayNames.map((name, day) => ({ key: name, ...kept.filter(entry => weekday(entry.date) === day).reduce((sum, entry) => ({ count: sum.count + 1, guests: sum.guests + entry.guests }), { count: 0, guests: 0 }) })),
      noShows, arrived, noShowRate: noShows + arrived ? Math.round(noShows / (noShows + arrived) * 1000) / 10 : null,
    },
    items: [...items.values()].sort((a, b) => b.qty - a.qty).slice(0, 20),
    sales: { orders: orders.length, revenue: orders.reduce((sum, order) => sum + order.total, 0) },
    events: db.events.filter(event => event.date >= from && event.date <= to).map(event => { const bookings = db.eventBookings.filter(entry => entry.eventId === event.id && entry.status !== 'cancelled'); return { title: event.title, date: event.date, booked: bookings.reduce((sum, entry) => sum + entry.guests, 0), attended: bookings.filter(entry => entry.status === 'attended').reduce((sum, entry) => sum + entry.guests, 0), limit: event.bookingLimit }; }),
    visitors: Object.entries(db.visits).filter(([date]) => date >= from && date <= to).sort().map(([date, day]) => ({ key: date, count: day.visitors.length, views: day.views })),
  };
});

// ---- Dispatcher -------------------------------------------------------------------------------------------------------
async function readBody(request, limit) {
  // A request with nothing in it (the admin panel's Delete buttons) needs no content type.
  const empty = !request.headers['transfer-encoding'] && !Number(request.headers['content-length'] || 0);
  if (empty) return {};
  if (!/^application\/json\b/.test(request.headers['content-type'] || '')) throw new HttpError(415, 'Requests must be sent as JSON.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'That is too large to send.');
    chunks.push(chunk);
  }
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (body && typeof body === 'object' && !Array.isArray(body)) return body; } catch { /* handled below */ }
  throw new HttpError(400, 'The request could not be read.');
}

export async function handleApi(request, response, url, ip) {
  const secure = request.headers['x-forwarded-proto'] === 'https';
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  const send = (status, body) => { response.writeHead(status, headers); response.end(JSON.stringify(body)); };
  try {
    let found, params;
    for (const candidate of routes) {
      const match = candidate.method === request.method && candidate.matcher.exec(url.pathname);
      if (match) { found = candidate; params = match.groups || {}; break; }
    }
    if (!found) throw new HttpError(404, 'Not found.');
    const token = /(?:^|;\s*)nasha_sid=([\w-]+)/.exec(request.headers.cookie || '')?.[1] || '';
    const ctx = {
      request, params, ip, token, query: Object.fromEntries(url.searchParams), body: {}, user: null,
      origin: db.settings.info.siteUrl || `${secure ? 'https' : 'http'}://${request.headers.host}`,
      setSession(value) { ctx.token = value; headers['Set-Cookie'] = `nasha_sid=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${value ? '' : '; Max-Age=0'}`; },
    };
    const admin = url.pathname.startsWith('/api/admin/');
    // Admin requests must come from the panel's own scripts; other sites cannot set this header.
    if (admin && request.method !== 'GET' && request.headers['x-nasha-admin'] !== '1') throw new HttpError(403, 'Request blocked.');
    if (found.permission !== 'public') {
      const session = sec.getSession(token);
      const user = session && db.users.find(entry => entry.id === session.userId && entry.active);
      if (!user || (session.pending !== (found.permission === 'pending'))) throw new HttpError(401, 'Please sign in.');
      ctx.user = user;
      if (!['self', 'pending'].includes(found.permission)) {
        if (user.mustChangePassword) throw new HttpError(403, 'Choose a new password before continuing.');
        if (!can(user, found.permission)) throw new HttpError(403, 'You do not have access to that.');
      }
    }
    if (request.method !== 'GET') ctx.body = await readBody(request, ['/api/admin/upload', '/api/public/memories'].includes(url.pathname) ? 8 * 1024 * 1024 : 64 * 1024);
    const result = await found.handler(ctx);
    save();
    if (result?.download) {
      response.writeHead(200, { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${result.download.name}"` });
      response.end(result.download.body);
    } else send(200, result ?? { ok: true });
  } catch (error) {
    if (!(error instanceof HttpError)) console.error(error);
    send(error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Something went wrong on our side. Please try again.' });
  }
}
