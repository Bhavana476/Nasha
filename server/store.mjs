// Data store. Everything is held in memory as one object and saved after changes: to MongoDB when a
// connection string is configured, and always to db.json on this computer as a local copy.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hashPassword } from './security.mjs';
import { openMongo, loadFromMongo, mongoWriter, mongoImages } from './mongo.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Where the database lives: DATA_DIR if set, else the folder named in nasha.config.json, else ./data.
// Customer details belong outside synced or shared folders, which is what the config file is for.
function configuredDataDir() {
  try { return JSON.parse(readFileSync(path.join(root, 'nasha.config.json'), 'utf8')).dataDir || ''; }
  catch { return ''; }
}
export const dataDir = path.resolve(process.env.DATA_DIR || configuredDataDir() || path.join(root, 'data'));
export const uploadDir = path.join(dataDir, 'uploads');
// Guests' photos wait here, out of public reach, until someone approves them in the admin panel.
export const memoryDir = path.join(dataDir, 'memories');
const file = path.join(dataDir, 'db.json');

export const PAGES = ['index.html', 'about.html', 'menu.html', 'gallery.html', 'events.html', 'offers.html', 'order.html', 'visit.html', 'privacy.html', '404.html'];
export const newId = () => randomBytes(6).toString('hex');

function defaults() {
  const site = JSON.parse(readFileSync(path.join(root, 'site-data.json'), 'utf8'));
  const seed = JSON.parse(readFileSync(path.join(root, 'server', 'seed.json'), 'utf8'));
  return {
    meta: { version: 5, secret: randomBytes(32).toString('hex'), orderSeq: 1000, bookingSeq: 1000 },
    users: [],
    resets: [],
    settings: {
      info: { name: site.name, logo: '', gst: '', address: site.address, phone: site.phone, phoneDisplay: site.phoneDisplay, email: '', whatsapp: '', mapsUrl: site.mapsUrl, siteUrl: '' },
      // The website's branch switch. The first branch is the default; Attibele's details come from the
      // restaurant's printed offers sheet.
      branches: [
        { id: 'btm', name: 'BTM 2nd Stage', address: site.address, phone: site.phone, phoneDisplay: site.phoneDisplay, whatsapp: '', mapsUrl: site.mapsUrl, instagram: 'https://www.instagram.com/nashatherestobar_btm/' },
        { id: 'attibele', name: 'Attibele', address: 'Yadavanahalli, Attibele Hobli, Bengaluru, Karnataka 562107', phone: '+918050007102', phoneDisplay: '+91 80500 07102', whatsapp: '', mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Nasha+The+Resto+Bar+Yadavanahalli+Attibele', instagram: 'https://www.instagram.com/nasharestobar_attibele/' },
      ],
      // day 0 is Sunday; a closing time earlier than opening means "after midnight".
      hours: [0, 1, 2, 3, 4, 5, 6].map(day => ({ day, open: '12:00', close: '01:00', closed: false })),
      holidays: [],
      social: { instagram: '', facebook: '', youtube: '', x: '', zomato: site.menuUrl.replace(/\/menu$/, ''), swiggy: '', googleReviews: '', district: site.bookingUrl },
      ageGate: { enabled: true, minAge: 21 },
      booking: { firstSlot: '12:00', lastSlot: '23:30', slotMinutes: 30, capacityPerSlot: 40, maxParty: 12, maxDaysAhead: 60, autoConfirm: false, blockedDates: [] },
      notifications: { recipients: [], customerChannel: 'whatsapp', twilioSid: '', twilioToken: '', twilioSmsFrom: '', twilioWhatsappFrom: '', webhookUrl: '', webhookSecret: '' },
      payments: { gateway: 'none', keyId: '', keySecret: '' },
      ordering: { enabled: false, delivery: false, deliveryFee: 0, minOrder: 0 },
      banner: { mode: 'off', offerId: '', text: '', link: 'offers.html' },
    },
    content: {
      hero: { eyebrow: '', title: '', description: '', image: '' },
      about: { heading: '', body: '', chefName: '', chefBio: '', chefPhoto: '', ambience: '' },
      seo: {},
      instagramPosts: [],
    },
    categories: seed.categories.map((category, order) => ({ ...category, order })),
    items: seed.items.map((item, order) => ({ price: null, photo: '', badges: [], available: true, ...item, order })),
    gallery: seed.gallery.map((photo, order) => ({ ...photo, order })),
    reservations: [], events: [], eventBookings: [], offers: [], coupons: [], vouchers: [], inquiries: [],
    customers: [], subscribers: [], reviews: [], memories: [], party: [], orders: [], outbox: [], activity: [], visits: {},
  };
}

// Fill in keys added by newer versions without touching what the owner has saved.
function merge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (!(key in target)) target[key] = value;
    else if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) merge(target[key], value);
  }
  return target;
}

mkdirSync(uploadDir, { recursive: true });
mkdirSync(memoryDir, { recursive: true });
// One dated copy of the database per day, taken before anything is changed, keeping the last 30.
function dailyBackup() {
  if (!existsSync(file)) return;
  const folder = path.join(dataDir, 'backups');
  mkdirSync(folder, { recursive: true });
  const copy = path.join(folder, `db-${new Date().toISOString().slice(0, 10)}.json`);
  if (!existsSync(copy)) copyFileSync(file, copy);
  for (const old of readdirSync(folder).filter(name => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().slice(0, -30)) unlinkSync(path.join(folder, old));
}
dailyBackup();
setInterval(dailyBackup, 6 * 3600000).unref();

// MongoDB is used when MONGODB_URI is set or mongodb-uri.txt sits in the data folder. The connection
// string holds a password, so it is kept there rather than in the project folder, which is synced.
function mongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI.trim();
  try { return readFileSync(path.join(dataDir, 'mongodb-uri.txt'), 'utf8').trim(); } catch { return ''; }
}
// Present while the local copy holds changes MongoDB has not confirmed yet (for example after the
// internet dropped). On the next start the local copy is then the newer one, and is sent to MongoDB.
const unsynced = path.join(dataDir, 'mongodb-unsynced');
const local = () => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;

// If MongoDB cannot be reached, the website still starts from the local copy and keeps trying to connect;
// everything changed in the meantime is sent across once it is back.
export let storage = 'this computer (db.json)';
let writer = null, remote = null, connection = null;
const uri = mongoUri(), mongoName = process.env.MONGODB_DB || 'nasha';
let startData = null;
if (uri) {
  try {
    const { database } = await openMongo(uri, mongoName, 1);
    const saved = await loadFromMongo(database);
    connection = { database, saved };
    // MongoDB's copy is used unless the local one holds changes MongoDB never received.
    if (saved && !(existsSync(unsynced) && existsSync(file))) startData = saved;
    else if (saved) console.log('The local copy has changes MongoDB did not receive last time. Sending them now.');
  } catch (error) {
    storage = 'this computer for now (MongoDB not reachable, retrying every 30 seconds)';
    console.error(`\nMongoDB is not reachable: ${error.message}\nStarting from the copy saved on this computer, which has every change. Changes are kept here and sent to MongoDB as soon as it can be reached.\nIf this keeps happening, add this computer's internet address under Network Access in MongoDB Atlas.\n`);
  }
}

export const db = merge(startData ?? local() ?? defaults(), defaults());

// Version 3 replaced the bundled stock photos with the restaurant's own. Applied once to an older
// database: anything still pointing at a removed stock file is switched over, while photos the owner
// uploaded are left alone.
if (db.meta.version < 3) {
  const seed = JSON.parse(readFileSync(path.join(root, 'server', 'seed.json'), 'utf8'));
  const stock = image => !image || (image.startsWith('assets/') && !image.startsWith('assets/nasha-'));
  for (const item of db.items) if (stock(item.photo)) item.photo = seed.items.find(entry => entry.id === item.id)?.photo || '';
  const kept = db.gallery.filter(photo => !stock(photo.image) && !seed.gallery.some(entry => entry.id === photo.id));
  db.gallery = [...seed.gallery, ...kept].map((photo, order) => ({ ...photo, order }));
  if (stock(db.content.hero.image)) db.content.hero.image = '';
  db.meta.version = 3;
}

// Version 4 added drinks, prawns and kitchen photos. A dish is updated only if it still has the photo
// (or the gap) it was given before; new gallery pictures are added after the existing ones.
if (db.meta.version < 4) {
  const seed = JSON.parse(readFileSync(path.join(root, 'server', 'seed.json'), 'utf8'));
  const before = { 'prawns-tikka': '', cocktails: 'assets/nasha-0021.jpg', beer: 'assets/nasha-0024.jpg' };
  for (const item of db.items) if (item.id in before && item.photo === before[item.id]) item.photo = seed.items.find(entry => entry.id === item.id).photo;
  for (const photo of seed.gallery) if (!db.gallery.some(entry => entry.id === photo.id)) db.gallery.push({ ...photo, order: db.gallery.length });
  db.meta.version = 4;
}

// Version 5 added branches. The first branch starts from the contact details already saved in Settings.
if (db.meta.version < 5) {
  const { address, phone, phoneDisplay, whatsapp, mapsUrl } = db.settings.info;
  Object.assign(db.settings.branches[0], { address, phone, phoneDisplay, whatsapp, mapsUrl });
  db.meta.version = 5;
}

// Version 6 added the offers from the restaurant's printed "Nasha Masala News" sheet. They are shared
// by both branches. Each is added once; the owner can edit, hide or delete them afterwards.
if (db.meta.version < 6) {
  const offer = (id, title, description, days = [], startTime = '', endTime = '') => ({ id: `masala-${id}`, createdAt: new Date().toISOString(), title, description, startDate: '', endDate: '', startTime, endTime, days, couponCode: '', active: true });
  const masala = [
    offer('happy-hour', 'Happy Hour: 1+1 on drinks', 'Buy one drink, get one free. Ask the team for the happy hours menu.', [], '12:00', '17:00'),
    offer('dj-nights', 'DJ Nights', 'Good music. Good people. Good vibes. Every Friday and Saturday.', [5, 6]),
    offer('monday-mood', 'Monday Mood: 1+1 on cocktails', 'Buy one cocktail, get one free. Only on Mondays.', [1]),
    offer('twos-day', 'Two’s Day: 2+1 on beer', 'Buy two beers, get one free. Only on Tuesdays.', [2]),
    offer('gen-z', 'Gen Z Offer: ₹699', '2 shooters + 1 veg or non-veg starter + 5 Kingfisher Premium beer bottles. Only on Wednesdays.', [3]),
    offer('story-time', 'Story Time: a beer mug on us', 'Share one story, tag us on Instagram, and get one beer mug.', [4], '12:00', '17:00'),
    offer('corporate', 'Corporate Discount: 25% off', '25% off, all day. Show your corporate ID.'),
    offer('birthday', 'Birthday Bash', '1 free cake + birthday song + 2 shooters + 1 veg or non-veg starter, and 10% off the total bill (on bills up to ₹3,000). All day.'),
    offer('maja-maadi', 'Maja Maadi Combo: ₹999', '1 beer pitcher + green salad + masala papad + veg starter + veg fried rice.', [], '12:00', '17:00'),
    offer('piyo-aur-khao', 'Piyo Aur Khao Combo: ₹1,499', 'Tower beer + green salad + peanut masala + non-veg starter + chicken biryani.', [], '12:00', '17:00'),
  ];
  for (const entry of masala) if (!db.offers.some(existing => existing.id === entry.id)) db.offers.push(entry);
  db.meta.version = 6;
}

// Version 7 let an offer belong to a single branch, and split the corporate discount: 25% at the
// first branch, 20% at Attibele. The existing offer is only touched if its wording is unchanged.
if (db.meta.version < 7) {
  for (const offer of db.offers) offer.branch ??= '';
  const corporate = db.offers.find(offer => offer.id === 'masala-corporate' && offer.title === 'Corporate Discount: 25% off');
  if (corporate) {
    corporate.branch = db.settings.branches[0].id;
    if (!db.offers.some(offer => offer.id === 'masala-corporate-attibele')) db.offers.splice(db.offers.indexOf(corporate) + 1, 0, { ...corporate, id: 'masala-corporate-attibele', branch: 'attibele', title: 'Corporate Discount: 20% off', description: '20% off, all day. Show your corporate ID.' });
  }
  db.meta.version = 7;
}

// Version 8 put the printed happy hours price list into the menu, so it can be edited in the admin panel.
// Each part of the list becomes a "happy" category and the combos a "combo" category; ids are fixed, so
// anything the owner has already deleted or changed is left as it is.
if (db.meta.version < 8) {
  const happy = JSON.parse(readFileSync(path.join(root, 'server', 'happy-hours.json'), 'utf8'));
  let categoryOrder = Math.max(-1, ...db.categories.map(category => category.order)) + 1;
  let itemOrder = Math.max(-1, ...db.items.map(item => item.order)) + 1;
  const addCategory = category => { if (!db.categories.some(entry => entry.id === category.id)) db.categories.push({ ...category, order: categoryOrder++ }); };
  const addItem = item => { if (!db.items.some(entry => entry.id === item.id)) db.items.push({ badges: [], available: true, ...item, order: itemOrder++ }); };
  for (const group of happy.groups) {
    addCategory({ id: group.id, name: group.name, kind: 'happy', note: group.note, photo: group.photo });
    group.items.forEach(([name, price], index) => addItem({ id: `${group.id}-${index + 1}`, categoryId: group.id, name, description: '', price, photo: '', diet: group.id === 'hh-mocktails' ? 'veg' : 'alcoholic' }));
  }
  addCategory({ id: 'hh-combos', name: 'Happy hours combos', kind: 'combo', note: '', photo: '' });
  for (const combo of happy.combos) addItem({ id: combo.id, categoryId: 'hh-combos', name: combo.name, description: combo.includes.join(' + '), price: combo.price, photo: combo.photo, diet: 'alcoholic' });
  db.meta.version = 8;
}

// Version 9 changed the corporate discount to 20% at BTM and 15% at Attibele.
if (db.meta.version < 9) {
  const set = (id, percent) => {
    const offer = db.offers.find(entry => entry.id === id);
    if (offer) Object.assign(offer, { title: `Corporate Discount: ${percent}% off`, description: `${percent}% off, all day. Show your corporate ID.` });
  };
  set('masala-corporate', 20);
  set('masala-corporate-attibele', 15);
  db.meta.version = 9;
}

// Version 10 added the printed party menu: packages, the dishes guests choose from, and the terms.
if (db.meta.version < 10) {
  const party = JSON.parse(readFileSync(path.join(root, 'server', 'party-menu.json'), 'utf8'));
  let order = 0;
  const add = (kind, entry) => { if (!db.party.some(record => record.id === entry.id)) db.party.push({ price: null, ...entry, kind, order: order++ }); };
  party.packages.forEach(entry => add('package', entry));
  party.courses.forEach(entry => add('course', entry));
  add('terms', { id: 'party-terms', name: 'Terms & conditions', details: party.terms });
  db.meta.version = 10;
}

// Version 11 put in the BTM food menu of 17-08-26. The food that was on the menu before moved to the
// happy hours list, and the new food categories come first.
if (db.meta.version < 11) {
  const food = JSON.parse(readFileSync(path.join(root, 'server', 'food-menu.json'), 'utf8'));
  for (const category of db.categories) if ((category.kind || 'food') === 'food') { category.kind = 'happy'; category.note ||= 'Happy hours'; category.photo ??= ''; }
  const shift = food.categories.length;
  for (const category of db.categories) category.order += shift;
  let itemOrder = Math.max(-1, ...db.items.map(item => item.order)) + 1;
  food.categories.forEach((category, index) => {
    if (db.categories.some(entry => entry.id === category.id)) return;
    db.categories.push({ id: category.id, name: category.name, kind: 'food', note: '', photo: '', order: index });
    category.items.forEach(([name, price, diet, description], position) => db.items.push({ id: `${category.id}-${position + 1}`, categoryId: category.id, name, description, price, photo: '', diet, badges: [], available: true, order: itemOrder++ }));
  });
  db.meta.version = 11;
}

// Version 12 gave the new food menu photos (from Wikimedia Commons; credits on the privacy page).
// Only dishes still without a photo get one, so the owner's own pictures are kept.
if (db.meta.version < 12) {
  const photos = JSON.parse(readFileSync(path.join(root, 'server', 'food-photos.json'), 'utf8'));
  for (const item of db.items) if (!item.photo && photos[item.id]) item.photo = photos[item.id];
  db.meta.version = 12;
}

// Version 13 put in the rooftop bar menu of 17-08-26 as drinks categories after the food. The old
// placeholder drinks (no prices) are removed unless the owner had priced any of them. Drinks sold in
// several sizes show the smallest price, with every size listed in the description.
if (db.meta.version < 13) {
  const bar = JSON.parse(readFileSync(path.join(root, 'server', 'bar-menu.json'), 'utf8'));
  for (const id of ['cocktails', 'mocktails', 'beer', 'wine']) {
    const items = db.items.filter(item => item.categoryId === id);
    if (items.some(item => item.price !== null)) continue;
    db.items = db.items.filter(item => item.categoryId !== id);
    db.categories = db.categories.filter(category => category.id !== id);
  }
  const rupee = amount => '₹' + amount.toLocaleString('en-IN');
  let categoryOrder = Math.max(-1, ...db.categories.filter(category => category.kind === 'food').map(category => category.order)) + 1;
  const after = bar.categories.length;
  for (const category of db.categories) if (category.kind !== 'food') category.order += after;
  let itemOrder = Math.max(-1, ...db.items.map(item => item.order)) + 1;
  for (const category of bar.categories) {
    if (db.categories.some(entry => entry.id === category.id)) { categoryOrder++; continue; }
    db.categories.push({ id: category.id, name: category.name, kind: 'drink', note: '', photo: '', order: categoryOrder++ });
    category.items.forEach(([name, sizes, ingredients], position) => {
      const entries = Object.entries(sizes);
      const sizeText = entries.length > 1 ? entries.map(([size, price]) => `${size} ${rupee(price)}`).join(' · ') : entries[0][0] ? `Per ${entries[0][0]}` : '';
      db.items.push({
        id: `${category.id}-${position + 1}`, categoryId: category.id, name, description: [sizeText, ingredients].filter(Boolean).join('. '),
        price: Math.min(...entries.map(([, price]) => price)), photo: category.photo, diet: category.soft ? 'veg' : 'alcoholic', badges: [], available: true, order: itemOrder++,
      });
    });
  }
  db.meta.version = 13;
}

// Version 14 filled in photos for the dishes and drinks still without one. Keys are an item id or,
// for a whole drinks section, a category id. Photos the owner has added are left alone.
if (db.meta.version < 14) {
  const photos = JSON.parse(readFileSync(path.join(root, 'server', 'extra-photos.json'), 'utf8'));
  for (const item of db.items) if (!item.photo) item.photo = photos[item.id] || photos[item.categoryId] || '';
  db.meta.version = 14;
}

// Version 15 changed the BTM phone number to +91 80506 01533 (only where the old number was still set).
if (db.meta.version < 15) {
  const btm = db.settings.branches.find(branch => branch.id === 'btm');
  for (const record of [btm, db.settings.info]) if (record && record.phone === '+918050007103') Object.assign(record, { phone: '+918050601533', phoneDisplay: '+91 80506 01533' });
  db.meta.version = 15;
}

// Version 16 gave every menu category a branch (empty means both; otherwise 'btm' or 'attibele'). Every
// category already on the menu is marked as BTM's own, since it came from BTM's own printed menus, and
// the Attibele Garden food menu (10-12-25) is added as Attibele's own. A dish with more than one size
// (e.g. "Veg ₹169 · Chicken ₹189") shows its lowest price on the card and every size in its description.
if (db.meta.version < 16) {
  for (const category of db.categories) category.branch ??= 'btm';
  const attibele = JSON.parse(readFileSync(path.join(root, 'server', 'attibele-menu.json'), 'utf8'));
  const drinkCategories = new Set(['att-beverages', 'att-hot-beverages']);
  const rupee = amount => '₹' + amount.toLocaleString('en-IN');
  let categoryOrder = Math.max(-1, ...db.categories.map(category => category.order)) + 1;
  let itemOrder = Math.max(-1, ...db.items.map(item => item.order)) + 1;
  for (const category of attibele.categories) {
    if (db.categories.some(entry => entry.id === category.id)) continue;
    db.categories.push({ id: category.id, name: category.name, kind: drinkCategories.has(category.id) ? 'drink' : 'food', note: '', photo: '', branch: 'attibele', order: categoryOrder++ });
    category.items.forEach(([name, sizes, diet, description], position) => {
      const entries = Object.entries(sizes);
      const sizeText = entries.length > 1 ? entries.map(([size, price]) => `${size} ${price === null ? 'Ask' : rupee(price)}`).join(' · ') : '';
      db.items.push({
        id: `${category.id}-${position + 1}`, categoryId: category.id, name, description: [sizeText, description].filter(Boolean).join('. '),
        price: entries.length > 1 ? Math.min(...entries.map(([, price]) => price)) : entries[0][1], photo: '', diet, badges: [], available: true, order: itemOrder++,
      });
    });
  }
  db.meta.version = 16;
}

// Items that shared a photo with another item get their own (server/unique-photos.json). This runs on
// every start, but only replaces a stock photo from assets/, never one the owner uploaded.
{
  const file = path.join(root, 'server', 'unique-photos.json');
  const photos = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) : {};
  const stock = { ...JSON.parse(readFileSync(path.join(root, 'server', 'food-photos.json'), 'utf8').replace(/^﻿/, '')), ...JSON.parse(readFileSync(path.join(root, 'server', 'extra-photos.json'), 'utf8').replace(/^﻿/, '')) };
  const bar = Object.fromEntries(JSON.parse(readFileSync(path.join(root, 'server', 'bar-menu.json'), 'utf8')).categories.map(category => [category.id, category.photo]));
  for (const item of db.items) {
    if (photos[item.id] && (!item.photo || item.photo.startsWith('assets/'))) item.photo = photos[item.id];
    // A stock photo that has since been removed falls back to the dish's or section's original one.
    if (item.photo?.startsWith('assets/') && !existsSync(path.join(root, item.photo))) item.photo = stock[item.id] || stock[item.categoryId] || bar[item.categoryId] || '';
  }
}

let retry;
function flushLocal() {
  const temporary = `${file}.tmp`;
  const json = JSON.stringify(db);
  try { writeFileSync(temporary, json); renameSync(temporary, file); }
  catch { writeFileSync(file, json); } // Synced folders can briefly lock the target; fall back to a direct write.
}
// Saves the local copy straight away, then MongoDB. Resolves once MongoDB has it (or has failed and will retry).
export function flush() {
  flushLocal();
  if (!uri) return Promise.resolve(true);
  writeFileSync(unsynced, new Date().toISOString());
  if (!writer) return Promise.resolve(false); // Not connected yet; sent when the connection is made.
  clearTimeout(retry);
  return writer.sync(db).then(async done => {
    if (done && photosBehind) await sendPhotos().catch(error => console.error(`Could not send photos to MongoDB, will retry: ${error.message}`));
    if (done && !photosBehind) { try { unlinkSync(unsynced); } catch { /* already gone */ } }
    if (!done || photosBehind) retry = setTimeout(flush, 10000);
    return done;
  });
}
let timer;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; flush(); }, 150);
}
process.on('exit', () => { if (timer) flushLocal(); });
// Ctrl+C or closing the window: give MongoDB a few seconds to receive the latest changes first.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, async () => {
  clearTimeout(timer); timer = null;
  await Promise.race([flush(), new Promise(resolve => setTimeout(resolve, 8000))]);
  process.exit(0);
});

// Photos. With MongoDB they are stored there, with a copy kept on this computer; otherwise only on this
// computer. A photo that is not public (a guest's photo awaiting approval) is never served on the website.
const files = {
  async put(name, bytes, isPublic) { await writeFile(path.join(isPublic ? uploadDir : memoryDir, name), bytes); },
  async get(name) {
    for (const [folder, isPublic] of [[uploadDir, true], [memoryDir, false]]) {
      try { return { bytes: await readFile(path.join(folder, name)), public: isPublic }; } catch { /* try the next folder */ }
    }
    return null;
  },
  async setPublic(name, isPublic) {
    await rename(path.join(isPublic ? memoryDir : uploadDir, name), path.join(isPublic ? uploadDir : memoryDir, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  },
  async remove(name) { for (const folder of [uploadDir, memoryDir]) await unlink(path.join(folder, name)).catch(() => {}); },
};
// Every photo is saved on this computer first, so none is lost if MongoDB is unreachable at that moment;
// photos MongoDB missed are sent by sendPhotos once it can be reached.
let photosBehind = false;
const behind = (what, error) => { photosBehind = true; console.error(`Could not ${what} in MongoDB, will retry: ${error.message}`); };
export const images = {
  async put(name, bytes, isPublic) { await files.put(name, bytes, isPublic); if (remote) await remote.put(name, bytes, isPublic).catch(error => behind('save a photo', error)); else photosBehind = Boolean(uri); },
  async get(name) { return (remote && await remote.get(name).catch(() => null)) || files.get(name); },
  async setPublic(name, isPublic) { await files.setPublic(name, isPublic); if (remote) await remote.setPublic(name, isPublic).catch(error => behind('update a photo', error)); else photosBehind = Boolean(uri); },
  async remove(name) { await files.remove(name); if (remote) await remote.remove(name).catch(error => behind('delete a photo', error)); },
};
// Brings MongoDB's photos in line with this computer's: adds missing ones and fixes which are public.
async function sendPhotos() {
  let count = 0;
  for (const [folder, isPublic] of [[uploadDir, true], [memoryDir, false]]) {
    for (const name of readdirSync(folder).filter(entry => /^[a-f0-9]+\.(jpg|png|webp)$/.test(entry))) {
      const saved = await remote.info(name);
      if (!saved) { await remote.put(name, readFileSync(path.join(folder, name)), isPublic); count++; }
      else if (saved.public !== isPublic) { await remote.setPublic(name, isPublic); count++; }
    }
  }
  photosBehind = false;
  return count;
}
// Connects the running website to MongoDB and sends it whatever it is missing, records and photos.
async function attach({ database, saved }) {
  const next = mongoWriter(database);
  if (saved) next.prime(saved);
  else console.log('First start with MongoDB: copying all data and photos across…');
  writer = next;
  remote = mongoImages(database);
  storage = `MongoDB (database "${database.databaseName}")`;
  photosBehind = true;
  await flush();
  if (!saved) console.log('Copied all records and photos to MongoDB.');
}
if (connection) await attach(connection);
else if (uri) {
  const reconnect = async () => {
    try {
      const { database } = await openMongo(uri, mongoName, 1);
      await attach({ database, saved: await loadFromMongo(database) });
      console.log('Connected to MongoDB. Everything changed while it was unreachable has been sent.');
    } catch { setTimeout(reconnect, 30000); }
  };
  setTimeout(reconnect, 30000);
}

// First run: create the owner account. The password is shown once and must be changed at first login.
if (!db.users.length) {
  const password = process.env.ADMIN_PASSWORD || randomBytes(9).toString('base64url');
  const email = (process.env.ADMIN_EMAIL || 'owner@nasha.local').toLowerCase();
  db.users.push({ id: newId(), name: 'Owner', email, phone: '', role: 'owner', passHash: hashPassword(password), totpSecret: '', totpPending: '', totpEnabled: false, active: true, mustChangePassword: !process.env.ADMIN_PASSWORD, createdAt: new Date().toISOString(), lastLoginAt: '' });
  flush();
  if (!process.env.ADMIN_PASSWORD) {
    const note = `Nasha admin panel – first login\nEmail: ${email}\nTemporary password: ${password}\nYou will be asked to choose a new password. Delete this file afterwards.\n`;
    writeFileSync(path.join(dataDir, 'first-login.txt'), note);
    console.log(`\n${note}(Also saved to ${path.join(dataDir, 'first-login.txt')})\n`);
  }
}
