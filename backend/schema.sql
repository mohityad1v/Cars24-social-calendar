-- Cars24 Social Calendar — database schema
-- This runs automatically on server boot (CREATE TABLE IF NOT EXISTS),
-- so you normally don't need to run it by hand. Kept here for reference
-- and for anyone who wants to inspect/apply it manually in Neon's SQL editor.

CREATE TABLE IF NOT EXISTS campaigns (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  start_date    TEXT,           -- YYYY-MM-DD (kept as text to avoid timezone drift)
  end_date      TEXT,
  platform      TEXT,
  posts         INTEGER DEFAULT 0,
  reach         BIGINT  DEFAULT 0,
  eng           NUMERIC DEFAULT 0,
  status        TEXT DEFAULT 'done',    -- done | live | upcoming
  types         JSONB DEFAULT '[]'::jsonb,  -- e.g. ["ad","ooh"]
  amplification TEXT,
  notes         TEXT,
  hero          TEXT,           -- Cloudinary secure_url (or base64 fallback)
  video         TEXT,
  gallery       JSONB DEFAULT '[]'::jsonb,  -- ["url", ...]
  media         JSONB DEFAULT '[]'::jsonb,  -- [{url,thumb,label}, ...]
  link          TEXT,
  sample        BOOLEAN DEFAULT false,
  sort_order    INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- UI state that isn't campaign-specific: starred/done day marks, removed days,
-- image focal points & zoom, custom categories. One row per blob.
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,   -- marks | removed | heropos | monthpos | herozoom | monthzoom | herofit | types
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);