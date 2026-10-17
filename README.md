# Nasha Resto Bar

The customer website and admin panel for Nasha Resto Bar, BTM 2nd Stage, Bengaluru. Plain HTML, CSS and JavaScript on a small Node server with a file-based database. There are no runtime dependencies to install and no separate database server.

## Run it

```sh
npm start
```

- Website: **http://localhost:5173**
- Admin panel: **http://localhost:5173/admin/**

Node 18+ is required. In Windows PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`.

**Where data is stored.** When a MongoDB connection string is set (the `MONGODB_URI` environment variable, or a file named `mongodb-uri.txt` in the data folder), all records and uploaded photos are saved to MongoDB, in the `nasha` database (`MONGODB_DB` changes the name). Each list, such as `items`, `offers` or `reservations`, is its own collection; settings, page content and visitor counts are in `state`; photos are in `images`. A copy is still written to `db.json` and the `uploads` folder on this computer. If MongoDB cannot be reached, changes are kept locally and sent when it is back, including on the next start. On its first start with MongoDB, the server copies everything already saved on this computer into it. Without a connection string, everything is stored on this computer only. Keep the connection string out of the project folder, since it contains the database password.

**First sign-in.** The first time the server starts it creates the owner account and prints a temporary password in the terminal (also saved to `data/first-login.txt`). Sign in as `owner@nasha.local`, choose your own password when asked, then delete that file. To pick the credentials yourself, start with `ADMIN_EMAIL` and `ADMIN_PASSWORD` set.

## Customer website

| Page | What it does |
|---|---|
| Home | Hero banner with **Book a table** / **View menu**, live offers, upcoming events, guest reviews, offer sign-up |
| Menu | Categories (Starters, Mains, Desserts, Cocktails, Mocktails, Beer, Wine), prices, descriptions, veg / non-veg / alcohol tags, badges, out-of-stock state, search and filters, saved wish list, add-to-order, `?table=5` for QR codes |
| Events | Live music, DJ, karaoke and sports listings with entry fee and places left, reserve-a-spot, private party and corporate enquiry form |
| Offers | Happy hours and offers with day/time schedule and an “on now” marker, gift voucher requests, WhatsApp/email sign-up |
| Gallery | Photos managed in admin, category filters, keyboard-friendly viewer |
| Our story | Story, chef and ambience sections, reviews with a feedback form, optional Instagram posts |
| Visit | Table request form with live time-slot availability, address, opening hours, click-to-call, WhatsApp, map, FAQ |
| Order | Basket, coupon, pickup/delivery, pay at restaurant or online (when switched on) and live order status |

**Branches.** A switch at the top of every page lets visitors choose BTM 2nd Stage or Attibele. It changes the address, phone, WhatsApp, map and Instagram link, and table requests, party enquiries, event places and orders are recorded against the chosen branch, each with its own table capacity. The menu, offers, events, gallery and opening hours are shared by both branches. Edit each branch under Settings in the admin panel.

Also: age-verification popup, announcement bar or popup, floating WhatsApp button, SEO titles/descriptions and Restaurant structured data, mobile layout down to 320px, privacy page.

## Admin panel

Login and security (email or phone + password, two-step codes from an authenticator app, password reset, Owner / Manager / Staff roles, activity log) · Dashboard · Menu management (drag-and-drop order, one-click out-of-stock, bulk price update, QR code menu) · Reservations (list and calendar, filters, status flow, walk-in/phone bookings, capacity, time slots, blocked dates, Excel export) · Events and guest lists · Offers, homepage banner, coupon codes, gift vouchers · Party and corporate inquiries with internal notes · Customers (visit history, birthdays, VIP/Regular tags, promotions, export) · Messages · Website content (homepage, about, gallery, social links, SEO) · Reviews (approve, hide, reply) · Online orders (sound alert, statuses, daily sales) · Reports (bookings, peak hours, busiest days, popular items, event attendance, no-show rate; Excel download and print-to-PDF) · Settings · Team.

| Role | Access |
|---|---|
| Owner | Everything |
| Manager | Dashboard, reservations, menu, events, offers, inquiries, orders |
| Staff | View reservations only |

## Things that need your accounts before they work

These are built, but depend on a service only the restaurant can sign up for. Until then the site behaves as described.

- **SMS / WhatsApp / email sending.** Every confirmation and promotion is written to **Messages**. With no provider connected you send each one from your own phone with one click (“Open in WhatsApp”) and mark it sent. To send automatically, add Twilio credentials or a webhook address under Settings → Notifications. The Twilio and webhook code paths have not been exercised against a live account.
- **Online payment.** Razorpay checkout is implemented and switches on when its keys are saved under Settings → Payment gateway. It has not been run against Razorpay; test with Razorpay test keys first. PayU and Paytm can be selected but are not connected. Without a gateway, orders are pay-at-restaurant.
- **Online ordering** is off by default (Settings → Online ordering). Only priced items can be ordered and alcoholic drinks are never sold online.
- **WhatsApp button, email, social links, Swiggy link, Google reviews link** appear once filled in under Settings and Website content. None are assumed.
- **Google and Zomato reviews, Instagram feed.** The site links to your Google/Zomato listings and embeds the Instagram posts you paste in; it does not pull reviews or a feed automatically, which would need those platforms’ API access.
- **Google Business Profile, domain and SSL** are set up outside this project. Put the site behind HTTPS before using the admin panel on the internet.
- **Prices, events and offers** start empty. The menu is seeded with the eleven published highlights and no invented prices; add yours in the admin panel.
- **Excel export** produces `.csv` files that open in Excel. **PDF reports** use the browser’s print → Save as PDF.

## Data and deployment

Everything is stored in one data folder: `db.json` holds bookings, customers, settings and any integration keys, and `uploads/` holds photos. The server prints the folder's location when it starts. It is `DATA_DIR` if set, otherwise the `dataDir` named in `nasha.config.json` in the project root, otherwise `data/` in the project. On this computer `nasha.config.json` points to `%LOCALAPPDATA%\NashaRestoBar`, so customer details stay out of OneDrive.

**Backups.** The server saves a dated copy of the database to `backups/` inside the data folder once a day and keeps the last 30. Those copies are on the same computer, so also copy the data folder somewhere else (a USB drive or private cloud folder) regularly. To restore, stop the server and replace `db.json` with a backup copy.

**Starting it.** Double-click `Start Nasha.cmd` to start the server and open the website and admin panel, and keep that window open while the site is in use.

The site must be hosted somewhere that runs Node (a VPS such as DigitalOcean, Hostinger VPS or AWS), behind a reverse proxy that provides HTTPS:

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default 5173) |
| `HOST` | Address to bind (default `127.0.0.1`, reachable only from the same machine) |
| `DATA_DIR` | Where the database and uploads live |
| `TRUST_PROXY=1` | Set when behind your own reverse proxy, so visitor addresses are read correctly |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Owner credentials for the very first start |

Set your public address under Settings → Restaurant details → Website address so QR codes and reset links point to it. Signing-in sessions are kept in memory, so restarting the server signs everyone out. The JSON database suits one restaurant; it is not designed for several server processes at once.

`npm run build` also writes a static copy of the public pages to `dist/`. That copy shows the built-in content only: forms, live menu, and the admin panel need the Node server.

## Edit and build

Business basics live in `site-data.json`; the starting menu and gallery in `server/seed.json`. Page templates are in `build.py` (and `home-content.html` for the home page); appearance in `styles.css` / `pages.css`; page behaviour in `script.js` (works offline) and `site.js` (live content and forms). The server is `serve.mjs` with `server/` (API, data store, security, notifications). The admin panel is in `admin/`.

```sh
npm run build   # regenerate the HTML pages (Python 3.12+)
npm run check   # syntax, links, anchors, assets, headings, structured data
npm test        # browser tests (headless Microsoft Edge, throwaway database)
```

Tests cover every page at four widths, the age popup, menu filters, bookings and capacity rules, enquiries, admin-to-website updates, online ordering with a coupon, sign-in, roles, two-step codes, request forgery protection, and private files.

## Content sources and photography

The address and primary phone number are from [District](https://www.district.in/dining/bangalore/nasha-the-resto-bar-btm-bangalore), cross-checked with [Zomato](https://www.zomato.com/bangalore/nasha-the-resto-bar-btm-bangalore). Hours come from [Nasha’s contact page](https://www.nashatherestrobar.in/contact-us); dishes from [its menu page](https://www.nashatherestrobar.in/menu). Checked 29 September 2026. All can now be changed in the admin panel.

Photographs in `assets/nasha-*.jpg` are the restaurant’s own pictures of its premises and food, taken from the copy of its website saved in `Documents/nasha resto bar` and resized for the web. Dish photos were matched to menu items by eye, so check them under Menu → Edit. Replace or add photos in the admin panel: dishes under Menu, event posters under Events, and the gallery under Website content.
