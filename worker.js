/* ============================================================================
   Venue dashboard - Worker shell (ships in the FC Member Dashboard Kit)

   You are the AI running this build. This file is YOURS to finish; the owner
   never sees it. The shell already does the hard plumbing:

     - serves the dashboard page
     - a metrics API with a fixed contract the page already understands
     - an OAuth2 begin/callback flow with token storage
     - automatic access-token refresh, INCLUDING rotating refresh tokens
       (Xero rotates the refresh token on every refresh - the store persists
       the new one every time; never cache tokens outside the store)
     - plain-English connection status for the Connections screen
     - the no-API rungs built in: POST /api/ingest (file/export data in),
       an email() handler stub for emailed reports, a scheduled() cron hook,
       and a KV day-store the export-fed adapters read from

   What you fill in: the three ADAPTERS (accounting / pos / rostering), each
   marked with  >>> ADAPTER ...  blocks. Wire them against the provider's
   CURRENT documentation, per capability-matrix.md and playbook.md.

   Rules that bind every adapter (kpi-spec.md is the law):
     - accounting supplies EVERY money figure, always ex GST/sales tax
     - pos supplies ONE number: completed transaction count (no voids/refunds)
     - rostering supplies rostered cost only (projected wage %)
     - read-only scopes/permissions everywhere
     - secrets ONLY via Worker secrets (wrangler secret put NAME) - never in
       this file, never in the repo, never echoed to the owner

   Bindings expected (wrangler.toml): TOKENS (KV). Secrets: see each adapter.
============================================================================ */

import dashboardHtml from './dashboard.html';

/* ----------------------------------------------------------------------------
   Provider adapters - THE PART YOU BUILD.
   Flip `configured: true` per source as you wire it. Until then the
   dashboard honestly shows "not configured" (never a fake zero).
---------------------------------------------------------------------------- */
/* OPTIONAL no-API hooks any adapter may add (the fallback-ladder rungs):
     mode: 'export'           - source is fed by exports, not a live API
     parseExport(env, h, raw) - raw = { text, contentType }: parse the tool's
                                exported CSV/report into day rows:
                                  pos:        [{ date:'YYYY-MM-DD', count }]
                                  accounting: [{ date, revenue, cogs, wagesSuper, overheads }]
                                  rostering:  [{ date, cost }]
                                Adding parseExport makes the dashboard's
                                Connections screen offer a file-upload panel
                                for this source (the guided-upload rung).
     scheduledPull(env, h)    - cron hook (uncomment [triggers] in
                                wrangler.toml): fetch the tool's own export
                                (its report scheduler's output, a saved export
                                URL) and h.saveIngestedRows(rows).
   In export mode, implement fetchRange/fetchMonthly via h.readIngested /
   h.monthlyIngested instead of provider calls. Emailed reports: complete the
   email() handler at the bottom (needs the owner's domain on their Cloudflare
   with Email Routing pointed at this Worker). Ingest auth: the INGEST_TOKEN
   secret; if the owner uploads by hand, that same value is their upload code. */
const ADAPTERS = {

  /* >>> ADAPTER 1: ACCOUNTING - Xero, live OAuth
     Scopes: offline_access accounting.reports.profitandloss.read
     Secrets: ACCOUNTING_CLIENT_ID, ACCOUNTING_CLIENT_SECRET (set in Cloudflare)
     Callback: https://dash-cakes-dashboard.glenn-9fb.workers.dev/auth/accounting/callback
  */
  accounting: {
    configured: true,
    auth: 'oauth',
    oauth: {
      authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
      tokenUrl: 'https://identity.xero.com/connect/token',
      scopes: 'openid profile email offline_access accounting.reports.profitandloss.read',
      clientIdSecret: 'ACCOUNTING_CLIENT_ID',
      clientSecretSecret: 'ACCOUNTING_CLIENT_SECRET',
      tokenAuth: 'basic'
    },

    async status(env, h) {
      try {
        const tokens = await h.getTokens();
        if (!tokens || !tokens.access_token) return { connected: false };
        const data = await h.fetchJson('https://api.xero.com/connections', {
          headers: { 'Accept': 'application/json' }
        });
        if (!Array.isArray(data) || !data.length) return { connected: false };
        const org = data.map(c => c.tenantName || '').join(' + ');
        const sandbox = data.some(c => (c.tenantName||'').toLowerCase().includes('demo company'));
        return {
          connected: true,
          org,
          sandbox,
          lastSync: tokens.lastSync || null
        };
      } catch (e) {
        if (e.status === 401) return { connected: false };
        return { connected: false, error: e.message };
      }
    },

    async fetchRange(env, h, q) {
      const tenants = await _xeroTenantsWithNames(env, h);
      const params = new URLSearchParams({ fromDate: q.from, toDate: q.to, periods: '1', timeframe: 'MONTH', standardLayout: 'true' });
      const results = await Promise.all(tenants.map(t =>
        h.fetchJson('https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?' + params.toString(),
          { headers: { 'Xero-Tenant-Id': t.id, 'Accept': 'application/json' } }
        ).then(data => ({ ...(_parseXeroPL(data, 1)[0]), _name: t.name }))
      ));
      await h.noteSync();
      const locs = { albury: { revenue:0,cogs:0,wagesSuper:0,overheads:0 }, wodonga: { revenue:0,cogs:0,wagesSuper:0,overheads:0 } };
      const combined = { revenue:0, cogs:0, wagesSuper:0, overheads:0 };
      for (const r of results) {
        const loc = r._name && r._name.toLowerCase().includes('wodonga') ? 'wodonga' : 'albury';
        for (const k of ['revenue','cogs','wagesSuper','overheads']) {
          locs[loc][k] += r[k] || 0;
          combined[k] += r[k] || 0;
        }
      }
      return { ...combined, locations: locs };
    },

    async fetchMonthly(env, h, q) {
      const tenants = await _xeroTenantsWithNames(env, h);
      const months = _monthRange(q.from, q.to);
      const zero = () => Array(months.length).fill(0);
      const combined = { months, revenue: zero(), cogs: zero(), wagesSuper: zero(), overheads: zero() };
      const locs = {
        albury:  { revenue: zero(), cogs: zero(), wagesSuper: zero(), overheads: zero() },
        wodonga: { revenue: zero(), cogs: zero(), wagesSuper: zero(), overheads: zero() }
      };
      for (const t of tenants) {
        const loc = t.name && t.name.toLowerCase().includes('wodonga') ? 'wodonga' : 'albury';
        for (let i = 0; i < months.length; i += 12) {
          const batch = months.slice(i, i + 12);
          const fromDate = batch[0] + '-01';
          const lastMonth = batch[batch.length - 1];
          const toDate = lastMonth + '-' + new Date(+lastMonth.slice(0,4), +lastMonth.slice(5,7), 0).getDate();
          const params = new URLSearchParams({ fromDate, toDate, periods: String(batch.length), timeframe: 'MONTH', standardLayout: 'true' });
          const data = await h.fetchJson(
            'https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?' + params.toString(),
            { headers: { 'Xero-Tenant-Id': t.id, 'Accept': 'application/json' } }
          );
          const parsed = _parseXeroPL(data, batch.length);
          for (let j = 0; j < batch.length; j++) {
            for (const k of ['revenue','cogs','wagesSuper','overheads']) {
              const v = parsed[j] ? (parsed[j][k]||0) : 0;
              combined[k][i+j] += v;
              locs[loc][k][i+j] += v;
            }
          }
        }
      }
      await h.noteSync();
      return { ...combined, locations: locs };
    }
  },

  /* >>> ADAPTER 2: POS
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { count }   (completed transactions only;
                                  exclude voided/cancelled; refunds never
                                  reduce the count; q.rollover shifts the
                                  trading-day boundary by that many hours)
       fetchMonthly(env, h, q)-> { months:[...], count:[...] }
     NEVER return a dollar figure from the POS.
     Example (Square): pasted production personal access token (secret
     POS_API_TOKEN); sandbox sign = token only answers on
     connect.squareupsandbox.com.
  */
  /* >>> ADAPTER 2: POS - Square, personal access token
     Contract:
       fetchRange  -> { count }   completed transactions for the period
       fetchMonthly-> { months, count }
     Secret: POS_API_TOKEN  (Square production personal access token)
  */
  pos: {
    configured: true,
    auth: null,
    oauth: {},

    async status(env, h) {
      const token = env.POS_API_TOKEN;
      if (!token) return { connected: false };
      try {
        const res = await fetch('https://connect.squareup.com/v2/merchants', {
          headers: { 'Authorization': 'Bearer ' + token, 'Square-Version': '2024-01-18', 'Content-Type': 'application/json' }
        });
        if (res.status === 401) return { connected: false };
        if (!res.ok) return { connected: false, error: 'Square API ' + res.status };
        const data = await res.json();
        const m = (data.merchant || [])[0] || {};
        const org = m.business_name || m.id || 'Square';
        const sandbox = !!token.match(/^EAAA.*sandbox/i) || !token.startsWith('EAAA');
        return { connected: true, org, sandbox, lastSync: null };
      } catch (e) { return { connected: false, error: e.message }; }
    },

    async fetchRange(env, h, q) {
      const token = env.POS_API_TOKEN;
      if (!token) throw new NotConfigured('pos');
      const offset = _tzOffset(q.tz || 'Australia/Sydney');
      const beginTime = q.from + 'T00:00:00' + offset;
      const endTime   = q.to   + 'T23:59:59' + offset;
      const LOCATIONS = {
        albury:  ['L96MPP0J2PJN9', 'VC0RZ0FY4NZH5'],  // Dash Albury + Albury
        wodonga: ['LCSQR972MP157', 'LDWD004HPAQTS']    // Dash Wodonga + Wodonga
      };
      async function countForLocation(locationId) {
        let count = 0, cursor = null;
        try {
          do {
            const params = new URLSearchParams({ begin_time: beginTime, end_time: endTime, sort_order: 'ASC', limit: '100', location_id: locationId });
            if (cursor) params.set('cursor', cursor);
            const res = await fetch('https://connect.squareup.com/v2/payments?' + params.toString(), {
              headers: { 'Authorization': 'Bearer ' + token, 'Square-Version': '2024-01-18', 'Content-Type': 'application/json' }
            });
            if (!res.ok) { console.error('Square ' + locationId + ' returned ' + res.status); break; }
            const data = await res.json();
            count += (data.payments || []).filter(p => p.status === 'COMPLETED').length;
            cursor = data.cursor || null;
          } while (cursor);
        } catch (e) { console.error('Square location ' + locationId + ' error: ' + e.message); }
        return count;
      }
      const [albCounts, wodCounts] = await Promise.all([
        Promise.all(LOCATIONS.albury.map(id => countForLocation(id))),
        Promise.all(LOCATIONS.wodonga.map(id => countForLocation(id)))
      ]);
      const alburyCount = albCounts.reduce((a, b) => a + b, 0);
      const wodongaCount = wodCounts.reduce((a, b) => a + b, 0);
      await h.noteSync();
      return { count: alburyCount + wodongaCount, locations: { albury: { count: alburyCount }, wodonga: { count: wodongaCount } } };
    },

    async fetchMonthly(env, h, q) {
      const months = _monthRange(q.from, q.to);
      const counts = [], albCounts = [], wodCounts = [];
      for (const m of months) {
        const lastDay = new Date(+m.slice(0,4), +m.slice(5,7), 0).getDate();
        try {
          const r = await ADAPTERS.pos.fetchRange(env, h, { ...q, from: m + '-01', to: m + '-' + String(lastDay).padStart(2,'0') });
          counts.push(r.count);
          albCounts.push(r.locations ? r.locations.albury.count : 0);
          wodCounts.push(r.locations ? r.locations.wodonga.count : 0);
        } catch (e) { counts.push(0); albCounts.push(0); wodCounts.push(0); }
      }
      return { months, count: counts, locations: { albury: { count: albCounts }, wodonga: { count: wodCounts } } };
    }
  },

  /* >>> ADAPTER 3: ROSTERING (optional - only if the owner has one)
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { cost }    (rostered labour cost for the
                                  period; powers the PROJECTED wage % only)
     If this source is gated or absent, leave configured:false - the actual
     Wage % from accounting already covers the board (fallback ladder).
     Example (Deputy): pasted permanent token (secret ROSTERING_API_TOKEN).
  */
  rostering: {
    configured: false,
    auth: null,
    oauth: {},
    async status(env, h) { return { connected: false }; },
    async fetchRange(env, h, q) { throw new NotConfigured('rostering'); },
    async fetchMonthly(env, h, q) { return { months: [], cost: [] }; }
  },

  /* >>> ADAPTER 4: SHOPIFY - online store revenue
     Contract:
       status(env, h)          -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q)   -> { revenue }   (subtotal ex-tax, AUD)
       fetchMonthly(env, h, q) -> { months:[...], revenue:[...] }
     Secrets: SHOPIFY_SHOP (e.g. dashcakes.myshopify.com), SHOPIFY_ACCESS_TOKEN
     Scopes needed: read_orders
  */
  shopify: {
    configured: true,
    auth: 'oauth',
    oauth: {
      clientIdSecret: 'SHOPIFY_CLIENT_ID',
      clientSecretSecret: 'SHOPIFY_CLIENT_SECRET',
      scopes: 'read_orders',
      tokenAuth: 'post'
      /* authorizeUrl + tokenUrl built dynamically in authStart/authCallback via SHOPIFY_SHOP */
    },
    async status(env, h) {
      try {
        const tokens = await h.getTokens();
        const token = (tokens && tokens.access_token) || env.SHOPIFY_ACCESS_TOKEN;
        const shop = await env.TOKENS.get('shopify_shop') || env.SHOPIFY_SHOP;
        if (!shop || !token) return { connected: false };
        const res = await fetch('https://' + shop + '/admin/api/2024-01/shop.json', {
          headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
        });
        if (!res.ok) return { connected: false };
        const data = await res.json();
        return { connected: true, org: data.shop ? data.shop.name : shop, sandbox: false, lastSync: null };
      } catch (e) { return { connected: false, error: e.message }; }
    },
    async fetchRange(env, h, q) {
      const tokens = await h.getTokens();
      const token = (tokens && tokens.access_token) || env.SHOPIFY_ACCESS_TOKEN;
      const shop = await env.TOKENS.get('shopify_shop') || env.SHOPIFY_SHOP;
      if (!shop || !token) throw new NotConfigured('shopify');
      let revenue = 0;
      let count = 0;
      let pageInfo = null;
      let url = `https://${shop}/admin/api/2024-01/orders.json?status=any&financial_status=paid&created_at_min=${q.from}T00:00:00%2B10:00&created_at_max=${q.to}T23:59:59%2B10:00&limit=250&fields=subtotal_price`;
      while (true) {
        const res = await fetch(pageInfo ? pageInfo : url, {
          headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
        });
        if (!res.ok) throw new Error('Shopify orders API error ' + res.status);
        const data = await res.json();
        const orders = data.orders || [];
        for (const o of orders) { revenue += parseFloat(o.subtotal_price || '0'); count++; }
        const link = res.headers.get('Link') || '';
        const next = link.match(/<([^>]+)>;\s*rel="next"/);
        if (!next) break;
        pageInfo = next[1];
      }
      return { revenue, count };
    },
    async fetchMonthly(env, h, q) {
      const months = [];
      const revenue = [];
      const count = [];
      const ms = _monthRange(q.from, q.to);
      for (const m of ms) {
        const lastDay = new Date(+m.slice(0,4), +m.slice(5,7), 0).getDate();
        try {
          const r = await ADAPTERS.shopify.fetchRange(env, h, { from: m + '-01', to: m + '-' + lastDay });
          months.push(m); revenue.push(r.revenue || 0); count.push(r.count || 0);
        } catch (e) { months.push(m); revenue.push(0); count.push(0); }
      }
      return { months, revenue, count };
    }
  }
};


/* ============================================================================
   Shared adapter helpers
============================================================================ */

/* Return the current UTC offset string for a timezone name, e.g. "+10:00".
   Used to build RFC-3339 timestamps for Square and Shopify. */
function _tzOffset(tz) {
  try {
    const now = new Date();
    const local  = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const utc    = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
    const diffMin = Math.round((local - utc) / 60000);
    const sign = diffMin >= 0 ? '+' : '-';
    const abs  = Math.abs(diffMin);
    return sign + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0');
  } catch (e) { return '+10:00'; }
}

async function _xeroTenantIds(env, h) {
  const tokens = await h.getTokens();
  if (tokens && tokens.tenantIds && tokens.tenantIds.length) return tokens.tenantIds;
  const data = await h.fetchJson('https://api.xero.com/connections', {
    headers: { 'Accept': 'application/json' }
  });
  const ids = Array.isArray(data) ? data.map(c => c.tenantId).filter(Boolean) : [];
  if (!ids.length) throw new Error('No Xero organisation found');
  // Cache all tenant ids and names
  const names = Array.isArray(data) ? data.map(c => c.tenantName || '').join(' + ') : '';
  await h.saveTokens({ ...tokens, tenantIds: ids, tenantId: ids[0], tenantName: names });
  return ids;
}
/* Legacy single-id helper kept for compatibility */
async function _xeroTenantId(env, h) {
  const ids = await _xeroTenantIds(env, h);
  return ids[0];
}
async function _xeroTenantsWithNames(env, h) {
  const tokens = await h.getTokens();
  if (tokens && tokens.tenantMeta && tokens.tenantMeta.length) return tokens.tenantMeta;
  const data = await h.fetchJson('https://api.xero.com/connections', { headers: { 'Accept': 'application/json' } });
  if (!Array.isArray(data) || !data.length) throw new Error('No Xero organisation found');
  const tenantMeta = data.map(c => ({ id: c.tenantId, name: c.tenantName || '' }));
  const ids = tenantMeta.map(t => t.id);
  const names = tenantMeta.map(t => t.name).join(' + ');
  await h.saveTokens({ ...tokens, tenantIds: ids, tenantId: ids[0], tenantName: names, tenantMeta });
  return tenantMeta;
}


const WAGE_KEYWORDS = /wages|salaries|superannuation|super|payroll|annual leave|long service|workcover/i;

function _parseXeroPL(data, numPeriods) {
  const rows = (data.Reports && data.Reports[0] && data.Reports[0].Rows) || [];
  const results = Array.from({ length: numPeriods }, () => ({
    revenue: 0, cogs: 0, wagesSuper: 0, overheads: 0
  }));

  for (const section of rows) {
    if (section.RowType !== 'Section') continue;
    const title = (section.Title || '').toLowerCase();
    const isIncome = title.includes('income') || title.includes('revenue') || title.includes('trading');
    const isOtherIncome = title.includes('other income') || title.includes('other revenue');
    const isCOGS = title.includes('cost of sales') || title.includes('cost of goods') || title.includes('direct costs');
    const isOpex = title.includes('operating') || title.includes('expenses') || title.includes('overhead');

    if (isOtherIncome) continue; // exclude other income per kpi-spec

    for (const row of (section.Rows || [])) {
      if (row.RowType === 'Row' || row.RowType === 'SummaryRow') {
        const label = (row.Cells && row.Cells[0] && row.Cells[0].Value) || '';
        const isSummary = row.RowType === 'SummaryRow';
        for (let p = 0; p < numPeriods; p++) {
          const cell = row.Cells && row.Cells[p + 1];
          const val = cell ? Math.abs(parseFloat(cell.Value) || 0) : 0;
          if (isSummary) {
            if (isIncome && !isOtherIncome) results[p].revenue += val;
            if (isCOGS) results[p].cogs += val;
          } else if (isOpex && !isSummary) {
            // Per-line in opex: detect wages/super
            if (WAGE_KEYWORDS.test(label)) {
              results[p].wagesSuper += val;
            } else if (!isCOGS) {
              results[p].overheads += val;
            }
          }
        }
      }
    }
  }
  return results;
}

function _monthRange(from, to) {
  const months = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ey, em] = to.slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    months.push(String(y) + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
  }
  return months;
}

/* ============================================================================
   Everything below is the shell. You should rarely need to edit it.
============================================================================ */

class NotConfigured extends Error {
  constructor(source) { super('not configured: ' + source); this.source = source; }
}

const PLAIN_ERRORS = {
  401: 'This connection needs reconnecting. Click Reconnect and log in again.',
  403: 'This connection is missing a permission it needs. Your AI will sort out the access.',
  429: 'The tool is asking us to slow down. Wait a few minutes, then refresh.',
  500: 'The tool had a problem at its end. Try refresh in a little while.'
};
function plainError(status) {
  return PLAIN_ERRORS[status] || ('Something went wrong talking to this tool (code ' + status + '). Try refresh; if it persists, tell your AI.');
}

/* ---------------- Token store (KV) with refresh built in ---------------- */

async function getTokens(env, source) {
  const raw = await env.TOKENS.get('tokens:' + source);
  return raw ? JSON.parse(raw) : null;
}
async function saveTokens(env, source, tokens) {
  await env.TOKENS.put('tokens:' + source, JSON.stringify(tokens));
}
async function clearTokens(env, source) {
  await env.TOKENS.delete('tokens:' + source);
}
async function noteSync(env, source) {
  await env.TOKENS.put('lastSync:' + source, new Date().toISOString());
}
async function lastSync(env, source) {
  return await env.TOKENS.get('lastSync:' + source);
}

/* Build the POST to an OAuth token endpoint, honouring the adapter's client-auth
   method. tokenAuth:'basic' -> client id+secret in an HTTP Basic Authorization
   header, NOT in the body (Xero and most OpenID providers expect this); 'post'
   (or unset, for back-compat) -> client_id/client_secret in the form body. */
function tokenRequestInit(cfg, params, env) {
  const id = env[cfg.clientIdSecret] || '';
  const secret = env[cfg.clientSecretSecret] || '';
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(params);
  if ((cfg.tokenAuth || 'post') === 'basic') {
    headers['Authorization'] = 'Basic ' + btoa(id + ':' + secret);
  } else {
    body.set('client_id', id);
    body.set('client_secret', secret);
  }
  return { method: 'POST', headers: headers, body: body.toString() };
}

/* Returns a valid access token for an OAuth source, refreshing (and
   persisting the ROTATED refresh token) when needed. */
async function getValidAccessToken(env, source) {
  const adapter = ADAPTERS[source];
  const tokens = await getTokens(env, source);
  if (!tokens || !tokens.access_token) { const e = new Error('no tokens'); e.status = 401; throw e; }
  const skewMs = 60 * 1000;
  if (!tokens.expires_at || Date.now() < tokens.expires_at - skewMs) return tokens.access_token;

  /* refresh */
  const cfg = adapter.oauth || {};
  if (!tokens.refresh_token || !cfg.tokenUrl) { const e = new Error('cannot refresh'); e.status = 401; throw e; }
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  }, env));
  if (!res.ok) {
    /* refresh failed: force a reconnect rather than silently serving stale data */
    const e = new Error('refresh failed'); e.status = 401; throw e;
  }
  const fresh = await res.json();
  const updated = {
    ...tokens,
    access_token: fresh.access_token,
    /* CRITICAL: many providers (Xero!) rotate the refresh token - always keep the new one */
    refresh_token: fresh.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + ((fresh.expires_in || 1800) * 1000)
  };
  await saveTokens(env, source, updated);
  return updated.access_token;
}

/* Helpers handed to every adapter call */
function makeHelpers(env, source) {
  return {
    getValidAccessToken: () => getValidAccessToken(env, source),
    getTokens: () => getTokens(env, source),
    saveTokens: (t) => saveTokens(env, source, t),
    noteSync: () => noteSync(env, source),
    saveIngestedRows: (rows) => saveIngestedRows(env, source, rows),
    readIngested: (from, to) => readIngested(env, source, from, to),
    monthlyIngested: (fromMonth, toMonth) => monthlyIngested(env, source, fromMonth, toMonth),
    /* fetch JSON with one automatic refresh-and-retry on 401 (OAuth sources) */
    fetchJson: async (url, init, opts) => {
      const useAuth = !opts || opts.auth !== false;
      const doFetch = async () => {
        const headers = new Headers((init && init.headers) || {});
        if (useAuth && ADAPTERS[source].auth === 'oauth') {
          headers.set('Authorization', 'Bearer ' + await getValidAccessToken(env, source));
        }
        return fetch(url, { ...(init || {}), headers });
      };
      let res = await doFetch();
      if (res.status === 401 && useAuth && ADAPTERS[source].auth === 'oauth') {
        const t = await getTokens(env, source);
        if (t) { t.expires_at = 0; await saveTokens(env, source, t); } /* force refresh */
        res = await doFetch();
      }
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.json();
    }
  };
}

/* ---------------- OAuth begin + callback (generic, per-source) ---------- */

function randomState() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- Owner login: one passcode + a signed session cookie ----
   The owner sets the dashboard password on the dashboard's own FIRST-RUN screen;
   it is stored PBKDF2-hashed in KV (sys:passcode_hash) - no Cloudflare Variables
   step. (env.DASHBOARD_PASSCODE still works as an override, e.g. when the
   one-click button collected it in its wizard.) The session-signing key is
   generated and stored in KV on first run (env.SESSION_SECRET overrides if set).
   Until a password exists the dashboard shows the SET-PASSWORD screen, never an
   open page; once set, the page and every data route require a valid session. */
const SESSION_TTL = 60 * 60 * 24 * 30;
/* A password exists if the owner set one (first-run -> KV) or the deploy provided
   one as an env override (the one-click button's wizard). */
async function passcodeSet(env) {
  if (env.DASHBOARD_PASSCODE) return true;
  if (env.TOKENS) return !!(await env.TOKENS.get('sys:passcode_hash'));
  return false;
}
/* PBKDF2-SHA256 of a passcode with a hex salt -> base64url (at-rest hashing). */
async function pbkdf2B64(passcode, saltHex) {
  const salt = Uint8Array.from((saltHex.match(/.{2}/g) || []).map((h) => parseInt(h, 16)));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  return b64url(bits);
}
let _sessionKeyCache = null;
async function getSessionKey(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (_sessionKeyCache) return _sessionKeyCache;
  if (env.TOKENS) {
    let k = await env.TOKENS.get('sys:session_secret');
    if (!k) {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      k = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
      await env.TOKENS.put('sys:session_secret', k);
    }
    _sessionKeyCache = k;
    return k;
  }
  return env.DASHBOARD_PASSCODE || 'unset';
}
function b64url(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmacB64(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
async function shaB64(s) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function makeSession(env) {
  const payload = 'v1.' + Math.floor(Date.now() / 1000);
  return payload + '.' + await hmacB64(await getSessionKey(env), payload);
}
async function validSession(env, token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  if (!timingSafeEqual(token.slice(i + 1), await hmacB64(await getSessionKey(env), payload))) return false;
  const issued = parseInt(payload.split('.')[1], 10);
  return !!issued && (Date.now() / 1000 - issued) <= SESSION_TTL;
}
function getCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function isLoggedIn(request, env) {
  return await validSession(env, getCookie(request, 'vd_session'));
}
function htmlResponse(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
}
async function apiLogin(env, request) {
  if (!(await passcodeSet(env))) return json({ ok: false, error: 'no_passcode' }, 400);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  let okPass = false;
  if (env.DASHBOARD_PASSCODE) {
    okPass = timingSafeEqual(await shaB64(passcode), await shaB64(env.DASHBOARD_PASSCODE));
  } else if (env.TOKENS) {
    const stored = await env.TOKENS.get('sys:passcode_hash');
    if (stored) {
      const dot = stored.indexOf('.');
      okPass = timingSafeEqual(await pbkdf2B64(passcode, stored.slice(0, dot)), stored.slice(dot + 1));
    }
  }
  if (!okPass) return json({ ok: false }, 401);
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}

/* First-run (or authenticated change): set the dashboard password. Allowed only
   when none is set yet, OR when the caller already holds a valid session - so a
   stranger can never overwrite an existing password. Stored PBKDF2-hashed in KV. */
async function apiSetup(env, request) {
  if (!env.TOKENS) return json({ ok: false, error: 'no_store' }, 400);
  if ((await passcodeSet(env)) && !(await isLoggedIn(request, env))) return json({ ok: false, error: 'exists' }, 403);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  if (passcode.length < 6) return json({ ok: false, error: 'too_short' }, 400);
  const saltB = new Uint8Array(16); crypto.getRandomValues(saltB);
  const saltHex = Array.from(saltB).map((x) => x.toString(16).padStart(2, '0')).join('');
  await env.TOKENS.put('sys:passcode_hash', saltHex + '.' + (await pbkdf2B64(passcode, saltHex)));
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}
function apiLogout() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' } });
}
function loginPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Your dashboard</h1><p>Enter the password for this dashboard.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="current-password" placeholder="Password" autofocus>'
    + '<button type="submit">Sign in</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:document.getElementById("p").value})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="That password did not match. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

function setupPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Set your password</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Set your password</h1><p>Choose a password for your dashboard. You\u2019ll type it each time you open it - pick something only you and your team know, at least 6 characters.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="new-password" placeholder="New password" autofocus>'
    + '<input id="p2" type="password" autocomplete="new-password" placeholder="Confirm password" style="margin-top:10px">'
    + '<button type="submit">Save and open my dashboard</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'var p=document.getElementById("p").value,p2=document.getElementById("p2").value;'
    + 'if(p.length<6){e.textContent="Use at least 6 characters.";return;}'
    + 'if(p!==p2){e.textContent="The two passwords do not match.";return;}'
    + 'fetch("/api/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:p})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="Could not save that. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

async function authStart(env, source, url) {
  const adapter = ADAPTERS[source];
  if (!adapter || adapter.auth !== 'oauth') {
    return new Response('This connection is not set up for browser authorisation yet.', { status: 404 });
  }
  const cfg = adapter.oauth;
  const state = randomState();
  await env.TOKENS.put('oauthstate:' + source, state, { expirationTtl: 600 });
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  /* Shopify: dynamic authorize URL built from SHOPIFY_SHOP env var */
  if (source === 'shopify') {
    const shop = env.SHOPIFY_SHOP;
    if (!shop) return new Response('SHOPIFY_SHOP is not configured.', { status: 500 });
    await env.TOKENS.put('shopify_shop', shop, { expirationTtl: 86400 * 365 });
    const p = new URLSearchParams({ client_id: env[cfg.clientIdSecret] || '', scope: cfg.scopes || '', redirect_uri: redirectUri, state });
    return Response.redirect('https://' + shop + '/admin/oauth/authorize?' + p.toString(), 302);
  }
  if (!cfg.authorizeUrl) {
    return new Response('This connection is not set up for browser authorisation yet.', { status: 404 });
  }
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: env[cfg.clientIdSecret] || '',
    redirect_uri: redirectUri,
    scope: cfg.scopes || '',
    state
  });
  return Response.redirect(cfg.authorizeUrl + '?' + p.toString(), 302);
}

async function authCallback(env, source, url) {
  const adapter = ADAPTERS[source];
  const cfg = (adapter && adapter.oauth) || {};
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  const wantState = await env.TOKENS.get('oauthstate:' + source);
  if (!code || !gotState || gotState !== wantState) {
    return new Response('That authorisation didn’t complete cleanly. Go back to the dashboard and click Reconnect to try again.', { status: 400 });
  }
  await env.TOKENS.delete('oauthstate:' + source);
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  /* Shopify: dynamic token URL, no refresh token, no expiry */
  let tokenUrl = cfg.tokenUrl;
  if (source === 'shopify') {
    const shop = await env.TOKENS.get('shopify_shop') || env.SHOPIFY_SHOP;
    if (!shop) return new Response('SHOPIFY_SHOP missing during callback.', { status: 500 });
    tokenUrl = `https://${shop}/admin/oauth/access_token`;
  }
  const res = await fetch(tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  }, env));
  if (!res.ok) {
    return new Response('The connection couldn’t be finished (the tool said no: ' + res.status + '). Your AI will check the app settings - the usual cause is a redirect address that doesn’t match exactly.', { status: 502 });
  }
  const t = await res.json();
  const expiresAt = source === 'shopify' ? null : Date.now() + ((t.expires_in || 1800) * 1000);
  await saveTokens(env, source, {
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    token_type: t.token_type || 'Bearer',
    expires_at: expiresAt,
    obtained_at: new Date().toISOString()
  });
  /* After token storage, adapters' status() should resolve org name etc. */
  return Response.redirect(url.origin + '/', 302);
}

/* ---------------- No-API ingest: KV day-store + endpoint ---------------- */

/* Day rows live at data:<source>:<YYYY-MM-DD> as JSON objects of numeric
   fields. Same-day re-uploads overwrite (idempotent; re-ingesting a corrected
   export is safe and expected). */
async function saveIngestedRows(env, source, rows) {
  if (!Array.isArray(rows)) return 0;
  let saved = 0;
  for (const r of rows) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) continue;
    const clean = {};
    for (const [k, v] of Object.entries(r)) {
      if (k !== 'date' && typeof v === 'number' && isFinite(v)) clean[k] = v;
    }
    if (Object.keys(clean).length === 0) continue;
    await env.TOKENS.put('data:' + source + ':' + r.date, JSON.stringify(clean));
    saved++;
  }
  return saved;
}

function eachDate(from, to, cap) {
  const out = [];
  const d = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (d.getTime() <= end.getTime() && out.length < (cap || 400)) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* Sum stored day rows across a range. Returns { sums, daysWithData, lastDate }. */
async function readIngested(env, source, from, to) {
  const sums = {};
  let daysWithData = 0, lastDate = null;
  for (const date of eachDate(from, to)) {
    const raw = await env.TOKENS.get('data:' + source + ':' + date);
    if (!raw) continue;
    daysWithData++; lastDate = date;
    try {
      const row = JSON.parse(raw);
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'number' && isFinite(v)) sums[k] = (sums[k] || 0) + v;
      }
    } catch (e) { /* skip bad row */ }
  }
  return { sums, daysWithData, lastDate };
}

async function monthlyIngested(env, source, fromMonth, toMonth) {
  const months = monthList(fromMonth, toMonth);
  const out = { months, byMonth: [] };
  for (const mo of months) {
    const [y, m] = mo.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const r = await readIngested(env, source, mo + '-01', mo + '-' + String(lastDay).padStart(2, '0'));
    out.byMonth.push(r.daysWithData ? r.sums : null);
  }
  return out;
}

/* POST /api/ingest?source=pos|accounting|rostering
   Authorization: Bearer <INGEST_TOKEN>. Body: the exported file's text.
   The source's adapter.parseExport() turns it into day rows. */
async function apiIngest(env, request, url) {
  const source = url.searchParams.get('source');
  if (!['accounting', 'pos', 'rostering', 'shopify'].includes(source)) return json({ error: 'unknown source' }, 400);
  const auth = request.headers.get('Authorization') || '';
  if (!env.INGEST_TOKEN || auth !== 'Bearer ' + env.INGEST_TOKEN) {
    return json({ error: 'not authorised', plain: 'That upload code didn\u2019t match. Check it with your AI and try again.' }, 401);
  }
  const adapter = ADAPTERS[source];
  if (!adapter || typeof adapter.parseExport !== 'function') {
    return json({ error: 'no parser', plain: 'This source isn\u2019t set up for file uploads yet. Your AI adds that when this path is chosen.' }, 501);
  }
  const text = await request.text();
  if (text.length > 2000000) return json({ error: 'too big', plain: 'That file is too large. Export a shorter date range and try again.' }, 413);
  try {
    const rows = await adapter.parseExport(env, makeHelpers(env, source), {
      text, contentType: request.headers.get('Content-Type') || ''
    });
    const saved = await saveIngestedRows(env, source, rows);
    if (!saved) return json({ error: 'nothing parsed', plain: 'No usable rows were found in that file. Check it\u2019s the right report, or show it to your AI.' }, 422);
    await noteSync(env, source);
    return json({ ok: true, days: saved });
  } catch (e) {
    return json({ error: 'parse failed', plain: 'That file couldn\u2019t be read. Check it\u2019s the right report, or show it to your AI.' }, 422);
  }
}

/* ---------------- Metrics API ---------------- */

function parseRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(s);
  return m ? { from: m[1], to: m[2] } : null;
}
function parseMonthRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}):(\d{4}-\d{2})$/.exec(s);
  return m ? { fromMonth: m[1], toMonth: m[2] } : null;
}

async function sourceStatus(env, source) {
  const adapter = ADAPTERS[source];
  if (!adapter || !adapter.configured) return { configured: false };
  try {
    const h = makeHelpers(env, source);
    const st = await adapter.status(env, h);
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: !!(st && st.connected),
      org: (st && st.org) || null,
      sandbox: !!(st && st.sandbox),
      lastSync: (st && st.lastSync) || (await lastSync(env, source)) || null,
      error: null
    };
  } catch (err) {
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: false,
      org: null,
      sandbox: false,
      lastSync: (await lastSync(env, source)) || null,
      error: { code: err.status || 0, plain: plainError(err.status || 500) }
    };
  }
}

async function fetchSlot(env, q) {
  /* One period slot: pull each configured source; null where unavailable. */
  const out = {};
  for (const source of ['accounting', 'pos', 'rostering', 'shopify']) {
    const adapter = ADAPTERS[source];
    if (!adapter || !adapter.configured) { out[source] = null; continue; }
    try {
      const h = makeHelpers(env, source);
      out[source] = await adapter.fetchRange(env, h, q);
      await noteSync(env, source);
    } catch (err) {
      out[source] = { _error: err.message || String(err) }; /* per-source failure never breaks the whole payload */
    }
  }
  return out;
}

const METRICS_CACHE_TTL = 120; /* seconds: brief cache for live provider data */

async function apiMetrics(env, url) {
  const cur = parseRange(url.searchParams.get('cur'));
  if (!cur) return json({ error: 'bad cur range' }, 400);
  const prev = parseRange(url.searchParams.get('prev'));
  const yoy = parseRange(url.searchParams.get('yoy'));
  const trend = parseMonthRange(url.searchParams.get('trend'));
  const tz = url.searchParams.get('tz') || 'Australia/Sydney';
  const rollover = Math.max(0, Math.min(6, parseInt(url.searchParams.get('rollover') || '0', 10) || 0));

  const base = { tz, rollover };
  const [sAcc, sPos, sRos, sShop] = await Promise.all([
    sourceStatus(env, 'accounting'),
    sourceStatus(env, 'pos'),
    sourceStatus(env, 'rostering'),
    sourceStatus(env, 'shopify')
  ]);

  /* The provider calls (periods + trend) are the expensive part and the only
     thing that brushes provider rate limits on quick reopens/refreshes. Cache
     them briefly in KV, keyed by the requested ranges; source status stays live.
     generatedAt is stored with the data so the dashboard's "last synced" reflects
     the real fetch time even when served from cache. ?refresh=1 forces fresh. */
  const cacheKey = 'metricscache:' + [
    url.searchParams.get('cur') || '', url.searchParams.get('prev') || '',
    url.searchParams.get('yoy') || '', url.searchParams.get('trend') || '',
    tz, rollover
  ].join('|');
  const force = url.searchParams.get('refresh') === '1';
  let data = null;
  if (!force && env.TOKENS) {
    const cached = await env.TOKENS.get(cacheKey);
    if (cached) { try { data = JSON.parse(cached); } catch (e) { data = null; } }
  }
  if (!data) {
    const periods = {};
    periods.cur = await fetchSlot(env, { ...base, ...cur });
    periods.prev = prev ? await fetchSlot(env, { ...base, ...prev }) : null;
    periods.yoy = yoy ? await fetchSlot(env, { ...base, ...yoy }) : null;

    let trendOut = null;
    if (trend) {
      trendOut = { months: monthList(trend.fromMonth, trend.toMonth) };
      for (const source of ['accounting', 'pos', 'shopify']) {
        const adapter = ADAPTERS[source];
        if (!adapter || !adapter.configured) { trendOut[source] = null; continue; }
        try {
          const h = makeHelpers(env, source);
          const series = await adapter.fetchMonthly(env, h, { ...base, ...trend });
          trendOut[source] = alignSeries(trendOut.months, series);
        } catch (err) { trendOut[source] = null; }
      }
    }
    data = { generatedAt: new Date().toISOString(), periods: periods, trend: trendOut };
    if (env.TOKENS) {
      try { await env.TOKENS.put(cacheKey, JSON.stringify(data), { expirationTtl: METRICS_CACHE_TTL }); } catch (e) {}
    }
  }

  return json({
    generatedAt: data.generatedAt,
    protected: true,
    sources: { accounting: sAcc, pos: sPos, rostering: sRos, shopify: sShop },
    periods: data.periods,
    trend: data.trend
  });
}

function monthList(fromMonth, toMonth) {
  const out = [];
  let [y, m] = fromMonth.split('-').map(Number);
  const [ey, em] = toMonth.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 60) break;
  }
  return out;
}
/* Adapters return {months:[...], <field>:[...]} - align onto the requested grid. */
function alignSeries(months, series) {
  if (!series || !Array.isArray(series.months)) return null;
  const idx = {};
  series.months.forEach((mo, i) => { idx[mo] = i; });
  const out = {};
  Object.keys(series).forEach((k) => {
    if (k === 'months') return;
    out[k] = months.map((mo) => (mo in idx && series[k] ? (series[k][idx[mo]] ?? null) : null));
  });
  return out;
}

/* ---------------- Router ---------------- */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/api/login' && request.method === 'POST') return apiLogin(env, request);
    if (path === '/api/setup' && request.method === 'POST') return apiSetup(env, request);
    if (path === '/api/logout' && request.method === 'POST') return apiLogout();
    if (path === '/api/ingest' && request.method === 'POST') return apiIngest(env, request, url);

    const loggedIn = await isLoggedIn(request, env);

    if (path === '/' || path === '/index.html') {
      if (loggedIn) return htmlResponse(dashboardHtml);
      return htmlResponse((await passcodeSet(env)) ? loginPage() : setupPage());
    }
    if (path === '/api/metrics' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiMetrics(env, url);
    }
    const authRoute = /^\/auth\/(accounting|pos|rostering|shopify)\/(start|callback)$/.exec(path);
    if (authRoute && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      return authRoute[2] === 'start' ? authStart(env, authRoute[1], url) : authCallback(env, authRoute[1], url);
    }
    if (path === '/api/disconnect' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      const source = url.searchParams.get('source');
      if (['accounting', 'pos', 'rostering', 'shopify'].includes(source)) {
        await clearTokens(env, source);
        return json({ ok: true });
      }
      return json({ error: 'unknown source' }, 400);
    }
    if (path === '/api/trend' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      const trendParam = parseMonthRange(url.searchParams.get('trend'));
      if (!trendParam) return json({ error: 'bad trend range' }, 400);
      const tz = url.searchParams.get('tz') || 'Australia/Sydney';
      const rollover = Math.max(0, Math.min(6, parseInt(url.searchParams.get('rollover') || '0', 10) || 0));
      const base = { tz, rollover };
      const cacheKey = 'trendcache:' + [url.searchParams.get('trend') || '', tz, rollover].join('|');
      const force = url.searchParams.get('refresh') === '1';
      let trendData = null;
      if (!force && env.TOKENS) {
        const cached = await env.TOKENS.get(cacheKey);
        if (cached) { try { trendData = JSON.parse(cached); } catch (e) {} }
      }
      if (!trendData) {
        const trendOut = { months: monthList(trendParam.fromMonth, trendParam.toMonth) };
        /* Only accounting + shopify — pos (Square) is 4 calls/month and would exceed subrequest limit */
        for (const source of ['accounting', 'shopify']) {
          const adapter = ADAPTERS[source];
          if (!adapter || !adapter.configured) { trendOut[source] = null; continue; }
          try {
            const h = makeHelpers(env, source);
            const series = await adapter.fetchMonthly(env, h, { ...base, ...trendParam });
            trendOut[source] = alignSeries(trendOut.months, series);
          } catch (err) { trendOut[source] = null; }
        }
        trendOut.pos = null; /* pos excluded: too many subrequests for monthly Square data */
        trendData = { generatedAt: new Date().toISOString(), trend: trendOut };
        if (env.TOKENS) {
          try { await env.TOKENS.put(cacheKey, JSON.stringify(trendData), { expirationTtl: 300 }); } catch (e) {}
        }
      }
      return json(trendData);
    }
    if (path === '/api/shopify-debug' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      const h = makeHelpers(env, 'shopify');
      const tokens = await h.getTokens();
      const token = (tokens && tokens.access_token) || env.SHOPIFY_ACCESS_TOKEN;
      const shop = await env.TOKENS.get('shopify_shop') || env.SHOPIFY_SHOP;
      const from = url.searchParams.get('from') || '2026-06-01';
      const to = url.searchParams.get('to') || '2026-06-30';
      const testUrl = 'https://' + shop + '/admin/api/2024-01/orders.json?status=any&financial_status=paid&created_at_min=' + from + 'T00:00:00%2B10:00&created_at_max=' + to + 'T23:59:59%2B10:00&limit=5&fields=subtotal_price,id,financial_status,status';
      const res = await fetch(testUrl, { headers: { 'X-Shopify-Access-Token': token } });
      const body = await res.text();
      return json({ shop, hasToken: !!token, status: res.status, ok: res.ok, url: testUrl, body: body.slice(0, 2000) });
    }
    return new Response('Not found', { status: 404 });
  },

  /* Cron rung: uncomment [triggers] in wrangler.toml and give any adapter a
     scheduledPull() to fetch its tool's own export on a schedule. */
  async scheduled(event, env, ctx) {
    for (const source of ['accounting', 'pos', 'rostering', 'shopify']) {
      const a = ADAPTERS[source];
      if (a && typeof a.scheduledPull === 'function') {
        try {
          await a.scheduledPull(env, makeHelpers(env, source));
          await noteSync(env, source);
        } catch (e) {
          console.log('scheduledPull failed for ' + source + ': ' + (e && e.message));
        }
      }
    }
  },

  /* Email rung (Path B): complete when this rung is chosen. */
  async email(message, env, ctx) {
    console.log('email received from ' + message.from + '; email ingest not wired yet');
  }
};
// EOF worker.js
