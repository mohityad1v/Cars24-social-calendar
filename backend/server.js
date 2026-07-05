/**
 * Cars24 Social Calendar — backend API
 * Stack: Node + Express + Neon (Postgres via `pg`) + Cloudinary (signed uploads)
 *
 * Serves:
 *   GET  /api/health              -> { ok: true }
 *   GET  /api/state               -> { campaigns:[...], marks, removed, heropos, ... , types }
 *   PUT  /api/campaigns           -> replace the whole campaign list (body: array)
 *   PUT  /api/state/:key          -> upsert one UI-state blob (body: { value })
 *   POST /api/cloudinary/sign     -> { cloudName, apiKey, timestamp, signature } for a signed upload
 *   *    (everything else)        -> serves the single-file frontend
 */
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || '';

// Neon needs SSL. Local Postgres on localhost does not.
const useSSL = DATABASE_URL && !/localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

const app = express();
app.use(cors());
// base64 fallback images can be large, so allow a generous body size
app.use(express.json({ limit: '25mb' }));

/* ------------------------------------------------------------------ schema */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS campaigns (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  start_date    TEXT,
  end_date      TEXT,
  platform      TEXT,
  posts         INTEGER DEFAULT 0,
  reach         BIGINT  DEFAULT 0,
  eng           NUMERIC DEFAULT 0,
  status        TEXT DEFAULT 'done',
  types         JSONB DEFAULT '[]'::jsonb,
  amplification TEXT,
  notes         TEXT,
  hero          TEXT,
  video         TEXT,
  gallery       JSONB DEFAULT '[]'::jsonb,
  media         JSONB DEFAULT '[]'::jsonb,
  link          TEXT,
  sample        BOOLEAN DEFAULT false,
  sort_order    INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);
`;

// Seed data — matches the dashboard's built-in placeholders so a fresh
// deploy isn't blank. Marked sample:true so the "Placeholder" note shows
// until you fill each one in (or import your sheet / edit in-app).
const SEED = [
  { name: 'Dinesh Karthik Ad Campaign', start: '2026-01-01', status: 'done', types: ['ad'], notes: 'Brand ad with Dinesh Karthik. Awaiting details.', sample: true },
  { name: 'Mother & Sister Promise Ad Campaign', start: '2026-01-01', status: 'done', types: ['ad'], notes: 'Brand ad — Mother & Sister promise narrative. Awaiting details.', sample: true },
  { name: 'Gaurav Gera Ad Campaign', start: '2026-05-01', platform: 'IG, YT', status: 'done', types: ['ad'], notes: 'Ad campaign featuring Gaurav Gera. Awaiting details.', sample: true },
  { name: 'Hyrox × Cars24', start: '2026-01-01', platform: 'IG, OOH', status: 'live', types: ['collab'], notes: 'Fitness event partnership in Bangalore. Awaiting details.', sample: true },
  { name: 'Jaipur Challan Billboards', start: '2026-06-01', platform: 'OOH', status: 'live', types: ['roadsafety'], notes: 'ANPR challan billboard rollout in Jaipur (Project Protect).', sample: true },
  { name: 'Gurugram Road Safety', start: '2025-12-01', platform: 'OOH', status: 'live', types: ['roadsafety'], notes: 'Gurugram-specific road safety signage program — 200 boards installed.', sample: true },
  { name: 'New Year — Drink & Drive', start: '2025-12-28', end: '2026-01-02', platform: 'IG, YT, OOH', status: 'done', types: ['roadsafety'], notes: 'NYE drunk-driving safety push.', sample: true },
  { name: "First — Father's Day", start: '2026-06-15', end: '2026-06-21', platform: 'IG, YT, OOH', status: 'done', types: ['topical'], notes: "First-time-Dad celebration. 'Before ADAS there were DADAS' OOH execution.", sample: true },
  { name: 'ET Edge — Road Safety Summit', start: '2026-06-15', end: '2026-06-17', platform: 'OOH, LinkedIn, PR', status: 'done', types: ['event'], notes: 'Industry summit appearance — road safety vertical.', sample: true },
  { name: 'Token — AI Event', start: '2026-05-01', status: 'done', types: ['event'], notes: 'AI event participation.', sample: true },
];

async function initDb() {
  if (!DATABASE_URL) {
    console.warn('[db] DATABASE_URL is not set — API data routes will fail until you add it.');
    return;
  }
  await pool.query(SCHEMA);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM campaigns');
  if (rows[0].n === 0) {
    console.log('[db] empty campaigns table — seeding placeholders');
    await replaceCampaigns(SEED);
  }
  console.log('[db] ready');
}

/* --------------------------------------------------------------- mappers */
const rowToCampaign = (r) => ({
  id: r.id,
  name: r.name,
  start: r.start_date || '',
  end: r.end_date || '',
  platform: r.platform || '',
  posts: r.posts || 0,
  reach: Number(r.reach) || 0,
  eng: Number(r.eng) || 0,
  status: r.status || 'done',
  type: (Array.isArray(r.types) && r.types[0]) || 'topical',
  types: Array.isArray(r.types) ? r.types : [],
  amplification: r.amplification || '',
  notes: r.notes || '',
  hero: r.hero || '',
  video: r.video || '',
  gallery: Array.isArray(r.gallery) ? r.gallery : [],
  media: Array.isArray(r.media) ? r.media : [],
  link: r.link || '',
  sample: !!r.sample,
});

async function replaceCampaigns(list) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM campaigns');
    let i = 0;
    for (const c of list) {
      const types = Array.isArray(c.types) && c.types.length ? c.types : [c.type || 'topical'];
      await client.query(
        `INSERT INTO campaigns
          (name,start_date,end_date,platform,posts,reach,eng,status,types,
           amplification,notes,hero,video,gallery,media,link,sample,sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          c.name || 'Untitled',
          c.start || null,
          c.end || null,
          c.platform || '',
          parseInt(c.posts, 10) || 0,
          parseInt(String(c.reach).replace(/[, ]/g, ''), 10) || 0,
          parseFloat(c.eng) || 0,
          c.status || 'done',
          JSON.stringify(types),
          c.amplification || '',
          c.notes || '',
          c.hero || '',
          c.video || '',
          JSON.stringify(c.gallery || []),
          JSON.stringify(c.media || []),
          c.link || '',
          !!c.sample,
          i++,
        ]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/* ---------------------------------------------------------------- routes */
app.get('/api/health', (_req, res) => res.json({ ok: true, db: !!DATABASE_URL }));

app.get('/api/state', async (_req, res) => {
  try {
    const c = await pool.query('SELECT * FROM campaigns ORDER BY sort_order, id');
    const s = await pool.query('SELECT key, value FROM app_state');
    const st = {};
    s.rows.forEach((r) => (st[r.key] = r.value));
    res.json({
      campaigns: c.rows.map(rowToCampaign),
      marks: st.marks || {},
      removed: st.removed || {},
      heropos: st.heropos || {},
      monthpos: st.monthpos || {},
      herozoom: st.herozoom || {},
      monthzoom: st.monthzoom || {},
      herofit: st.herofit || {},
      types: st.types || {},
    });
  } catch (e) {
    console.error('GET /api/state', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/campaigns', async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Body must be an array of campaigns' });
  try {
    await replaceCampaigns(req.body);
    res.json({ ok: true, count: req.body.length });
  } catch (e) {
    console.error('PUT /api/campaigns', e.message);
    res.status(500).json({ error: e.message });
  }
});

const STATE_KEYS = new Set(['marks', 'removed', 'heropos', 'monthpos', 'herozoom', 'monthzoom', 'herofit', 'types']);
app.put('/api/state/:key', async (req, res) => {
  const key = req.params.key;
  if (!STATE_KEYS.has(key)) return res.status(400).json({ error: 'Unknown state key' });
  try {
    await pool.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [key, JSON.stringify(req.body.value ?? {})]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/state', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Signed Cloudinary upload. Frontend gets a signature, then uploads the file
// straight to Cloudinary — the API secret never leaves the server.
app.post('/api/cloudinary/sign', (_req, res) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const folder = process.env.CLOUDINARY_FOLDER || '';
  if (!cloudName || !apiKey || !apiSecret) return res.json({ cloudName: null }); // not configured -> frontend falls back to base64
  const timestamp = Math.round(Date.now() / 1000);
  const params = folder ? { folder, timestamp } : { timestamp };
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const signature = crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
  res.json({ cloudName, apiKey, timestamp, signature, folder: folder || undefined });
});

/* ------------------------------------------------------ static frontend */
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND_DIR));
// SPA-style catch-all (only for non-API paths) -> serve the dashboard
app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

/* ---------------------------------------------------------------- boot */
initDb()
  .catch((e) => console.error('[db] init failed:', e.message))
  .finally(() => {
    app.listen(PORT, () => console.log(`Cars24 Social Calendar running on http://localhost:${PORT}`));
  });