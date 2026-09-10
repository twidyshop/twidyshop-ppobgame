require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const midtransClient = require('midtrans-client');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const dbFile = path.join(__dirname, 'transactions.json');

const readDB = () => {
    try {
        if (!fs.existsSync(dbFile)) return [];
        return JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    } catch (e) {
        return [];
    }
};

const saveDB = (data) => {
    fs.writeFileSync(dbFile, JSON.stringify(data.slice(-100), null, 2));
};

let snap = new midtransClient.Snap({
  isProduction: true,
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY
});

let cachedProducts = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 5 * 60 * 1000;

app.get('/api/config', (req, res) => {
  res.json({ clientKey: process.env.MIDTRANS_CLIENT_KEY });
});

// Endpoint Tarik Semua Produk Digiflazz (Multi-Kategori)
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
      } else if (Array.isArray(raw)) {
        cachedProducts = raw;
        cacheTimestamp = now;
      } else {
        return res.status(400).json({ message: 'Gagal ambil data dari Digiflazz', error: raw });
      }
    }
    res.json({ data: cachedProducts });
  } catch (err) {
    console.error("Digiflazz Error:", err.response?.data || err.message);
    res.status(500).json({ message: err.message, detail: err.response?.data });
  }
});

// Endpoint Riwayat Transaksi Real-time
app.get('/api/transactions', (req, res) => {
    try {
        return res.status(200).json(readDB().reverse());
    } catch (e) {
        return res.status(500).json({ message: 'Error Database' });
    }
});

// Endpoint Checkout & Buat Transaksi Midtrans
app.post('/api/checkout', async (req, res) => {
  try {
    const { targetId, serverId, price, productName, productCode } = req.body;
    if (!targetId || !productCode) return res.status(400).json({ message: 'Data kurang lengkap' });

    const orderId = `TWIDY-${Date.now()}`;
    const amount = parseInt(price || 0);
    const fullTarget = serverId ? `${targetId}${serverId}` : targetId;

    const db = readDB();
    db.push({
        order_id: orderId,
        target_id: fullTarget,
        product_code: productCode,
        product_name: productName || 'Produk Digital Twidy',
        amount: amount,
        status: 'UNPAID',
        sn: '-',
        created_at: new Date().toISOString()
    });
    saveDB(db);

    let parameter = {
      transaction_details: { order_id: orderId, gross_amount: amount },
      item_details: [{
        id: productCode,
        price: amount,
        quantity: 1,
        name: productName,
        merchant_data: fullTarget
      }],
      customer_details: { first_name: "Pelanggan", last_name: "TwidyShop" }
    };

    let transaction = await snap.createTransaction(parameter);
    res.json({ token: transaction.token, orderId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Webhook Midtrans & Otomatis Tembak Digiflazz
app.post('/api/webhook', async (req, res) => {
  try {
    const notif = req.body;
    if (!notif || !notif.transaction_status) return res.status(200).send("OK");

    const { transaction_status, order_id } = notif;
    let db = readDB();
    let trx = db.find(t => t.order_id === order_id);
    if (!trx) return res.status(200).send("OK");

    if (transaction_status === 'settlement' || transaction_status === 'capture') {
        if (['SUKSES', 'DIPROSES', 'GAGAL'].includes(trx.status)) return res.status(200).send("OK");
        
        trx.status = 'DIPROSES';
        saveDB(db);

        const user = process.env.DIGIFLAZZ_USERNAME;
        const key = process.env.DIGIFLAZZ_API_KEY;
        if (user && key) {
            const sign = crypto.createHash('md5').update(user + key + order_id).digest('hex');
            try {
                const digiRes = await axios.post('https://api.digiflazz.com/v1/transaction', {
                    username: user,
                    buyer_sku_code: trx.product_code,
                    customer_no: trx.target_id,
                    ref_id: order_id,
                    sign: sign,
                    testing: false
                });
                const result = digiRes.data.data || {};
                
                if (result.status === 'Sukses' || result.status === 0) {
                    trx.status = 'SUKSES';
                } else if (result.status === 'Gagal') {
                    trx.status = 'GAGAL';
                } else {
                    trx.status = 'DIPROSES';
                }
                
                // Menangkap SN lebih pintar
                const resultSn = result.sn || result.message;
                trx.sn = (resultSn && resultSn.trim() !== '') ? resultSn : 'Diproses (Menunggu Pembaruan)';
                saveDB(db);
            } catch (err) {
                console.error("Digiflazz Execution Error:", err.message);
            }
        }
    } else if (['expire', 'cancel', 'deny'].includes(transaction_status)) {
        trx.status = 'GAGAL';
        saveDB(db);
    }
    return res.status(200).send("OK");
  } catch (e) {
    return res.status(500).send("Error");
  }
});

// TAMBAHAN: Webhook Digiflazz untuk menerima update SN dan status secara Real-Time
app.post('/api/digiflazz-webhook', (req, res) => {
  try {
    const payload = req.body;
    
    // Pastikan ini adalah data transaksi dari Digiflazz
    if (!payload || !payload.data || !payload.data.ref_id) {
        return res.status(200).send("OK");
    }

    const { ref_id, status, sn, message } = payload.data;
    
    let db = readDB();
    let trx = db.find(t => t.order_id === ref_id);
    if (!trx) return res.status(200).send("OK"); // Order tidak ditemukan di database kita

    // Update Status
    if (status === 'Sukses') {
        trx.status = 'SUKSES';
    } else if (status === 'Gagal') {
        trx.status = 'GAGAL';
    } else {
        trx.status = 'DIPROSES';
    }
    
    // Update SN / Ket terbaru dari Digiflazz
    const currentSn = sn || message;
    if (currentSn && currentSn.trim() !== '') {
        trx.sn = currentSn;
    } else if (status === 'Sukses') {
        trx.sn = 'Transaksi Berhasil';
    }
    
    saveDB(db);
    return res.status(200).send("OK");
  } catch (error) {
    console.error("Digiflazz Webhook Error:", error.message);
    return res.status(500).send("Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server Twidy Shop berjalan di port ${PORT}`));
