'use strict';

require('dotenv').config();

const express = require('express');
const { TwitterApi } = require('twitter-api-v2');

const MINUTE_MS = 60_000;
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

function createApp({ state = { botStatus: 'starting', startedAt: Date.now() } } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.get('/healthz', (_request, response) => {
    response.json({
      status: state.botStatus === 'error' ? 'degraded' : 'ok',
      botStatus: state.botStatus,
      uptimeSeconds: Math.max(Math.floor((Date.now() - state.startedAt) / 1000), 0),
    });
  });

  return app;
}

async function runCycle({
  client,
  userId,
  config,
  logger = console,
  random = Math.random,
  setTimeoutFn = setTimeout,
}) {
  const tweetId = selectRandomTweetId(config.tweetIds, random);
  const start = Date.now();
  const schedule = calculateSchedule({
    start,
    minDelayMinutes: config.minDelayMinutes,
    maxDelayMinutes: config.maxDelayMinutes,
    cycleMinutes: config.cycleMinutes,
    random,
  });

  logger.info(`[${new Date(start).toISOString()}] Selected tweet: ${tweetId}`);
  logger.info(`Retweet scheduled for: ${new Date(schedule.retweetAt).toISOString()}`);
  logger.info(`Next cycle scheduled for: ${new Date(schedule.nextCycleAt).toISOString()}`);

  try {
    await client.v2.delete(`users/${userId}/retweets/${tweetId}`);
    logger.info(`Unretweeted ${tweetId}`);
  } catch (error) {
    logger.warn(`Unretweet failed for ${tweetId}: ${getErrorMessage(error)}`);
  }

  setTimeoutFn(async () => {
    try {
      await client.v2.post(`users/${userId}/retweets`, { tweet_id: tweetId });
      logger.info(`Retweeted ${tweetId}`);
    } catch (error) {
      logger.warn(`Retweet failed for ${tweetId}: ${getErrorMessage(error)}`);
    }

    const remainingCycleMs = Math.max(schedule.nextCycleAt - Date.now(), 0);
    logger.info(`Waiting ${(remainingCycleMs / MINUTE_MS).toFixed(1)} minutes for the next cycle.`);

    setTimeoutFn(() => {
      runCycle({ client, userId, config, logger, random, setTimeoutFn }).catch((error) => {
        logger.error(`Cycle failed: ${getErrorMessage(error)}`);
      });
    }, remainingCycleMs);
  }, schedule.retweetDelayMs);

  return { tweetId, ...schedule };
}

async function start({ env = process.env, logger = console } = {}) {
  const config = loadConfig(env);
  const state = { botStatus: 'starting', startedAt: Date.now() };
  const app = createApp({ state });
  const client = new TwitterApi({
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

  try {
    const userId = (await client.v2.me()).data.id;
    state.botStatus = 'running';
    logger.info(`Bot authenticated and started at ${new Date().toISOString()}.`);
    await runCycle({ client, userId, config, logger });
  } catch (error) {
    state.botStatus = 'error';
    logger.error(`Bot startup failed: ${getErrorMessage(error)}`);
  }

  return { server, state };
}

if (require.main === module) {
  start().catch((error) => {
    console.error(`Startup error: ${getErrorMessage(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  calculateSchedule,
  createApp,
  getErrorMessage,
  loadConfig,
  parsePositiveInteger,
  parseTweetIds,
  randomMinutes,
  runCycle,
  selectRandomTweetId,
  start,
};
