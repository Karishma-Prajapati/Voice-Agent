import { createInvoice, sendInvoice, getInvoice } from './paypal.js';

const id = await createInvoice({
  customer: { firstName: 'Test', lastName: 'Buyer', email: 'sb-vs2vn53758913@personal.example.com' },
  items: [{ name: 'Rice (3 kg)', quantity: 1, price: 12 }],
});
console.log('Created:', id);

console.log(await sendInvoice(id));

const inv = await getInvoice(id);
console.log('Status:', inv.status);