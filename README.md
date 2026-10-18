# 序帖 (Xutie)

[English](./README.md) · [简体中文](./README.zh-CN.md)

Self-hosted scheduler for X (Twitter). You bring your own developer-app credentials. 序帖 does not ship a shared API key.

Paste or upload a batch of posts, queue them on an interval, and let a local process call `POST /2/tweets` when each one is due. The interface defaults to Simplified Chinese and can be switched to English.

## Features

- Settings page for the four OAuth 1.0a user-context credentials, with a connection test (`GET /2/users/me`) that shows the connected @handle.
- Credentials stay on the server. They are encrypted at rest with AES-256-GCM using a key from the environment, and API responses never send them back to the browser.
- Bulk import: one post per line, blank lines between posts, a line that is exactly `---`, or a `.txt` / `.csv` upload. One batch accepts at most 50 valid posts (`MAX_IMPORT_BATCH`). Extra valid posts are reported so you can split them; lines that fail the length check do not use a slot.
- Length uses X's weighted count: Latin characters count as 1, CJK as 2, and each `http(s)` URL as 23. Posts over 280 are still queued, marked “Long post”, with a warning that they need X Premium. The hard limit is 25,000 (X's Premium long-post limit); anything longer is rejected. Each import takes up to 50 posts and up to 2,000,000 characters of source text.
- Queue controls: start time, interval (default 15 minutes), optional jitter, edit, delete, reorder, pause, resume, and retry.
- Before each send, the scheduler reads the account's latest post on X, including posts made outside this app. If that post is newer than one interval, the due tweet and the pending tweets after it move forward together so the gap is preserved. A delay caused by a post this app did not send is labeled in the queue.
- State lives in SQLite, so a restart keeps unsent posts. HTTP 429 waits for `x-rate-limit-reset`. Duplicate content is marked failed and the queue continues. An auth failure pauses the queue and shows the reason. A successful post stores the tweet id and a link to `https://x.com/{handle}/status/{id}`.

## Screenshots

Screenshots of the queue, import, and settings screens can be added here.

## Quick start

Node.js 22 or newer.

```bash
cp .env.example .env.local
```

Set `CREDENTIALS_ENCRYPTION_KEY` to a random string of at least 16 characters:

```bash
openssl rand -base64 32
```

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:3847](http://127.0.0.1:3847).

Production:

```bash
npm run build
npm start
```

The server listens on port `3847`. The database is created at `./data/xqueue.sqlite` on first start.

### Mock mode

To try the queue without calling X, set this in `.env.local`:

```bash
X_API_MODE=mock
```

Connection tests and posts stay local. Tweet text containing `[[duplicate]]`, `[[rate-limit]]`, `[[auth]]`, or `[[fail]]` makes the mock client return a duplicate, a 429, an auth error, or a transient error. Switch back to `X_API_MODE=live` before posting for real.

### Tests

```bash
npm test
npm run lint
```

Tests use a mocked X client and do not call X. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Create your own X developer app

序帖 uses **OAuth 1.0a user context**. Posting requires an access token for the account. An app-only bearer token cannot post as you.

1. Open the [X developer console](https://console.x.com). Some accounts still enter through the [developer portal](https://developer.x.com/en/portal/dashboard). Sign in as the account that will post and enable developer access.
2. Create a **Project**. v2 endpoints expect the app to belong to a project.
3. Create an **App** inside that project.
4. Open **User authentication settings**:
   - App permissions: **Read and Write**. Direct messages are not required.
   - App type: a confidential web app or automated app / bot.
   - Callback URL and website are required by the console. 序帖 uses the access token generated in the console and does not run a three-legged login, so `http://127.0.0.1:3847` is enough for both.
5. After saving permissions, open **Keys and tokens** and copy these four values:

   | In 序帖 | In the X console |
   | --- | --- |
   | API Key | API Key / Consumer Key |
   | API Key Secret | API Key Secret / Consumer Secret |
   | Access Token | Access Token |
   | Access Token Secret | Access Token Secret |

6. Set permissions to Read and Write **before** you generate the access token and access token secret. A token created earlier often stays read-only, and posting then returns 403. After changing permissions, regenerate both and use the new pair.
7. Do not paste the bearer token into 序帖. A bearer token represents the app, not your account.
8. On the settings page, save the four values and run the connection test. A success message shows your @handle.

The secrets pass through the browser only on that save. After that they are stored encrypted. Reloading the page does not show them again.

## Pricing

X's prices change. The figures below are from public 2026 information. **Your developer console is the source of truth.**

- New developers no longer get the old free tier. The default is pay-per-use: after you buy credits, creating a post without a link is about $0.015, and a post that contains a link is about $0.20. Reads such as `GET /2/users/me` also spend a small amount of credit.
- Before each post, 序帖 makes one extra read: `GET /2/users/:id/tweets` with `max_results=5`, `tweet.fields=created_at`, and `exclude=retweets,replies`, so it can see the time of the account's latest original post, including posts you wrote by hand. Replies (comments) and retweets don't count toward the gap. That read is billed. One response contains up to 5 posts. Public figures put a single read around $0.005; confirm the unit price on your bill. A successful result is cached for 60 seconds, and kept until the interval ends when the latest post is still inside that interval, so the wait does not re-read every 5 seconds. If the read fails, the queue is not paused: the app uses its own last send time and logs the failure.
- A sent post therefore costs about one timeline read plus one create. If nobody posts by hand during the wait, the app reads once more when the interval is over, to confirm the gap is clear.
- The older Basic plan (about $200 per month) and Pro remain only for accounts that already subscribe. New accounts generally cannot start them.
- Posting too fast returns HTTP 429. 序帖 waits until `x-rate-limit-reset`, or 15 minutes if that header is missing. The tweet stays pending.
- Public docs often cite about 100 creates per user per 15 minutes and 10,000 per app per 24 hours. Plans differ. The default of one post every 15 minutes is meant to look less like a burst and sits far under those numbers.
- X rejects duplicate content. That item is marked failed and the queue continues. Edit the text and retry.
- Posts over 280 need X Premium. If X refuses a long post (for example a 403 about length or Premium), only that post is marked failed with a readable message; the queue keeps going.
- A 401, or a 403 that is about the token or permissions, pauses the whole queue. A common cause is a still-read-only access token, or a mistyped value. Fix the credentials, pass the connection test, then resume.

## Deploy

Run **one** process. A lock in SQLite reduces double-sends if two processes share a file, but the app is designed as a single instance.

There is no login. Do not expose the port on the public internet. Keep it on your machine, or put it behind a reverse proxy that already authenticates users.

### Docker

```bash
cp .env.example .env
# Edit .env: set CREDENTIALS_ENCRYPTION_KEY and keep X_API_MODE=live
docker compose up -d --build
```

Data is in the `xuti-data` volume, at `/data/xqueue.sqlite` inside the container.

Without Compose:

```bash
docker build -t xuti .
docker run -d --name xuti \
  -p 3847:3847 \
  -e CREDENTIALS_ENCRYPTION_KEY='a-long-random-string' \
  -e X_API_MODE=live \
  -e DATABASE_PATH=/data/xqueue.sqlite \
  -v xuti-data:/data \
  xuti
```

### Node on a server

Install Node.js 22, set the same environment variables, then `npm ci`, `npm run build`, and `npm start`. Keep that one process running with systemd or another supervisor, and back up `./data`.

Changing `CREDENTIALS_ENCRYPTION_KEY` makes old credentials undecryptable and pauses the queue. Enter the four values again, test the connection, and resume.

## Data

| Table | What it holds |
| --- | --- |
| `queue_settings` | Interval, jitter, pause, rate-limit deadline, and the last timeline read |
| `tweets` | Text, schedule, status, tweet id, error, and whether a post made outside this app delayed it |
| `credentials` | The four credentials, encrypted, plus the @handle from a successful test |

The cipher is scrypt plus AES-256-GCM. The salt and IV are stored with the ciphertext. Without the encryption key, the credentials cannot be read back.

## Limitations

- Text only. No images, video, or polls.
- Long posts (over 280, up to 25,000) need X Premium on the posting account. 序帖 does not check your subscription in advance.
- One saved credential set, so one X account.
- Designed for a single process.
- No built-in login. Do not expose it on the public internet.
- OAuth 1.0a user context only. No OAuth 2.0 PKCE.
- The character count approximates twitter-text v3. Complex emoji can be off by one or two.

## Roadmap

These are not implemented. They are the directions that would make 序帖 usable for more than one person on one machine:

- **Multi-user login.** Accounts on the app itself, so a shared install is not an open queue.
- **Multiple X accounts.** More than one credential set, with a queue per account.
- **Images and other media.** Attachments on a post, not only text.
- **Threads.** A sequence posted as replies to the previous tweet in the thread.
- **Cloud deploy.** A documented path for a hosted single-tenant install, still without leaving the port open to the world.

## License

[MIT](./LICENSE). Copyright 2026 Barrett-QClabs.

Issues, feature ideas, and pull requests: [CONTRIBUTING.md](./CONTRIBUTING.md). Community expectations: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
