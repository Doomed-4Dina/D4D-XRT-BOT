# D4D X Retweet Bot

A small Node.js service that uses OAuth 1.0a user context and the X API v2 to cycle through an explicit list of tweet IDs. It exposes a health endpoint for deployments and validates all configuration before starting.

## Responsible use

Use this project only with accounts and content you are authorized to automate. Follow the current X Developer Agreement, automation rules, API limits, and applicable law. The randomized delay distributes requests within a configured window; it is not intended to imitate a person or evade platform controls.

X API access levels, pricing, quotas, and endpoint behavior can change. This repository deliberately avoids promising a particular tier or daily call allowance. Check the official X developer documentation before deployment and set the cycle values to fit the limits assigned to your app.

## Features

- OAuth 1.0a user-context authentication
- Configurable tweet IDs, retweet delay, cycle interval, and HTTP port
- Startup validation with useful configuration errors
- `GET /healthz` deployment health endpoint
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

`MIN_DELAY_MINUTES` must not exceed `MAX_DELAY_MINUTES`, and `MAX_DELAY_MINUTES` must be less than `CYCLE_MINUTES`.

Tweet IDs are the numeric values at the end of status URLs such as `https://x.com/example/status/1234567890123456789`.

## Run

```bash
npm start
```

Each cycle selects one configured ID, requests an unretweet, waits within the configured delay window, requests a retweet, then waits until the configured cycle boundary. API errors are logged without exposing credentials.

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

The endpoint remains available with `status: "degraded"` and `botStatus: "error"` when X authentication or startup fails, which makes deployment diagnosis easier.

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
4. Expose `PORT` and configure the platform health probe to request `/healthz`.
5. Recheck current X API rules and your app's rate-limit allocation before enabling the scheduler.

Do not deploy multiple replicas with the same account and tweet list unless you have added coordination or locking; independent schedulers can issue duplicate requests.

## License

[MIT](LICENSE)

Contributions and issue reports are welcome.
