'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertExpectedUserId,
  calculateSchedule,
  createApp,
  getErrorMessage,
  loadConfig,
  loadRotationState,
  parseTweetIds,
  randomMinutes,
  remainingCycleDelay,
  retryDelayMs,
  runCycle,
  selectNextTweetId,
  selectRandomTweetId,
  start,
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
  assert.throws(() => loadConfig({ ...validEnv, EXPECTED_USER_ID: 'wrong' }), /EXPECTED_USER_ID/);
});

test('expected user guard refuses a changed account', () => {
  assert.doesNotThrow(() => assertExpectedUserId('123', '123'));
  assert.throws(() => assertExpectedUserId('456', '123'), /EXPECTED_USER_ID/);
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

test('rotation persists the next target and a restart delay', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'd4d-xrt-bot-'));
  const stateFile = path.join(directory, 'rotation.json');
  try {
    const state = { rotation: loadRotationState(stateFile) };
    assert.equal(selectNextTweetId(['11', '22', '33'], state, () => 0, stateFile), '11');
    assert.equal(selectNextTweetId(['11', '22', '33'], state, () => 0, stateFile), '22');

    const resumed = { rotation: loadRotationState(stateFile) };
    assert.equal(resumed.rotation.lastTweetId, '22');
    assert.equal(selectNextTweetId(['11', '22', '33'], resumed, () => 0, stateFile), '33');
    assert.ok(remainingCycleDelay(resumed.rotation.lastCycleAt, 480) > 0);
    assert.equal(remainingCycleDelay(Date.now() - 9 * 60 * 60_000, 480), 0);

    fs.writeFileSync(stateFile, '{broken json');
    assert.throws(() => loadRotationState(stateFile), /Cannot read STATE_FILE/);
  } finally {
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    fs.rmdirSync(directory);
  }
});

test('billing retries back off without exceeding a day', () => {
  const state = { billingFailures: 0 };
  const config = { cycleMinutes: 480 };
  const error = { code: 402, message: 'Payment Required' };
  assert.equal(retryDelayMs(error, config, state), 8 * 60 * 60_000);
  assert.equal(retryDelayMs(error, config, state), 16 * 60 * 60_000);
  assert.equal(retryDelayMs(error, config, state), 24 * 60 * 60_000);
});

test('402 during unretweet skips the repost write and queues one retry', async () => {
  const timers = [];
  let postCalls = 0;
  const state = { botStatus: 'running', billingFailures: 0, rotation: loadRotationState(null) };
  const config = { tweetIds: ['11', '22'], minDelayMinutes: 15, maxDelayMinutes: 45, cycleMinutes: 480 };
  const client = { v2: {
    delete: async () => { throw { code: 402, message: 'Credits depleted' }; },
    post: async () => { postCalls += 1; },
  } };
  const result = await runCycle({
    client, userId: '123', config, state,
    logger: { info() {}, warn() {}, error() {} },
    random: () => 0,
    setTimeoutFn: (fn, delay) => { timers.push({ fn, delay }); },
  });
  assert.equal(result.failed, true);
  assert.equal(state.botStatus, 'error');
  assert.equal(state.lastFailure.httpStatus, 402);
  assert.equal(postCalls, 0);
  assert.equal(state.rotation.pending.tweetId, '11');
  assert.equal(state.rotation.pending.stage, 'unretweet-pending');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 8 * 60 * 60_000);
});

test('a deleted target is skipped and the next cycle advances', async () => {
  const timers = [];
  let postCalls = 0;
  const state = { botStatus: 'running', billingFailures: 0, rotation: loadRotationState(null) };
  const config = { tweetIds: ['11', '22'], minDelayMinutes: 15, maxDelayMinutes: 45, cycleMinutes: 60 };
  const client = { v2: {
    delete: async () => { throw { code: 404, message: 'Not found' }; },
    post: async () => { postCalls += 1; throw { code: 404, message: 'Post was deleted' }; },
  } };
  await runCycle({
    client, userId: '123', config, state,
    logger: { info() {}, warn() {}, error() {} },
    random: () => 0,
    setTimeoutFn: (fn, delay) => { timers.push({ fn, delay }); },
  });
  state.rotation.pending.retweetAt = Date.now() - 1;
  await timers[0].fn();
  assert.equal(state.botStatus, 'error');
  assert.equal(state.rotation.lastTweetId, '11');
  assert.equal(state.rotation.nextIndex, 1);
  assert.equal(state.rotation.pending, null);
  assert.equal(postCalls, 1);
  assert.equal(timers.length, 2);
});

test('a later successful repost restores health after a billing failure', async () => {
  const timers = [];
  let postCalls = 0;
  const state = { botStatus: 'running', billingFailures: 0, rotation: loadRotationState(null) };
  const config = { tweetIds: ['11', '22'], minDelayMinutes: 15, maxDelayMinutes: 45, cycleMinutes: 60 };
  const client = { v2: {
    delete: async () => {},
    post: async (_url, body) => {
      assert.equal(body.tweet_id, '11');
      postCalls += 1;
      if (postCalls === 1) throw { code: 402, message: 'Credits depleted' };
    },
  } };
  const setTimeoutFn = (fn, delay) => { timers.push({ fn, delay }); };
  const options = {
    client, userId: '123', config, state,
    logger: { info() {}, warn() {}, error() {} },
    random: () => 0, setTimeoutFn,
  };
  await runCycle(options);
  assert.equal(timers.length, 1);
  state.rotation.pending.retweetAt = Date.now() - 1;
  await timers[0].fn();
  assert.equal(state.botStatus, 'error');
  assert.equal(timers.length, 2);
  assert.equal(timers[1].delay, 60 * 60_000);
  assert.equal(state.rotation.pending.tweetId, '11');

  await timers[1].fn();
  assert.equal(state.rotation.lastTweetId, '11');
  assert.equal(state.rotation.pending.stage, 'retweet-pending');
  assert.equal(timers.length, 3);
  assert.equal(postCalls, 1);
  state.rotation.pending.retweetAt = Date.now() - 1;
  await timers[2].fn();
  assert.equal(state.rotation.pending, null);
  assert.equal(postCalls, 2);
  assert.equal(state.botStatus, 'running');
  assert.equal(state.lastFailure, null);
});

test('a restart deletes any uncertain repost, waits, and reports healthy after X recovery', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'd4d-xrt-bot-'));
  const stateFile = path.join(directory, 'rotation.json');
  const retweetAt = Date.now() + 15 * 60_000;
  fs.writeFileSync(stateFile, JSON.stringify({
    nextIndex: 1, lastTweetId: '11', lastCycleAt: Date.now(),
    pending: { stage: 'retweet-pending', tweetId: '11', retweetAt, nextCycleAt: Date.now() + 60 * 60_000 },
    retryAt: null, billingFailures: 0,
  }));
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const timers = [];
  let deleteCalls = 0;
  let postCalls = 0;
  const client = { v2: {
    me: async () => ({ data: { id: '123' } }),
    delete: async () => { deleteCalls += 1; },
    post: async () => { postCalls += 1; },
  } };
  let server;
  try {
    const result = await start({
      env: { ...validEnv, PORT: String(port), STATE_FILE: stateFile, EXPECTED_USER_ID: '123' },
      client,
      logger: { info() {}, warn() {}, error() {} },
      setTimeoutFn: (fn, delay) => { timers.push({ fn, delay }); },
    });
    server = result.server;
    if (!server.listening) await once(server, 'listening');
    assert.equal(result.state.botStatus, 'running');
    assert.equal(deleteCalls, 1);
    assert.equal(postCalls, 0);
    assert.equal(timers.length, 1);
    assert.ok(timers[0].delay >= 15 * 60_000 - 5_000);
    assert.equal(result.state.rotation.pending.stage, 'retweet-pending');
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { connection: 'close' } });
    assert.equal(response.status, 200);
    result.state.rotation.pending.retweetAt = Date.now() - 1;
    await timers[0].fn();
    assert.equal(postCalls, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.unlinkSync(stateFile);
    fs.rmdirSync(directory);
  }
});

test('a persisted billing backoff stays live but reports degraded X health', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'd4d-xrt-bot-'));
  const stateFile = path.join(directory, 'rotation.json');
  const now = Date.now();
  fs.writeFileSync(stateFile, JSON.stringify({
    nextIndex: 1, lastTweetId: '11', lastCycleAt: now,
    pending: { stage: 'retweet-pending', tweetId: '11', retweetAt: now, nextCycleAt: now + 60 * 60_000 },
    retryAt: now + 8 * 60 * 60_000, billingFailures: 1,
  }));
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const timers = [];
  let server;
  try {
    const result = await start({
      env: { ...validEnv, PORT: String(port), STATE_FILE: stateFile },
      client: { v2: { me: async () => ({ data: { id: '123' } }) } },
      logger: { info() {}, warn() {}, error() {} },
      setTimeoutFn: (fn, delay) => { timers.push({ fn, delay }); },
    });
    server = result.server;
    if (!server.listening) await once(server, 'listening');
    assert.equal(timers.length, 1);
    assert.ok(timers[0].delay > 0);
    const live = await fetch(`http://127.0.0.1:${port}/livez`, { headers: { connection: 'close' } });
    const health = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { connection: 'close' } });
    assert.equal(live.status, 200);
    assert.equal(health.status, 503);
    assert.equal((await health.json()).botStatus, 'error');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.unlinkSync(stateFile);
    fs.rmdirSync(directory);
  }
});

test('GET /healthz reports HTTP 503 for starting and failed states', async () => {
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

    state.botStatus = 'error';
    const failedResponse = await fetch(`http://127.0.0.1:${port}/healthz`);
    const failedBody = await failedResponse.json();
    assert.equal(failedResponse.status, 503);
    assert.equal(failedBody.status, 'degraded');
    const liveResponse = await fetch(`http://127.0.0.1:${port}/livez`, {
      headers: { connection: 'close' },
    });
    assert.equal(liveResponse.status, 200);
    assert.deepEqual(await liveResponse.json(), { status: 'alive' });

    state.botStatus = 'starting';
    const startingResponse = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(startingResponse.status, 503);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
