// Powerzyme Nutrition Backend
// Handles: creating Razorpay orders, verifying payments, saving orders to Supabase,
// and serving live product data (prices/stock) from Supabase.

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ---- Environment variables (set these in Render, never hardcode) ----
const {
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  PORT = 3000
} = process.env;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.warn('⚠️  Razorpay keys are missing. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn('⚠️  Supabase credentials are missing. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.');
}

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---- Health check ----
app.get('/', (req, res) => {
  res.json({ status: 'Powerzyme backend is running' });
});

// ---- 1. Get live products (prices/stock) from Supabase ----
app.get('/products', async (req, res) => {
  try {
    const { data, error } = await supabase.from('products').select('*');
    if (error) throw error;
    res.json({ success: true, products: data });
  } catch (err) {
    console.error('Error fetching products:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- 2. Create a Razorpay order ----
// Frontend sends: { amount } (in rupees, e.g. 4999)
app.post('/create-order', async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // Razorpay wants paise
      currency: 'INR',
      receipt: 'order_rcpt_' + Date.now()
    });

    res.json({ success: true, order });
  } catch (err) {
    console.error('Error creating Razorpay order:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- 3. Verify payment + save order to Supabase ----
// Frontend sends: { razorpay_order_id, razorpay_payment_id, razorpay_signature, customer, items, amount }
app.post('/verify-payment', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      customer_name,
      phone,
      address,
      items,
      amount
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Missing payment verification fields' });
    }

    // Verify the payment signature is genuinely from Razorpay
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    const isValid = expectedSignature === razorpay_signature;

    if (!isValid) {
      return res.status(400).json({ success: false, error: 'Payment verification failed — signature mismatch' });
    }

    // Save the order to Supabase
    const { data, error } = await supabase
      .from('orders')
      .insert([{
        customer_name,
        phone,
        address,
        items: JSON.stringify(items),
        amount,
        payment_id: razorpay_payment_id,
        status: 'paid'
      }])
      .select();

    if (error) throw error;

    res.json({ success: true, message: 'Payment verified and order saved', order: data[0] });
  } catch (err) {
    console.error('Error verifying payment:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Powerzyme backend running on port ${PORT}`);
});
