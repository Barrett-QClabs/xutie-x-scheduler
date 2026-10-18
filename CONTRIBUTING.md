# Contributing to 序帖

Thanks for taking a look. Issues, ideas, and pull requests are welcome.

Please read the [code of conduct](./CODE_OF_CONDUCT.md) first. This project is licensed under the [MIT License](./LICENSE).

## Report a bug

Open a [bug report](https://github.com/Barrett-QClabs/xutie-x-scheduler/issues/new?template=bug_report.md) and include:

- What you did, what you expected, and what happened.
- Node.js version, commit or release, and whether `X_API_MODE` was `live` or `mock`.
- The relevant server log line, with secrets removed.

Do not paste API keys, access tokens, access token secrets, or the value of `CREDENTIALS_ENCRYPTION_KEY`. A screenshot of the settings page after a save is fine; the fields are cleared on purpose.

## Propose a feature

Open a [feature request](https://github.com/Barrett-QClabs/xutie-x-scheduler/issues/new?template=feature_request.md). Describe the job you are trying to do and the smallest change that would do it. The current [roadmap](./README.md#roadmap) is a guide, not a promise.

## Run it locally

Requirements: Node.js 22 or newer.

```bash
cp .env.example .env.local
# Set CREDENTIALS_ENCRYPTION_KEY to a random string of at least 16 characters.
npm install
npm run dev
```

The app listens on [http://127.0.0.1:3847](http://127.0.0.1:3847). `X_API_MODE=mock` in `.env.local` keeps every X call local.

`.env.local` and `data/*.sqlite` are gitignored. Do not commit them.

## Tests and lint

```bash
npm test
npm run lint
```

`npm test` uses Vitest and a mocked X client. It does not call X and does not need real credentials. Please add or update a test when you change scheduling, import rules, credential handling, or the X client. Keep existing tests passing.

User-facing copy lives in `lib/messages.ts`. Add both the Simplified Chinese string and the English string.

## Pull requests

- One change per pull request, with a short description of why.
- Run `npm test` and `npm run lint` before you ask for review.
- Do not include generated folders (`node_modules`, `.next`), local databases, or env files.
- Match the style of the surrounding code. Prefer a small edit over a new dependency.
- If the change affects how someone runs or deploys the app, update `README.md` and `README.zh-CN.md`.
