# BolBill: a voice-first PayPal invoicing agent for small merchants

**Speak a bill in your own language. BolBill turns it into a real PayPal invoice, checks it for mistakes, and chases late payments for you.**

Built for the PayPal AI Hackathon. Runs entirely on the PayPal **sandbox**.

## The problem
Millions of small shopkeepers and freelancers find invoicing apps hard to use: forms, English-only menus, dashboards. Many also bill customers abroad, where PayPal is the natural way to get paid. BolBill lets them run their billing by talking.

## What it does
- **Speak a bill** in Hindi, English, Marathi, Tamil or Bengali: "Sharma ji ko 19 kilo chawal ka bill bhejo, 17 rupaye per kilo".
- **Gemini parses** the speech into customer, items, prices, currency and due date.
- **Rupees to dollars**: amounts spoken in rupees are converted with the latest ECB reference rate (via Frankfurter), shown on screen, and sent as a USD PayPal invoice.
- **Reads the bill back aloud** and waits for a big green tick or red cross. Nothing is sent without confirmation.
- **Safety checks before money moves**: possible duplicate (same customer and amount within 10 minutes), amount far above the customer's usual bill, very large bills, and a **number cross-check** that warns when the AI's reading of a number differs from the numbers actually spoken.
- **Real PayPal invoices**: created and sent through the PayPal Invoicing API.
- **Dashboard** with Paid / Waiting / Late tiles, read live from PayPal.
- **Ask your business by voice**: "How much did I earn?", "Who hasn't paid me?" Answers come only from the real invoice data.
- **Agent actions with human approval**: "Remind everyone who is late" drafts a polite reminder in each customer's language and sends it through PayPal after confirmation. "Sharma paid me" records a cash or UPI payment on the PayPal invoice after confirmation.

## How PayPal is used
All of this goes through the PayPal Invoicing v2 API (sandbox):
| Action | Endpoint |
|---|---|
| Authenticate | `POST /v1/oauth2/token` |
| Create invoice | `POST /v2/invoicing/invoices` |
| Send invoice | `POST /v2/invoicing/invoices/{id}/send` |
| Read status (Paid / Waiting / Late) | `GET /v2/invoicing/invoices/{id}` |
| Send payment reminder | `POST /v2/invoicing/invoices/{id}/remind` |
| Record cash/UPI payment | `POST /v2/invoicing/invoices/{id}/payments` |

## How AI is used
Google **Gemini** (`@google/genai`) handles:
1. Turning messy multilingual speech into structured invoice JSON (temperature 0, JSON output mode).
2. Answering questions about the business using only the invoice data it is given.
3. Writing polite payment reminders in the customer's language.

The server retries and falls back to a second Gemini model when one is overloaded. Exchange rates and arithmetic are done in code, not by the AI.

## Architecture
```
Browser (Chrome)                        Node.js + Express                 External
 mic -> Web Speech API  -- text -->  /api/parse  ---------------------->  Gemini
 read-back (speech synthesis)        /api/invoice/send  --------------->  PayPal Invoicing API
 confirm / cancel buttons            /api/ask, /api/remind/send ------->  Gemini + PayPal
 Paid / Waiting / Late dashboard     /api/invoices (polls PayPal)         Frankfurter (FX rates)
```
Voice input uses the browser's Web Speech API, so Chrome or Edge is needed for the microphone. A text box is available as a fallback.

## Run it locally
Requirements: Node.js 18 or newer.

1. **Clone and install**
   ```bash
   git clone <this repo>
   cd <repo folder>
   npm install
   ```
2. **PayPal sandbox**
   - In the [PayPal Developer Dashboard](https://developer.paypal.com), go to *Testing Tools > Sandbox Accounts* and create a **Business** and a **Personal** account. **Use United States as the country for both.** PayPal blocks sending invoices to customers inside India, so India-based sandbox accounts will fail at the send step.
   - Under *Apps & Credentials > Sandbox*, create a **Merchant** app linked to the Business account, with **Invoicing** enabled.
3. **Gemini**: create a free API key at https://aistudio.google.com/apikey.
4. **Configure**
   ```bash
   cp .env.example .env     # then fill in the keys
   ```
   Edit `contacts.json` and set the `email` of each contact to your sandbox **Personal** account email.
5. **Start**
   ```bash
   npm start
   ```
   Open http://localhost:3000 in Chrome and allow the microphone.

## Trying the demo
1. Say or type: *"Sharma ji ko 3 kilo chawal ka bill bhejo, 100 rupaye per kilo"*, check the card, tap the green tick.
2. Log in at https://sandbox.paypal.com with the Personal sandbox account to see the invoice, and pay it. Within about 15 seconds the dashboard moves it to **Paid**. Or tap **Mark as paid** (cash/UPI).
3. Open http://localhost:3000/?demo=1 and use the **Demo: make latest bill late** button, then say *"Remind everyone who is late"*. The demo button only backdates a due date so the late flow can be shown.

## Configuration
| Variable | Purpose |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `PAYPAL_BASE` | PayPal sandbox credentials |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL` | Gemini access and model names (model names change; check AI Studio if one is retired) |
| `FALLBACK_USD_INR` | Rate used only if the exchange-rate service is unreachable |
| `MAX_INVOICE_USD` | Amount above which a "large bill" warning appears |

## Limitations
- Sandbox only. No real money moves.
- PayPal cannot send invoices to customers inside India, so BolBill targets merchants who bill international customers in USD.
- Invoices are stored in a local JSON file (`data/invoices.json`), not a database.
- The contact book is a simple JSON file.
- Exchange rates are ECB daily reference rates, not live market rates.

## License
MIT. See [LICENSE](LICENSE).