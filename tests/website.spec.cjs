const { test, expect } = require('@playwright/test');
const pages = ['index', 'about', 'menu', 'gallery', 'events', 'offers', 'order', 'visit', 'privacy', '404'];
const ADMIN = { 'X-Nasha-Admin': '1' };
const future = days => new Date(Date.now() + 330 * 60000 + days * 86400000).toISOString().slice(0, 10);

const live = page => page.waitForFunction(() => document.documentElement.dataset.live === 'ready');

// Most tests are about the pages behind the age question, so answer it in advance.
test.beforeEach(async ({ page }, info) => {
  if (!info.title.startsWith('age question')) await page.addInitScript(() => localStorage.setItem('nasha-age-ok', String(Date.now())));
});

async function signIn(page) {
  const response = await page.request.post('/api/admin/auth/login', { headers: ADMIN, data: { identifier: 'owner@nasha.local', password: 'test-owner-password' } });
  expect(response.status()).toBe(200);
  const call = async (method, path, data) => {
    const result = await page.request.fetch(`/api/admin/${path}`, { method, headers: ADMIN, data });
    expect(result.status(), `${method} ${path}: ${await result.text()}`).toBe(200);
    return result.json();
  };
  return call;
}

test('all pages load their assets without script errors at desktop and mobile sizes', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of pages) {
      const response = await page.goto(`/${name}.html`);
      expect(response.status()).toBe(200);
      await expect(page).toHaveTitle(/Nasha Resto Bar/);
      await expect(page.locator('h1')).toHaveCount(1);
      await live(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      expect(overflow, `${name} has horizontal overflow at ${width}px`).toBe(false);
      const images = await page.locator('img[src]').evaluateAll(images => images.filter(img => img.complete && !img.naturalWidth).map(img => img.src));
      expect(images, `${name}: broken images`).toEqual([]);
    }
  }
  expect(errors).toEqual([]);
});

test('age question blocks the site until answered and is remembered', async ({ page }) => {
  await page.goto('/index.html');
  const gate = page.locator('dialog.age-gate');
  await expect(gate).toBeVisible();
  await expect(gate).toContainText('Are you 21 or older?');
  await page.keyboard.press('Escape');
  await expect(gate).toBeVisible();
  await gate.getByRole('button', { name: 'Yes, I am 21+' }).click();
  await expect(gate).toHaveCount(0);
  await page.goto('/menu.html');
  await live(page);
  await expect(page.locator('dialog.age-gate')).toHaveCount(0);
});

test('menu categories are collapsed until opened, and a search or filter opens a match on its own', async ({ page }) => {
  await page.goto('/menu.html');
  await live(page);
  const total = await page.locator('[data-menu-item]').count();
  expect(total).toBeGreaterThan(90);
  // Collapsed by default: the category cards are there, but no dish is visible until one is opened.
  await expect(page.locator('.dish-group')).not.toHaveCount(0);
  await expect(page.locator('[data-menu-item]:visible')).toHaveCount(0);
  const soup = page.locator('.dish-group').filter({ has: page.locator('h3', { hasText: /^Soup$/ }) });
  await soup.locator('summary').click();
  await expect(soup).toHaveJSProperty('open', true);
  await expect(soup.locator('[data-menu-item]:visible')).toHaveCount(3);
  await soup.locator('summary').click();
  await expect(page.locator('[data-menu-item]:visible')).toHaveCount(0);
  // Searching opens whichever card has a match, with no click needed.
  await page.locator('#menu-search').fill('crispy paneer');
  await expect(page.locator('[data-menu-item]:visible')).toHaveCount(1);
  await page.getByRole('button', { name: 'Save Crispy paneer burger', exact: true }).click();
  await page.reload();
  await live(page);
  await page.locator('#menu-search').fill('crispy paneer');
  await expect(page.getByRole('button', { name: 'Unsave Crispy paneer burger', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#clear-filters').click();
  await page.locator('[data-menu-filter="saved"]').click();
  await expect(page.locator('[data-menu-item]:visible')).toHaveCount(1);
  await page.locator('#clear-filters').click();
  await page.locator('#diet-filter').selectOption('veg');
  await expect(page.locator('[data-menu-item]:visible')).toHaveCount(await page.locator('[data-menu-item][data-diet="veg"]').count());
  await page.locator('#menu-search').fill('no-such-dish');
  await expect(page.locator('#menu-empty')).toBeVisible();
  await page.locator('#empty-reset').click();
  // Clearing the search returns to the collapsed browse view, not an all-open one.
  await expect(page.locator('[data-menu-item]:visible')).toHaveCount(0);
  await page.locator('#clear-saved').click();
  await expect(page.locator('#shortlist')).toBeHidden();
  await page.locator('[data-menu-filter="f-soup"]').click();
  await expect(page.locator('[data-menu-item]:visible')).toHaveCount(3);
  await page.locator('#clear-filters').click();
  await page.locator('#diet-filter').selectOption('alcoholic');
  await expect(page.locator('[data-menu-item]:visible')).toHaveCount(await page.locator('[data-menu-item][data-diet="alcoholic"]').count());
});
test('menu gracefully handles invalid saved browser data', async ({ page }) => {
  await page.goto('/menu.html');
  await page.evaluate(() => localStorage.setItem('nasha-saved-dishes-v1', '{invalid'));
  await page.reload();
  await live(page);
  await expect(page.locator('.dish-group')).not.toHaveCount(0);
  await expect(page.locator('[data-menu-item]:visible')).toHaveCount(0);
  await expect(page.locator('[data-menu-filter="saved"]')).toHaveText('Saved (0)');
});

test('gallery filters, keyboard controls and focus restoration work', async ({ page }) => {
  await page.goto('/gallery.html');
  await live(page);
  await page.locator('[data-gallery-filter="drinks"]').click();
  await expect(page.locator('.gallery-tile:visible')).toHaveCount(14);
  const opener = page.locator('.gallery-tile:visible').first();
  await opener.click();
  await expect(page.locator('#lightbox')).toBeVisible();
  await expect(page.locator('#photo-counter')).toHaveText('1 / 14');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#photo-counter')).toHaveText('2 / 14');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#photo-counter')).toHaveText('14 / 14');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#photo-counter')).toHaveText('1 / 14');
  await page.keyboard.press('Escape');
  await expect(page.locator('#lightbox')).toBeHidden();
  await expect(opener).toBeFocused();
});

test('a table request is validated, stored, and can be confirmed in the admin panel', async ({ page }) => {
  await page.goto('/visit.html#reserve');
  await live(page);
  const form = page.locator('#reserve-form');
  await form.getByRole('button', { name: 'Request my table' }).click();
  await expect(page.locator('#reserve-result')).toBeHidden();
  await form.locator('[name="date"]').fill(future(3));
  await expect(form.locator('[name="time"] option')).not.toHaveCount(0);
  await form.locator('[name="time"]').selectOption('20:00');
  await form.locator('[name="guests"]').fill('4');
  await form.locator('[name="name"]').fill('Asha Rao');
  await form.locator('[name="phone"]').fill('98765 43210');
  await form.getByRole('button', { name: 'Request my table' }).click();
  await expect(page.locator('#reserve-result')).toContainText('Request received');
  await expect(page.locator('#reserve-result')).toContainText('not yet a confirmed booking');

  await signIn(page);
  await page.goto('/admin/#/reservations');
  const row = page.locator('tr', { hasText: 'Asha Rao' });
  await expect(row).toContainText('+919876543210');
  await row.getByLabel('Status for Asha Rao').selectOption('confirmed');
  await expect(page.locator('#toast')).toContainText('Marked confirmed');
  await expect(page.getByRole('navigation').getByRole('link', { name: /^Messages/ })).toHaveCount(0);
  await page.goto('/admin/#/customers');
  await expect(page.locator('tr', { hasText: 'Asha Rao' })).toBeVisible();
  await page.goto('/admin/#/team');
  await expect(page.locator('tr', { hasText: 'Marked confirmed reservation' }).first()).toBeVisible();
});

test('online booking respects capacity, blocked dates and party size', async ({ page, request }) => {
  const call = await signIn(page);
  const settings = await call('GET', 'settings');
  await call('PUT', 'settings/booking', { ...settings.booking, capacityPerSlot: 6, blockedDates: [{ date: future(9), reason: 'Private event' }] });
  const book = (date, guests) => request.post('/api/public/reservations', { data: { name: 'Capacity Test', phone: '9000000001', date, time: '19:00', guests } });
  expect((await book(future(8), 4)).status()).toBe(200);
  const full = await book(future(8), 4);
  expect(full.status()).toBe(400);
  expect((await full.json()).error).toContain('Only 2 seats');
  expect((await (await book(future(9), 2)).json()).error).toContain('Private event');
  expect((await book(future(8), 40)).status()).toBe(400);
  expect((await (await request.get('/api/public/availability?date=2020-01-01')).json()).open).toBe(false);
  await call('PUT', 'settings/booking', settings.booking);
});

test('party enquiry form stores the enquiry', async ({ page }) => {
  await page.goto('/events.html#enquiry');
  await live(page);
  const form = page.locator('#event-form');
  await form.getByRole('button', { name: 'Send my enquiry' }).click();
  await expect(form.locator('.enquiry-result')).toHaveCount(0);
  await form.locator('[name="name"]').fill('Corporate Carl');
  await form.locator('[name="phone"]').fill('9812345678');
  await form.locator('[name="type"]').selectOption('Corporate event');
  await form.locator('[name="date"]').fill(future(14));
  await form.locator('[name="guests"]').fill('30');
  await form.locator('[name="budget"]').fill('₹1,500 per person');
  await form.locator('[name="requirements"]').fill('<img src=x onerror=alert(1)> Projector please');
  await form.getByRole('button', { name: 'Send my enquiry' }).click();
  await expect(form.locator('.enquiry-result')).toContainText('Enquiry sent');

  // The admin panel no longer has a party inquiries section; the enquiry is still kept on the server.
  const call = await signIn(page);
  const saved = (await call('GET', 'inquiries')).find(entry => entry.name === 'Corporate Carl');
  expect(saved.requirements).toBe('<img src=x onerror=alert(1)> Projector please');
  expect(saved.status).toBe('new');
});

test('menu, events, offers and reviews managed in admin appear on the website', async ({ page, request }) => {
  const call = await signIn(page);
  await page.goto('/admin/#/menu');
  const row = page.locator('.item-row', { hasText: 'Crispy paneer burger' });
  await row.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Price (₹)').fill('320');
  await page.getByLabel('Bestseller').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row).toContainText('₹320');
  await expect(row).toContainText('Bestseller');

  const beer = (await call('GET', 'items')).find(item => item.id === 'b-bourbon-1');
  await call('PUT', 'items/b-bourbon-1', { price: 200 });
  expect((await call('POST', 'menu/bulk-price', { categoryId: beer.categoryId, percent: 5, roundTo: 1 })).updated).toBe(2);
  await call('PUT', 'items/f-soup-1', { available: false });
  const event = await call('POST', 'events', { title: 'Saturday Live Set', type: 'live', date: future(5), time: '20:00', entryFee: 500, bookingLimit: 2, description: 'An evening of live music.' });
  await call('POST', 'events', { title: 'Last Month Karaoke', type: 'karaoke', date: '2026-01-01', time: '20:00' });
  const offer = await call('POST', 'offers', { title: '1+1 on beer', description: 'Happy hours at the bar.', days: [1, 2, 3, 4], startTime: '17:00', endTime: '20:00' });
  await call('PUT', 'settings/banner', { mode: 'bar', offerId: offer.id, text: '', link: 'offers.html' });
  expect((await request.post('/api/public/reviews', { data: { name: 'Happy Guest', rating: 5, comment: 'Lovely evening.' } })).status()).toBe(200);
  let site = await (await request.get('/api/public/site')).json();
  expect(site.reviews).toHaveLength(0);
  const review = (await call('GET', 'reviews'))[0];
  await call('PUT', `reviews/${review.id}`, { status: 'approved', reply: 'Thank you!' });

  await page.goto('/menu.html');
  const card = page.locator('[data-id="f-burgers-2"]');
  await expect(card).toContainText('₹320');
  await expect(card).toContainText('Bestseller');
  await expect(page.locator('[data-id="b-bourbon-1"]')).toContainText('₹210');
  await expect(page.locator('[data-id="f-soup-1"]')).toContainText('Currently unavailable');
  await expect(page.locator('.offer-bar')).toContainText('1+1 on beer · Mon–Thu · 5 pm – 8 pm');

  await page.goto('/events.html');
  await expect(page.locator('.event-card')).toHaveCount(1);
  await expect(page.locator('.event-card')).toContainText('Saturday Live Set');
  await expect(page.locator('.event-card')).toContainText('Entry ₹500 · 2 places left');
  await page.getByRole('button', { name: 'Reserve a spot' }).click();
  const dialog = page.locator('#event-dialog');
  await dialog.locator('[name="name"]').fill('Event Guest');
  await dialog.locator('[name="phone"]').fill('9000000002');
  await dialog.locator('[name="guests"]').fill('2');
  await dialog.getByRole('button', { name: 'Put me on the list' }).click();
  await expect(dialog).toContainText('You’re on the list');
  expect((await request.post(`/api/public/events/${event.id}/book`, { data: { name: 'Late', phone: '9000000003', guests: 1 } })).status()).toBe(400);

  await page.goto('/offers.html');
  await expect(page.locator('.offer-card', { hasText: 'Happy hours at the bar.' })).toContainText('1+1 on beer');
  await expect(page.locator('.offer-card', { hasText: 'Maja Maadi Combo: ₹999' })).toContainText('12 noon – 5 pm');
  await expect(page.locator('.offer-card')).toHaveCount(11);
  await page.goto('/about.html');
  await expect(page.locator('.review-card')).toContainText('Lovely evening.');
  await expect(page.locator('.review-card')).toContainText('Thank you!');
  await call('PUT', 'settings/banner', { mode: 'off', offerId: '', text: '', link: 'offers.html' });
});

test('online ordering: basket, coupon and order placed', async ({ page, request }) => {
  const call = await signIn(page);
  await call('PUT', 'items/f-burgers-1', { price: 450 });
  await call('PUT', 'items/b-red-wine-1', { price: 600 });
  await call('POST', 'coupons', { code: 'nasha10', type: 'percent', value: 10 });
  await page.goto('/order.html');
  await expect(page.locator('#order-app')).toContainText('not open right now');
  await call('PUT', 'settings/ordering', { enabled: true, delivery: false, deliveryFee: 0, minOrder: 0 });

  await page.goto('/menu.html');
  await expect(page.locator('[data-id="b-red-wine-1"] [data-add]')).toHaveCount(0);
  await page.locator('#menu-search').fill('Veg patty burger');
  await page.locator('[data-id="f-burgers-1"] [data-add]').click();
  await page.locator('[data-id="f-burgers-1"] [data-add]').click();
  await expect(page.locator('#cart-bar')).toContainText('2 items · ₹900');
  await page.locator('#cart-bar').click();
  await expect(page).toHaveURL(/order\.html$/);
  await page.locator('[name="coupon"]').fill('NASHA10');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('#order-totals')).toContainText('₹810');
  await page.locator('#order-form [name="name"]').fill('Order Olivia');
  await page.locator('#order-form [name="phone"]').fill('9000000004');
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.locator('.order-status')).toContainText('Order received');
  const refused = await request.post('/api/public/orders', { data: { name: 'X', phone: '9000000005', type: 'pickup', payment: 'cod', items: [{ id: 'b-red-wine-1', qty: 1 }] } });
  expect((await refused.json()).error).toContain('Alcoholic drinks');

  const placed = (await call('GET', `orders?date=${future(0)}`)).orders.find(order => order.name === 'Order Olivia');
  expect(placed.lines[0]).toMatchObject({ name: 'Veg patty burger', qty: 2 });
  expect(placed.total).toBe(810);

  // The order, with its full details, is also visible and actionable in the admin panel.
  await page.goto('/admin/#/orders');
  await page.locator('input[type="date"]').fill(future(0));
  const row = page.locator('tr', { hasText: 'Order Olivia' });
  await expect(row).toContainText('9000000004');
  await expect(row).toContainText('2× Veg patty burger');
  await expect(row).toContainText('₹810');
  await expect(row).toContainText('Coupon NASHA10');
  await row.getByLabel(/Status for order/).selectOption('preparing');
  await expect(page.locator('#toast')).toContainText('preparing');
  expect((await call('GET', `orders?date=${future(0)}`)).orders.find(order => order.name === 'Order Olivia').status).toBe('preparing');

  await call('PUT', 'settings/ordering', { enabled: false, delivery: false, deliveryFee: 0, minOrder: 0 });
});

test('admin sign-in, roles, two-step codes and request protection', async ({ page, request, browser }) => {
  expect((await request.get('/api/admin/customers')).status()).toBe(401);
  expect((await request.post('/api/admin/auth/login', { headers: ADMIN, data: { identifier: 'owner@nasha.local', password: 'wrong-password-1' } })).status()).toBe(401);

  await page.goto('/admin/');
  await page.getByLabel('Email or phone').fill('owner@nasha.local');
  await page.getByLabel('Password').fill('test-owner-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('Reservations today')).toBeVisible();
  for (const removed of ['Party inquiries', 'Online orders']) await expect(page.getByRole('navigation').getByRole('link', { name: removed })).toHaveCount(0);
  for (const section of ['Reservations', 'Menu', 'Events & nightlife', 'Party menu', 'Offers & vouchers', 'Customers', 'Reviews', 'Website content', 'Reports', 'Settings', 'Team & activity', 'My account']) {
    await page.getByRole('navigation').getByRole('link', { name: new RegExp(`^${section.replace(/[&]/g, '\\$&')}\\s*\\d*$`) }).click();
    await expect(page.locator('main h1')).toBeVisible();
    await expect(page.locator('main .notice.error')).toHaveCount(0);
  }
  await page.goto('/admin/#/reservations');
  await page.getByRole('tab', { name: 'Calendar' }).click();
  await expect(page.locator('.calendar button').first()).toBeVisible();

  // A request another website could forge (no custom header) is refused even with a valid session.
  expect((await page.request.post('/api/admin/categories', { data: { name: 'Forged', kind: 'food' } })).status()).toBe(403);

  const call = async (method, path, data) => (await page.request.fetch(`/api/admin/${path}`, { method, headers: ADMIN, data }));
  expect((await call('POST', 'users', { name: 'Sam Staff', email: 'staff@nasha.local', role: 'staff', password: 'temporary-pass-1' })).status()).toBe(200);
  const staffContext = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  const staff = async (method, path, data) => staffContext.request.fetch(`/api/admin/${path}`, { method, headers: ADMIN, data });
  expect((await staff('POST', 'auth/login', { identifier: 'staff@nasha.local', password: 'temporary-pass-1' })).status()).toBe(200);
  expect((await staff('GET', 'reservations')).status()).toBe(403); // Must choose their own password first.
  expect((await staff('POST', 'auth/password', { current: 'temporary-pass-1', password: 'staff-own-password' })).status()).toBe(200);
  expect((await staff('GET', 'reservations')).status()).toBe(200);
  expect((await staff('GET', 'customers')).status()).toBe(403);
  expect((await staff('GET', 'users')).status()).toBe(403);
  expect((await staff('POST', 'reservations', { name: 'X', phone: '9000000006', date: future(2), time: '19:00', guests: 2, source: 'phone' })).status()).toBe(403);
  expect((await staff('PUT', 'settings/info', {})).status()).toBe(403);
  await staffContext.close();

  const security = await import('../server/security.mjs');
  const setup = await (await call('POST', 'auth/2fa/setup', {})).json();
  expect((await call('POST', 'auth/2fa/enable', { code: '000000' })).status()).toBe(400);
  expect((await call('POST', 'auth/2fa/enable', { code: security.totpNow(setup.secret) })).status()).toBe(200);
  await call('POST', 'auth/logout', {});
  const login = await call('POST', 'auth/login', { identifier: 'owner@nasha.local', password: 'test-owner-password' });
  expect(await login.json()).toEqual({ twoFactor: true });
  expect((await call('GET', 'dashboard')).status()).toBe(401);
  expect((await call('POST', 'auth/2fa', { code: security.totpNow(setup.secret) })).status()).toBe(200);
  expect((await call('GET', 'dashboard')).status()).toBe(200);
  expect((await call('POST', 'auth/2fa/disable', { password: 'test-owner-password' })).status()).toBe(200);
});

test('website content, SEO titles and settings edited in admin reach the website', async ({ page }) => {
  const call = await signIn(page);
  await call('PUT', 'content/hero', { eyebrow: '', title: 'FRIDAY NIGHTS.\nDONE RIGHT.', description: '', image: '' });
  await call('PUT', 'content/seo', { 'menu.html': { title: 'Nasha Menu & Prices | Resto Bar in BTM', description: 'See our menu.' } });
  const settings = await call('GET', 'settings');
  await call('PUT', 'settings/info', { ...settings.info, whatsapp: '9876500000', email: 'hello@example.com' });
  await call('PUT', 'settings/hours', { hours: settings.hours.map(entry => ({ ...entry, closed: entry.day === 1 })) });
  await page.goto('/index.html');
  await expect(page.locator('#hero-title')).toHaveText('FRIDAY NIGHTS.DONE RIGHT.');
  await expect(page.locator('.whatsapp-float')).toHaveAttribute('href', /wa\.me\/919876500000/);
  await page.goto('/menu.html');
  await expect(page).toHaveTitle('Nasha Menu & Prices | Resto Bar in BTM');
  await page.goto('/visit.html');
  await expect(page.locator('.hours-table tr').first()).toContainText('Closed');
  await expect(page.locator('[data-live="contact-extra"]')).toContainText('hello@example.com');
  await call('PUT', 'content/hero', { eyebrow: '', title: '', description: '', image: '' });
  await call('PUT', 'content/seo', {});
  await call('PUT', 'settings/info', settings.info);
  await call('PUT', 'settings/hours', { hours: settings.hours });
});

test('contact actions, manual clipboard fallback and FAQ work', async ({ page }) => {
  await page.goto('/visit.html');
  await live(page);
  await expect(page.getByRole('link', { name: 'Book on District' })).toHaveAttribute('href', /district\.in\/dining/);
  await expect(page.locator('a[href="tel:+918050601533"]').first()).toBeVisible();
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }));
  await page.locator('#copy-address').click();
  await expect(page.locator('#copy-dialog')).toBeVisible();
  await expect(page.locator('#manual-copy')).toHaveValue(/100 Feet Ring Road/);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('summary').filter({ hasText: 'How can I book a table?' }).click();
  await expect(page.locator('details').first()).toHaveAttribute('open', '');
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.route('https://maps.google.com/**', route => route.fulfill({ body: '<html><body>Map test</body></html>', contentType: 'text/html' }));
  await page.locator('#load-map').click();
  await expect(page.locator('iframe')).toHaveAttribute('title', /Nasha Resto Bar/);
});

test('mobile navigation supports opening, Escape and following links', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/index.html');
  const toggle = page.locator('.nav-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await page.locator('#navigation').getByRole('link', { name: 'Food & drinks', exact: true }).click();
  await expect(page).toHaveURL(/menu\.html$/);
  await expect(page.locator('#navigation')).toBeHidden();
  await expect(page.locator('.mobile-actions')).toBeVisible();
});

test('404 uses working root-relative assets and private files are not served', async ({ page, request }) => {
  const response = await page.goto('/not/a/real/page');
  expect(response.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Wrong turn');
  await page.getByRole('link', { name: 'Back to home' }).click();
  await expect(page).toHaveURL(/index\.html$/);
  for (const path of ['/site-data.json', '/data/db.json', '/data/first-login.txt', '/server/api.mjs', '/serve.mjs', '/uploads/../data/db.json', '/package.json']) expect((await request.get(path)).status(), path).toBe(404);
});

test('capture desktop and mobile previews', async ({ page }) => {
  async function readyForScreenshot() {
    await live(page);
    await page.evaluate(async () => {
      document.documentElement.classList.remove('reveal-on'); // Full-page captures include sections not yet scrolled to.
      await document.fonts.ready;
      await Promise.all([...document.querySelectorAll('img[src]')].map(image => {
        image.loading = 'eager';
        return image.decode().catch(() => {});
      }));
    });
  }
  await page.goto('/index.html');
  await readyForScreenshot();
  await page.screenshot({ path: 'test-results/home-desktop.png', fullPage: true });
  await page.goto('/menu.html');
  await readyForScreenshot();
  await page.screenshot({ path: 'test-results/menu-desktop.png', fullPage: true });
  await page.goto('/events.html');
  await readyForScreenshot();
  await page.screenshot({ path: 'test-results/events-desktop.png', fullPage: true });
  await signIn(page);
  for (const section of ['dashboard', 'reservations', 'menu', 'reports', 'settings']) {
    await page.goto(`/admin/#/${section}`);
    await expect(page.locator('main h1')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: `test-results/admin-${section}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/index.html');
  await readyForScreenshot();
  await page.screenshot({ path: 'test-results/home-mobile.png', fullPage: true });
  await page.goto('/visit.html');
  await readyForScreenshot();
  await page.screenshot({ path: 'test-results/visit-mobile.png', fullPage: true });
  await page.goto('/admin/#/menu');
  await expect(page.locator('main h1')).toBeVisible();
  await page.screenshot({ path: 'test-results/admin-menu-mobile.png', fullPage: true });
});

test('branch switch changes contact details and records the branch on a booking', async ({ page }) => {
  await page.goto('/visit.html');
  await live(page);
  const toggle = page.locator('.branch-toggle');
  await expect(toggle.getByRole('button', { name: 'BTM 2nd Stage' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.contact-panel address')).toContainText('100 Feet Ring Road');
  await toggle.getByRole('button', { name: 'Attibele' }).click();
  await expect(toggle.getByRole('button', { name: 'Attibele' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.contact-panel address')).toContainText('Attibele Hobli');
  await expect(page.locator('.contact-panel a[href="tel:+918050007102"]')).toBeVisible();
  await expect(page.locator('#reserve-form .branch-note')).toContainText('Attibele');
  await page.goto('/index.html');
  await live(page);
  await expect(page.locator('[data-live="hero-eyebrow"]')).toHaveText('ATTIBELE, BENGALURU');
  await page.goto('/offers.html');
  await live(page);
  await expect(page.locator('.offer-card', { hasText: 'Corporate Discount: 15% off' })).toHaveCount(1);
  await expect(page.locator('.offer-card', { hasText: 'Corporate Discount: 20% off' })).toHaveCount(0);
  await page.locator('.branch-toggle').getByRole('button', { name: 'BTM 2nd Stage' }).click();
  await expect(page.locator('.offer-card', { hasText: 'Corporate Discount: 20% off' })).toHaveCount(1);
  await expect(page.locator('.offer-card', { hasText: 'Corporate Discount: 15% off' })).toHaveCount(0);
  await page.locator('.branch-toggle').getByRole('button', { name: 'Attibele' }).click();
  await page.goto('/visit.html#reserve');
  await live(page);
  const form = page.locator('#reserve-form');
  await form.locator('[name="date"]').fill(future(6));
  await form.locator('[name="time"]').selectOption('21:00');
  await form.locator('[name="name"]').fill('Branch Bina');
  await form.locator('[name="phone"]').fill('9000000009');
  await form.getByRole('button', { name: 'Request my table' }).click();
  await expect(page.locator('#reserve-result')).toContainText('Request received');
  const call = await signIn(page);
  expect((await call('GET', 'reservations?branch=attibele')).map(entry => entry.name)).toEqual(['Branch Bina']);
  expect((await call('GET', 'reservations?branch=btm')).some(entry => entry.name === 'Branch Bina')).toBe(false);
  await page.goto('/admin/#/reservations');
  await expect(page.locator('tr', { hasText: 'Branch Bina' })).toContainText('Attibele');
});

test('each branch shows its own food & drinks menu', async ({ page }) => {
  const group = name => page.locator('.dish-group').filter({ has: page.locator('h3', { hasText: new RegExp(`^${name}$`) }) });
  await page.goto('/menu.html');
  await live(page);
  await expect(group('Badass burgers')).toHaveCount(1);
  await expect(group('Andhra style')).toHaveCount(0);
  await page.locator('.branch-toggle').getByRole('button', { name: 'Attibele' }).click();
  await expect(group('Andhra style')).toHaveCount(1);
  await expect(group('Badass burgers')).toHaveCount(0);
  const andhra = group('Andhra style');
  await andhra.locator('summary').click();
  await expect(andhra).toContainText('Chicken Ghee Roast / Pepper Fry / Roast');
  await expect(andhra).toContainText('₹349');
  await page.locator('.branch-toggle').getByRole('button', { name: 'BTM 2nd Stage' }).click();
  await expect(group('Badass burgers')).toHaveCount(1);
  await expect(group('Andhra style')).toHaveCount(0);
});

test('the happy hours menu is kept in the admin menu and drawn from it on the website', async ({ page, request }) => {
  const call = await signIn(page);
  await page.goto('/admin/#/menu');
  await expect(page.locator('.cat-head').filter({ hasText: 'Draught beer · 9 items' }).filter({ hasText: 'BTM 2nd Stage' })).toContainText('Happy hours (1+1 list)');
  const mug = page.locator('.item-row[data-id="hh-draught-beer-1"]');
  await mug.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Price (₹)').fill('289');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(mug).toContainText('₹289');
  await call('PUT', 'items/hh-gin-2', { available: false });
  await call('PUT', 'categories/hh-beer-bucket', { note: '5 pints and a starter' });

  for (const path of ['/menu.html', '/offers.html']) {
    await page.goto(path);
    await live(page);
    const beer = page.locator('.happy-group', { hasText: 'Draught beer' });
    await expect(beer.locator('li', { hasText: 'Woodpecker / KF Premium mug' })).toContainText('₹289');
    const gin = page.locator('.happy-group').filter({ has: page.locator('h3', { hasText: /^Gin/ }) });
    await expect(gin).toContainText('Blue Riband');
    await expect(gin).not.toContainText('Bombay Sapphire');
    await expect(page.locator('.happy-group', { hasText: 'Beer bucket' })).toContainText('5 pints and a starter');
    await expect(page.locator('.happy-combo', { hasText: 'Piyo Aur Khao Combo' })).toContainText('₹1,499');
    await expect(page.locator('.happy-combo', { hasText: 'Piyo Aur Khao Combo' }).locator('li')).toHaveCount(5);
  }
  // The happy hours list is not mixed into the regular menu browser, and cannot be ordered online.
  await page.goto('/menu.html');
  await live(page);
  await expect(page.locator('[data-menu-filter="hh-draught-beer"]')).toHaveCount(0);
  await expect(page.locator('.dish-card[data-category^="hh-"]')).toHaveCount(0);
  await call('PUT', 'settings/ordering', { enabled: true, delivery: false, deliveryFee: 0, minOrder: 0 });
  const order = await request.post('/api/public/orders', { data: { items: [{ id: 'hh-mocktails-1', qty: 1 }], type: 'pickup', payment: 'cod', name: 'Mock Tail', phone: '9000000009' } });
  expect(order.status()).toBe(400);
  expect((await order.json()).error).toContain('served at the restaurant only');
  await call('PUT', 'settings/ordering', { enabled: false, delivery: false, deliveryFee: 0, minOrder: 0 });
  await call('PUT', 'items/hh-gin-2', { available: true });
});

test('Attibele has its own happy hours list, separate from BTM’s', async ({ page }) => {
  await page.goto('/offers.html');
  await live(page);
  await expect(page.locator('.happy-group', { hasText: 'Whisky' })).not.toContainText('D.S.P Black');
  await page.locator('.branch-toggle').getByRole('button', { name: 'Attibele' }).click();
  const beer = page.locator('.happy-group', { hasText: 'Draught beer' });
  await expect(beer.locator('li', { hasText: 'Woodpecker / KF Premium mug' })).toContainText('₹299');
  await expect(beer.locator('li', { hasText: 'Bud Magnum / KF Ultra Max tower' })).toContainText('₹3,699');
  await expect(page.locator('.happy-group', { hasText: 'Whisky' })).toContainText('D.S.P Black');
  await expect(page.locator('.happy-combo', { hasText: 'Maja Maadi Combo' })).toContainText('₹999');
  await page.locator('.branch-toggle').getByRole('button', { name: 'BTM 2nd Stage' }).click();
  await expect(page.locator('.happy-group', { hasText: 'Whisky' })).not.toContainText('D.S.P Black');
});

test('guests share a photo memory, it stays private until approved in admin, then shows on the gallery page', async ({ page, request }) => {
  await page.goto('/gallery.html#memories');
  await live(page);
  const form = page.locator('[data-form="memory"]');
  await form.locator('[name="photo"]').setInputFiles('assets/drink-mocktail.jpg');
  await expect(form.locator('.memory-preview')).toBeVisible();
  await form.locator('[name="name"]').fill('Priya & friends');
  await form.locator('[name="occasion"]').fill('Birthday');
  await form.locator('[name="caption"]').fill('Birthday night with the squad');
  await form.getByRole('button', { name: 'Share my memory' }).click();
  await expect(form.locator('.enquiry-result')).toHaveCount(0); // The consent box is not ticked yet, so nothing is sent.
  await form.locator('[name="consent"]').check();
  await form.getByRole('button', { name: 'Share my memory' }).click();
  await expect(form.locator('.enquiry-result')).toContainText('Thank you for sharing');
  expect((await request.post('/api/public/memories', { data: { name: 'No Consent', data: 'data:image/jpeg;base64,/9j/4AAQ' } })).status()).toBe(400);

  const call = await signIn(page);
  const [memory] = (await call('GET', 'memories')).filter(entry => entry.name === 'Priya & friends');
  expect(memory.status).toBe('pending');
  expect((await request.get(`/uploads/${memory.file}`)).status()).toBe(404); // Not public while waiting.
  let site = await (await request.get('/api/public/site')).json();
  expect(site.memories.some(entry => entry.id === memory.id)).toBe(false);

  await page.goto('/admin/#/memories');
  const card = page.locator('.memory-item', { hasText: 'Priya & friends' });
  await expect(card).toContainText('Birthday night with the squad');
  await expect(card.locator('img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('#toast')).toContainText('Published on the website');

  await page.goto('/gallery.html#memories');
  await live(page);
  const shown = page.locator('.memory-card', { hasText: 'Priya & friends' });
  await expect(shown).toContainText('Birthday night with the squad');
  const src = await shown.locator('img').getAttribute('src');
  expect((await request.get(src)).status()).toBe(200);
  // The home page's Our stories wall shows it as a polaroid, in place of the blank ones.
  await page.goto('/#stories');
  await live(page);
  const polaroid = page.locator('#stories .memory-card', { hasText: 'Priya & friends' });
  await expect(polaroid).toContainText('Birthday');
  await expect(polaroid).toContainText('Birthday night with the squad');
  await expect(page.locator('#stories .story-blank')).toHaveCount(2); // Blank prints fill the row until there are three photos.
  await page.locator('#stories').screenshot({ path: 'test-results/stories-with-photo.png' });

  await call('PUT', `memories/${memory.id}`, { status: 'hidden' });
  expect((await request.get(src)).status()).toBe(404);
  site = await (await request.get('/api/public/site')).json();
  expect(site.memories.some(entry => entry.id === memory.id)).toBe(false);
  // Deleting goes through the admin panel's own Delete button and confirmation.
  await page.goto('/admin/#/memories');
  await page.locator('.memory-item', { hasText: 'Priya & friends' }).getByRole('button', { name: 'Delete' }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.memory-item', { hasText: 'Priya & friends' })).toHaveCount(0);
  await expect(page.locator('#toast')).not.toContainText('JSON');
  expect((await call('GET', 'memories')).some(entry => entry.id === memory.id)).toBe(false);
});

test('an offer can be given its own photo in admin, and the website shows it on the offer card', async ({ page, request }) => {
  const call = await signIn(page);
  const offer = await call('POST', 'offers', { title: 'Photo Friday: 1+1 on sangria', description: 'With a photo of our own.', days: [5] });
  await page.goto('/admin/#/offers');
  const row = page.locator('tr', { hasText: 'Photo Friday' });
  await expect(row).toContainText('Auto');
  await row.getByRole('button', { name: 'Edit' }).click();
  const dialog = page.locator('dialog[open]');
  await dialog.getByLabel('Photo (optional)').setInputFiles('assets/drink-gin.jpg');
  await expect(dialog.locator('.image-field img')).toHaveAttribute('src', /^\/uploads\/[a-f0-9]+\.jpg$/);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row.locator('img.offer-thumb')).toHaveAttribute('src', /^\/uploads\//);
  const photo = (await call('GET', 'offers')).find(entry => entry.id === offer.id).photo;
  expect(photo).toMatch(/^\/uploads\/[a-f0-9]+\.jpg$/);

  await page.goto('/offers.html');
  await live(page);
  const card = page.locator('.offer-card', { hasText: 'Photo Friday' });
  await expect(card.locator('.offer-photo')).toHaveAttribute('src', photo);
  expect((await request.get(photo)).status()).toBe(200);
  // Without a photo of its own, the card goes back to one picked from its wording.
  await call('PUT', `offers/${offer.id}`, { photo: '' });
  await page.reload();
  await live(page);
  await expect(page.locator('.offer-card', { hasText: 'Photo Friday' }).locator('.offer-photo')).toHaveAttribute('src', /^assets\/nasha-/);
  await page.goto('/admin/#/offers');
  await page.locator('tr', { hasText: 'Photo Friday' }).getByRole('button', { name: 'Delete' }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('tr', { hasText: 'Photo Friday' })).toHaveCount(0);
});

test('offers slide along by themselves every five seconds and loop', async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'reduce' }); // Jumps instead of glides, so positions can be read straight away.
  await page.goto('/offers.html');
  await live(page);
  const track = page.locator('.offer-grid.carousel');
  await expect(track.locator('.offer-card', { hasText: 'Happy Hour: 1+1 on drinks' })).toBeVisible();
  const count = await track.locator('.offer-card').count();
  expect(count).toBeGreaterThanOrEqual(10);
  await expect(page.locator('.carousel-controls')).toHaveCount(0);
  const left = () => track.evaluate(node => Math.round(node.scrollLeft));
  expect(await left()).toBe(0);
  await page.clock.runFor(5100);
  const one = await left();
  expect(one).toBeGreaterThan(200);
  await page.clock.runFor(5000);
  expect(await left()).toBeGreaterThan(one + 200);
  // A resting mouse does not stop it.
  await track.hover();
  const hovered = await left();
  await page.clock.runFor(5000);
  expect(await left()).toBeGreaterThan(hovered);
  // It waits while someone tabs through it with the keyboard, then carries on.
  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab'); // Keyboard use, so the focus that follows counts as tabbing in.
  await track.evaluate(node => node.focus());
  const held = await left();
  await page.clock.runFor(10000);
  expect(await left()).toBe(held);
  await track.evaluate(node => node.blur());
  await page.clock.runFor(5000);
  expect(await left()).not.toBe(held);
  // After the last card it starts again from the first.
  await page.clock.runFor(5000 * count);
  const positions = [];
  for (let step = 0; step < count; step++) { await page.clock.runFor(5000); positions.push(await left()); }
  expect(positions).toContain(0);
});
