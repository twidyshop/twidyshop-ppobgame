require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const midtransClient = require('midtrans-client');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Inisialisasi Midtrans Snap (Production)
let snap = new midtransClient.Snap({
  isProduction: true,
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// Helper Signature Digiflazz
function getDigiflazzSignature(refId = '') {
  const username = process.env.DIGIFLAZZ_USERNAME;
  const apiKey = process.env.DIGIFLAZZ_API_KEY;
  // Format signature untuk price-list atau transaksi
  return crypto.createHash('md5').update(username + apiKey + 'depo').digest('hex');
}

// 1. Endpoint untuk Auto-Sync / Ambil Daftar Produk dari Digiflazz
app.get('/api/products', async (req, res) => {
  try {
    const username = process.env.DIGIFLAZZ_USERNAME;
    const apiKey = process.env.DIGIFLAZZ_API_KEY;
    // Signature khusus price-list Digiflazz: md5(username + api_key + "pricelist")
    const sign = crypto.createHash('md5').update(username + apiKey + 'pricelist').digest('hex');

    const response = await axios.post('https://api.digiflazz.com/v1/price-list', {
      cmd: "prepaid",
      username: username,
      sign: sign
    });

    res.json(response.data);
  } catch (error) {
    console.error('Gagal ambil produk Digiflazz:', error.message);
    res.status(500).json({ error: 'Gagal memuat produk dari server Digiflazz' });
  }
});

// 2. Endpoint Checkout Midtrans
app.post('/api/checkout', async (req, res) => {
  try {
    const { userId, serverId, price, game, productCode, customerNo } = req.body;
    const orderId = `TWIDY-${Date.now()}`;
    const serverIdStr = serverId ? `(${serverId})` : '';
    const targetNo = serverId ? `${userId}${serverId}` : userId;

    let parameter = {
      transaction_details: {
        order_id: orderId,
        gross_amount: price,
      },
      item_details: [{
        id: productCode, // SKU Code Digiflazz (contoh: 'ml86')
        price: price,
        quantity: 1,
        name: `${game} - ID: ${userId}${serverIdStr}`,
        merchant_data: targetNo // Menyimpan nomor tujuan game
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

// 3. Webhook Otomatis (Midtrans -> Sukses -> Tembak Digiflazz)
app.post('/api/webhook', async (req, res) => {
  const notification = req.body;

  if (notification.transaction_status === 'settlement' || notification.transaction_status === 'capture') {
    const orderId = notification.order_id;
    const item = notification.item_details?.[0];
    const buyerSkuCode = item?.id; // SKU Digiflazz
    const customerNo = item?.merchant_data; // User ID game target

    if (buyerSkuCode && customerNo) {
      try {
        const username = process.env.DIGIFLAZZ_USERNAME;
        const apiKey = process.env.DIGIFLAZZ_API_KEY;
        const refId = orderId;
        
        // Signature transaksi Digiflazz: md5(username + api_key + ref_id)
        const sign = crypto.createHash('md5').update(username + apiKey + refId).digest('hex');

        const digiflazzRes = await axios.post('https://api.digiflazz.com/v1/transaction', {
          username: username,
          buyer_sku_code: buyerSkuCode,
          customer_no: customerNo,
          ref_id: refId,
          sign: sign,
          testing: false // Ubah ke true jika ingin tes sandbox
        });

        console.log('Transaksi Digiflazz Berhasil:', digiflazzRes.data);
      } catch (err) {
        console.error('Gagal Tembak Digiflazz:', err.message);
      }
    }
  }

  res.status(200).json({ status: 'OK' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Twidy Shop server aktif di port ${PORT}`));
