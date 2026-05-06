'use strict';

require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// POST /webhook/strava/:secret
// Composio posts here after every Strava activity. The secret in the path
// acts as a shared credential since Composio doesn't yet sign payloads.
app.post('/webhook/strava/:secret', async (req, res) => {
  if (req.params.secret !== process.env.COMPOSIO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Composio wraps Strava data differently across trigger types — handle variants
  const body = req.body;
  const activity =
    body.client_payload ??
    body.clientPayload ??
    body.payload ??
    body.data ??
    body;

  const stravaId = activity.id ?? activity.strava_id;
  if (!stravaId) {
    console.warn('[strava] payload missing activity id — skipped');
    return res.status(200).json({ ok: true, skipped: true });
  }

  const { error } = await supabase.from('activities').upsert(
    {
      strava_id: Number(stravaId),
      type: activity.type ?? activity.sport_type ?? null,
      distance_m: activity.distance ?? null,
      moving_time_s: activity.moving_time ?? null,
      started_at: activity.start_date ?? null,
      raw: activity,
    },
    { onConflict: 'strava_id' }
  );

  if (error) console.error('[strava] upsert error:', error.message);
  else console.log(`[strava] upserted activity ${stravaId}`);

  res.status(200).json({ ok: true });
});

// POST /webhook/telegram
// Telegram sends updates here. Always respond 200 first to prevent retries,
// then process asynchronously.
app.post('/webhook/telegram', async (req, res) => {
  const token = req.headers['x-telegram-bot-api-secret-token'];
  if (token !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.status(200).json({ ok: true }); // respond before processing

  try {
    const update = req.body;
    const message = update.message ?? update.edited_message;
    if (!message?.text) return;

    const chatId = message.chat.id;
    const userText = message.text;

    console.log(`[telegram] chat=${chatId} text="${userText.slice(0, 80)}"`);

    const reply = await getCoachingResponse(userText);

    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: reply }),
      }
    );
  } catch (err) {
    console.error('[telegram] handler error:', err.message);
  }
});

// GET /health
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

async function getCoachingResponse(userText) {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const { data: activities, error } = await supabase
    .from('activities')
    .select('type, distance_m, moving_time_s, started_at')
    .gte('started_at', since)
    .order('started_at', { ascending: false });

  if (error) throw error;

  let trainingBlock;
  if (!activities || activities.length === 0) {
    trainingBlock = 'No activities logged in the last 14 days.';
  } else {
    trainingBlock = activities
      .map((a) => {
        const date = new Date(a.started_at).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        });

        const distMi = ((a.distance_m ?? 0) * 0.000621371).toFixed(2);
        const totalSecs = a.moving_time_s ?? 0;
        const h = Math.floor(totalSecs / 3600);
        const m = Math.floor((totalSecs % 3600) / 60);
        const s = totalSecs % 60;
        const timeStr =
          h > 0
            ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${m}:${String(s).padStart(2, '0')}`;

        const distMiNum = parseFloat(distMi);
        let paceStr = 'N/A';
        if (distMiNum > 0 && totalSecs > 0) {
          const paceMpM = totalSecs / 60 / distMiNum;
          const paceMin = Math.floor(paceMpM);
          const paceSec = Math.round((paceMpM - paceMin) * 60);
          paceStr = `${paceMin}:${String(paceSec).padStart(2, '0')}/mi`;
        }

        return `${date} | ${a.type ?? 'Unknown'} | ${distMi} mi | ${timeStr} | ${paceStr}`;
      })
      .join('\n');
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system:
      "You are an expert endurance coach. Give concrete, personalized advice based on the athlete's recent training. Be direct and specific. Use imperial units.",
    messages: [
      {
        role: 'user',
        content: `Recent training (last 14 days):\n${trainingBlock}\n\nAthlete: ${userText}`,
      },
    ],
  });

  return response.content[0].text;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
