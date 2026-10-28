require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");
const Database = require("better-sqlite3");
const twilio = require("twilio");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const db = new Database("orders.db");
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    order_date TEXT NOT NULL,
    pickup_time TEXT NOT NULL,
    order_type TEXT NOT NULL DEFAULT 'pickup',
    delivery_address TEXT DEFAULT '',
    delivery_fee INTEGER NOT NULL DEFAULT 0,
    total_amount INTEGER NOT NULL DEFAULT 0,
    notes TEXT DEFAULT '', 
    status TEXT NOT NULL DEFAULT 'Received',
    sms_status TEXT NOT NULL DEFAULT 'Not configured',
    sms_sid TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS admin_users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL
  );
`);

// Safe, additive migrations for databases created by earlier versions.
const existingColumns = new Set(db.prepare("PRAGMA table_info(orders)").all().map(c => c.name));
for (const [column, declaration] of Object.entries({
  order_type: "TEXT NOT NULL DEFAULT 'pickup'",
  delivery_address: "TEXT DEFAULT ''",
  delivery_fee: "INTEGER NOT NULL DEFAULT 0",
  total_amount: "INTEGER NOT NULL DEFAULT 0"
})) {
  if (!existingColumns.has(column)) db.exec(`ALTER TABLE orders ADD COLUMN ${column} ${declaration}`);
}
db.prepare("UPDATE orders SET total_amount = quantity * 60 + delivery_fee WHERE total_amount = 0").run();

const UNIT_PRICE = 60;
const DELIVERY_FEE = 30;
const username = process.env.ADMIN_USERNAME || "owner";
const adminPassword = process.env.ADMIN_PASSWORD || "";
if (!adminPassword || adminPassword === "change-this-to-a-long-unique-password") {
  console.warn("WARNING: Set a unique ADMIN_PASSWORD in .env before using this site publicly.");
} else {
  const existing = db.prepare("SELECT username FROM admin_users WHERE username = ?").get(username);
  if (!existing) {
    db.prepare("INSERT INTO admin_users (username, password_hash) VALUES (?, ?)").run(
      username, bcrypt.hashSync(adminPassword, 12)
    );
  } else {
    db.prepare("UPDATE admin_users SET password_hash = ? WHERE username = ?").run(
      bcrypt.hashSync(adminPassword, 12), username
    );
  }
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(session({
  store: new SQLiteStore({ db: "sessions.db", dir: "." }),
  secret: process.env.SESSION_SECRET || "development-only-change-this-session-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000
  }
}));
app.use(express.static(path.join(__dirname, "public")));

const orderLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin === true) return next();
  return res.status(401).json({ error: "Please log in as the restaurant owner." });
}
function cleanString(v, max=160) {
  return String(v ?? "").trim().slice(0, max);
}
function validPhone(phone) {
  return /^\+?[1-9]\d{9,14}$/.test(phone.replace(/[\s()-]/g, ""));
}
function getTwilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) return null;
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}
async function sendSms(to, body) {
  const client = getTwilioClient();
  if (!client) return { status: "Not configured", sid: "" };
  try {
    const msg = await client.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to });
    return { status: "Sent", sid: msg.sid };
  } catch (e) {
    console.error("SMS delivery failed:", e.message);
    return { status: "Failed", sid: "" };
  }
}
function formatDate(date) {
  const [y,m,d] = date.split("-");
  return `${d}/${m}/${y}`;
}

app.get("/api/config", (req, res) => res.json({
  restaurantName: "Puran Poli House",
  phone: "8624079323",
  email: "shreyasnanoti0@gmail.com",
  address: "Near Revolve Gym, Punarvasan Shivangaon, Chinchbhavan, Nagpur",
  currency: "INR",
  unitPrice: UNIT_PRICE,
  deliveryFee: DELIVERY_FEE
}));

app.post("/api/orders", orderLimiter, async (req, res) => {
  const name = cleanString(req.body.name, 80);
  const phoneRaw = cleanString(req.body.phone, 20);
  const phone = phoneRaw.replace(/[\s()-]/g, "");
  const quantity = Number(req.body.quantity);
  const orderDate = cleanString(req.body.orderDate, 10);
  const pickupTime = cleanString(req.body.pickupTime, 5);
  const notes = cleanString(req.body.notes, 500);
  const orderType = cleanString(req.body.orderType || "pickup", 20);
  const deliveryAddress = cleanString(req.body.deliveryAddress, 300);
  const deliveryFee = orderType === "delivery" ? DELIVERY_FEE : 0;
  const totalAmount = quantity * UNIT_PRICE + deliveryFee;

  if (name.length < 2) return res.status(400).json({ error: "Please enter your full name." });
  if (!validPhone(phone)) return res.status(400).json({ error: "Enter a valid phone number with country code, e.g. +919876543210." });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) return res.status(400).json({ error: "Quantity must be between 1 and 100." });
  if (!["pickup", "delivery"].includes(orderType)) return res.status(400).json({ error: "Choose pickup or home delivery." });
  if (orderType === "delivery" && deliveryAddress.length < 8) return res.status(400).json({ error: "Please enter your complete delivery address." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate) || orderDate < new Date().toLocaleDateString("en-CA", {timeZone:"Asia/Kolkata"})) {
    return res.status(400).json({ error: "Choose today or a future pickup date." });
  }
  if (!/^\d{2}:\d{2}$/.test(pickupTime)) return res.status(400).json({ error: "Choose a pickup time." });

  const result = db.prepare(`
    INSERT INTO orders (customer_name, phone, quantity, order_date, pickup_time, order_type, delivery_address, delivery_fee, total_amount, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, phone, quantity, orderDate, pickupTime, orderType, deliveryAddress, deliveryFee, totalAmount, notes);
  const orderId = Number(result.lastInsertRowid);
  const fulfilment = orderType === "delivery" ? `home delivery to ${deliveryAddress}` : "pickup";
  const message = `Puran Poli House: Order #${orderId} received! ${quantity} Puran Poli. Total ₹${totalAmount} including ${orderType === "delivery" ? "₹30 delivery" : "free pickup"}. ${fulfilment}, ${formatDate(orderDate)} at ${pickupTime}. Call 8624079323 for help.`;
  const sms = await sendSms(phone, message);
  db.prepare("UPDATE orders SET sms_status = ?, sms_sid = ? WHERE id = ?").run(sms.status, sms.sid, orderId);
  res.status(201).json({
    ok: true, orderId, smsStatus: sms.status,
    message: `Thank you, ${name}! Order #${orderId} received. ${quantity} Puran Poli × ₹${UNIT_PRICE} + ₹${deliveryFee} delivery fee = ₹${totalAmount}. ${orderType === "delivery" ? "Home delivery" : "Pickup"}: ${formatDate(orderDate)} at ${pickupTime}. We will contact you to confirm.`
  });
});

app.post("/api/admin/login", loginLimiter, (req, res) => {
  const user = cleanString(req.body.username, 80);
  const pass = String(req.body.password ?? "");
  const row = db.prepare("SELECT username, password_hash FROM admin_users WHERE username = ?").get(user);
  if (!row || !bcrypt.compareSync(pass, row.password_hash)) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Could not start a secure session." });
    req.session.admin = true;
    req.session.username = row.username;
    res.json({ ok: true, username: row.username });
  });
});
app.post("/api/admin/logout", requireAdmin, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.get("/api/admin/me", requireAdmin, (req, res) => res.json({ ok: true, username: req.session.username }));
app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const status = cleanString(req.query.status, 30);
  const rows = status && status !== "All"
    ? db.prepare("SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC, id DESC").all(status)
    : db.prepare("SELECT * FROM orders ORDER BY created_at DESC, id DESC").all();
  res.json(rows);
});
app.patch("/api/admin/orders/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const status = cleanString(req.body.status, 30);
  const allowed = ["Received", "Confirmed", "Preparing", "Ready for pickup", "Completed", "Cancelled"];
  if (!Number.isInteger(id) || !allowed.includes(status)) return res.status(400).json({ error: "Invalid order or status." });
  const result = db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, id);
  if (!result.changes) return res.status(404).json({ error: "Order not found." });
  res.json({ ok: true });
});
app.get("/api/admin/export.csv", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT id, customer_name, phone, quantity, order_date, pickup_time, order_type, delivery_address, delivery_fee, total_amount, notes, status, sms_status, created_at FROM orders ORDER BY created_at DESC").all();
  const cols = ["id","customer_name","phone","quantity","order_date","pickup_time","order_type","delivery_address","delivery_fee","total_amount","notes","status","sms_status","created_at"];
  const escape = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.join(","), ...rows.map(r => cols.map(c => escape(r[c])).join(","))].join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="puran-poli-orders.csv"');
  res.send("\uFEFF" + csv);
});

app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Puran Poli ordering website running at http://localhost:${PORT}`));
