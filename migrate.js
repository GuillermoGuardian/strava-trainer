'use strict';

require('dotenv').config();

const PROJECT_REF = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS activities (
  id           bigserial PRIMARY KEY,
  strava_id    bigint UNIQUE NOT NULL,
  type         text,
  distance_m   double precision,
  moving_time_s integer,
  started_at   timestamptz,
  raw          jsonb,
  created_at   timestamptz DEFAULT now()
);
`.trim();

async function run() {
  console.log(`Targeting Supabase project: ${PROJECT_REF}`);

  // Try Supabase Management API (requires a Personal Access Token, not service key).
  // This will 401 if you don't have a PAT — that's expected.
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: CREATE_SQL }),
    }
  );

  if (res.ok) {
    console.log('✓ activities table created (or already exists)');
    return;
  }

  const body = await res.text();
  console.warn(`Management API returned ${res.status}: ${body}`);
  console.log('\n── Manual step required ────────────────────────────────────');
  console.log('Paste the following SQL into your Supabase SQL editor:');
  console.log('  https://supabase.com/dashboard/project/' + PROJECT_REF + '/sql/new');
  console.log('\n' + CREATE_SQL + '\n');
  console.log('────────────────────────────────────────────────────────────\n');
  process.exit(1);
}

run().catch((err) => {
  console.error('migrate error:', err.message);
  process.exit(1);
});
