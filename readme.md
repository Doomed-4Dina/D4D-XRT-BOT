# Twitter Retweet/Unretweet Bot

This Node.js server automatically retweets and unretweets a rotating list of tweets using the Twitter (X) API v2.

- Picks a random tweet from your list
- Unretweets it
- Waits 15–45 minutes
- Retweets it again
- Waits the remainder of the hour
- Repeats endlessly, staying under 50 API calls/day

---

## Features

- **X API v2** compliant
- Uses **OAuth 1.0a User Context**
- Randomized, human-like timing
- Suitable for **free-tier** X Developer accounts

---

## Limitations

- Works with **free-tier X API (v2)** — max **50 write calls/day**
- Bot is rate-aware: 1 unretweet + 1 retweet = **2 calls/hour**
- Twitter/X imposes a **15-minute cooldown** between retweeting the same tweet ID
- Tweets must be public, not deleted, and not protected
- Duplicate retweet attempts will be ignored by X and logged

---

## Prerequisites

### 1. Twitter Developer Account

- Visit: [https://developer.twitter.com/en/portal/dashboard](https://developer.twitter.com/en/portal/dashboard)
- Sign up for a **free Basic tier** Developer account
- Create a **Project** and an **App**

---

### 2. App Configuration

1. Go to your [Twitter Developer Dashboard](https://developer.twitter.com/en/portal/dashboard)
2. Create a new app under your project
3. Enable **OAuth 1.0a User Context**
4. Set App permissions to:  
   **Read and Write**
5. Use any callback URL (e.g. `http://localhost`)
6. Under **Keys and Tokens**, generate:
   - API Key
   - API Secret
   - Access Token
   - Access Token Secret

---

## .env Setup

Create a .env file in the root directory:

.env
APP_KEY=your_consumer_key
APP_SECRET=your_consumer_secret
ACCESS_TOKEN=your_access_token
ACCESS_SECRET=your_access_secret
PORT=3000

---

## Installation

git clone https://github.com/Doomed-4Dina/D4D-XRT-BOT
cd D4D-XRT-BOT
npm install

---

## Usage

Start the bot:
node index.js

It will:
	•	Pick a random tweet from your list
	•	Unretweet it
	•	Wait 15–45 minutes
	•	Retweet it again
	•	Wait until the top of the next hour before repeating

You’ll see logs like:
[01:00:00 AM] → Selected tweet: 1903978070165373410
→ Scheduled retweet at: 01:38:24 AM
→ Next cycle will start at: 02:00:00 AM
→ Unretweeted 1903978070165373410
[01:38:24 AM] → Retweeting 1903978070165373410
→ Retweeted 1903978070165373410

---

## How to Add Your Own Tweet List

In the index.js file, find the section:
const tweetIds = [
  '1896962523175477692',
  '1903978070165373410',
  '1904660069792333970',
  // Add your tweet IDs here
];

To add your own tweets:
	1.	Go to the tweet you want to include.
	2.	Copy the Tweet ID — this is the long number at the end of the tweet URL.
Example:
Tweet URL: https://x.com/yourhandle/status/1234567890123456789
Tweet ID:  1234567890123456789

	3.	Add the ID (in quotes) to the array:
const tweetIds = [
  '1234567890123456789',
  '9876543210987654321',
  '1122334455667788990'
];

You can list as many tweet IDs as you like. The bot will pick one at random every hour.

---

## Deployment

You can deploy this bot on:
	•	Replit
	•	Railway
	•	Render
	•	Your own VPS or Node.js server

Deployment Tips:
	•	Add .env values using the platform’s Secret/Environment manager
	•	Set index.js as your server’s entry file

---

## License

MIT — free to use, remix, or adapt.

⸻

## Support & Contributions

If you found this useful:

- **Give it a star** on GitHub — it really helps!
- **[Buy me lunch](https://throne.com/doomed4dina/item/fc7a1f37-da0c-4658-bc42-db5aa6f57eea)** if you're feeling generous

Pull requests and issues are always welcome — especially if you’re improving timing logic, adding persistence, or extending features.

Thanks for checking it out.

