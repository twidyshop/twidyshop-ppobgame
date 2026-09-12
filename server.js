require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const midtransClient = require('midtrans-client');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

const dbFile = path.join(__dirname, 'transactions.json');
const digitalDbFile = path.join(__dirname, 'digital_products.json');

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

// --- FUNGSI HELPER: KIRIM EMAIL VIA RESEND ---
async function sendEmailReceipt(trx, targetEmail) {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
        console.log('[Resend] API Key tidak ditemukan. Melewati pengiriman email.');
        return;
    }

    let itemsHtml = '';
    if (trx.cart_items && Array.isArray(trx.cart_items)) {
        itemsHtml = trx.cart_items.map(item => `
            <div style="margin-bottom: 15px; padding: 15px; border: 1px solid #e5e7eb; border-radius: 8px; background-color: #ffffff;">
                <h4 style="margin: 0 0 10px 0; color: #1f2937; font-size: 16px;">${item.name}</h4>
                <a href="${item.downloadUrl}" style="background-color: #3b82f6; color: #ffffff; padding: 10px 15px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold; font-size: 14px;">Unduh Produk</a>
            </div>
        `).join('');
    } else {
        itemsHtml = `
            <div style="margin-bottom: 15px; padding: 15px; border: 1px solid #e5e7eb; border-radius: 8px; background-color: #ffffff;">
                <h4 style="margin: 0 0 10px 0; color: #1f2937; font-size: 16px;">${trx.product_name}</h4>
                <a href="${trx.download_url}" style="background-color: #3b82f6; color: #ffffff; padding: 10px 15px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold; font-size: 14px;">Unduh Produk</a>
            </div>
        `;
    }

    const emailHtml = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; color: #374151; background-color: #f9fafb; padding: 20px; border-radius: 12px; border: 1px solid #e5e7eb;">
            <div style="text-align: center; margin-bottom: 20px;">
                <h1 style="color: #2563eb; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: 1px;">TWIDY SHOP</h1>
                <p style="margin: 5px 0 0 0; font-size: 12px; color: #6b7280;">twidyshop.my.id</p>
            </div>
            
            <div style="background-color: #ffffff; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb;">
                <h2 style="color: #111827; margin-top: 0; font-size: 20px;">Terima Kasih atas Pembelian Anda! 🎉</h2>
                <p style="line-height: 1.6;">Pembayaran untuk pesanan digital Anda telah berhasil dikonfirmasi. Berikut adalah detail pesanan dan tautan akses produk Anda:</p>
                
                <div style="background-color: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0; font-size: 14px;">
                    <p style="margin: 5px 0;"><strong>Order ID:</strong> <span style="font-family: monospace;">${trx.order_id}</span></p>
                    <p style="margin: 5px 0;"><strong>Total Bayar:</strong> Rp ${trx.amount.toLocaleString('id-ID')}</p>
                    <p style="margin: 5px 0;"><strong>Tanggal:</strong> ${new Date().toLocaleString('id-ID')}</p>
                </div>

                <h3 style="color: #111827; margin-bottom: 15px; font-size: 16px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px;">Daftar Produk & Link Unduh:</h3>
                ${itemsHtml}
            </div>

            <p style="margin-top: 20px; font-size: 12px; color: #9ca3af; text-align: center; line-height: 1.5;">
                Harap simpan email ini sebagai bukti pembelian yang sah.<br>
                Jika Anda memiliki pertanyaan, silakan hubungi Customer Service kami via WhatsApp.<br><br>
                &copy; ${new Date().getFullYear()} Twidy Shop. All rights reserved.
            </p>
        </div>
    `;

    try {
        const response = await axios.post('https://api.resend.com/emails', {
            from: 'Twidy Shop <noreply@twidyshop.my.id>',
            to: targetEmail,
            subject: `✅ Akses Produk: Pesanan Anda Berhasil! (${trx.order_id})`,
            html: emailHtml
        }, {
            headers: {
                'Authorization': `Bearer ${resendKey}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`[Resend] Sukses kirim email nota ke ${targetEmail} (ID: ${response.data.id})`);
    } catch (error) {
        console.error(`[Resend Error] Gagal kirim email:`, error.response ? error.response.data : error.message);
    }
}
// --- END FUNGSI HELPER ---

// --- FITUR PRODUK DIGITAL & ADMIN ---

app.get('/api/digital-products', (req, res) => {
    res.json({ data: readDigitalDB() });
});

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    const adminUser = process.env.ADMIN_USER || 'admin';
    const adminPass = process.env.ADMIN_PASS || 'twidy2026';

    if (username === adminUser && password === adminPass) {
        res.json({ success: true, token: 'twidy-admin-secure-token' });
    } else {
        res.status(401).json({ success: false, message: 'Username atau Password salah!' });
    }
});

// Tambah Produk Digital Satuan (Dengan URL Cover Gambar)
app.post('/api/admin/products', (req, res) => {
    const { category, name, price, description, downloadUrl, image } = req.body;
    if (!category || !name || !price || !downloadUrl) {
        return res.status(400).json({ success: false, message: 'Data produk kurang lengkap!' });
    }

    const digitalProducts = readDigitalDB();
    const newProduct = {
        id: `DIGI-${Date.now()}-${Math.floor(Math.random()*1000)}`,
        category: category.toLowerCase(),
        name,
        price: parseInt(price),
        description: description || 'Produk digital siap download',
        downloadUrl,
        image: image && image.trim() !== '' ? image : 'https://via.placeholder.com/150?text=TwidyShop',
        created_at: new Date().toISOString()
    };

    digitalProducts.push(newProduct);
    saveDigitalDB(digitalProducts);
    res.json({ success: true, message: 'Produk digital berhasil ditambahkan!' });
});

// Upload Masal / Bulk Import Data Produk (Restore)
app.post('/api/admin/products/bulk', (req, res) => {
    const { products } = req.body;
    if (!Array.isArray(products) || products.length === 0) {
        return res.status(400).json({ success: false, message: 'Format data masal tidak valid!' });
    }

    let digitalProducts = readDigitalDB();
    products.forEach(p => {
        digitalProducts.push({
            id: `DIGI-${Date.now()}-${Math.floor(Math.random()*1000)}`,
            category: (p.category || 'ebook').toLowerCase(),
            name: p.name || 'Produk Tanpa Nama',
            price: parseInt(p.price || 0),
            description: p.description || '',
            downloadUrl: p.downloadUrl || '#',
            image: p.image || 'https://via.placeholder.com/150?text=TwidyShop',
            created_at: new Date().toISOString()
        });
    });

    saveDigitalDB(digitalProducts);
    res.json({ success: true, message: `Berhasil mengimpor ${products.length} produk secara masal!` });
});

// Edit/Update Produk Digital (BARU)[span_2](start_span)[span_2](end_span)
app.put('/api/admin/products/:id', (req, res) => {
    const { id } = req.params;
    const { category, name, price, description, downloadUrl, image } = req.body;
    
    let digitalProducts = readDigitalDB();
    const index = digitalProducts.findIndex(p => p.id === id);
    if (index > -1) {
        digitalProducts[index] = {
            ...digitalProducts[index],
            category: category.toLowerCase(),
            name,
            price: parseInt(price),
            description: description || '',
            downloadUrl,
            image: image && image.trim() !== '' ? image : 'https://via.placeholder.com/150?text=TwidyShop'
        };
        saveDigitalDB(digitalProducts);
        res.json({ success: true, message: 'Produk berhasil diperbarui!' });
    } else {
        res.status(404).json({ success: false, message: 'Produk tidak ditemukan!' });
    }
});

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

// Endpoint Checkout & Buat Transaksi Midtrans
app.post('/api/checkout', async (req, res) => {
  try {
    const { targetId, serverId, price, productName, productCode, isDigital, downloadUrl, cartItems } = req.body;
    if (!targetId) return res.status(400).json({ message: 'Data kurang lengkap' });

    const orderId = `TWIDY-${Date.now()}`;
    const fullTarget = serverId ? `${targetId}${serverId}` : targetId;
    
    let amount = 0;
    let originalProductName = '';
    let itemDetails = [];
    let finalProductCode = productCode || 'DIGI-MULTI';

    if (isDigital && cartItems && Array.isArray(cartItems)) {
        amount = cartItems.reduce((sum, item) => sum + parseInt(item.price), 0);
        originalProductName = `Pembelian ${cartItems.length} Produk Digital`;
        
        itemDetails = cartItems.map((item, index) => ({
            id: `DIGI-${index}`,
            price: parseInt(item.price),
            quantity: 1,
            name: item.name.replace(/[\[\]]/g, '').substring(0, 50),
            merchant_data: fullTarget
        }));
    } else {
        if (!productCode) return res.status(400).json({ message: 'Data kurang lengkap' });
        amount = parseInt(price || 0);
        originalProductName = productName || 'Produk Digital Twidy';
        
        itemDetails = [{
            id: productCode.substring(0, 50),
            price: amount,
            quantity: 1,
            name: originalProductName.replace(/[\[\]]/g, '').substring(0, 50),
            merchant_data: fullTarget
        }];
    }

    const db = readDB();
    db.push({
        order_id: orderId,
        target_id: fullTarget, 
        product_code: finalProductCode,
        product_name: originalProductName,
        amount: amount,
        status: 'UNPAID',
        sn: isDigital ? 'Menunggu Pembayaran (Link akan muncul otomatis setelah lunas)...' : '-',
        is_digital: !!isDigital,
        download_url: downloadUrl || '',
        cart_items: cartItems || null,
        created_at: new Date().toISOString()
    });
    saveDB(db);

    let parameter = {
      transaction_details: { order_id: orderId, gross_amount: amount },
      item_details: itemDetails,
      customer_details: { first_name: "Pelanggan", last_name: "TwidyShop", email: isDigital ? targetId : "customer@twidyshop.my.id" }
    };

    let transaction = await snap.createTransaction(parameter);
    res.json({ token: transaction.token, orderId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Webhook Midtrans
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
        
        // JIKA PRODUK DIGITAL SUKSES DIBAYAR
        if (trx.is_digital) {
            trx.status = 'SUKSES';
            if (trx.cart_items && Array.isArray(trx.cart_items)) {
                trx.sn = trx.cart_items.map(item => `[${item.name}]: ${item.downloadUrl}`).join(' \n ');
            } else {
                trx.sn = `DOWNLOAD LINK: ${trx.download_url}`;
            }
            saveDB(db);

            sendEmailReceipt(trx, trx.target_id);

            return res.status(200).send("OK");
        }

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

// Webhook Digiflazz
app.post('/api/digiflazz-webhook', (req, res) => {
  try {
    const payload = req.body;
    if (!payload || !payload.data || !payload.data.ref_id) {
        return res.status(200).send("OK");
    }

    const { ref_id, status, sn, message } = payload.data;
    let db = readDB();
    let trx = db.find(t => t.order_id === ref_id);
    if (!trx) return res.status(200).send("OK");

    if (status === 'Sukses') {
        trx.status = 'SUKSES';
    } else if (status === 'Gagal') {
        trx.status = 'GAGAL';
    } else {
        trx.status = 'DIPROSES';
    }
    
    const currentSn = sn || message;
    if (currentSn && currentSn.trim() !== '') {
        trx.sn = currentSn;
    } else if (status === 'Sukses') {
        trx.sn = 'Transaksi Berhasil';
    }
    
    saveDB(db);
    return res.status(200).send("OK");
  } catch (error) {
    console.error("Digiflazz Error:", error.message);
    return res.status(500).send("Error");
  }
});

// ROUTING SPA: Mengarahkan semua request file/path agar diarahkan ke index.html utama
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server Twidy Shop berjalan di port ${PORT}`));
