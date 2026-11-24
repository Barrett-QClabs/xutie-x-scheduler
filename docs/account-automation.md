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

进程每 20 秒调用一次内部调度。关注节奏按号分开，取关不改。账号2回关也改到 `Asia/Taipei` 00:00 锚定，仍是 15 分钟工作、15 分钟休息、每轮最多 10 人。工作槽是台北的 `HH:00` 和 `HH:30`。账号2若仍由外部例程在 00:00 打开、05:00 暂停，那个例程不要再作用于账号1的关注。账号1用 `Asia/Taipei`。关注和回关共用一个永久候选池，除台北 05:00–09:00 外都可开工：09:00 锚定，工作 15 分钟，休息 18 分钟，33 分钟一轮，每轮最多 13 人。14:35 落在 14:30–14:45。05:00 起绝对不关注，09:00 恢复。00:00–00:06 仍属于前一天 23:51 那一轮。`kind=followback` 和 `kind=new` 随机抽用，不再按 `followed_by` 分池；`kind=new` 仍要当天授权。未关注的人跨日保留，不按日期过期。已成功关注或已确认取关的人不再执行。账号1的幂等槽仍是 `taipei:YYYY-MM-DDTHH:MM`，历史 `taipei-new:` 槽只供审计。每日合计上限 350，按台北日历日计，关注和回关加在一起；账号2仍是 380，按伦敦日。取关两号都只在台北 05:00–09:00，槽是 :15 和 :45，一共 8 个：05:15、05:45、06:15、06:45、07:15、07:45、08:15、08:45，每槽最多 10 人。08:45 这一槽在 09:00 结束。05:00–05:14 没有取关槽。名次大于 1000 且最新帖严格早于 48 小时时，两号都不需要关注时间。同一槽已完成就回放，不重复写。进程整段窗口不在线时不补跑。`GET /api/follow/config` 没有周期字段。`PUT` 可以只保存 `keywords`，或只保存账号1的 `approvedListFollow`，或保存 `ops`。已筛名单开关默认关闭，说明见文末。换容器时沿用原数据卷和 `credentials.key`，不要运行 `install.sh`，不要改待发帖。换完后，账号2在伦敦每小时的 15–29 分和 45–59 分 `schedule` 为 `rest`，00–14 分和 30–44 分为 `work`。账号1在台北 09:00–09:14 为 `work`，09:15–09:32 为 `rest`，05:00–08:59 为 `rest`。

证据持续供给仍是父把免费插件结果 `POST /api/evidence`。程序不搜索、不调用 X 的 GET。信封字段见 `docs/free-evidence.md`。

账号1的取关池由伦敦 00:00 的导入建立。进程之后在每个 `:15` 和 `:45` 槽自己取关，每槽最多 10 人，助手不在线也会继续。证据缺失或过期只跳过，候选保持 `candidate`。取关证据从 `observed_at` 起最长 25 小时。候选和剩余可执行数是 `GET /api/unfollow/candidates?accountId=1`。72 小时只认本账号 `follow_success.succeeded_at`。following 列表名次大于 1000 的没回关候选用 `followingPage: 41` 或 `followingRank` 导入，不再要求关注时间；名次 1000 以内仍要 72 小时。账号1的 `inactive_48h` 同样只在名次大于 1000 时可以不带关注时间：证据里要有最新公开帖时间，且执行时严格早于 48 小时，`activity_window_complete: false` 也可以。没有帖子时间仍然跳过，不编造 `followedAt`。名次 1000 及以内不取。账号2的不活跃规则不变。`unknown` 可以靠这次带位置的导入回到 `candidate`。

平时只回关。账号1的批次只选 followback。账号2在回关之后仍可以用 new 补位。新关注要先进入活动储备才会被批次执行；把现有 `kind=new` 且 `status=reserved` 的人清出去用：

```json
{ "accountId": 2, "kinds": ["new"], "statuses": ["reserved"], "reason": "hold_new" }
```

`POST /api/follow/reserve/prune` 只处理正文里的 `accountId`。匹配的 reserved 行从活动储备删掉，原字段、`checkedAt`、`createdAt`、`updatedAt` 和原先的 result/reason 写入 `follow_reserve_audit`。`follow_success`、失败和 unknown 行不改。`kinds` 省略时，只移走过期、关系未知或其他当前不能执行的 reserved；写了 `kinds:["new"]` 时，该号全部 reserved new 都移走，回关行留下。`reason` 不能写成 `spam` 或 `not_blue`。审计是 `GET /api/follow/reserve/audit?accountId=2&limit=50`。之后用新鲜且证据合格的 `POST /api/follow/reserve` 可以重新入库；成功、失败和 unknown 不会因此变回可执行。读接口不会自己清理。`13f378e` 还没有这个接口。

## 账号1已筛名单开关

这是账号1的持久配置，存在 `follow_account_config.approved_list_follow`。进程启动时若列不存在会补上，默认 `0`。已有储备、成功账、黑名单和证据行都不会被改写。重复启动不会把开关打开。账号2没有这个开关，`PUT` 账号2会得到 400 `approved_list_locked`。

关闭（默认）时，账号1仍要新鲜证据，并继续做蓝V、垃圾内容、是否已关注、中文和资格判断。证据页 `fresh: false` 时，批次可以提交，但结果是 `evidence_pending`，人留在 `reserved`，不会假装已经查过资料。

开启时，只对账号1执行白名单里的人跳过缺证据、非蓝V、非中文和资格过滤。不在白名单上的人，包括储备请求里自己带 `trusted` 之类字段的人，仍走原筛选。白名单只能由 `PUT /api/follow/allowlist` 写入。开启不制造证据，回执原因是 `approved_list`，不是 `new` 或 `followback`。

开关两边都保留：永久取关黑名单、已经关注过的人、固定永不取关 id、执行白名单强制、`kind=new` 的当天授权、身份核对、暂停、`X_API_MODE`、429/403 即停、台北 15 分钟工作 / 18 分钟休息、05:00–09:00 不关注、每日 350、当前每轮 13 人。发帖、取关和账号2不改。

管理页是「自动关注 / 取关」（`/automation`），先选账号1。账号1区块有复选框「已筛名单直接关注」和「保存已筛名单开关」。状态句来自接口，不是页面自己编的。保存不开始运行。

已经在储备里的人不用重新导入。2026-11-24 现场的 21 个 `kind=new` 只要仍是 `reserved`、在执行白名单里、不在取关黑名单、也没有成功账，打开开关后的下一个工作槽就会执行，每轮最多 13 人。不要为了这 21 人补证据，也不要再 `POST /api/follow/reserve`。

打开：

```bash
curl -sS -X PUT http://127.0.0.1:3847/api/follow/config \
  -H 'content-type: application/json' \
  -d '{"accountId":1,"approvedListFollow":true}'
```

核对。`approvedListFollow` 为 true，`approvedListStatus` 以「开启」开头。`dailyCap` 仍是 350。`ops.followback.batchSize` 仍是当前批量（现场是 13），`workMinutes` 15，`restMinutes` 18。`savesDoNotStart` 仍是 true。

```bash
curl -sS 'http://127.0.0.1:3847/api/follow/config?accountId=1'
curl -sS 'http://127.0.0.1:3847/api/follow?accountId=1'
curl -sS 'http://127.0.0.1:3847/api/follow/allowlist?accountId=1'
```

`GET /api/follow?accountId=1` 在台北 17:15–17:29 的 `schedule` 应为 `work`，槽 `taipei:当天T17:15`；05:00–08:59 为 `rest`。证据页可以继续是 `fresh: false`。下一次真实批次的成功行 `reason` 是 `approved_list`。同一槽再调用只回放，不第二次关注。

关闭并恢复原筛选：

```bash
curl -sS -X PUT http://127.0.0.1:3847/api/follow/config \
  -H 'content-type: application/json' \
  -d '{"accountId":1,"approvedListFollow":false}'
```

不必删列，不必重导名单。已经写成 `followed` 的人保持已关注。还是 `reserved` 的人恢复证据和资格筛选。账号2的配置请求不要带这个字段。
