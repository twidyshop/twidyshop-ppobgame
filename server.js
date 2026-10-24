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
    fs.writeFileSync(dbFile, JSON.stringify(data.slice(-10000), null, 2));
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
const adminSessions = new Map();
const pascaQuotes = new Map();

function isAdmin(req) {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const expiresAt = adminSessions.get(token);
    if (!token || !expiresAt || expiresAt < Date.now()) {
        if (token) adminSessions.delete(token);
        return false;
    }
    return true;
}
function requireAdmin(req, res, next) {
    if (!isAdmin(req)) return res.status(401).json({ success: false, message: 'Sesi admin tidak valid. Silakan login ulang.' });
    next();
}
function constantTimeEqual(a, b) {
    const left = Buffer.from(String(a || ''), 'utf8');
    const right = Buffer.from(String(b || ''), 'utf8');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function verifyMidtransNotification(notif) {
    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    if (!serverKey || !notif || !notif.order_id || !notif.status_code || !notif.gross_amount || !notif.signature_key) return false;
    const expected = crypto.createHash('sha512').update(String(notif.order_id) + String(notif.status_code) + String(notif.gross_amount) + serverKey).digest('hex');
    return constantTimeEqual(expected.toLowerCase(), String(notif.signature_key).toLowerCase());
}

// --- FUNGSI HELPER MARGIN (1%, Min Rp 200, Max Rp 500) ---
function calculateMargin(basePrice) {
    let bp = parseInt(basePrice);
    if (isNaN(bp) || bp <= 0) return 0; 
    let margin = Math.round(bp * 0.01);
    if (margin < 200) margin = 200;
    if (margin > 500) margin = 500;
    return bp + margin;
}

app.get('/api/config', (req, res) => {
  res.json({ clientKey: process.env.MIDTRANS_CLIENT_KEY });
});

// --- FUNGSI HELPER: KIRIM EMAIL VIA RESEND ---
async function sendEmailReceipt(trx, targetEmail) {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return;

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
                &copy; ${new Date().getFullYear()} Twidy Shop. All rights reserved.
            </p>
        </div>
    `;

    try {
        await axios.post('https://api.resend.com/emails', {
            from: 'Twidy Shop <noreply@twidyshop.my.id>',
            to: targetEmail,
            subject: `✅ Akses Produk: Pesanan Anda Berhasil! (${trx.order_id})`,
            html: emailHtml
        }, { headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' } });
    } catch (error) {
        console.error(`[Resend Error] Gagal kirim email:`, error.message);
    }
}

// --- FITUR PRODUK DIGITAL & ADMIN ---
app.get('/api/digital-products', (req, res) => {
    const safeProducts = readDigitalDB().map(({ downloadUrl, ...product }) => product);
    res.json({ data: safeProducts });
});
app.get('/api/admin/products', requireAdmin, (req, res) => {
    res.json({ data: readDigitalDB() });
});

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body || {};
    const adminUser = process.env.ADMIN_USER;
    const adminPass = process.env.ADMIN_PASS;
    if (!adminUser || !adminPass) return res.status(503).json({ success: false, message: 'ADMIN_USER dan ADMIN_PASS wajib disetel di environment server.' });
    if (constantTimeEqual(username, adminUser) && constantTimeEqual(password, adminPass)) {
        const token = crypto.randomBytes(32).toString('hex');
        adminSessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
        return res.json({ success: true, token });
    }
    return res.status(401).json({ success: false, message: 'Username atau Password salah!' });
});

app.post('/api/admin/products', requireAdmin, (req, res) => {
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

app.post('/api/admin/products/bulk', requireAdmin, (req, res) => {
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

app.put('/api/admin/products/:id', requireAdmin, (req, res) => {
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

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    let digitalProducts = readDigitalDB();
    digitalProducts = digitalProducts.filter(p => p.id !== id);
    saveDigitalDB(digitalProducts);
    res.json({ success: true, message: 'Produk berhasil dihapus!' });
});

// --- KATALOG PRODUK: DIGIFLAZZ SAJA ---
app.get('/api/products', async (req, res) => {
    try {
        const now = Date.now();
        if (cachedProducts && (now - cacheTimestamp <= CACHE_DURATION)) {
            return res.json({ data: cachedProducts });
        }

        const user = process.env.DIGIFLAZZ_USERNAME;
        const key = process.env.DIGIFLAZZ_API_KEY;
        if (!user || !key) {
            return res.status(503).json({ message: 'Kredensial Digiflazz belum dikonfigurasi di server.' });
        }

        const sign = crypto.createHash('md5').update(user + key + 'pricelist').digest('hex');
        const digiRes = await axios.post('https://api.digiflazz.com/v1/price-list', {
            cmd: 'prepaid',
            username: user,
            sign
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });

        const raw = digiRes.data;
        const digiData = Array.isArray(raw.data) ? raw.data : (Array.isArray(raw) ? raw : []);
        const products = digiData.map(p => ({
            ...p,
            supplier: 'digiflazz',
            price: calculateMargin(p.price)
        })).filter(p => p.price > 0 && p.product_name && p.buyer_sku_code);

        cachedProducts = products;
        cacheTimestamp = now;
        return res.json({ data: products });
    } catch (err) {
        console.error('[Digiflazz] Gagal memuat pricelist:', err.message);
        return res.status(502).json({ message: 'Daftar produk Digiflazz gagal dimuat. Silakan coba lagi.' });
    }
});

// --- FUNGSI CEK TAGIHAN PASCABAYAR (INQUIRY) ---
app.post('/api/inquiry-pasca', async (req, res) => {
    const { sku, targetId } = req.body || {};
    if (typeof sku !== 'string' || !sku.trim() || typeof targetId !== 'string' || !targetId.trim() || targetId.length > 100) {
        return res.status(400).json({ success: false, message: 'SKU atau nomor pelanggan tidak valid.' });
    }
    const user = process.env.DIGIFLAZZ_USERNAME;
    const key = process.env.DIGIFLAZZ_API_KEY;
    
    if (!user || !key) return res.status(500).json({ success: false, message: 'API Key belum diatur' });
    
    const refId = `INQ-${Date.now()}`; 
    const sign = crypto.createHash('md5').update(user + key + refId).digest('hex');

    try {
        const digiRes = await axios.post('https://api.digiflazz.com/v1/transaction', {
            commands: "inq-pasca", 
            username: user,
            buyer_sku_code: sku,
            customer_no: targetId,
            ref_id: refId,
            sign: sign,
            testing: false
        });

        const result = digiRes.data.data;
        if (result && result.status === 'Sukses') {
            const base = Number(result.selling_price);
            if (!Number.isFinite(base) || base <= 0) return res.status(502).json({ success: false, message: 'Harga tagihan dari supplier tidak valid.' });
            const quoteToken = crypto.randomBytes(24).toString('hex');
            const quotePrice = Math.round(base + 2000);
            pascaQuotes.set(quoteToken, { sku: String(sku), targetId: String(targetId), price: quotePrice, expiresAt: Date.now() + 5 * 60 * 1000 });
            res.json({ success: true, data: result, quoteToken, quotePrice });
        } else {
            res.json({ success: false, message: result?.message || 'Gagal cek tagihan' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.response?.data?.data?.message || err.message });
    }
});

// --- FITUR AUTO-POLLING CEK STATUS REALTIME ---
app.get('/api/transactions', async (req, res) => {
    try {
        let db = readDB();
        let needsSave = false;
        
        // AUTO SYNC STATUS: Cek max 5 transaksi terakhir yang masih 'DIPROSES'
        const requestedOrderId = String(req.query.orderId || '');
        const adminRequest = isAdmin(req);
        const pendingTrx = db.filter(t => t.status === 'DIPROSES' && !t.is_digital && (adminRequest || (requestedOrderId && t.order_id === requestedOrderId))).slice(-5); 
        if (pendingTrx.length > 0) {
            await Promise.all(pendingTrx.map(async (trx) => {
                try {
                    // Pesanan lama dari supplier yang sudah dihentikan tidak boleh dikirim ke Digiflazz.
                    if (trx.supplier !== 'digiflazz') return;
                    const user = process.env.DIGIFLAZZ_USERNAME;
                    const key = process.env.DIGIFLAZZ_API_KEY;
                    if (!user || !key || !trx.product_code || !trx.order_id) return;
                    const sign = crypto.createHash('md5').update(user + key + trx.order_id).digest('hex');
                    const payload = {
                        username: user,
                        buyer_sku_code: trx.product_code,
                        customer_no: trx.target_id,
                        ref_id: trx.order_id,
                        sign
                    };
                    if (trx.is_pasca) payload.commands = 'pay-pasca';
                    const checkRes = await axios.post('https://api.digiflazz.com/v1/transaction', payload, { timeout: 15000 });
                    const result = checkRes.data?.data;
                    if (!result || !result.status) return;
                    const status = String(result.status).toLowerCase();
                    if (status === 'sukses') {
                        trx.status = 'SUKSES';
                        trx.sn = result.sn || trx.sn;
                        needsSave = true;
                    } else if (status === 'gagal') {
                        trx.status = 'GAGAL';
                        trx.sn = result.message || 'Transaksi gagal';
                        needsSave = true;
                    }
                } catch (err) {
                    console.error('[Digiflazz] Gagal sinkron status transaksi:', err.message);
                }
            }));
            if (needsSave) saveDB(db);
        }
        if (adminRequest) return res.status(200).json(db.reverse());
        if (requestedOrderId) {
            if (!/^TWIDY-\d+-[a-f0-9]{32}$/i.test(requestedOrderId)) return res.status(404).json({ message: 'Transaksi tidak ditemukan.' });
            const found = db.find(t => t.order_id === requestedOrderId);
            return found ? res.status(200).json([found]) : res.status(404).json({ message: 'Transaksi tidak ditemukan.' });
        }
        return res.status(401).json({ message: 'Gunakan Order ID untuk mengecek transaksi.' });
    } catch (e) {
        return res.status(500).json({ message: 'Error Database' });
    }
});

// Endpoint Checkout & Buat Transaksi Midtrans
app.post('/api/checkout', async (req, res) => {
  try {
    const body = req.body || {};
    const { targetId, serverId, isDigital, isPasca, cartItems, quoteToken } = body;
    if (typeof targetId !== 'string' || !targetId.trim() || targetId.length > 100) return res.status(400).json({ message: 'Nomor tujuan atau email tidak valid.' });
    if (String(process.env.CHECKOUT_ENABLED || '').toLowerCase() !== 'true') return res.status(503).json({ message: 'Checkout sementara dinonaktifkan demi keamanan. Hubungi admin.' });
    if (!process.env.MIDTRANS_SERVER_KEY || !process.env.MIDTRANS_CLIENT_KEY) return res.status(503).json({ message: 'Pembayaran sedang dinonaktifkan: konfigurasi Midtrans belum lengkap.' });
    const orderId = `TWIDY-${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;
    const fullTarget = serverId ? `${targetId.trim()}${String(serverId).trim()}` : targetId.trim();
    let amount = 0, originalProductName = '', itemDetails = [], finalProductCode = '', finalSupplier = 'digiflazz', finalCustomNominal = null, finalCartItems = null;
    if (isDigital === true) {
      if (!Array.isArray(cartItems) || cartItems.length < 1 || cartItems.length > 20) return res.status(400).json({ message: 'Keranjang produk digital tidak valid.' });
      const catalog = readDigitalDB();
      const authoritativeItems = [];
      for (const requested of cartItems) {
        const item = catalog.find(p => p.id && String(p.id) === String(requested && requested.id));
        if (!item || !Number.isSafeInteger(Number(item.price)) || Number(item.price) <= 0 || !item.downloadUrl || item.downloadUrl === '#') return res.status(400).json({ message: 'Ada produk digital yang sudah tidak tersedia. Muat ulang halaman dan coba lagi.' });
        authoritativeItems.push({ id: item.id, name: item.name, price: Number(item.price), downloadUrl: item.downloadUrl });
      }
      amount = authoritativeItems.reduce((sum, item) => sum + item.price, 0);
      originalProductName = `Pembelian ${authoritativeItems.length} Produk Digital`;
      finalProductCode = 'DIGI-MULTI'; finalSupplier = 'digital'; finalCartItems = authoritativeItems;
      itemDetails = authoritativeItems.map(item => ({ id: String(item.id).substring(0, 50), price: item.price, quantity: 1, name: String(item.name || 'Produk Digital').replace(/[\[\]]/g, '').substring(0, 50) }));
    } else if (isPasca === true) {
      const quote = pascaQuotes.get(String(quoteToken || ''));
      if (!quote || quote.expiresAt < Date.now() || quote.targetId !== targetId.trim() || quote.sku !== String(body.productCode || '')) return res.status(400).json({ message: 'Kutipan tagihan kedaluwarsa atau tidak cocok. Silakan cek tagihan lagi.' });
      pascaQuotes.delete(String(quoteToken));
      amount = quote.price; originalProductName = 'Pembayaran Tagihan Pascabayar'; finalProductCode = quote.sku; finalSupplier = 'digiflazz';
      itemDetails = [{ id: finalProductCode.substring(0, 50), price: amount, quantity: 1, name: originalProductName }];
    } else {
      const requestedCode = String(body.productCode || '');
      const requestedSupplier = String(body.supplier || 'digiflazz');
      if (!requestedCode || requestedSupplier !== 'digiflazz') return res.status(400).json({ message: 'Produk atau supplier tidak valid.' });
      if (!cachedProducts || Date.now() - cacheTimestamp > CACHE_DURATION) return res.status(503).json({ message: 'Daftar harga sedang diperbarui. Muat ulang halaman sebelum checkout.' });
      const product = cachedProducts.find(p => String(p.buyer_sku_code || '') === requestedCode && String(p.supplier || '') === requestedSupplier && p.buyer_product_status !== false);
      if (!product) return res.status(400).json({ message: 'Produk tidak ditemukan atau supplier tidak cocok. Muat ulang halaman.' });
      if (body.customNominal !== undefined && body.customNominal !== null && body.customNominal !== '') {
        const nominal = Number(body.customNominal);
        if (!String(product.product_name || '').toLowerCase().includes('bebas nominal') || !Number.isSafeInteger(nominal) || nominal < 1000 || nominal > 1000000) return res.status(400).json({ message: 'Nominal bebas tidak valid untuk produk ini.' });
        finalCustomNominal = nominal;
        amount = nominal + Math.max(200, Math.min(500, Math.round(nominal * 0.01)));
      } else amount = Number(product.price);
      if (!Number.isSafeInteger(amount) || amount <= 0) return res.status(400).json({ message: 'Harga produk tidak valid.' });
      originalProductName = `${product.brand ? product.brand + ' - ' : ''}${product.product_name || 'Produk'}`.substring(0, 120);
      finalProductCode = requestedCode; finalSupplier = requestedSupplier;
      itemDetails = [{ id: requestedCode.substring(0, 50), price: amount, quantity: 1, name: originalProductName.replace(/[\[\]]/g, '').substring(0, 50) }];
    }
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100000000) return res.status(400).json({ message: 'Total pembayaran tidak valid.' });
    const parameter = {
      transaction_details: { order_id: orderId, gross_amount: amount },
      item_details: itemDetails,
      customer_details: { first_name: 'Pelanggan', last_name: 'TwidyShop', email: isDigital ? targetId.trim() : 'customer@twidyshop.my.id' }
    };
    const transaction = await snap.createTransaction(parameter);
    const db = readDB();
    db.push({
      order_id: orderId, target_id: fullTarget, product_code: finalProductCode, product_name: originalProductName,
      amount, status: 'UNPAID', supplier: finalSupplier, custom_nominal: finalCustomNominal,
      sn: isDigital ? 'Menunggu Pembayaran (tautan hanya tersedia setelah lunas).' : '-',
      is_digital: isDigital === true, is_pasca: isPasca === true, download_url: '', cart_items: finalCartItems,
      created_at: new Date().toISOString()
    });
    saveDB(db);
    return res.json({ token: transaction.token, orderId });
  } catch (error) {
    console.error('[Checkout] Gagal membuat transaksi Midtrans:', error.message);
    return res.status(500).json({ error: 'Gagal membuat pembayaran. Silakan coba lagi.' });
  }
});

// Webhook Midtrans - Eksekusi ke Supplier API
app.post('/api/webhook', async (req, res) => {
  try {
    const notif = req.body;
    if (!verifyMidtransNotification(notif)) {
      console.warn('[Midtrans Webhook] Ditolak: signature tidak valid atau konfigurasi key kosong.');
      return res.status(401).send('Invalid notification signature');
    }
    const { transaction_status, order_id } = notif;
    let db = readDB();
    let trx = db.find(t => t.order_id === order_id);
    if (!trx) return res.status(200).send('OK');
    const paidAmount = Number(notif.gross_amount);
    const paidEvent = transaction_status === 'settlement' || transaction_status === 'capture';
    if (!Number.isFinite(paidAmount) || Math.round(paidAmount) !== Number(trx.amount) ||
        (paidEvent && String(notif.status_code) !== '200') ||
        (notif.currency && String(notif.currency).toUpperCase() !== 'IDR') ||
        (paidEvent && notif.fraud_status && String(notif.fraud_status).toLowerCase() !== 'accept')) {
      console.warn('[Midtrans Webhook] Ditolak: amount/status/currency/fraud tidak cocok untuk', order_id);
      return res.status(400).send('Transaction verification failed');
    }
    if (transaction_status === 'settlement' || transaction_status === 'capture') {
        if (['SUKSES', 'DIPROSES', 'GAGAL'].includes(trx.status)) return res.status(200).send("OK");
        
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

        // Pesanan lama dari supplier non-Digiflazz perlu pemeriksaan admin, jangan kirim SKU asing ke supplier.
        if (trx.supplier !== 'digiflazz') {
            trx.status = 'DIPROSES';
            trx.sn = 'Pembayaran terkonfirmasi; pesanan lama dari supplier yang sudah dihentikan perlu pemeriksaan admin.';
            saveDB(db);
            return res.status(200).send('OK');
        }

        trx.status = 'DIPROSES';
        saveDB(db);

        // Semua topup dan PPOB diproses melalui Digiflazz saja.
        const user = process.env.DIGIFLAZZ_USERNAME;
        const key = process.env.DIGIFLAZZ_API_KEY;
        if (!user || !key) {
            trx.status = 'DIPROSES';
            trx.sn = 'Konfigurasi Digiflazz belum tersedia; transaksi perlu diperiksa admin.';
            saveDB(db);
            return res.status(503).send('Supplier configuration unavailable');
        }
        const sign = crypto.createHash('md5').update(user + key + order_id).digest('hex');
        const payload = {
            username: user,
            buyer_sku_code: trx.product_code,
            customer_no: trx.target_id,
            ref_id: order_id,
            sign,
            testing: false
        };
        if (trx.is_pasca) payload.commands = 'pay-pasca';
        try {
            const digiRes = await axios.post('https://api.digiflazz.com/v1/transaction', payload, { timeout: 20000 });
            const result = digiRes.data?.data || {};
            const status = String(result.status || '').toLowerCase();
            if (status === 'sukses') trx.status = 'SUKSES';
            else if (status === 'gagal') trx.status = 'GAGAL';
            else trx.status = 'DIPROSES';
            const resultSn = result.sn || result.message;
            trx.sn = (resultSn && String(resultSn).trim() !== '') ? resultSn : 'Diproses (Menunggu Pembaruan)';
            saveDB(db);
        } catch (err) {
            console.error('[Digiflazz] Eksekusi transaksi gagal dihubungi:', err.message);
            // Jangan tandai gagal: supplier mungkin sudah menerima transaksi.
            trx.status = 'DIPROSES';
            trx.sn = 'Status belum terkonfirmasi; sistem akan melakukan pengecekan ulang.';
            saveDB(db);
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
    if (!payload || !payload.data || !payload.data.ref_id) return res.status(200).send("OK");

    if (!process.env.DIGIFLAZZ_WEBHOOK_SECRET || !constantTimeEqual(req.get('x-webhook-secret'), process.env.DIGIFLAZZ_WEBHOOK_SECRET)) return res.status(401).send('Webhook authentication required');
    const { ref_id, status, sn, message } = payload.data;
    let db = readDB();
    let trx = db.find(t => t.order_id === ref_id);
    if (!trx) return res.status(200).send("OK");

    const cStatus = (status || '').toLowerCase();
    if (cStatus === 'sukses') trx.status = 'SUKSES';
    else if (cStatus === 'gagal') trx.status = 'GAGAL';
    else trx.status = 'DIPROSES';
    
    const currentSn = sn || message;
    if (currentSn && currentSn.trim() !== '') trx.sn = currentSn;
    else if (trx.status === 'SUKSES') trx.sn = 'Transaksi Berhasil';
    
    saveDB(db);
    return res.status(200).send("OK");
  } catch (error) {
    return res.status(500).send("Error");
  }
});

// ROUTING SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server Twidy Shop berjalan di port ${PORT}`));
