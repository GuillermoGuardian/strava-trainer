'use strict';

require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();

// Capture raw body before JSON parsing — needed for Composio HMAC verification
app.use(
  express.json({
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
  })
);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Strava direct webhook ────────────────────────────────────────────────────

// GET — Strava calls this once during webhook subscription to verify ownership.
// Responds with the hub.challenge value if the verify_token matches.
app.get('/webhook/strava', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.STRAVA_VERIFY_TOKEN) {
    console.log('[strava] subscription verified');
    return res.json({ 'hub.challenge': challenge });
  }
  res.status(403).json({ error: 'Forbidden' });
});

// POST — Strava sends a minimal event; we fetch the full activity and upsert.
app.post('/webhook/strava', async (req, res) => {
  res.status(200).json({ ok: true }); // must ack within 2 s

  try {
    const event = req.body;
    if (event.object_type !== 'activity' || event.aspect_type !== 'create') return;

    const activityId = event.object_id;
    console.log(`[strava] new activity ${activityId}`);

    const token   = await getStravaToken();
    const actRes  = await fetch(
      `https://www.strava.com/api/v3/activities/${activityId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const activity = await actRes.json();

    if (!activity.id) {
      console.error('[strava] unexpected response:', JSON.stringify(activity).slice(0, 200));
      return;
    }

    const { error } = await supabase.from('activities').upsert(
      {
        strava_id:     activity.id,
        type:          activity.type          ?? activity.sport_type ?? null,
        distance_m:    activity.distance      ?? null,
        moving_time_s: activity.moving_time   ?? null,
        started_at:    activity.start_date    ?? null,
        raw:           activity,
      },
      { onConflict: 'strava_id' }
    );

    if (error) console.error('[strava] upsert error:', error.message);
    else console.log(`[strava] saved ${activity.type} ${activityId}`);
  } catch (err) {
    console.error('[strava] handler error:', err.message);
  }
});

// ─── Strava OAuth (one-time setup) ───────────────────────────────────────────

// Visit this URL in a browser once to authorise your Strava app and store tokens.
app.get('/auth/strava', (req, res) => {
  const params = new URLSearchParams({
    client_id:       process.env.STRAVA_CLIENT_ID,
    response_type:   'code',
    redirect_uri:    `${process.env.PUBLIC_URL}/auth/strava/callback`,
    approval_prompt: 'force',
    scope:           'activity:read_all',
  });
  res.redirect(`https://www.strava.com/oauth/authorize?${params}`);
});

app.get('/auth/strava/callback', async (req, res) => {
  const { code, error: oauthErr } = req.query;
  if (oauthErr) return res.status(400).send(`OAuth error: ${oauthErr}`);

  const tokenRes = await fetch('https://www.strava.com/oauth/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      client_id:     process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type:    'authorization_code',
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokens.access_token) return res.status(400).json(tokens);

  await saveTokens(tokens);
  console.log('[strava] OAuth complete — tokens stored in Supabase');
  res.send('<h2>✓ Strava connected!</h2><p>You can close this tab. Your coaching bot is fully wired up.</p>');
});

// ─── Telegram webhook ─────────────────────────────────────────────────────────

app.post('/webhook/telegram', async (req, res) => {
  const token = req.headers['x-telegram-bot-api-secret-token'];
  if (token !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.status(200).json({ ok: true });

  try {
    const message = req.body.message ?? req.body.edited_message;
    if (!message?.text) return;

    const chatId   = message.chat.id;
    const userText = message.text;
    console.log(`[telegram] chat=${chatId} "${userText.slice(0, 80)}"`);

    const reply = await getCoachingResponse(userText);

    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ chat_id: chatId, text: reply }),
      }
    );
  } catch (err) {
    console.error('[telegram] error:', err.message);
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

// ─── Coaching ─────────────────────────────────────────────────────────────────

async function getCoachingResponse(userText) {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const { data: activities, error } = await supabase
    .from('activities')
    .select('type, distance_m, moving_time_s, started_at')
    .gte('started_at', since)
    .order('started_at', { ascending: false });

  if (error) throw error;

  const trainingBlock = (!activities || activities.length === 0)
    ? 'No activities logged in the last 14 days.'
    : activities.map((a) => {
        const date      = new Date(a.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const distMi    = ((a.distance_m ?? 0) * 0.000621371).toFixed(2);
        const totalSecs = a.moving_time_s ?? 0;
        const h         = Math.floor(totalSecs / 3600);
        const m         = Math.floor((totalSecs % 3600) / 60);
        const s         = totalSecs % 60;
        const timeStr   = h > 0
          ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
          : `${m}:${String(s).padStart(2,'0')}`;
        const distMiNum = parseFloat(distMi);
        let paceStr = 'N/A';
        if (distMiNum > 0 && totalSecs > 0) {
          const p = totalSecs / 60 / distMiNum;
          paceStr = `${Math.floor(p)}:${String(Math.round((p - Math.floor(p)) * 60)).padStart(2,'0')}/mi`;
        }
        return `${date} | ${a.type ?? 'Unknown'} | ${distMi} mi | ${timeStr} | ${paceStr}`;
      }).join('\n');

  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1024,
    system:     "You are an expert endurance coach. Give concrete, personalized advice based on the athlete's recent training. Be direct and specific. Use imperial units.",
    messages:   [{ role: 'user', content: `Recent training (last 14 days):\n${trainingBlock}\n\nAthlete: ${userText}` }],
  });

  return response.content[0].text;
}

// ─── Strava token management (stored in Supabase) ────────────────────────────

async function getStravaToken() {
  const { data: rows } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', ['strava_access_token', 'strava_refresh_token', 'strava_token_expires_at']);

  const kv         = Object.fromEntries((rows || []).map(r => [r.key, r.value]));
  const expiresAt  = parseInt(kv.strava_token_expires_at || '0', 10);

  if (kv.strava_access_token && Date.now() / 1000 < expiresAt - 300) {
    return kv.strava_access_token;
  }

  // Token expired — refresh it
  const res    = await fetch('https://www.strava.com/oauth/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      client_id:     process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: kv.strava_refresh_token,
      grant_type:    'refresh_token',
    }),
  });
  const tokens = await res.json();
  await saveTokens(tokens);
  return tokens.access_token;
}

async function saveTokens(tokens) {
  await supabase.from('settings').upsert([
    { key: 'strava_access_token',     value: tokens.access_token },
    { key: 'strava_refresh_token',    value: tokens.refresh_token },
    { key: 'strava_token_expires_at', value: String(tokens.expires_at) },
  ]);
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
