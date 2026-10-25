# X follow / unfollow automation (序帖 → 自动化)

Node 22 scripts that use the same OAuth 1.0a keys 序帖 stores (encrypted) in `data/xqueue.sqlite`,
decrypted with `CREDENTIALS_ENCRYPTION_KEY` from `.env.local`. Keys are never printed or logged.

Runtime data (logs, cache, locks, snapshots, candidate pools, `whitelist.txt`, `automation.config.json`,
`followback-targets.json`, `plugin-pages/`) live in `X_AUTOMATION_DIR` (default `/workspace/x-unfollow`),
**not** in this repo.

| script | what |
| --- | --- |
| `unfollow.mjs` / `run.sh` | hourly: unfollow all non-blue-V accounts + blue-V non-mutuals outside the 400 most recent; blue-V mutuals never (rules in RULES.txt). Still uses paid GETs for list cache / blue-V re-check. |
| `followback.mjs` / `start-followback.sh` | daemon: follow back blue-V followers from `followback-targets.json` (written by the free X plugin). **Zero paid reads** (`NO_PAID_READS=1`); paid API is POST follow only. |
| `write-followback-targets.mjs` | merge free-plugin follower page JSON → `followback-targets.json` (hourly: newest 1–3 pages with `--merge`) |
| `keywordfollow.mjs` / `start-keywordfollow.sh` | daemon: follow new people from `keyword-candidates/YYYY-MM-DD.json` (AI/商业/两性, ≤100 followers, Chinese-zone). **Zero paid reads** (`NO_PAID_READS=1`); paid API is POST follow only. |
| `write-keyword-pool.mjs` | merge free-plugin search pages → `keyword-candidates/YYYY-MM-DD.json` (hourly: `--merge` after saving new pages under `plugin-pages/keyword/`) |
| `follow-common.mjs` | shared combined daily cap, 15-min window, mutex, stop flag, config |

Disable flags in the runtime dir: `FOLLOWBACK_DISABLED`, `KEYWORD_DISABLED` (start scripts exit 0 if present).

The 序帖 server (`instrumentation.ts` → `lib/automation.ts`) restarts enabled daemons every 5 min
(`XUTIE_AUTOMATION_SUPERVISOR=off` disables that) and serves `/automation`, `GET /api/automation`,
`GET|PATCH /api/automation/config`, `POST /api/automation/start {"daemon":"followback"|"keywordfollow"}`.
