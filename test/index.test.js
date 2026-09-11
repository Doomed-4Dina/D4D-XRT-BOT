'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');

const {
  calculateSchedule,
  createApp,
  getErrorMessage,
  loadConfig,
  parseTweetIds,
  randomMinutes,
  selectRandomTweetId,
} = require('../index');

const validEnv = {
  APP_KEY: 'app-key',
  APP_SECRET: 'app-secret',
  ACCESS_TOKEN: 'access-token',
  ACCESS_SECRET: 'access-secret',
  TWEET_IDS: '123456789,987654321',
};

test('parseTweetIds trims and de-duplicates numeric IDs', () => {
  assert.deepEqual(parseTweetIds(' 123,456,123 '), ['123', '456']);
});

test('parseTweetIds rejects empty and non-numeric values', () => {
  assert.throws(() => parseTweetIds(''), /at least one tweet ID/);
  assert.throws(() => parseTweetIds('123,not-an-id'), /invalid values: not-an-id/);
});

test('loadConfig applies defaults and validates required variables', () => {
  const config = loadConfig(validEnv);

  assert.equal(config.port, 3000);
  assert.equal(config.minDelayMinutes, 15);
  assert.equal(config.maxDelayMinutes, 45);
  assert.equal(config.cycleMinutes, 60);
  assert.deepEqual(config.tweetIds, ['123456789', '987654321']);

  assert.throws(
    () => loadConfig({ ...validEnv, APP_KEY: '' }),
    /Missing required environment variables: APP_KEY/,
  );
});

test('loadConfig rejects invalid scheduler ranges and ports', () => {
  assert.throws(
    () => loadConfig({ ...validEnv, MIN_DELAY_MINUTES: '46', MAX_DELAY_MINUTES: '45' }),
    /MIN_DELAY_MINUTES/,
  );
  assert.throws(
    () => loadConfig({ ...validEnv, MAX_DELAY_MINUTES: '60', CYCLE_MINUTES: '60' }),
    /MAX_DELAY_MINUTES/,
  );
  assert.throws(() => loadConfig({ ...validEnv, PORT: '70000' }), /PORT/);
});

test('random selection helpers honor deterministic random sources', () => {
  assert.equal(randomMinutes(15, 45, () => 0), 15);
  assert.equal(randomMinutes(15, 45, () => 0.999999), 45);
  assert.equal(selectRandomTweetId(['one', 'two'], () => 0.75), 'two');
});

test('calculateSchedule returns exact retweet and cycle timestamps', () => {
  const start = Date.UTC(2026, 0, 1);
  const schedule = calculateSchedule({
    start,
    minDelayMinutes: 15,
    maxDelayMinutes: 45,
    cycleMinutes: 60,
    random: () => 0,
  });

  assert.deepEqual(schedule, {
    retweetDelayMs: 15 * 60_000,
    retweetAt: start + 15 * 60_000,
    nextCycleAt: start + 60 * 60_000,
  });
});

test('getErrorMessage reads X API errors and ordinary errors', () => {
  assert.equal(getErrorMessage({ data: { errors: [{ message: 'API failed' }] } }), 'API failed');
  assert.equal(getErrorMessage(new Error('ordinary failure')), 'ordinary failure');
});

test('GET /healthz reports service and bot state', async () => {
  const state = { botStatus: 'running', startedAt: Date.now() - 2_000 };
  const server = createApp({ state }).listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { connection: 'close' },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.botStatus, 'running');
    assert.ok(body.uptimeSeconds >= 1);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
