# Puran Poli House — ordering website + owner dashboard

A responsive customer ordering site and private owner dashboard. Orders are saved to a local SQLite database. Twilio can send an SMS confirmation to the customer after an order is saved.

## Features
- Mobile-friendly landing page, menu, contact details, and order form.
- Customer name, phone, quantity, requested date/time, optional notes, pickup or home delivery with delivery address.
- Server-side validation and rate limits on order/login endpoints.
- SQLite order storage (persists across app restarts on persistent hosting).
- Owner login, order list, status updates, filters, and CSV export.
- Optional SMS confirmation using Twilio; the dashboard records Sent / Failed / Not configured.
- Password hashes, session cookies, and HTTP security headers.

## Before launch
The restaurant name was not supplied, so the display name is currently **Puran Poli House**. Change it in `public/index.html`, `public/admin.html`, and `/api/config` in `server.js` if needed. Default market-based starting prices are ₹60 per Puran Poli and ₹30 flat local delivery fee. Pickup is free. These are editable starting prices, not a guarantee of the cheapest local rate; check ingredient costs and your service area before launch.

### Run locally
Requires Node.js 20 or newer.

1. Extract this ZIP.
2. Copy `.env.example` to `.env`.
3. Set a unique `ADMIN_PASSWORD` and a random `SESSION_SECRET` (at least 32 characters).
4. In a terminal in this folder run:
   ```bash
   npm install
   npm start
   ```
5. Open `http://localhost:3000` for customers or `http://localhost:3000/admin` for the owner.

Default username is `owner` unless `ADMIN_USERNAME` is changed. Do not use the example password on a public site. The app will warn if the password is still the placeholder.

## Enable customer SMS
SMS is not active until a real SMS provider account and sender number are configured.

1. Create a Twilio account and obtain an Account SID, Auth Token, and an SMS-capable sender number. See the official Twilio docs: https://www.twilio.com/docs/messaging/quickstart/node
2. Put these values in `.env`:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_PHONE_NUMBER` (include country code, e.g. `+1...` or your approved sender)
3. Restart the server.
4. Test with a phone number you own and check the order's SMS status in the dashboard.

For Indian recipients, confirm the provider supports your intended Indian sender/route and complete applicable Indian business messaging/DLT requirements before production use. Do not publish credentials or commit `.env` to source control. SMS is best-effort: an order is saved even if sending the SMS fails, and the page tells the customer to call to confirm.

## Deploying
Deploy the Node app to a host that supports Node.js and persistent disk/storage, then set the environment variables in the host's secret/environment settings. Set `NODE_ENV=production`, a strong `SESSION_SECRET`, `ADMIN_PASSWORD`, and `PUBLIC_BASE_URL`. Ensure HTTPS is enabled. SQLite needs persistent storage; on ephemeral hosting, orders may be lost on redeploy/restart. For multi-instance deployment, use a managed database and shared session store rather than local SQLite.

Do not expose the database or `.env` publicly. Change the restaurant name and confirm the address spelling before publishing. The address supplied was normalized to “Near Revolve Gym, Punarvasan Shivangaon, Chinchbhavan, Nagpur”; please verify it.

## Order workflow
Customer submits form → server validates data and calculates ₹60 per Puran Poli plus ₹30 local delivery (if selected) → saves order in SQLite → attempts SMS → returns order number and estimated total. Owner signs in at `/admin`, views the order, and changes status (Received → Confirmed → Preparing → Ready for pickup → Completed / Cancelled).

Prices are set to ₹60 per Puran Poli, ₹30 flat local delivery, and free pickup. The website estimates totals automatically; delivery availability/address should be confirmed by the owner. Current customer SMS is an **order received** message, not a promise that the order has been accepted/confirmed by the owner. Add a separate SMS on status changes if you want confirmation/ready-for-pickup notifications.
