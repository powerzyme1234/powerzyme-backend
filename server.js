// Powerzyme Nutrition Backend
// Handles: creating Razorpay orders, verifying payments, saving orders to Supabase,
// and serving live product data (prices/stock) from Supabase.

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ---- Environment variables (set these in Render, never hardcode) ----
const {
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  RESEND_API_KEY,
  PORT = 3000
} = process.env;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.warn('⚠️  Razorpay keys are missing. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn('⚠️  Supabase credentials are missing. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.');
}
if (!RESEND_API_KEY) {
  console.warn('⚠️  RESEND_API_KEY is missing. Order confirmation emails will not be sent.');
}

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---- Generate a simple invoice PDF as a Buffer ----
function generateInvoicePDF({ customerName, email, address, items, amount, paymentId, date }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).fillColor('#B76E79').text('Powerzyme Nutrition', { align: 'left' });
    doc.fontSize(10).fillColor('#666').text('powerzymenutrition@gmail.com', { align: 'left' });
    doc.moveDown(1.5);

    doc.fontSize(16).fillColor('#000').text('Invoice', { align: 'left' });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#333');
    doc.text(`Invoice Date: ${date}`);
    doc.text(`Payment ID: ${paymentId}`);
    doc.moveDown(1);

    doc.fontSize(12).fillColor('#000').text('Billed To:');
    doc.fontSize(10).fillColor('#333').text(customerName || '-');
    doc.text(email || '-');
    doc.text(address || '-');
    doc.moveDown(1);

    doc.fontSize(12).fillColor('#000').text('Order Items:');
    doc.moveDown(0.3);
    (items || []).forEach((i) => {
      doc.fontSize(10).fillColor('#333').text(`${i.name}  x${i.qty}  —  ₹${i.price * i.qty}`);
    });
    doc.moveDown(1);

    doc.fontSize(13).fillColor('#000').text(`Total Paid: ₹${amount}`, { align: 'right' });
    doc.moveDown(2);
    doc.fontSize(9).fillColor('#888').text('Thank you for shopping with Powerzyme Nutrition.', { align: 'center' });

    doc.end();
  });
}
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

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
      email,
      phone,
      address,
      addr1,
      addr2,
      pincode,
      items,
      amount
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Missing payment verification fields' });
    }

    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    const isValid = expectedSignature === razorpay_signature;

    if (!isValid) {
      return res.status(400).json({ success: false, error: 'Payment verification failed — signature mismatch' });
    }

    const { data, error } = await supabase
      .from('orders')
      .insert([{
        customer_name,
        email,
        phone,
        address,
        addr1,
        addr2,
        pincode,
        items: JSON.stringify(items),
        amount,
        payment_id: razorpay_payment_id,
        payment_method: 'Online',
        status: 'paid'
      }])
      .select();

    if (error) throw error;

    // Send order confirmation email with invoice attached (non-blocking — order is already saved either way)
    if (resend && email) {
      try {
        const itemsList = (items || [])
          .map(i => `${i.name} x${i.qty} — ₹${i.price * i.qty}`)
          .join('<br>');

        const invoiceDate = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
        const invoiceBuffer = await generateInvoicePDF({
          customerName: customer_name,
          email,
          address,
          items,
          amount,
          paymentId: razorpay_payment_id,
          date: invoiceDate
        });

        await resend.emails.send({
          from: 'Powerzyme Nutrition <orders@powerzymenutrition.in>',
          to: email,
          subject: 'Your Powerzyme Order is Confirmed! 🎉',
          html: `
            <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto;">
              <h2 style="color:#B76E79;">Order Confirmed!</h2>
              <p>Hi ${customer_name || 'there'},</p>
              <p>Thanks for your order — here are the details:</p>
              <p><b>Order Items:</b><br>${itemsList}</p>
              <p><b>Total Paid:</b> ₹${amount}</p>
              <p><b>Payment ID:</b> ${razorpay_payment_id}</p>
              <p><b>Delivery Address:</b><br>${address}</p>
              <p>We'll notify you once your order ships. Expected delivery: 4-6 days (1-2 days for Delhi NCR).</p>
              <p>You can check shipping updates anytime through the account section on our website.</p>
              <p>The invoice is attached below.</p>
              <div style="margin:28px 0; padding:20px; background:#f9f5f5; border-radius:12px; text-align:center;">
                <p style="font-size:15px; font-weight:bold; color:#B76E79; margin-bottom:6px;">Your gains don't stop here. 💪</p>
                <p style="font-size:13px; color:#555; margin-bottom:18px;">Stack your results — explore our full range of protein, creatine, pre-workout, and more. Your next level is one order away.</p>
                <a href="https://powerzymenutrition.in" style="display:inline-block; background:#B76E79; color:#fff; text-decoration:none; padding:12px 32px; border-radius:30px; font-weight:bold; font-size:14px; letter-spacing:0.5px;">Shop Now →</a>
              </div>
              <p style="margin-top:24px; color:#888; font-size:13px;">Powerzyme Nutrition · powerzymenutrition@gmail.com</p>
            </div>
          `,
          attachments: [
            {
              filename: `Powerzyme_Invoice_${razorpay_payment_id}.pdf`,
              content: invoiceBuffer.toString('base64')
            }
          ]
        });
      } catch (emailErr) {
        console.error('Order saved, but confirmation email failed:', emailErr.message);
      }
    }

    res.json({ success: true, message: 'Payment verified and order saved', order: data[0] });
  } catch (err) {
    console.error('Error verifying payment:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- 4. Get active coupons from Supabase ----
app.get('/coupons', async (req, res) => {
  try {
    const { data, error } = await supabase.from('coupons').select('*').eq('active', true);
    if (error) throw error;
    res.json({ success: true, coupons: data });
  } catch (err) {
    console.error('Error fetching coupons:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- 5. Save an email signup ----
app.post('/subscribe', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'Invalid email' });
    }
    const { data, error } = await supabase
      .from('subscribers')
      .insert([{ email }])
      .select();
    if (error) throw error;
    res.json({ success: true, subscriber: data[0] });
  } catch (err) {
    console.error('Error saving subscriber:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- 6. Save a bulk order / contact form submission ----
app.post('/bulk-order', async (req, res) => {
  try {
    const { name, phone, quantity, message } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, error: 'Name and phone are required' });
    }
    const { data, error } = await supabase
      .from('bulk_orders')
      .insert([{ name, phone, quantity, message }])
      .select();
    if (error) throw error;
    res.json({ success: true, submission: data[0] });
  } catch (err) {
    console.error('Error saving bulk order request:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- 7. Customer signup ----
app.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, error: 'Name, email and password are required' });
    }
    const { data: existing } = await supabase.from('customers').select('id').eq('email', email).single();
    if (existing) {
      return res.status(400).json({ success: false, error: 'An account with this email already exists' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase
      .from('customers')
      .insert([{ name, email, password_hash: passwordHash }])
      .select();
    if (error) throw error;
    res.json({ success: true, customer: { name: data[0].name, email: data[0].email } });
  } catch (err) {
    console.error('Error signing up:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- 8. Customer login ----
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }
    const { data: customer, error } = await supabase.from('customers').select('*').eq('email', email).single();
    if (error || !customer) {
      return res.status(400).json({ success: false, error: 'No account found with this email' });
    }
    const match = await bcrypt.compare(password, customer.password_hash);
    if (!match) {
      return res.status(400).json({ success: false, error: 'Incorrect password' });
    }
    res.json({ success: true, customer: { name: customer.name, email: customer.email } });
  } catch (err) {
    console.error('Error logging in:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- 9. Get a customer's order history ----
app.get('/my-orders', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ success: false, error: 'Email is required' });
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('email', email)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, orders: data });
  } catch (err) {
    console.error('Error fetching order history:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- 10. Place a COD order ----
app.post('/place-cod-order', async (req, res) => {
  try {
    const { customer_name, email, phone, address, addr1, addr2, pincode, items, amount, payment_method } = req.body;
    if (!customer_name || !phone || !addr1 || !pincode) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    const { data, error } = await supabase
      .from('orders')
      .insert([{
        customer_name,
        email,
        phone,
        address,
        addr1,
        addr2,
        pincode,
        items: JSON.stringify(items),
        amount,
        payment_id: 'COD-' + Date.now(),
        payment_method: 'COD',
        status: 'pending'
      }])
      .select();
    if (error) throw error;

    // Send confirmation email for COD
    if (resend && email) {
      try {
        const itemsList = (items || []).map(i => `${i.name} x${i.qty} — ₹${i.price * i.qty}`).join('<br>');
        const invoiceDate = new Date().toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
        const invoiceBuffer = await generateInvoicePDF({ customerName: customer_name, email, address, items, amount, paymentId: 'COD', date: invoiceDate });
        await resend.emails.send({
          from: 'Powerzyme Nutrition <orders@powerzymenutrition.in>',
          to: email,
          subject: 'Your Powerzyme COD Order is Confirmed! 🎉',
          html: `
            <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto;">
              <h2 style="color:#B76E79;">Order Confirmed (COD)!</h2>
              <p>Hi ${customer_name || 'there'},</p>
              <p>Thanks for your order — you'll pay <b>₹${amount}</b> cash when it's delivered.</p>
              <p><b>Order Items:</b><br>${itemsList}</p>
              <p><b>Total to Pay on Delivery:</b> ₹${amount}</p>
              <p><b>Delivery Address:</b><br>${address}</p>
              <p>We'll notify you once your order ships. Expected delivery: 4-6 days (1-2 days for Delhi NCR).</p>
              <p>You can check shipping updates anytime through the account section on our website.</p>
              <p>Your gains don't stop here. 💪 Stack your results — explore our full range of protein, creatine, pre-workout, and more.</p>
              <div style="text-align:center; margin:20px 0;"><a href="https://powerzymenutrition.in" style="background:#B76E79; color:#fff; padding:12px 32px; border-radius:30px; font-weight:bold; text-decoration:none;">Shop Now →</a></div>
              <p>The invoice is attached below.</p>
              <p style="color:#888; font-size:13px;">Powerzyme Nutrition · powerzymenutrition@gmail.com</p>
            </div>
          `,
          attachments: [{ filename: `Powerzyme_Invoice_COD.pdf`, content: invoiceBuffer.toString('base64') }]
        });
      } catch (emailErr) {
        console.error('COD order saved, email failed:', emailErr.message);
      }
    }
    res.json({ success: true, order: data[0] });
  } catch (err) {
    console.error('Error placing COD order:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Powerzyme backend running on port ${PORT}`);
});
