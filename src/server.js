import 'dotenv/config';
import express from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { GoogleGenAI } from '@google/genai';
import { createInvoice, sendInvoice, getInvoice, remindInvoice, recordPayment } from './paypal.js';

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
    const today = new Date().toISOString().slice(0, 10);
    const list = await Promise.all(
      sentInvoices.map(async inv => {
        let paypalStatus = 'UNKNOWN';
        try {
          paypalStatus = (await getInvoice(inv.id)).status;
        } catch (e) {
          console.error('Status check failed for', inv.id, e.message);
        }
        let bucket = 'waiting';
        if (inv.paidManually || paypalStatus === 'PAID' || paypalStatus === 'MARKED_AS_PAID') bucket = 'paid';
        else if (inv.dueDate < today) bucket = 'late';
        return { ...inv, paypalStatus, bucket };
      })
    );
    res.json(list.reverse());
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
Keep the answer to 1-3 short, simple sentences, in the language the question was asked in (Hindi, Hinglish or English). Say amounts like "36 dollars".
If the shopkeeper asks you to remind or chase customers who are late, set action to "remind_late".
If the shopkeeper says a customer has paid (cash, UPI or any other way), set action to "mark_paid" and "customer" to that customer's name, and answer by asking them to confirm.
Otherwise action is "none".
Reply with ONLY JSON: {"answer": string, "action": "none"|"remind_late"|"mark_paid", "customer": string|null}`;

async function listInvoices() {
  const today = new Date().toISOString().slice(0, 10);
  return Promise.all(
    sentInvoices.map(async inv => {
      let paypalStatus = 'UNKNOWN';
      try { paypalStatus = (await getInvoice(inv.id)).status; } catch (e) { /* keep UNKNOWN */ }
      let bucket = 'waiting';
      if (inv.paidManually || paypalStatus === 'PAID' || paypalStatus === 'MARKED_AS_PAID') bucket = 'paid';
      else if (inv.dueDate < today) bucket = 'late';
      return { ...inv, paypalStatus, bucket };
    })
  );
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
      bucket: i.bucket, dueDate: i.dueDate, createdAt: i.createdAt,
    }));

    const response = await generate({
      contents: `Today: ${new Date().toISOString().slice(0, 10)}\nInvoices: ${JSON.stringify(data)}\nQuestion: ${question}`,
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
      await remindInvoice(r.id, r.message);
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
    await recordPayment(inv.id, inv.total);
    inv.paidManually = true;
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