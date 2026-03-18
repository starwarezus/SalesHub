const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Config ───────────────────────────────────────────────────────────────────
const SC_SERVER = process.env.SC_SERVER || 'blny.api.sellercloud.com';
const SC_USER   = process.env.SC_USER   || 'henry@goldlabelny.com';
const SC_PASS   = process.env.SC_PASS   || 'Corishabt1987!!';
const PORT      = process.env.PORT      || 3000;

// ─── Token store ──────────────────────────────────────────────────────────────
let tokenStore = {
  value: null,
  expiresAt: null,
  refreshing: false
};

async function fetchNewToken() {
  const url = `https://${SC_SERVER}/rest/api/token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: SC_USER, Password: SC_PASS })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token fetch failed: ${res.status} ${text.slice(0, 120)}`);
  }
  const data = await res.json();
  const token = data.access_token || data.AccessToken || data.token || data.Token;
  if (!token) throw new Error('No token in SellerCloud response');
  return token;
}

async function getToken() {
  const now = Date.now();
  if (tokenStore.value && tokenStore.expiresAt && now < tokenStore.expiresAt) {
    return tokenStore.value;
  }
  if (tokenStore.refreshing) {
    // Wait for ongoing refresh
    await new Promise(r => setTimeout(r, 800));
    return tokenStore.value;
  }
  tokenStore.refreshing = true;
  try {
    const token = await fetchNewToken();
    tokenStore.value = token;
    tokenStore.expiresAt = now + 55 * 60 * 1000; // 55 min
    console.log(`[${new Date().toISOString()}] Token refreshed, valid until ${new Date(tokenStore.expiresAt).toISOString()}`);
    return token;
  } finally {
    tokenStore.refreshing = false;
  }
}

// Pre-fetch token on startup
getToken().catch(e => console.error('Startup token fetch failed:', e.message));

// Auto-refresh every 55 minutes
setInterval(async () => {
  try {
    const token = await fetchNewToken();
    tokenStore.value = token;
    tokenStore.expiresAt = Date.now() + 55 * 60 * 1000;
    console.log(`[${new Date().toISOString()}] Token auto-refreshed`);
  } catch (e) {
    console.error('Auto token refresh failed:', e.message);
  }
}, 55 * 60 * 1000);

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    tokenValid: !!(tokenStore.value && tokenStore.expiresAt && Date.now() < tokenStore.expiresAt),
    tokenExpiresAt: tokenStore.expiresAt ? new Date(tokenStore.expiresAt).toISOString() : null
  });
});

// Fetch orders for a single date — called per-day by the frontend
// GET /api/orders/day?date=2025-03-10&dateTo=2025-03-17 (dateTo optional, defaults to date)
app.get('/api/orders/day', async (req, res) => {
  const { date, dateTo } = req.query;
  if (!date) return res.status(400).json({ error: 'date param required (YYYY-MM-DD)' });

  try {
    const token = await getToken();

    const [y, m, d] = date.split('-');
    const from = `${y}/${m}/${d}`;
    let to = from;
    if (dateTo) {
      const [y2, m2, d2] = dateTo.split('-');
      to = `${y2}/${m2}/${d2}`;
    }

    let pageNum = 1;
    const pageSize = 50;
    let allItems = [];
    let totalResults = null;

    while (true) {
      const url = new URL(`https://${SC_SERVER}/rest/api/Orders`);
      url.searchParams.set('pageSize', pageSize);
      url.searchParams.set('pageNumber', pageNum);
      url.searchParams.set('model.createdOnFrom', from);
      url.searchParams.set('model.createdOnTo', to);

      const scRes = await fetch(url.toString(), {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!scRes.ok) {
        const txt = await scRes.text().catch(() => '');
        return res.status(scRes.status).json({ error: `SellerCloud error: ${scRes.status}`, detail: txt.slice(0, 200) });
      }

      const data = await scRes.json();
      const items = data.Items || [];
      if (totalResults === null) totalResults = data.TotalResults || 0;

      allItems = allItems.concat(items);

      if (items.length === 0 || allItems.length >= totalResults) break;
      pageNum++;
    }

    // Debug: log sample image URLs to diagnose auth issues
    const sampleImgs = allItems.flatMap(o => (o.Items||[]).map(it => it.ImageURL)).filter(Boolean).slice(0,3);
    if(sampleImgs.length) console.log(`[IMG SAMPLES] ${sampleImgs.join(' | ')}`);

    res.json({ date, count: allItems.length, total: totalResults, orders: allItems });

  } catch (e) {
    console.error('Order fetch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// In-memory image URL cache: SKU -> URL string
const imageCache = {};

// GET /api/images?skus=i123,i456,i789
// Fetches default image URL for each SKU from SC ProductImage API
app.get('/api/images', async (req, res) => {
  const { skus } = req.query;
  if (!skus) return res.json({});
  const skuList = skus.split(',').map(s => s.trim()).filter(Boolean);
  const result = {};
  // Return cached ones immediately
  const toFetch = skuList.filter(sku => {
    if (imageCache[sku] !== undefined) { result[sku] = imageCache[sku]; return false; }
    return true;
  });
  if (!toFetch.length) return res.json(result);
  try {
    const token = await getToken();
    // Fetch in parallel, max 10 at a time
    const chunks = [];
    for (let i = 0; i < toFetch.length; i += 10) chunks.push(toFetch.slice(i, i + 10));
    for (const chunk of chunks) {
      await Promise.all(chunk.map(async sku => {
        try {
          const url = `https://${SC_SERVER}/rest/api/ProductImage/${encodeURIComponent(sku)}`;
          const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
          if (!r.ok) { imageCache[sku] = ''; result[sku] = ''; return; }
          const imgs = await r.json();
          const def = (imgs || []).find(i => i.IsDefault) || imgs[0];
          const imgUrl = def ? (def.Url || '') : '';
          imageCache[sku] = imgUrl;
          result[sku] = imgUrl;
          if (imgUrl) console.log(`[IMG] ${sku} -> ${imgUrl.slice(0, 80)}`);
        } catch(e) { imageCache[sku] = ''; result[sku] = ''; }
      }));
    }
  } catch(e) { console.error('Image fetch error:', e.message); }
  res.json(result);
});

// Image proxy — fetches SC images server-side with auth token
app.get('/api/image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('missing url');
  try {
    const token = await getToken();
    const imgRes = await fetch(decodeURIComponent(url), {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!imgRes.ok) return res.status(imgRes.status).send('image fetch failed');
    const ct = imgRes.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    imgRes.body.pipe(res);
  } catch(e) {
    res.status(500).send('proxy error: ' + e.message);
  }
});

// Serve frontend───────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Sales Hub running on port ${PORT}`);
  console.log(`SellerCloud server: ${SC_SERVER}`);
});
