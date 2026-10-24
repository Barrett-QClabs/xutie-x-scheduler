# X follow / unfollow automation (序帖 → 自动化)

Node 22 scripts that use the same OAuth 1.0a keys 序帖 stores (encrypted) in `data/xqueue.sqlite`,
decrypted with `CREDENTIALS_ENCRYPTION_KEY` from `.env.local`. Keys are never printed or logged.

Runtime data (logs, cache, locks, snapshots, candidate pools, `whitelist.txt`, `automation.config.json`)
live in `X_AUTOMATION_DIR` (default `/workspace/x-unfollow`), **not** in this repo.

| script | what |
| --- | --- |
| `unfollow.mjs` / `run.sh` | hourly: unfollow non-mutual, non-blue-V accounts (rules in RULES.txt) |
| `followback.mjs` / `start-followback.sh` | daemon: follow back followers (priority) |
| `keywordfollow.mjs` / `start-keywordfollow.sh` | daemon: daily keyword candidate pool + follows |
| `follow-common.mjs` | shared combined daily cap, 15-min window, mutex, stop flag, config |

The 序帖 server (`instrumentation.ts` → `lib/automation.ts`) restarts enabled daemons every 5 min
(`XUTIE_AUTOMATION_SUPERVISOR=off` disables that) and serves `/automation`, `GET /api/automation`,
`GET|PATCH /api/automation/config`, `POST /api/automation/start {"daemon":"followback"|"keywordfollow"}`.
