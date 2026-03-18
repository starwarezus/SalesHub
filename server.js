const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Config ───────────────────────────────────────────────────────────────────
const SC_SERVER    = process.env.SC_SERVER    || 'blny.api.sellercloud.com';
const SC_USER      = process.env.SC_USER      || 'henry@goldlabelny.com';
const SC_PASS      = process.env.SC_PASS      || 'Corishabt1987!!';
const PORT         = process.env.PORT         || 3000;
const RESEND_KEY   = process.env.RESEND_KEY   || '';
const REPORT_EMAIL = (process.env.REPORT_EMAIL || 'henry@goldlabelny.com').toLowerCase();
const APP_URL      = (process.env.APP_URL || 'https://ocrscanner-production.up.railway.app').replace(/\/+$/, '');

// ─── Token store ──────────────────────────────────────────────────────────────
let tokenStore = { value: null, expiresAt: null, refreshing: false };

async function fetchNewToken() {
  const res = await fetch(`https://${SC_SERVER}/rest/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: SC_USER, Password: SC_PASS })
  });
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
  const data = await res.json();
  const token = data.access_token || data.AccessToken || data.token || data.Token;
  if (!token) throw new Error('No token in response');
  return token;
}

async function getToken() {
  const now = Date.now();
  if (tokenStore.value && tokenStore.expiresAt && now < tokenStore.expiresAt) return tokenStore.value;
  if (tokenStore.refreshing) { await new Promise(r => setTimeout(r, 800)); return tokenStore.value; }
  tokenStore.refreshing = true;
  try {
    tokenStore.value = await fetchNewToken();
    tokenStore.expiresAt = now + 55 * 60 * 1000;
    console.log(`[${new Date().toISOString()}] Token refreshed`);
    return tokenStore.value;
  } finally { tokenStore.refreshing = false; }
}

getToken().catch(e => console.error('Startup token failed:', e.message));
setInterval(async () => {
  try { tokenStore.value = await fetchNewToken(); tokenStore.expiresAt = Date.now() + 55*60*1000; console.log(`[${new Date().toISOString()}] Token auto-refreshed`); }
  catch(e) { console.error('Auto refresh failed:', e.message); }
}, 55 * 60 * 1000);

// ─── SC helpers ───────────────────────────────────────────────────────────────
function scDateStr(d) {
  const [y,m,day] = d.toISOString().slice(0,10).split('-');
  return `${y}/${m}/${day}`;
}

async function fetchOrdersForRange(from, to) {
  const token = await getToken();
  let pageNum = 1, allItems = [], totalResults = null;
  while (true) {
    const url = new URL(`https://${SC_SERVER}/rest/api/Orders`);
    url.searchParams.set('pageSize', 50);
    url.searchParams.set('pageNumber', pageNum);
    url.searchParams.set('model.createdOnFrom', from);
    url.searchParams.set('model.createdOnTo', to);
    const r = await fetch(url.toString(), { headers: { 'Authorization': `Bearer ${token}` } });
    if (!r.ok) throw new Error(`SC error ${r.status}`);
    const data = await r.json();
    const items = data.Items || [];
    if (totalResults === null) totalResults = data.TotalResults || 0;
    allItems = allItems.concat(items);
    if (items.length === 0 || allItems.length >= totalResults) break;
    pageNum++;
  }
  return allItems;
}

function isInProcess(o) {
  const ss = o.ShippingStatus, sc = o.StatusCode;
  if (sc === -1 || sc === 7) return false; // cancelled/void
  if (ss === 3) return false;              // fully shipped
  if (sc === 3 && o.ShipDate) return false; // completed
  return true;                             // in process
}

function isINum(sku) { return sku && /^i\d+$/i.test(sku.trim()); }

function getUnpickedItems(orders, inumFilterOnly = true) {
  const rows = [];
  orders.forEach(o => {
    if (!isInProcess(o)) return;
    (o.Items || []).forEach(it => {
      if ((it.Qty || 0) > (it.QtyPicked || 0)) {
        // By default only include i-number SKUs in email/report
        if (inumFilterOnly && !isINum(it.ProductID) && !isINum(it.InventoryKey)) return;
        rows.push({ order: o, item: it });
      }
    });
  });
  rows.sort((a, b) => {
    const wa = (a.item.ShipFromWarehouseName || '').toLowerCase();
    const wb = (b.item.ShipFromWarehouseName || '').toLowerCase();
    if (wa < wb) return -1; if (wa > wb) return 1;
    return (a.order.CompanyName || '').localeCompare(b.order.CompanyName || '');
  });
  return rows;
}

// ─── Image cache ──────────────────────────────────────────────────────────────
const imageCache = {};

async function fetchImageUrls(skus) {
  const token = await getToken();
  const toFetch = skus.filter(s => imageCache[s] === undefined);
  const chunks = [];
  for (let i = 0; i < toFetch.length; i += 10) chunks.push(toFetch.slice(i, i+10));
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async sku => {
      try {
        const r = await fetch(`https://${SC_SERVER}/rest/api/ProductImage/${encodeURIComponent(sku)}`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!r.ok) { imageCache[sku] = ''; return; }
        const imgs = await r.json();
        const def = (imgs || []).find(i => i.IsDefault) || (imgs || [])[0];
        imageCache[sku] = def ? (def.Url || '') : '';
        if (imageCache[sku]) console.log(`[IMG] ${sku} -> ${imageCache[sku].slice(0,80)}`);
      } catch(e) { imageCache[sku] = ''; }
    }));
  }
  const result = {};
  skus.forEach(s => { result[s] = imageCache[s] || ''; });
  return result;
}

// ─── Email via Resend ─────────────────────────────────────────────────────────
async function sendEmail(subject, html) {
  if (!RESEND_KEY) { console.log('[EMAIL] No RESEND_KEY set, skipping email'); return; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Sales Hub <onboarding@resend.dev>',
        to: [REPORT_EMAIL],
        subject,
        html
      })
    });
    const d = await r.json();
    if (!r.ok) console.error('[EMAIL] Send failed:', JSON.stringify(d));
    else console.log('[EMAIL] Sent:', subject);
  } catch(e) { console.error('[EMAIL] Error:', e.message); }
}

async function fetchImageAsBase64(imgUrl) {
  try {
    const token = await getToken();
    const r = await fetch(imgUrl, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!r.ok) return '';
    const buf = await r.buffer();
    const ct = r.headers.get('content-type') || 'image/jpeg';
    return 'data:' + ct + ';base64,' + buf.toString('base64');
  } catch(e) { return ''; }
}

async function buildEmailHtml(rows, generatedAt) {
  // Pre-fetch images as base64 for email embedding
  const skus = [...new Set(rows.map(r => r.item.ProductID || r.item.InventoryKey || '').filter(Boolean))];
  const imgMap = {};
  if (skus.length) {
    // First ensure image URLs are in cache
    await fetchImageUrls(skus);
    // Then convert to base64 for email embedding
    await Promise.all(skus.map(async sku => {
      const url = imageCache[sku];
      if (url) {
        const b64 = await fetchImageAsBase64(url);
        imgMap[sku] = b64;
        if (b64) console.log(`[EMAIL IMG] ${sku} embedded (${Math.round(b64.length/1024)}kb)`);
        else console.log(`[EMAIL IMG] ${sku} failed to embed`);
      } else {
        console.log(`[EMAIL IMG] ${sku} no URL in cache`);
      }
    }));
  }
  const orderIds = new Set(rows.map(r => r.order.OrderSourceOrderID || r.order.ID));
  const byWarehouse = {};
  rows.forEach(r => {
    const wh = r.item.ShipFromWarehouseName || 'Unknown';
    if (!byWarehouse[wh]) byWarehouse[wh] = [];
    byWarehouse[wh].push(r);
  });

  let warehouseSections = '';
  Object.entries(byWarehouse).forEach(([wh, items]) => {
    const itemRows = items.map(r => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2f3a;font-family:monospace;font-size:12px;color:#8b9099">${r.order.CompanyName || '—'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2f3a;font-family:monospace;font-size:12px"><a href="${APP_URL}/unpicked" style="color:#4f8ef7">${r.order.OrderSourceOrderID || r.order.ID}</a></td>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2f3a;font-size:12px">
          ${imgMap[r.item.ProductID||r.item.InventoryKey||''] ? '<img src="' + imgMap[r.item.ProductID||r.item.InventoryKey||''] + '" style="width:32px;height:32px;border-radius:4px;object-fit:cover;vertical-align:middle;margin-right:8px"/>' : ''}${r.item.ProductName || r.item.DisplayName || r.item.ProductID || '—'}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2f3a;font-family:monospace;font-size:12px;text-align:center">${r.item.Qty || 0}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2f3a;font-family:monospace;font-size:12px;text-align:center">${r.item.QtyPicked || 0}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2f3a;font-family:monospace;font-size:12px;text-align:center;color:#f6ad55;font-weight:600">${(r.item.Qty||0)-(r.item.QtyPicked||0)}</td>
      </tr>`).join('');
    warehouseSections += `
      <tr><td colspan="6" style="padding:12px 12px 6px;background:#1a1e25;font-family:monospace;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#555c66">${wh} — ${items.length} items</td></tr>
      ${itemRows}`;
  });

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0d0f12;font-family:'IBM Plex Sans',sans-serif;color:#e8eaed">
  <div style="max-width:700px;margin:0 auto;padding:32px 16px">
    <div style="margin-bottom:24px">
      <div style="font-family:monospace;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#8b9099">Gold Label NY</div>
      <div style="font-size:22px;font-weight:500;margin:4px 0">Unpicked Items Report</div>
      <div style="font-family:monospace;font-size:11px;color:#555c66">${generatedAt} · <a href="${APP_URL}/unpicked" style="color:#4f8ef7">View live report →</a></div>
    </div>
    <div style="display:flex;gap:16px;margin-bottom:24px">
      <div style="background:#13161b;border:1px solid #1a1e25;border-radius:8px;padding:14px 20px">
        <div style="font-family:monospace;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#555c66;margin-bottom:4px">Unpicked Items</div>
        <div style="font-family:monospace;font-size:24px;font-weight:500;color:#4f8ef7">${rows.length}</div>
      </div>
      <div style="background:#13161b;border:1px solid #1a1e25;border-radius:8px;padding:14px 20px">
        <div style="font-family:monospace;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#555c66;margin-bottom:4px">Orders Affected</div>
        <div style="font-family:monospace;font-size:24px;font-weight:500;color:#f6ad55">${orderIds.size}</div>
      </div>
    </div>
    <table style="width:100%;border-collapse:collapse;background:#13161b;border-radius:8px;overflow:hidden;border:1px solid #1a1e25">
      <thead>
        <tr style="background:#1a1e25">
          <th style="padding:10px 12px;text-align:left;font-family:monospace;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#555c66;border-bottom:1px solid #21262f">Company</th>
          <th style="padding:10px 12px;text-align:left;font-family:monospace;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#555c66;border-bottom:1px solid #21262f">Order ID</th>
          <th style="padding:10px 12px;text-align:left;font-family:monospace;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#555c66;border-bottom:1px solid #21262f">Item</th>
          <th style="padding:10px 12px;text-align:center;font-family:monospace;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#555c66;border-bottom:1px solid #21262f">Qty</th>
          <th style="padding:10px 12px;text-align:center;font-family:monospace;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#555c66;border-bottom:1px solid #21262f">Picked</th>
          <th style="padding:10px 12px;text-align:center;font-family:monospace;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#555c66;border-bottom:1px solid #21262f">Remaining</th>
        </tr>
      </thead>
      <tbody>${warehouseSections}</tbody>
    </table>
    <div style="margin-top:20px;font-family:monospace;font-size:11px;color:#555c66;text-align:center">
      <a href="${APP_URL}/unpicked" style="color:#4f8ef7">Open live report</a> · Updates every 15 minutes
    </div>
  </div></body></html>`;
}

// ─── Scheduled email job ──────────────────────────────────────────────────────
// Runs every minute, fires at 9:30 AM and 4:00 PM Eastern
function getEasternHourMinute() {
  const now = new Date();
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { h: eastern.getHours(), m: eastern.getMinutes() };
}

let lastEmailSent = { h: -1, m: -1 };

setInterval(async () => {
  const { h, m } = getEasternHourMinute();
  const isScheduledTime = (h === 9 && m === 30) || (h === 16 && m === 0);
  const alreadySent = lastEmailSent.h === h && lastEmailSent.m === m;
  if (!isScheduledTime || alreadySent) return;

  lastEmailSent = { h, m };
  console.log(`[CRON] Sending unpicked report at ${h}:${String(m).padStart(2,'0')} ET`);

  try {
    const toD = new Date();
    const fromD = new Date(); fromD.setDate(fromD.getDate() - 6);
    const orders = await fetchOrdersForRange(scDateStr(fromD), scDateStr(toD));
    const rows = getUnpickedItems(orders);
    const timeLabel = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' });
    const html = await buildEmailHtml(rows, timeLabel);
    const subject = `Unpicked Items — ${rows.length} items across ${new Set(rows.map(r => r.order.OrderSourceOrderID||r.order.ID)).size} orders`;
    await sendEmail(subject, html);
  } catch(e) {
    console.error('[CRON] Report failed:', e.message);
  }
}, 60 * 1000);

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    tokenValid: !!(tokenStore.value && tokenStore.expiresAt && Date.now() < tokenStore.expiresAt),
    tokenExpiresAt: tokenStore.expiresAt ? new Date(tokenStore.expiresAt).toISOString() : null
  });
});

// Orders endpoint
app.get('/api/orders/day', async (req, res) => {
  const { date, dateTo } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  try {
    const [y,m,d] = date.split('-');
    const from = `${y}/${m}/${d}`;
    let to = from;
    if (dateTo) { const [y2,m2,d2] = dateTo.split('-'); to = `${y2}/${m2}/${d2}`; }
    const orders = await fetchOrdersForRange(from, to);
    res.json({ date, count: orders.length, total: orders.length, orders });
  } catch(e) {
    console.error('Order fetch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Unpicked in-process items for last N days (default 7)
app.get('/api/unpicked/today', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '7', 10);
    const toDate   = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - (days - 1));
    const from = scDateStr(fromDate);
    const to   = scDateStr(toDate);
    console.log(`[UNPICKED] Fetching ${days} days: ${from} -> ${to}`);
    const orders = await fetchOrdersForRange(from, to);
    console.log(`[UNPICKED] ${orders.length} orders fetched, filtering unpicked in-process...`);
    const rows = getUnpickedItems(orders, false); // frontend handles i# filter
    console.log(`[UNPICKED] ${rows.length} unpicked items found`);
    res.json({
      generatedAt: new Date().toISOString(),
      dateRange: { from, to },
      count: rows.length,
      orderCount: new Set(rows.map(r => r.order.OrderSourceOrderID || r.order.ID)).size,
      items: rows.map(r => ({
        companyName: r.order.CompanyName || '—',
        orderSourceOrderID: r.order.OrderSourceOrderID || String(r.order.ID),
        orderID: r.order.ID,
        productID: r.item.ProductID || r.item.InventoryKey || '',
        productName: r.item.ProductName || r.item.DisplayName || '—',
        qty: r.item.Qty || 0,
        qtyPicked: r.item.QtyPicked || 0,
        remaining: (r.item.Qty || 0) - (r.item.QtyPicked || 0),
        warehouse: r.item.ShipFromWarehouseName || '—',
        orderDate: r.order.TimeOfOrder || null
      }))
    });
  } catch(e) {
    console.error('[UNPICKED] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Images endpoint
app.get('/api/images', async (req, res) => {
  const { skus } = req.query;
  if (!skus) return res.json({});
  const skuList = skus.split(',').map(s => s.trim()).filter(Boolean);
  try {
    const result = await fetchImageUrls(skuList);
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Image proxy
app.get('/api/image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('missing url');
  try {
    const token = await getToken();
    const imgRes = await fetch(decodeURIComponent(url), { headers: { 'Authorization': 'Bearer ' + token } });
    if (!imgRes.ok) return res.status(imgRes.status).send('image fetch failed');
    res.setHeader('Content-Type', imgRes.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    imgRes.body.pipe(res);
  } catch(e) { res.status(500).send('proxy error: ' + e.message); }
});

// Manual email trigger (for testing)
app.get('/api/send-report', async (req, res) => {
  try {
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 6);
    const orders = await fetchOrdersForRange(scDateStr(fromDate), scDateStr(toDate));
    const rows = getUnpickedItems(orders);
    const timeLabel = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' });
    const html = await buildEmailHtml(rows, timeLabel);
    const subject = `[TEST] Unpicked Items — ${rows.length} items`;
    await sendEmail(subject, html);
    res.json({ ok: true, itemCount: rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Live unpicked page — must be before catch-all
app.get('/unpicked', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'unpicked.html'));
});

// Catch-all → main app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Sales Hub running on port ${PORT}`);
  console.log(`SellerCloud server: ${SC_SERVER}`);
  console.log(`Report email: ${REPORT_EMAIL}`);
  console.log(`App URL: ${APP_URL}`);
});
