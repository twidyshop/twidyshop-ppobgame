require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const midtransClient = require('midtrans-client');

const app = express();
app.use(express.json());
app.use(express.static('public'));

let snap = new midtransClient.Snap({
  isProduction: true,
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// Cache produk Digiflazz (Mengikuti referensi teman)
let cachedProducts = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 5 * 60 * 1000;

// Endpoint konfigurasi untuk Frontend
app.get('/api/config', (req, res) => {
  res.json({ clientKey: process.env.MIDTRANS_CLIENT_KEY });
});

// Endpoint untuk Tarik Produk / Price-List (Logika disesuaikan persis referensi)
app.get('/api/products', async (req, res) => {
  const user = process.env.DIGIFLAZZ_USERNAME;
  const key = process.env.DIGIFLAZZ_API_KEY;
  if (!user || !key) return res.status(500).json({ message: 'API Key belum diset' });

  try {
    const now = Date.now();
    if (!cachedProducts || (now - cacheTimestamp > CACHE_DURATION)) {
      const sign = crypto.createHash('md5').update(user + key + 'pricelist').digest('hex');
      
      const response = await axios.post('https://api.digiflazz.com/v1/price-list', {
        cmd: 'prepaid',
        username: user,
        sign: sign
      }, {
        headers: { 'Content-Type': 'application/json' }
      });

      const raw = response.data;
      if (raw.data && Array.isArray(raw.data)) {
        cachedProducts = raw.data;
        cacheTimestamp = now;
      } else {
        return res.status(400).json({ message: 'Gagal ambil data dari Digiflazz', error: raw });
      }
    }
    res.json(cachedProducts);
  } catch (err) {
    console.error("Digiflazz Error:", err.response?.data || err.message);
    res.status(500).json({ message: err.message, detail: err.response?.data });
  }
});

// Endpoint Checkout Midtrans
app.post('/api/checkout', async (req, res) => {
  try {
    const { userId, serverId, price, game, productCode } = req.body;
    const orderId = `TWIDY-${Date.now()}`;
    const serverIdStr = serverId ? `(${serverId})` : '';
    const targetNo = serverId ? `${userId}${serverId}` : userId;

    let parameter = {
      transaction_details: {
        order_id: orderId,
        gross_amount: price,
      },
      item_details: [{
        id: productCode,
        price: price,
        quantity: 1,
        name: `${game} - ID: ${userId}${serverIdStr}`,
        merchant_data: targetNo
      }],
      customer_details: {
        first_name: "Pelanggan",
        last_name: "TwidyShop",
      }
    };

    let transaction = await snap.createTransaction(parameter);
    res.json({ token: transaction.token, orderId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Webhook / Callback Midtrans -> Sukses -> Tembak Digiflazz
app.post('/api/webhook', async (req, res) => {
  const notification = req.body;

  if (notification.transaction_status === 'settlement' || notification.transaction_status === 'capture') {
    const orderId = notification.order_id;
    const item = notification.item_details?.[0];
    const buyerSkuCode = item?.id;
    const customerNo = item?.merchant_data;

    if (buyerSkuCode && customerNo) {
      try {
        const username = process.env.DIGIFLAZZ_USERNAME;
        const apiKey = process.env.DIGIFLAZZ_API_KEY;
        const refId = orderId;
        const sign = crypto.createHash('md5').update(username + apiKey + refId).digest('hex');

        await axios.post('https://api.digiflazz.com/v1/transaction', {
          username: username,
          buyer_sku_code: buyerSkuCode,
          customer_no: customerNo,
          ref_id: refId,
          sign: sign,
          testing: false
        });
      } catch (err) {
        console.error('Gagal Tembak Digiflazz:', err.message);
      }
    }
  }
  res.status(200).json({ status: 'OK' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server Twidy Shop aktif di port ${PORT}`));
