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
  console.log(`\n[composio] Strava webhook URL:`);
  console.log(`  ${STRAVA_URL}`);
  console.log('\n── Manual Composio step ──────────────────────────────────────────');
  console.log('Composio v3 dropped HTTP callback support for Strava triggers.');
  console.log('Set up the trigger in the dashboard (takes ~30 seconds):');
  console.log('  1. Open https://app.composio.dev/triggers');
  console.log('  2. Add Trigger → Strava → "New Activity Created"');
  console.log('  3. Set the webhook URL above');
  console.log('──────────────────────────────────────────────────────────────────\n');
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
