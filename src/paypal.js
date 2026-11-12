import 'dotenv/config';

const { PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_BASE, MERCHANT_EMAIL } = process.env;

async function getToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Auth failed: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function paypal(path, options = {}) {
  const token = await getToken();
  const res = await fetch(`${PAYPAL_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`PayPal error ${res.status}: ${text}`);
  return data;
}

// customer: { firstName, lastName, email }
// items: [{ name, quantity, price }]
export async function createInvoice({ customer, items, currency = 'USD', dueInDays = 7 }) {
  const body = {
    detail: {
        currency_code: currency,
        payment_term: {
            term_type: 'DUE_ON_DATE_SPECIFIED',
            due_date: new Date(Date.now() + dueInDays * 86400000).toISOString().slice(0, 10),
        },
    },
    primary_recipients: [{
      billing_info: {
        name: { given_name: customer.firstName, surname: customer.lastName },
        email_address: customer.email,
      },
    }],
    items: items.map(i => ({
      name: i.name,
      quantity: String(i.quantity),
      unit_amount: { currency_code: currency, value: Number(i.price).toFixed(2) },
    })),
  };

  const draft = await paypal('/v2/invoicing/invoices', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  // The create response returns a link; the invoice id is the last part of it
  const id = draft.href.split('/').pop();
  return id;
}

export async function sendInvoice(id) {
  return paypal(`/v2/invoicing/invoices/${id}/send`, {
    method: 'POST',
    body: JSON.stringify({ send_to_recipient: true }),
  });
}

export async function getInvoice(id) {
  return paypal(`/v2/invoicing/invoices/${id}`);
}

export async function remindInvoice(id, note) {
  return paypal(`/v2/invoicing/invoices/${id}/remind`, {
    method: 'POST',
    body: JSON.stringify({ subject: 'Payment reminder', note, send_to_invoicer: false }),
  });
}

export async function recordPayment(id, amount, currency = 'USD') {
  return paypal(`/v2/invoicing/invoices/${id}/payments`, {
    method: 'POST',
    body: JSON.stringify({
      method: 'OTHER',
      payment_date: new Date().toISOString().slice(0, 10),
      note: 'Paid in cash or UPI, recorded in BolBill',
      amount: { currency_code: currency, value: Number(amount).toFixed(2) },
    }),
  });
}
export async function listPayPalInvoices() {
  const data = await paypal('/v2/invoicing/invoices?page=1&page_size=100');
  return data.items || [];
}