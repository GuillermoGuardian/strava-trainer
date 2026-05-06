'use strict';

require('dotenv').config();

const PUBLIC_URL = process.argv[2];
if (!PUBLIC_URL) {
  console.error('Usage: node setup-webhooks.js <PUBLIC_URL>');
  console.error('Example: node setup-webhooks.js https://myapp.up.railway.app');
  process.exit(1);
}

const TELEGRAM_URL = `${PUBLIC_URL}/webhook/telegram`;
const STRAVA_URL   = `${PUBLIC_URL}/webhook/strava/${process.env.COMPOSIO_WEBHOOK_SECRET}`;

async function setupTelegram() {
  console.log(`\n[telegram] Registering webhook → ${TELEGRAM_URL}`);
  const res = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: TELEGRAM_URL,
        secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ['message', 'edited_message'],
      }),
    }
  );
  const data = await res.json();
  if (data.ok) console.log('[telegram] ✓ Webhook registered');
  else console.error('[telegram] ✗ Failed:', JSON.stringify(data));
}

async function setupComposio() {
  console.log(`\n[composio] Configuring Strava trigger → ${STRAVA_URL}`);

  // Step 1: set the global webhook callback URL for this Composio account
  const cbRes = await fetch(
    'https://backend.composio.dev/api/v1/triggers/set_callback_url',
    {
      method: 'POST',
      headers: {
        'x-api-key': process.env.COMPOSIO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ callbackURL: STRAVA_URL }),
    }
  );
  const cbData = await cbRes.json();
  if (!cbRes.ok) {
    console.warn('[composio] set_callback_url returned', cbRes.status, JSON.stringify(cbData));
  } else {
    console.log('[composio] ✓ Callback URL set');
  }

  // Step 2: enable the STRAVA_NEW_ACTIVITY_CREATED trigger for the default entity
  const trigRes = await fetch(
    'https://backend.composio.dev/api/v1/triggers/enable',
    {
      method: 'POST',
      headers: {
        'x-api-key': process.env.COMPOSIO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        triggerName: 'STRAVA_CREATE_ACTIVITY',
        entityId: 'default',
        triggerConfig: {},
      }),
    }
  );
  const trigData = await trigRes.json();
  if (!trigRes.ok) {
    console.warn('[composio] enable trigger returned', trigRes.status, JSON.stringify(trigData));
    console.log('\n── Manual Composio step ──────────────────────────────────────');
    console.log('If the auto-config above failed, open the Composio dashboard:');
    console.log('  https://app.composio.dev/triggers');
    console.log('Enable the Strava "New Activity" trigger and set webhook URL to:');
    console.log(`  ${STRAVA_URL}`);
    console.log('──────────────────────────────────────────────────────────────\n');
  } else {
    console.log('[composio] ✓ Strava trigger enabled');
  }
}

(async () => {
  try {
    await setupTelegram();
    await setupComposio();
    console.log('\n✓ Webhook setup complete.\n');
  } catch (err) {
    console.error('setup-webhooks error:', err.message);
    process.exit(1);
  }
})();
