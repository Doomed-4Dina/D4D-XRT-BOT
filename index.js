'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { TwitterApi } = require('twitter-api-v2');

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_BILLING_RETRY_MS = 24 * HOUR_MS;
const REQUIRED_ENV_VARIABLES = [
  'APP_KEY',
  'APP_SECRET',
  'ACCESS_TOKEN',
  'ACCESS_SECRET',
  'TWEET_IDS',
];

function parseTweetIds(value) {
  if (typeof value !== 'string') {
    throw new Error('TWEET_IDS must be a comma-separated list of numeric tweet IDs.');
  }

  const tweetIds = [...new Set(value.split(',').map((id) => id.trim()).filter(Boolean))];
  const invalidTweetIds = tweetIds.filter((id) => !/^\d+$/.test(id));

  if (tweetIds.length === 0) {
    throw new Error('TWEET_IDS must contain at least one tweet ID.');
  }

  if (invalidTweetIds.length > 0) {
    throw new Error(`TWEET_IDS contains invalid values: ${invalidTweetIds.join(', ')}`);
  }

  return tweetIds;
}

function parsePositiveInteger(name, value, fallback) {
  const resolvedValue = value ?? fallback;
  const parsedValue = Number(resolvedValue);

  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsedValue;
}

function loadConfig(env = process.env) {
  const missingVariables = REQUIRED_ENV_VARIABLES.filter(
    (name) => typeof env[name] !== 'string' || env[name].trim() === '',
  );

  if (missingVariables.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVariables.join(', ')}`);
  }

  const port = parsePositiveInteger('PORT', env.PORT, 3000);
  const minDelayMinutes = parsePositiveInteger(
    'MIN_DELAY_MINUTES',
    env.MIN_DELAY_MINUTES,
    15,
  );
  const maxDelayMinutes = parsePositiveInteger(
    'MAX_DELAY_MINUTES',
    env.MAX_DELAY_MINUTES,
    45,
  );
  const cycleMinutes = parsePositiveInteger('CYCLE_MINUTES', env.CYCLE_MINUTES, 60);

  if (port > 65_535) {
    throw new Error('PORT must be between 1 and 65535.');
  }

  if (minDelayMinutes > maxDelayMinutes) {
    throw new Error('MIN_DELAY_MINUTES must be less than or equal to MAX_DELAY_MINUTES.');
  }

  if (maxDelayMinutes >= cycleMinutes) {
    throw new Error('MAX_DELAY_MINUTES must be less than CYCLE_MINUTES.');
  }
  if (env.EXPECTED_USER_ID && !/^\d+$/.test(env.EXPECTED_USER_ID)) {
    throw new Error('EXPECTED_USER_ID must be a numeric X user ID.');
  }

  return Object.freeze({
    appKey: env.APP_KEY,
    appSecret: env.APP_SECRET,
    accessToken: env.ACCESS_TOKEN,
    accessSecret: env.ACCESS_SECRET,
    tweetIds: Object.freeze(parseTweetIds(env.TWEET_IDS)),
    port,
    minDelayMinutes,
    maxDelayMinutes,
    cycleMinutes,
    expectedUserId: env.EXPECTED_USER_ID || null,
    stateFile: env.STATE_FILE || null,
  });
}

function randomMinutes(min, max, random = Math.random) {
  return Math.floor(random() * (max - min + 1)) + min;
}

function selectRandomTweetId(tweetIds, random = Math.random) {
  if (!Array.isArray(tweetIds) || tweetIds.length === 0) {
    throw new Error('At least one tweet ID is required.');
  }

  return tweetIds[Math.floor(random() * tweetIds.length)];
}

function loadRotationState(stateFile) {
  const empty = {
    nextIndex: null,
    lastTweetId: null,
    lastCycleAt: null,
    pending: null,
    retryAt: null,
    billingFailures: 0,
  };
  if (!stateFile) return empty;
  if (!fs.existsSync(path.dirname(stateFile))) {
    throw new Error('STATE_FILE directory does not exist; mount a persistent volume first.');
  }

  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return empty;
    throw new Error(`Cannot read STATE_FILE: ${error.message}`);
  }
  const pending = saved?.pending ?? null;
  if (!saved || typeof saved !== 'object' ||
      (saved.nextIndex !== null && (!Number.isSafeInteger(saved.nextIndex) || saved.nextIndex < 0)) ||
      (saved.lastCycleAt !== null && (!Number.isSafeInteger(saved.lastCycleAt) || saved.lastCycleAt < 0)) ||
      (saved.lastTweetId !== null && !/^\d+$/.test(saved.lastTweetId)) ||
      (saved.retryAt != null && (!Number.isSafeInteger(saved.retryAt) || saved.retryAt < 0)) ||
      (saved.billingFailures != null && (!Number.isSafeInteger(saved.billingFailures) || saved.billingFailures < 0)) ||
      (pending !== null && (
        !['unretweet-pending', 'retweet-pending'].includes(pending.stage) ||
        !/^\d+$/.test(pending.tweetId) ||
        !Number.isSafeInteger(pending.retweetAt) ||
        !Number.isSafeInteger(pending.nextCycleAt)
      ))) {
    throw new Error('STATE_FILE contains an invalid rotation checkpoint.');
  }
  return { ...empty, ...saved, pending };
}

function saveRotationState(state, stateFile, nextRotation) {
  if (stateFile) {
    const tempFile = `${stateFile}.${process.pid}.tmp`;
    if (!fs.existsSync(path.dirname(stateFile))) {
      throw new Error('STATE_FILE directory does not exist; mount a persistent volume first.');
    }
    try {
      fs.writeFileSync(tempFile, JSON.stringify(nextRotation), { mode: 0o600 });
      fs.renameSync(tempFile, stateFile);
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  }
  state.rotation = nextRotation;
}

function selectNextTweetId(tweetIds, state, random = Math.random, stateFile = null, schedule = null) {
  if (!Array.isArray(tweetIds) || tweetIds.length === 0) {
    throw new Error('At least one tweet ID is required.');
  }
  const rotation = state.rotation || loadRotationState(null);
  if (rotation.pending) throw new Error('Cannot select another target while a repost is pending.');
  let index = rotation.nextIndex === null
    ? Math.floor(random() * tweetIds.length)
    : rotation.nextIndex % tweetIds.length;
  if (tweetIds.length > 1 && tweetIds[index] === rotation.lastTweetId) {
    index = (index + 1) % tweetIds.length;
  }

  const tweetId = tweetIds[index];
  const nextRotation = {
    ...rotation,
    nextIndex: (index + 1) % tweetIds.length,
    lastTweetId: tweetId,
    lastCycleAt: Date.now(),
    pending: schedule ? {
      stage: 'unretweet-pending',
      tweetId,
      retweetAt: schedule.retweetAt,
      nextCycleAt: schedule.nextCycleAt,
    } : null,
    retryAt: null,
    billingFailures: 0,
  };
  saveRotationState(state, stateFile, nextRotation);
  return tweetId;
}

function calculateSchedule({
  start,
  minDelayMinutes,
  maxDelayMinutes,
  cycleMinutes,
  random = Math.random,
}) {
  const retweetDelayMs = randomMinutes(minDelayMinutes, maxDelayMinutes, random) * MINUTE_MS;

  return Object.freeze({
    retweetDelayMs,
    retweetAt: start + retweetDelayMs,
    nextCycleAt: start + cycleMinutes * MINUTE_MS,
  });
}

function getErrorMessage(error) {
  return error?.data?.errors?.[0]?.message || error?.message || 'Unknown error';
}

function getErrorStatus(error) {
  for (const candidate of [error?.code, error?.status, error?.response?.status, error?.data?.status]) {
    const status = Number(candidate);
    if (Number.isInteger(status) && status >= 400 && status < 600) return status;
  }
  return null;
}

function isBillingError(error) {
  return getErrorStatus(error) === 402 || /billing|credits?|payment required/i.test(getErrorMessage(error));
}

function retryDelayMs(error, config, state) {
  const cycleMs = config.cycleMinutes * MINUTE_MS;
  if (!isBillingError(error)) {
    state.billingFailures = 0;
    return cycleMs;
  }

  state.billingFailures = (state.billingFailures || 0) + 1;
  const baseMs = Math.max(cycleMs, HOUR_MS);
  const capMs = Math.max(baseMs, MAX_BILLING_RETRY_MS);
  return Math.min(baseMs * (2 ** Math.min(state.billingFailures - 1, 10)), capMs);
}

function assertExpectedUserId(actualUserId, expectedUserId) {
  if (expectedUserId && actualUserId !== expectedUserId) {
    throw new Error('Authenticated X user does not match EXPECTED_USER_ID.');
  }
}

function remainingCycleDelay(lastCycleAt, cycleMinutes, now = Date.now()) {
  return Math.max(0, (lastCycleAt || 0) + (cycleMinutes * MINUTE_MS) - now);
}

function recordFailure(state, phase, error, logger) {
  state.botStatus = 'error';
  state.lastFailure = {
    at: new Date().toISOString(),
    phase,
    httpStatus: getErrorStatus(error),
  };
  logger.warn(`${phase} failed: ${getErrorMessage(error)}`);
}

function createApp({ state = { botStatus: 'starting', startedAt: Date.now() } } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.get('/livez', (_request, response) => {
    response.status(200).json({ status: 'alive' });
  });
  app.get('/healthz', (_request, response) => {
    const healthy = state.botStatus === 'running';
    response.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      botStatus: state.botStatus,
      uptimeSeconds: Math.max(Math.floor((Date.now() - state.startedAt) / 1000), 0),
      lastFailure: state.lastFailure || null,
      nextAttemptAt: state.nextAttemptAt || null,
    });
  });

  return app;
}

function scheduleTask(options, delayMs, task) {
  const { state, logger = console, setTimeoutFn = setTimeout } = options;
  if (state.timerScheduled) throw new Error('A bot action is already scheduled.');
  state.timerScheduled = true;
  state.nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
  setTimeoutFn(() => {
    state.timerScheduled = false;
    state.nextAttemptAt = null;
    return Promise.resolve().then(task).catch((error) => {
      recordFailure(state, 'scheduler', error, logger);
      throw error;
    });
  }, delayMs);
}

function scheduleRetry(options, error, phase) {
  const { config, state, logger = console } = options;
  recordFailure(state, phase, error, logger);
  const delayMs = retryDelayMs(error, config, state);
  saveRotationState(state, config.stateFile, {
    ...state.rotation,
    retryAt: Date.now() + delayMs,
    billingFailures: state.billingFailures,
  });
  scheduleTask(options, delayMs, () => (
    state.rotation.pending ? resumePending(options, true) : runCycle(options)
  ));
  return { failed: true };
}

function resolvePending(options, result) {
  const { config, state, logger = console } = options;
  const pending = state.rotation.pending;
  saveRotationState(state, config.stateFile, {
    ...state.rotation,
    pending: null,
    retryAt: null,
    billingFailures: 0,
  });
  state.billingFailures = 0;
  if (result === 'reposted') {
    state.botStatus = 'running';
    state.lastFailure = null;
  }
  const now = Date.now();
  const delayMs = pending.nextCycleAt > now
    ? Math.max(pending.nextCycleAt - now, MINUTE_MS)
    : config.cycleMinutes * MINUTE_MS;
  logger.info('Next cycle in ' + Math.ceil(delayMs / MINUTE_MS) + ' minutes.');
  scheduleTask(options, delayMs, () => runCycle(options));
}

async function resumePending(options, recover = true) {
  const { client, userId, config, state, logger = console, random = Math.random } = options;
  if (!state.rotation.pending) return runCycle(options);

  try {
    // After a restart or failed write, establish the unreposted state with DELETE.
    // The recovery schedule is saved first, so any further crash repeats this
    // bounded process instead of immediately issuing an uncertain POST.
    if (recover) {
      const start = Date.now();
      const schedule = calculateSchedule({
        start,
        minDelayMinutes: config.minDelayMinutes,
        maxDelayMinutes: config.maxDelayMinutes,
        cycleMinutes: config.cycleMinutes,
        random,
      });
      saveRotationState(state, config.stateFile, {
        ...state.rotation,
        pending: {
          ...state.rotation.pending,
          stage: 'unretweet-pending',
          retweetAt: schedule.retweetAt,
          nextCycleAt: schedule.nextCycleAt,
        },
      });
    }
    const pending = state.rotation.pending;
    if (pending.stage === 'unretweet-pending') {
      try {
        await client.v2.delete('users/' + userId + '/retweets/' + pending.tweetId);
      } catch (error) {
        if (getErrorStatus(error) !== 404) throw error;
        logger.info('No existing repost for ' + pending.tweetId + '.');
      }
      logger.info('Unretweeted ' + pending.tweetId);
      saveRotationState(state, config.stateFile, {
        ...state.rotation,
        pending: { ...pending, stage: 'retweet-pending' },
        retryAt: null,
        billingFailures: 0,
      });
      state.billingFailures = 0;
      return resumePending(options, false);
    }

    const waitMs = Math.max(pending.retweetAt - Date.now(), 0);
    if (waitMs > 0) {
      scheduleTask(options, waitMs, () => resumePending(options, false));
      if (!state.lastFailure) {
        state.botStatus = 'running';
        state.lastFailure = null;
      }
      return { pending: true };
    }

    try {
      await client.v2.post('users/' + userId + '/retweets', { tweet_id: pending.tweetId });
    } catch (error) {
      if (getErrorStatus(error) === 404) {
        recordFailure(state, 'target lookup', error, logger);
        resolvePending(options, 'missing');
        return { failed: true };
      }
      throw error;
    }
    logger.info('Retweeted ' + pending.tweetId);
    resolvePending(options, 'reposted');
    return { reposted: true };
  } catch (error) {
    return scheduleRetry(options, error, state.rotation.pending.stage === 'retweet-pending' ? 'retweet' : 'unretweet');
  }
}

async function runCycle(options) {
  const { client, userId, config, logger = console, random = Math.random, state } = options;
  if (state.rotation.pending) return resumePending(options, true);
  const start = Date.now();
  const schedule = calculateSchedule({
    start,
    minDelayMinutes: config.minDelayMinutes,
    maxDelayMinutes: config.maxDelayMinutes,
    cycleMinutes: config.cycleMinutes,
    random,
  });

  try {
    const tweetId = selectNextTweetId(config.tweetIds, state, random, config.stateFile, schedule);
    logger.info('[' + new Date(start).toISOString() + '] Selected tweet: ' + tweetId);
    logger.info('Retweet scheduled for: ' + new Date(schedule.retweetAt).toISOString());
    logger.info('Next cycle scheduled for: ' + new Date(schedule.nextCycleAt).toISOString());
    const result = await resumePending(options, false);
    return { tweetId, ...schedule, ...result };
  } catch (error) {
    return scheduleRetry(options, error, 'cycle');
  }
}

async function start({ env = process.env, logger = console, setTimeoutFn = setTimeout, client: suppliedClient } = {}) {
  const config = loadConfig(env);
  const rotation = loadRotationState(config.stateFile);
  const state = {
    botStatus: 'starting',
    startedAt: Date.now(),
    lastFailure: rotation.retryAt != null ? { phase: 'pending retry', httpStatus: null } : null,
    billingFailures: rotation.billingFailures,
    rotation,
    timerScheduled: false,
  };
  const app = createApp({ state });
  const client = suppliedClient || new TwitterApi({
    appKey: config.appKey,
    appSecret: config.appSecret,
    accessToken: config.accessToken,
    accessSecret: config.accessSecret,
  });
  const server = app.listen(config.port, () => {
    logger.info(`Health server listening on port ${config.port}.`);
  });

  server.on('error', (error) => {
    state.botStatus = 'error';
    logger.error(`HTTP server error: ${getErrorMessage(error)}`);
  });

  const authenticateAndRun = async () => {
    try {
      const userId = (await client.v2.me()).data.id;
      assertExpectedUserId(userId, config.expectedUserId);
      logger.info(`Bot authenticated and started at ${new Date().toISOString()}.`);
      const cycleOptions = { client, userId, config, logger, setTimeoutFn, state };
      const retryMs = Math.max(0, (state.rotation.retryAt || 0) - Date.now());
      if (retryMs > 0) {
        state.botStatus = 'error';
        logger.info(`Waiting ${Math.ceil(retryMs / MINUTE_MS)} minutes before retrying X.`);
        scheduleTask(cycleOptions, retryMs, () => authenticateAndRun());
        return;
      }
      if (state.rotation.pending) {
        state.botStatus = 'recovering';
        await resumePending(cycleOptions, true);
        return;
      }
      saveRotationState(state, config.stateFile, {
        ...state.rotation,
        retryAt: null,
        billingFailures: 0,
      });
      state.billingFailures = 0;
      state.botStatus = 'running';
      const remainingMs = remainingCycleDelay(state.rotation.lastCycleAt, config.cycleMinutes);
      if (remainingMs > 0) {
        logger.info(`Resuming rotation in ${Math.ceil(remainingMs / MINUTE_MS)} minutes.`);
        scheduleTask(cycleOptions, remainingMs, () => runCycle(cycleOptions));
      } else {
        await runCycle(cycleOptions);
      }
    } catch (error) {
      recordFailure(state, 'authentication', error, logger);
      const delayMs = retryDelayMs(error, config, state);
      saveRotationState(state, config.stateFile, {
        ...state.rotation,
        retryAt: Date.now() + delayMs,
        billingFailures: state.billingFailures,
      });
      scheduleTask({ client, config, logger, setTimeoutFn, state }, delayMs, () => authenticateAndRun());
    }
  };

  await authenticateAndRun();

  return { server, state };
}

if (require.main === module) {
  start().catch((error) => {
    console.error(`Startup error: ${getErrorMessage(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertExpectedUserId,
  calculateSchedule,
  createApp,
  getErrorMessage,
  getErrorStatus,
  isBillingError,
  loadConfig,
  loadRotationState,
  parsePositiveInteger,
  parseTweetIds,
  randomMinutes,
  remainingCycleDelay,
  retryDelayMs,
  runCycle,
  selectNextTweetId,
  selectRandomTweetId,
  start,
};
