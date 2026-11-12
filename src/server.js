import 'dotenv/config';
import express from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { GoogleGenAI } from '@google/genai';
import { createInvoice, sendInvoice, getInvoice, remindInvoice, recordPayment, listPayPalInvoices } from './paypal.js';

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ---------- Setup ----------
const contacts = JSON.parse(
  readFileSync(new URL('../contacts.json', import.meta.url), 'utf-8')
);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL;
const FALLBACK_RATE = Number(process.env.FALLBACK_USD_INR) || 94;
const MAX_AMOUNT = Number(process.env.MAX_INVOICE_USD) || 500;
const TZ = process.env.TZ_NAME || 'Asia/Kolkata';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// In-memory list of invoices sent this session (resets on restart)
// Invoices are saved to data/invoices.json so they survive a server restart
const DATA_DIR = new URL('../data/', import.meta.url);
const DATA_FILE = new URL('../data/invoices.json', import.meta.url);

function loadSaved() {
  try {
    return existsSync(DATA_FILE) ? JSON.parse(readFileSync(DATA_FILE, 'utf-8')) : [];
  } catch (e) {
    console.error('Could not read saved invoices:', e.message);
    return [];
  }
}

function saveInvoices() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DATA_FILE, JSON.stringify(sentInvoices, null, 2));
  } catch (e) {
    console.error('Could not save invoices:', e.message);
  }
}

const sentInvoices = loadSaved();

const PARSE_PROMPT = `You turn a shopkeeper's spoken request (any language, e.g. Hindi, Hinglish, English) into an invoice.
Reply with ONLY a JSON object, no markdown and no extra text:
{"customer_name": string|null, "items": [{"name": string, "quantity": number, "price": number}], "currency": "INR"|"USD", "due_in_days": number, "language": string}
Rules:
- Copy every number EXACTLY as spoken. Never round, estimate or change a number. Convert Devanagari digits and number words to normal digits (for example satrah = 17, उन्नीस = 19).
- Translate item names to English.
- "quantity" is how many units, "price" is the price of ONE unit, in the currency the shopkeeper said. Do not convert currency.
- "currency" is "INR" if they said rupees, rupaye, rupiye, Rs or the rupee sign. It is "USD" if they said dollars or $. Default "USD".
- Default due_in_days is 7 and must be at least 2.
- "language" is the language the shopkeeper spoke.
- If something is missing, use null for it.
Known customers: ${contacts.map(c => c.name).join(', ')}.`;

// ---------- Helpers ----------
async function generate({ contents, config }) {
  const models = [MODEL, FALLBACK_MODEL].filter(Boolean);
  let lastError;
  for (const model of models) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await ai.models.generateContent({ model, contents, config });
      } catch (e) {
        lastError = e;
        if (/404|NOT_FOUND/.test(e.message)) {
          console.log(`${model} not available, trying next model...`);
          break;
        }
        const overloaded = /503|UNAVAILABLE|429|RESOURCE_EXHAUSTED/.test(e.message);
        if (!overloaded) throw e;
        console.log(`${model} busy (attempt ${attempt}), retrying...`);
        await sleep(attempt * 500);
      }
    }
  }
  throw lastError;
}

function cleanJson(text) {
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

function findContact(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  return contacts.find(c => n.includes(c.name.toLowerCase())) || null;
}

const customerKey = c => `${c.firstName} ${c.lastName}`;
const sumItems = items => items.reduce((s, i) => s + (i.quantity || 0) * (i.price || 0), 0);

// Devanagari digits -> normal digits, then list every number in the transcript
function numbersIn(text) {
  const normal = text.replace(/[\u0966-\u096F]/g, d => String(d.charCodeAt(0) - 0x0966));
  return (normal.match(/\d+(?:\.\d+)?/g) || []).map(Number);
}

// Compare the numbers the AI read with the numbers in the transcript
function checkNumbers(text, items) {
  const heard = numbersIn(text);
  if (!heard.length) return [];
  const bad = items.some(i =>
    [i.quantity, i.price].some(v => v != null && !heard.includes(Number(v)))
  );
  if (!bad) return [];
  const read = items.map(i => `${i.quantity} x ${i.price}`).join(', ');
  return [`I heard the numbers ${heard.join(', ')} but read ${read}. Please check the numbers.`];
}

// Exchange rate with 1-hour cache and a safe fallback
let rateCache = { rate: null, at: 0, source: '', date: '' };
async function getUsdInr() {
  if (rateCache.rate && Date.now() - rateCache.at < 3600000) return rateCache;
  try {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR');
    if (!r.ok) throw new Error('status ' + r.status);
    const d = await r.json();
    rateCache = { rate: d.rates.INR, at: Date.now(), source: 'ECB reference rate', date: d.date };
  } catch (e) {
    console.error('Rate fetch failed:', e.message);
    if (!rateCache.rate) {
      rateCache = { rate: FALLBACK_RATE, at: Date.now() - 3000000, source: 'estimated rate', date: '' };
    }
  }
  return rateCache;
}

// Safety checks before money moves
function checkInvoice(contact, items, total) {
  const warnings = [];
  const prior = sentInvoices.filter(i => i.customerName === customerKey(contact));

  const dup = prior.find(
    i => i.total === total && Date.now() - new Date(i.createdAt) < 10 * 60000
  );
  if (dup) {
    const mins = Math.max(1, Math.round((Date.now() - new Date(dup.createdAt)) / 60000));
    warnings.push(`You already billed this customer $${total.toFixed(2)} ${mins} minutes ago. This may be a duplicate.`);
  }

  if (prior.length) {
    const avg = prior.reduce((s, i) => s + i.total, 0) / prior.length;
    if (total > avg * 4 && total - avg > 20) {
      warnings.push(`This is much higher than usual. Their bills are about $${avg.toFixed(2)}. Check the amount.`);
    }
  }

  if (total > MAX_AMOUNT) {
    warnings.push(`This is a large bill: over $${MAX_AMOUNT}.`);
  }
  if (items.some(i => (i.origQty ?? i.quantity) > 100)) {
    warnings.push('One item has a very large quantity. Check the number.');
  }
  return warnings;
}

// Sample bills so the hosted demo is never empty (Render wipes its disk on restart).
// They are marked demo: true and are never sent to PayPal.
function seedDemoData() {
  const hosted = process.env.RENDER || process.env.SEED_DEMO === 'true';
  if (sentInvoices.length || !hosted || !contacts.length) return;
  const c = contacts[0];
  const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const mk = (id, total, inr, due, extra = {}) => ({
    id, customerName: customerKey(c), customerEmail: c.email, total, inrTotal: inr,
    dueDate: due, language: 'Hindi',
    createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    demo: true, ...extra,
  });
  sentInvoices.push(
    mk('DEMO-1', 36.0, 3384, day(5), { paidManually: true }),
    mk('DEMO-2', 12.5, 1175, day(4)),
    mk('DEMO-3', 20.0, 1880, day(-3)),
  );
  saveInvoices();
}
seedDemoData();

// ---------- 1. Parse spoken text ----------
app.post('/api/parse', async (req, res) => {
  try {
    const text = req.body.text;
    if (!text) return res.status(400).json({ error: 'No text provided' });

    const response = await generate({
      contents: text,
      config: {
        systemInstruction: PARSE_PROMPT,
        responseMimeType: 'application/json',
        temperature: 0,
      },
    });

    const parsed = cleanJson(response.text);
    parsed.due_in_days = Math.max(2, parsed.due_in_days || 7);
    parsed.items = Array.isArray(parsed.items) ? parsed.items : [];

    // Does what the AI read match the numbers that were actually said?
    const numberWarnings = checkNumbers(text, parsed.items);

    // Rupees to dollars: convert each LINE total, so the invoice matches the rupee amount
    let fx = null;
    if (parsed.currency === 'INR') {
      const { rate, source, date } = await getUsdInr();
      const originalTotal = sumItems(parsed.items);
      parsed.items = parsed.items.map(i => {
        if (i.price == null || i.quantity == null) return i;
        const lineUsd = +((i.price * i.quantity) / rate).toFixed(2);
        return {
          name: `${i.name} (${i.quantity} x Rs ${i.price})`,
          baseName: i.name,
          quantity: 1,
          price: lineUsd,
          origQty: i.quantity,
          origPrice: i.price,
        };
      });
      fx = { from: 'INR', rate, source, date, originalTotal };
    }

    const customer = findContact(parsed.customer_name);
    const total = +sumItems(parsed.items).toFixed(2);
    const warnings = [
      ...numberWarnings,
      ...(customer ? checkInvoice(customer, parsed.items, total) : []),
    ];

    res.json({ parsed, customer, fx, warnings });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- 2. Create and send the invoice ----------
app.post('/api/invoice/send', async (req, res) => {
  try {
    const { customer, items, dueInDays, language, acknowledged, fx } = req.body;
    if (!customer?.email || !items?.length) {
      return res.status(400).json({ error: 'Missing customer or items' });
    }

    const total = +sumItems(items).toFixed(2);
    const warnings = checkInvoice(customer, items, total);
    if (warnings.length && !acknowledged) {
      return res.status(409).json({ error: 'Please confirm the warnings first', warnings });
    }

    const days = Math.max(2, dueInDays || 7);
    const id = await createInvoice({ customer, items, dueInDays: days });
    await sendInvoice(id);

    sentInvoices.push({
      id,
      customerName: customerKey(customer),
      customerEmail: customer.email,
      total,
      inrTotal: fx?.originalTotal || null,
      dueDate: new Date(Date.now() + days * 86400000).toISOString().slice(0, 10),
      language: language || 'English',
      createdAt: new Date().toISOString(),
    });

    saveInvoices();
    res.json({ id, total });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- 3. One invoice's status ----------
app.get('/api/invoice/:id', async (req, res) => {
  try {
    const inv = await getInvoice(req.params.id);
    res.json({ id: inv.id, status: inv.status });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- 4. Dashboard: Paid / Waiting / Late ----------
app.get('/api/invoices', async (req, res) => {
  try {
    res.json(await listInvoices());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/summary', async (req, res) => {
  try {
    res.json(await buildSummary(await listInvoices()));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- 5. Polite reminder for a late invoice ----------
app.post('/api/reminder/:id', async (req, res) => {
  try {
    const inv = sentInvoices.find(i => i.id === req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const prompt = `Write a short, polite, friendly payment reminder (2-3 sentences) from a small shopkeeper to a customer.
Customer name: ${inv.customerName}
Amount due: ${inv.total} USD
Original due date: ${inv.dueDate}
Write it in this language: ${inv.language}.
Reply with the message text only.`;

    const response = await generate({ contents: prompt });
    res.json({ message: response.text.trim() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- 6. Ask the business by voice ----------
const ASK_PROMPT = `You are the business assistant of a small shopkeeper who bills customers with PayPal invoices.
You get the shopkeeper's question and a JSON list of their invoices (total is in USD, inr is the rupee amount if any, bucket is paid, waiting or late).
Answer ONLY from this data. Never invent invoices or numbers. If the list is empty, say there are no bills yet.
You also get a "summary" with money EARNED (paid bills) today, in the last 7 days and this month, plus what is waiting and late, in USD and approximate INR. For earnings questions use the summary numbers exactly and never add numbers yourself. When asked in Hindi or about rupees, include the rupee amount.
Keep the answer to 1-3 short, simple sentences, in the language the question was asked in (Hindi, Hinglish or English). Say amounts like "36 dollars".
If the shopkeeper asks you to remind or chase customers who are late, set action to "remind_late".
If the shopkeeper says a customer has paid (cash, UPI or any other way), set action to "mark_paid" and "customer" to that customer's name, and answer by asking them to confirm.
Otherwise action is "none".
Reply with ONLY JSON: {"answer": string, "action": "none"|"remind_late"|"mark_paid", "customer": string|null}`;

// ---------- PayPal sync, dashboard list and earnings summary ----------
const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const shiftDay = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);

function dayOf(x) {
  if (!x) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
  const d = new Date(x);
  return isNaN(d) ? String(x).slice(0, 10) : d.toLocaleDateString('en-CA', { timeZone: TZ });
}

function fromPayPal(r) {
  const b = r.primary_recipients?.[0]?.billing_info || {};
  const n = b.name || {};
  return {
    id: r.id,
    customerName: `${n.given_name || ''} ${n.surname || ''}`.trim() || 'Customer',
    customerEmail: b.email_address || '',
    total: Number(r.amount?.value || 0),
    inrTotal: null,
    dueDate: r.detail?.payment_term?.due_date || r.detail?.invoice_date || '',
    language: 'English',
    createdAt: r.detail?.metadata?.create_time || `${r.detail?.invoice_date}T00:00:00.000Z`,
    imported: true,
  };
}

// Reads every invoice from PayPal and adds the ones this app does not know yet
async function refreshFromPayPal() {
  const raw = await listPayPalInvoices();
  const map = new Map();
  let changed = false;
  for (const r of raw) {
    map.set(r.id, r);
    if (['DRAFT', 'CANCELLED'].includes(r.status)) continue;
    if (!sentInvoices.some(i => i.id === r.id)) {
      sentInvoices.push(fromPayPal(r));
      changed = true;
    }
  }
  if (changed) saveInvoices();
  return map;
}

async function listInvoices() {
  const today = todayStr();
  let map = new Map();
  try {
    map = await refreshFromPayPal();
  } catch (e) {
    console.error('PayPal list failed, using saved data:', e.message);
  }
  const live = map.size > 0;

  const out = await Promise.all(
    sentInvoices
      .filter(inv => !(live && inv.demo))
      .map(async inv => {
        let raw = map.get(inv.id);
        let paypalStatus = raw?.status || 'UNKNOWN';
        if (!raw && !inv.demo) {
          try {
            raw = await getInvoice(inv.id);
            paypalStatus = raw.status;
          } catch (e) {
            console.error('Status check failed for', inv.id, e.message);
          }
        }
        const total = Number(raw?.amount?.value ?? inv.total);
        const isPaid = !!inv.paidManually || ['PAID', 'MARKED_AS_PAID'].includes(paypalStatus);
        let bucket = 'waiting';
        if (isPaid) bucket = 'paid';
        else if (inv.dueDate && inv.dueDate < today) bucket = 'late';
        const tx = (raw?.payments?.transactions || []).map(t => t.payment_date).filter(Boolean).sort().pop();
        const paidDate = isPaid ? dayOf(tx || inv.paidAt || inv.createdAt) : null;
        return { ...inv, total, paypalStatus, bucket, paidDate, invoiceNumber: raw?.detail?.invoice_number || null };
      })
  );
  return out
    .filter(i => !['DRAFT', 'CANCELLED', 'REFUNDED', 'MARKED_AS_REFUNDED'].includes(i.paypalStatus))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function buildSummary(list) {
  const { rate } = await getUsdInr();
  const t = todayStr();
  const weekStart = shiftDay(t, -6);
  const monthStart = t.slice(0, 8) + '01';
  const paid = list.filter(i => i.bucket === 'paid' && i.paidDate);
  const pack = arr => {
    const usd = +arr.reduce((s, i) => s + i.total, 0).toFixed(2);
    return { usd, inr: Math.round(usd * rate) };
  };
  return {
    asOf: t,
    earnedToday: pack(paid.filter(i => i.paidDate === t)),
    earnedLast7Days: pack(paid.filter(i => i.paidDate >= weekStart && i.paidDate <= t)),
    earnedThisMonth: pack(paid.filter(i => i.paidDate >= monthStart && i.paidDate <= t)),
    earnedAllTime: pack(paid),
    waiting: pack(list.filter(i => i.bucket === 'waiting')),
    late: pack(list.filter(i => i.bucket === 'late')),
    usdToInr: rate,
  };
}

async function draftReminder(inv) {
  const prompt = `Write a short, polite, friendly payment reminder (2-3 sentences) from a small shopkeeper to a customer.
Customer name: ${inv.customerName}
Amount due: ${inv.total} USD
Original due date: ${inv.dueDate}
Write it in this language: ${inv.language}.
Reply with the message text only.`;
  const r = await generate({ contents: prompt });
  return r.text.trim();
}

app.post('/api/ask', async (req, res) => {
  try {
    const question = req.body.text;
    if (!question) return res.status(400).json({ error: 'No question' });

    const list = await listInvoices();
    const data = list.map(i => ({
      customer: i.customerName, total: i.total, inr: i.inrTotal,
      bucket: i.bucket, dueDate: i.dueDate, paidDate: i.paidDate, createdAt: i.createdAt,
    }));
    const summary = await buildSummary(list);

    const response = await generate({
      contents: `Today: ${todayStr()}\nSummary: ${JSON.stringify(summary)}\nInvoices: ${JSON.stringify(data)}\nQuestion: ${question}`,
      config: { systemInstruction: ASK_PROMPT, responseMimeType: 'application/json', temperature: 0 },
    });
    const out = cleanJson(response.text);

    // Agent action: draft reminders for late invoices. Nothing is sent until the shopkeeper confirms.
    let reminders = [];
    if (out.action === 'remind_late') {
      for (const inv of list.filter(i => i.bucket === 'late')) {
        reminders.push({ id: inv.id, customer: inv.customerName, message: await draftReminder(inv) });
      }
    }
    // Agent action: find the unpaid bill to mark as paid. Nothing changes until the shopkeeper confirms.
    let answer = out.answer;
    let payment = null;
    if (out.action === 'mark_paid') {
      const contact = findContact(out.customer);
      const match = contact && [...list].reverse().find(
        i => i.bucket !== 'paid' && i.customerName === customerKey(contact)
      );
      if (match) payment = { id: match.id, customer: match.customerName, total: match.total };
      else answer = `I could not find an unpaid bill for ${out.customer || 'that customer'}.`;
    }
    res.json({ answer, action: out.action, reminders, payment });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Send the confirmed reminders through PayPal
app.post('/api/remind/send', async (req, res) => {
  const results = [];
  for (const r of req.body.reminders || []) {
    if (!sentInvoices.some(i => i.id === r.id)) {
      results.push({ id: r.id, ok: false, error: 'Unknown invoice' });
      continue;
    }
    try {
      if (!sentInvoices.find(i => i.id === r.id).demo) await remindInvoice(r.id, r.message);
      results.push({ id: r.id, ok: true });
    } catch (e) {
      console.error(e);
      results.push({ id: r.id, ok: false, error: e.message });
    }
  }
  res.json({ results });
});

// Record a cash or UPI payment on the PayPal invoice
app.post('/api/invoice/:id/paid', async (req, res) => {
  try {
    const inv = sentInvoices.find(i => i.id === req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (!inv.demo) await recordPayment(inv.id, inv.total);
    inv.paidManually = true;
    inv.paidAt = todayStr();
    saveInvoices();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Demo helper: backdate the latest invoice so the "late" flow can be shown
app.post('/api/demo/make-late', (req, res) => {
  const inv = sentInvoices[sentInvoices.length - 1];
  if (!inv) return res.status(404).json({ error: 'No invoices yet' });
  inv.dueDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  saveInvoices();
  res.json({ ok: true, id: inv.id });
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));