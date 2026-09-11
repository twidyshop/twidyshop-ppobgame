require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const midtransClient = require('midtrans-client');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const dbFile = path.join(__dirname, 'transactions.json');
const digitalDbFile = path.join(__dirname, 'digital_products.json');

const readDB = () => {
    try {
        if (!fs.existsSync(dbFile)) return [];
        return JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    } catch (e) { return []; }
};

const saveDB = (data) => {
    fs.writeFileSync(dbFile, JSON.stringify(data.slice(-100), null, 2));
};

const readDigitalDB = () => {
    try {
        if (!fs.existsSync(digitalDbFile)) return [];
        return JSON.parse(fs.readFileSync(digitalDbFile, 'utf8'));
    } catch (e) { return []; }
};

const saveDigitalDB = (data) => {
    fs.writeFileSync(digitalDbFile, JSON.stringify(data, null, 2));
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

// --- FITUR PRODUK DIGITAL & ADMIN ---

// Ambil Semua Produk Digital untuk Ditampilkan di Frontend
app.get('/api/digital-products', (req, res) => {
    res.json({ data: readDigitalDB() });
});

// Endpoint Login Admin Sederhana
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    // Password default admin bisa diatur di .env atau hardcoded aman sementara
    const adminUser = process.env.ADMIN_USER || 'admin';
    const adminPass = process.env.ADMIN_PASS || 'twidy2026';

    if (username === adminUser && password === adminPass) {
        res.json({ success: true, token: 'twidy-admin-secure-token' });
    } else {
        res.status(401).json({ success: false, message: 'Username atau Password salah!' });
    }
});

// Endpoint Tambah Produk Digital oleh Admin
app.post('/api/admin/products', (req, res) => {
    const { category, name, price, description, downloadUrl, image } = req.body;
    if (!category || !name || !price || !downloadUrl) {
        return res.status(400).json({ success: false, message: 'Data produk kurang lengkap!' });
    }

    const digitalProducts = readDigitalDB();
    const newProduct = {
        id: `DIGI-${Date.now()}`,
        category: category.toLowerCase(), // ebook, ecourse, template
        name,
        price: parseInt(price),
        description: description || 'Produk digital siap download',
        downloadUrl,
        image: image || 'assets/ml-logo.png',
        created_at: new Date().toISOString()
    };

    digitalProducts.push(newProduct);
    saveDigitalDB(digitalProducts);
    res.json({ success: true, message: 'Produk digital berhasil ditambahkan!' });
});

// Endpoint Hapus Produk Digital oleh Admin
app.delete('/api/admin/products/:id', (req, res) => {
    const { id } = req.params;
    let digitalProducts = readDigitalDB();
    digitalProducts = digitalProducts.filter(p => p.id !== id);
    saveDigitalDB(digitalProducts);
    res.json({ success: true, message: 'Produk berhasil dihapus!' });
});

// --- END FITUR DIGITAL ---

// Endpoint Tarik Semua Produk Digiflazz (Multi-Kategori) + Margin Profit
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
      let targetData = [];
      
      if (raw.data && Array.isArray(raw.data)) {
        targetData = raw.data;
      } else if (Array.isArray(raw)) {
        targetData = raw;
      } else {
        return res.status(400).json({ message: 'Gagal ambil data', error: raw });
      }

      cachedProducts = targetData.map(produk => ({
          ...produk,
          price: produk.price + 200
      }));
      
      cacheTimestamp = now;
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

// Endpoint Checkout & Buat Transaksi Midtrans (Support PPOB & Produk Digital)
app.post('/api/checkout', async (req, res) => {
  try {
    const { targetId, serverId, price, productName, productCode, isDigital, downloadUrl } = req.body;
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
        sn: isDigital ? `Link Download: ${downloadUrl}` : '-',
        is_digital: !!isDigital,
        download_url: downloadUrl || '',
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

// Webhook Midtrans & Otomatis Tembak Digiflazz (Atau Auto-Sukses untuk Produk Digital)
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
        
        // Jika Produk Digital, langsung sukses dan tampilkan link download di SN
        if (trx.is_digital) {
            trx.status = 'SUKSES';
            trx.sn = `DOWNLOAD LINK: ${trx.download_url}`;
            saveDB(db);
            return res.status(200).send("OK");
        }

        // Jika PPOB biasa, tembak Digiflazz
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

// Webhook Digiflazz Real-Time
app.post('/api/digiflazz-webhook', (req, res) => {
  try {
    const payload = req.body;
    if (!payload || !payload.data || !payload.data.ref_id) return res.status(200).send("OK");

    const { ref_id, status, sn, message } = payload.data;
    let db = readDB();
    let trx = db.find(t => t.order_id === ref_id);
    if (!trx) return res.status(200).send("OK");

    if (status === 'Sukses') trx.status = 'SUKSES';
    else if (status === 'Gagal') trx.status = 'GAGAL';
    else trx.status = 'DIPROSES';
    
    const currentSn = sn || message;
    if (currentSn && currentSn.trim() !== '') {
        trx.sn = currentSn;
    } else if (status === 'Sukses') {
        trx.sn = 'Transaksi Berhasil';
    }
    
    saveDB(db);
    return res.status(200).send("OK");
  } catch (error) {
    return res.status(500).send("Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server Twidy Shop berjalan di port ${PORT}`));
