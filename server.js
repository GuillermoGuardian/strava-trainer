'use strict';

require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();

// Capture raw body for Composio signature verification before JSON parsing
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

// ─── Composio/Strava webhook ──────────────────────────────────────────────────

// Verifies the Composio v3 HMAC-SHA256 webhook signature.
// Composio signs with: HMAC-SHA256({webhook-id}.{webhook-timestamp}.{rawBody})
// and puts the result in the `webhook-signature` header as "v1,<base64>".
function verifyComposioSignature(req) {
  const sig       = req.headers['webhook-signature'] || '';
  const timestamp = req.headers['webhook-timestamp'] || '';
  const id        = req.headers['webhook-id']        || '';
  const secret    = process.env.COMPOSIO_SIGNING_SECRET || '';

  if (!sig || !timestamp || !id || !secret) return false;

  const message  = `${id}.${timestamp}.${req.rawBody}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('base64');

  // Header may contain multiple space-separated signatures; accept any v1 match
  return sig.split(' ').some((s) => {
    const [ver, val] = s.split(',');
    if (ver !== 'v1' || !val) return false;
    return crypto.timingSafeEqual(Buffer.from(val), Buffer.from(expected));
  });
}

app.post('/webhook/strava', async (req, res) => {
  if (!verifyComposioSignature(req)) {
    console.warn('[strava] invalid signature — rejected');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.status(200).json({ ok: true });

  try {
    const body = req.body;

    // Composio v3 wraps the activity in various shapes; unwrap all of them
    const activity =
      body?.payload?.data ??
      body?.data ??
      body?.client_payload ??
      body?.clientPayload ??
      body?.payload ??
      body;

    const stravaId = activity?.id ?? activity?.strava_id;
    if (!stravaId) {
      console.warn('[strava] no activity id in payload — skipped');
      return;
    }

    const { error } = await supabase.from('activities').upsert(
      {
        strava_id:     Number(stravaId),
        type:          activity.type          ?? activity.sport_type ?? null,
        distance_m:    activity.distance      ?? null,
        moving_time_s: activity.moving_time   ?? null,
        started_at:    activity.start_date    ?? null,
        raw:           activity,
      },
      { onConflict: 'strava_id' }
    );

    if (error) console.error('[strava] upsert error:', error.message);
    else console.log(`[strava] upserted activity ${stravaId}`);
  } catch (err) {
    console.error('[strava] handler error:', err.message);
  }
});

// ─── Telegram webhook ─────────────────────────────────────────────────────────

app.post('/webhook/telegram', async (req, res) => {
  const token = req.headers['x-telegram-bot-api-secret-token'];
  if (token !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.status(200).json({ ok: true });

  try {
    const update  = req.body;
    const message = update.message ?? update.edited_message;
    if (!message?.text) return;

    const chatId   = message.chat.id;
    const userText = message.text;
    console.log(`[telegram] chat=${chatId} text="${userText.slice(0, 80)}"`);

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
    console.error('[telegram] handler error:', err.message);
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

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
