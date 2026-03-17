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
// GET /api/orders/day?date=2025-03-10
app.get('/api/orders/day', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date param required (YYYY-MM-DD)' });

  try {
    const token = await getToken();

    // Build date range: full day — format required by SC: yyyy/MM/dd
    const [y, m, d] = date.split('-');
    const from = `${y}/${m}/${d}`;
    const to   = `${y}/${m}/${d}`;

    let pageNum = 1;
    const pageSize = 50;
    let allItems = [];
    let totalResults = null;

    while (true) {
      const url = new URL(`https://${SC_SERVER}/rest/api/Orders`);
      url.searchParams.set('pageSize', pageSize);
      url.searchParams.set('pageNumber', pageNum);
      url.searchParams.set('model.OrderFromDate', from);
      url.searchParams.set('model.OrderToDate', to);

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

    // Debug: log actual StatusCode + ShippingStatus combos from real orders
    const uniqueStatuses = [...new Set(allItems.map(o => `SC:${o.StatusCode} SS:${o.ShippingStatus}`))]
    console.log(`[${date}] Statuses seen: ${uniqueStatuses.join(', ')}`);

    res.json({ date, count: allItems.length, total: totalResults, orders: allItems });

  } catch (e) {
    console.error('Order fetch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Serve frontend ───────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Sales Hub running on port ${PORT}`);
  console.log(`SellerCloud server: ${SC_SERVER}`);
});
