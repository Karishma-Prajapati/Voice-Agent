import 'dotenv/config';

const { PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_BASE } = process.env;
const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');

const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
  method: 'POST',
  headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
});
const data = await res.json();
console.log('App ID:', data.app_id);
console.log('Scopes:', data.scope);