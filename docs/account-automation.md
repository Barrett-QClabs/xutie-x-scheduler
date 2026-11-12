# 分账号关注配置和调度

旧的 `GET /api/automation` 与 `GET /api/automation/config` 是全局文件，`accountScoped` 为 false，`accountId` 为 null。查询参数里的 accountId 不会改变返回的关键词。`PATCH /api/automation/config` 如果正文带 `accountId`，返回 400 `shared_config`。不要把这份旧配置当成账号1或账号2自己的配置。`XUTIE_AUTOMATION_SUPERVISOR` 保持 `off`，三个旧进程不会启动。

分账号关键词是 `GET /api/follow/config?accountId=1` 和 `PUT /api/follow/config`。

```json
{ "accountId": 2, "keywords": ["business", "dating"] }
```

账号1默认是 `AI, 人工智能, 商业, 创业, crypto, 币圈, dating, 约会, 两性, 情感`。账号2默认是同一组主题的英文：`AI, artificial intelligence, business, entrepreneurship, crypto, dating, relationships`。回关、flb 不是关键词，只在储备排序里优先。保存后 `savesDoNotStart` 为 true，`running` 仍由开关和暂停决定。

启用账号1、保持账号2关闭：

```text
XUTIE_ACCOUNT1_FOLLOW=on
XUTIE_ACCOUNT1_UNFOLLOW=on
XUTIE_ACCOUNT2_FOLLOW=off
XUTIE_ACCOUNT2_UNFOLLOW=off
XUTIE_AUTOMATION_SUPERVISOR=off
X_API_MODE=live
```

然后只对账号1调用 `POST /api/follow/resume` 和 `POST /api/unfollow/resume`，正文 `{"accountId":1}`。这不恢复发帖。

进程每 20 秒调用一次内部调度。关注节奏按号分开，取关不改。账号2仍用伦敦钟（含夏令时）：从 00:00 起每 30 分钟一轮，前 15 分钟最多关注 10 人，后 15 分钟休息。工作槽是 `HH:00` 和 `HH:30`。账号1用 `Asia/Taipei`，每天 00:00 锚定：工作 15 分钟，休息 18 分钟，33 分钟一轮。头三轮是 00:00–00:15、00:33–00:48、01:06–01:21，每轮最多 13 人，只挑 `kind=followback`，不会退回 `kind=new`，也不会因为只有 new 就占掉这一轮的槽。回关窗口是台北 00:00–05:00，05:00 起不再开工；04:57 那一轮只开到 05:00。账号1的幂等槽是 `taipei:YYYY-MM-DDTHH:MM`，不会和它历史上的伦敦槽撞键。每日 380 的额度，账号1按台北日历日计；账号2仍按伦敦日。取关账号2仍是伦敦 `HH:15` 和 `HH:45`，每槽最多 10 人。账号1每天只在台北 05:00–09:00 取关，槽仍是 :15 和 :45，一共 8 个：05:15、05:45、06:15、06:45、07:15、07:45、08:15、08:45。08:45 这一槽在 09:00 结束。05:00–05:14 没有取关槽。同一槽已完成就回放，不重复写。进程整段窗口不在线时不补跑。`GET /api/follow/config` 没有周期字段，`PUT` 只接受 `accountId` 和 `keywords`。换容器时沿用原数据卷和 `credentials.key`，不要运行 `install.sh`，不要改待发帖。换完后，账号2在伦敦每小时的 15–29 分和 45–59 分 `schedule` 为 `rest`，00–14 分和 30–44 分为 `work`。账号1在台北 00:00–00:14 回关为 `work`，00:15–00:32 为 `rest`。

证据持续供给仍是父把免费插件结果 `POST /api/evidence`。程序不搜索、不调用 X 的 GET。信封字段见 `docs/free-evidence.md`。

账号1的取关池由伦敦 00:00 的导入建立。进程之后在每个 `:15` 和 `:45` 槽自己取关，每槽最多 10 人，助手不在线也会继续。证据缺失或过期只跳过，候选保持 `candidate`。取关证据从 `observed_at` 起最长 25 小时。候选和剩余可执行数是 `GET /api/unfollow/candidates?accountId=1`。72 小时只认本账号 `follow_success.succeeded_at`。following 列表名次大于 1000 的没回关候选用 `followingPage: 41` 或 `followingRank` 导入，不再要求关注时间；名次 1000 以内仍要 72 小时。账号1的 `inactive_48h` 同样只在名次大于 1000 时可以不带关注时间：证据里要有最新公开帖时间，且执行时严格早于 48 小时，`activity_window_complete: false` 也可以。没有帖子时间仍然跳过，不编造 `followedAt`。名次 1000 及以内不取。账号2的不活跃规则不变。`unknown` 可以靠这次带位置的导入回到 `candidate`。

平时只回关。账号1的批次只选 followback。账号2在回关之后仍可以用 new 补位。新关注要先进入活动储备才会被批次执行；把现有 `kind=new` 且 `status=reserved` 的人清出去用：

```json
{ "accountId": 2, "kinds": ["new"], "statuses": ["reserved"], "reason": "hold_new" }
```

`POST /api/follow/reserve/prune` 只处理正文里的 `accountId`。匹配的 reserved 行从活动储备删掉，原字段、`checkedAt`、`createdAt`、`updatedAt` 和原先的 result/reason 写入 `follow_reserve_audit`。`follow_success`、失败和 unknown 行不改。`kinds` 省略时，只移走过期、关系未知或其他当前不能执行的 reserved；写了 `kinds:["new"]` 时，该号全部 reserved new 都移走，回关行留下。`reason` 不能写成 `spam` 或 `not_blue`。审计是 `GET /api/follow/reserve/audit?accountId=2&limit=50`。之后用新鲜且证据合格的 `POST /api/follow/reserve` 可以重新入库；成功、失败和 unknown 不会因此变回可执行。读接口不会自己清理。`13f378e` 还没有这个接口。
