# D4D X Retweet Bot

A small Node.js service that uses OAuth 1.0a user context and the X API v2 to cycle through an explicit list of tweet IDs. It exposes a health endpoint for deployments and validates all configuration before starting.

## Responsible use

Use this project only with accounts and content you are authorized to automate. Follow the current X Developer Agreement, automation rules, API limits, and applicable law. The randomized delay distributes requests within a configured window; it is not intended to imitate a person or evade platform controls.

X API access levels, pricing, quotas, and endpoint behavior can change. This repository deliberately avoids promising a particular tier or daily call allowance. Check the official X developer documentation before deployment and set the cycle values to fit the limits assigned to your app.

## Features

- OAuth 1.0a user-context authentication
- Configurable tweet IDs, retweet delay, cycle interval, and HTTP port
- Round-robin rotation, with an optional checkpoint for safe restarts
- Startup validation with useful configuration errors
- `GET /livez` process liveness and `GET /healthz` X automation health endpoints
- No secrets or account credentials in source control
- Tests based on Node's built-in test runner

## Requirements

- Node.js 20 or newer
- An X developer project and app with OAuth 1.0a user context
- Read and write permissions for the account being automated
- App key, app secret, access token, and access-token secret

## Install

```bash
git clone https://github.com/Doomed-4Dina/D4D-XRT-BOT.git
cd D4D-XRT-BOT
npm ci
cp .env.example .env
```

On PowerShell, copy the example with:

```powershell
Copy-Item .env.example .env
```

## Configure

Edit `.env` locally. Never commit this file.

```dotenv
APP_KEY=your_app_key
APP_SECRET=your_app_secret
ACCESS_TOKEN=your_access_token
ACCESS_SECRET=your_access_token_secret
TWEET_IDS=1234567890123456789,9876543210987654321
PORT=3000
MIN_DELAY_MINUTES=15
MAX_DELAY_MINUTES=45
CYCLE_MINUTES=60
# EXPECTED_USER_ID=1234567890123456789
# STATE_FILE=/data/retweet-bot-state.json
```

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `APP_KEY` | Yes | — | X app key |
| `APP_SECRET` | Yes | — | X app secret |
| `ACCESS_TOKEN` | Yes | — | User access token |
| `ACCESS_SECRET` | Yes | — | User access-token secret |
| `TWEET_IDS` | Yes | — | Comma-separated numeric tweet IDs |
| `PORT` | No | `3000` | HTTP server port |
| `MIN_DELAY_MINUTES` | No | `15` | Earliest retweet time after unretweeting |
| `MAX_DELAY_MINUTES` | No | `45` | Latest retweet time after unretweeting |
| `CYCLE_MINUTES` | No | `60` | Time between cycle starts |
| `EXPECTED_USER_ID` | No | — | Refuse X writes if the authenticated user ID differs |
| `STATE_FILE` | No | — | Rotation checkpoint on a persistent volume |

`MIN_DELAY_MINUTES` must not exceed `MAX_DELAY_MINUTES`, and `MAX_DELAY_MINUTES` must be less than `CYCLE_MINUTES`.

Tweet IDs are the numeric values at the end of status URLs such as `https://x.com/example/status/1234567890123456789`.

## Run

```bash
npm start
```

Each cycle selects the next configured ID, requests an unretweet, waits within the configured delay window, requests a retweet, then waits until the configured cycle boundary. The first ID is selected randomly; the rest follow the list in order. Failed X requests degrade health and schedule one later attempt for the same pending ID. A 402 or billing error uses exponential backoff starting at the greater of one hour and `CYCLE_MINUTES`, capped at 24 hours. The bot never immediately retries a failed write or proceeds to retweet after an unretweet billing failure. A post that X reports as missing is skipped, and the next ID is tried on the next cycle.

Set `EXPECTED_USER_ID` in production so changing credentials cannot move the bot to another X account. To preserve the pending target across a service restart, mount a persistent volume and set `STATE_FILE` to a path inside it. The bot checkpoints the selected ID and intended repost time before contacting X. After a restart or failed write, it first requests an unretweet for that same ID, then waits a new `MIN_DELAY_MINUTES`–`MAX_DELAY_MINUTES` interval before reposting once. This safely handles an uncertain result if the process stopped just after an X write, without depending on a repost-membership endpoint that may not support OAuth 1.0a. A corrupt state file stops startup rather than risking a repeated write. If `STATE_FILE` is omitted, rotation is held only in memory and a restart can repeat a recent target.

## Health check

```http
GET /healthz
```

Example response:

```json
{
  "status": "ok",
  "botStatus": "running",
  "uptimeSeconds": 42
}
```

The endpoint returns HTTP 503 with `status: "degraded"` when X authentication, a target lookup, or a repost cycle fails. It returns HTTP 200 only while the bot is running without an outstanding X failure. A successful later repost restores health. The response includes the last failure phase and next attempt time, without credentials. `GET /livez` returns HTTP 200 while the HTTP process is alive, including during a 402 billing backoff; use it for a platform deployment or liveness probe. Monitor `/healthz` separately to detect failed X work.

## Test

```bash
npm run lint
npm test
```

Continuous integration runs both commands on supported Node.js versions for every pull request and push to `main`.

## Deploy

Use a long-running Node.js service on your preferred platform:

1. Install with `npm ci --omit=dev`.
2. Start with `npm start`.
3. Store every `.env` value in the platform's secret or environment manager.
4. Expose `PORT` and configure the platform deployment probe to request `/livez`; monitor `/healthz` for X failures.
5. Set `EXPECTED_USER_ID`; mount a persistent volume and set `STATE_FILE` to a file within it.
6. Recheck current X API rules and your app's rate-limit allocation before enabling the scheduler.

Do not deploy multiple replicas with the same account and tweet list unless you have added coordination or locking; independent schedulers can issue duplicate requests.

## License

[MIT](LICENSE)

Contributions and issue reports are welcome.
