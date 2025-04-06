require('dotenv').config();
const express = require('express');
const { TwitterApi } = require('twitter-api-v2');

const app = express();
const port = process.env.PORT || 3000;

const client = new TwitterApi({
  appKey: process.env.APP_KEY,
  appSecret: process.env.APP_SECRET,
  accessToken: process.env.ACCESS_TOKEN,
  accessSecret: process.env.ACCESS_SECRET,
});

const tweetIds = [
  '1908188616943112649',
  '1896962523175477692',
  '1903978070165373410',
  '1904660069792333970',
  '1903977102312972693',
  '1901949252454019113',
  '1873936148810391833',
  '1887972780303413262',
  '1891242102090039763',
  '1888157005832982582',
  '1879989497678688762',
  '1874547456224182639',
  '1786346542955204972',
  '1775542415098515747'
];

// Utility: Random delay in minutes converted to ms
function randomMinutes(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min) * 60 * 1000;
}

// Main tweet cycling loop
async function loop(userId) {
  const tweetId = tweetIds[Math.floor(Math.random() * tweetIds.length)];
  const start = Date.now();
  const unretweetToRetweetDelay = randomMinutes(15, 45);
  const retweetTime = new Date(start + unretweetToRetweetDelay);
  const nextCycleTime = new Date(start + 3600000);

  console.log(`\n[${new Date().toLocaleTimeString()}] → Selected tweet: ${tweetId}`);
  console.log(`→ Scheduled retweet at: ${retweetTime.toLocaleTimeString()}`);
  console.log(`→ Next cycle will start at: ${nextCycleTime.toLocaleTimeString()}`);

  try {
    await client.v2.delete(`users/${userId}/retweets/${tweetId}`);
    console.log(`→ Unretweeted ${tweetId}`);
  } catch (err) {
    const msg = err?.data?.errors?.[0]?.message || err.message || 'Unknown error';
    console.warn(`→ Unretweet failed for ${tweetId}: ${msg}`);
  }

  setTimeout(async () => {
    console.log(`[${new Date().toLocaleTimeString()}] → Retweeting ${tweetId}`);

    try {
      await client.v2.post(`users/${userId}/retweets`, { tweet_id: tweetId });
      console.log(`→ Retweeted ${tweetId}`);
    } catch (err) {
      const msg = err?.data?.errors?.[0]?.message || err.message || 'Unknown error';
      console.warn(`→ Retweet failed for ${tweetId}: ${msg}`);
    }

    const totalElapsed = Date.now() - start;
    const remaining = Math.max(3600000 - totalElapsed, 0);
    console.log(`→ Waiting ${(remaining / 60000).toFixed(1)} min until next cycle...\n`);
    setTimeout(() => loop(userId), remaining);
  }, unretweetToRetweetDelay);
}

// Start the server and bot
app.listen(port, async () => {
  try {
    const userId = (await client.v2.me()).data.id;
    console.log(`[Bot started at ${new Date().toLocaleTimeString()}]`);
    loop(userId);
  } catch (err) {
    console.error('Startup error:', err.message);
  }
});