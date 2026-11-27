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

## 页面配置与运行时设置

进程每 20 秒调用一次内部调度；工作节奏读每个账号已保存的 `automation_settings`。在「自动关注 / 取关」（`/automation`）选择账号后，可修改排程时区 `scheduleTimezone`、日上限时区 `quotaTimezone`、关注/取关的每轮人数、日上限（取关可选不设上限）、工作/休息分钟、锚点、时间窗、互斥，以及蓝 V、受众语言、近期活跃过滤。

`GET/PUT/DELETE /api/automation/settings?accountId=1|2` 分别读取、部分更新、恢复该号默认设置。页面用 `PUT /api/automation/settings`，正文为 `{ accountId, settings: { ...改动字段 } }`；未改字段不发送，所以只改批量不会重写同一通道已有的自定义工作/休息分钟。保存配置不会开始运行。`GET /api/follow/config` 继续提供关键词和账号1的 `ops` 兼容视图；旧晚间 `newFollow` 数字只为兼容保留，不驱动统一池节奏。已筛名单开关见文末。

时区可从列表选择，也可输入有效 IANA 名称，如 `Asia/Taipei`、`Europe/London`、`America/New_York`；不接受 `+08:00` 这样的偏移。`scheduleTimezone` 决定锚点、工作窗和幂等槽位键，`quotaTimezone` 决定日上限在当地午夜重置，两者可分别设置。台北排程的键例如 `taipei:YYYY-MM-DDTHH:MM`，其他排程时区用 `tz:<IANA>:YYYY-MM-DDTHH:MM`；历史 `taipei-new:` 槽只供审计。改工作/休息、锚点或窗口只影响未来尚未写入的槽；已完成槽只回放原结果，不重复执行。进程整段窗口不在线时不补跑。

编译默认值是：账号1以台北为排程和日上限时区，关注/回关共用 09:00 锚定的 15 分钟工作 / 18 分钟休息、09:00–次日 05:00 窗口，每轮 13 人、每日合计 350（含在途名额），互斥开启；取关 05:00–09:00，:15/:45 开槽，每批 10、每日 80。账号2默认台北 00:00 锚定 15/15、全天关注，每轮 10、每日 380，日上限默认按伦敦午夜重置；取关同一默认窗口、每批 10、不设日上限，互斥关闭。过滤默认蓝 V 和受众语言开、近期活跃关。这些值不是不可改的运行时规则；保存后以该号设置为准，升级前的 `ops` 兼容值见[免费证据契约](free-evidence.md)。

按上述默认值，账号1台北 14:35 属于 14:30 槽，09:00–09:14 为 `work`、09:15–09:32 为 `rest`、05:00–08:59 无关注槽；账号2台北每小时 00–14 分和 30–44 分为 `work`。这些仅用于核对默认配置，修改后应以设置和状态接口为准。外部例程若仍在暂停/恢复某号，会独立影响运行，不应把账号2的旧例程套到账号1。换容器时沿用原数据卷和原加密密钥，不要运行 `install.sh`，不要改待发帖。

账号1的 `kind=followback` 和 `kind=new` 从永久池随机抽用，不按 `followed_by` 分池。未关注的人跨日保留，不按日期过期；已成功关注或已确认取关的人不再执行。成功取关写入永久黑名单，后续入池和关注前都排除。

## 新关注持续授权与身份

账号1的 `kind=new` 需要持续授权，或仍有效的旧当天授权。在自动化页可授权、暂停、恢复、撤销，并可选填到期时间（按当前排程时区输入）。`GET/POST/DELETE /api/follow/authorization` 读取、修改或撤销持续授权；`POST` 的 `action` 为 `authorize`、`pause`、`resume`、`revoke`，可带 `expiresAt` 和 `note`。持续授权跨午夜保留，暂停后可恢复，恢复沿用原到期时间；撤销或到期后不再放行。旧的 `POST /api/follow/new-approval` 只覆盖一个台北日。暂停或撤销持续授权也会使更早写入的当天授权不再放行。回关不需要这份授权，程序永不自动补写授权。授权本身不打开开关或恢复已暂停的通道。

在「设置」页可核验或重新绑定当前账号槽的身份。普通 `POST /api/credentials/test` 在已有身份时返回已存身份，不重新访问 X；只有操作者明确要求重新核验时才带 `reverify: true`，重新读一次 `GET /2/users/me`。live 读取不可用时可在页面手动填 `userId`、`username`、可选 `displayName`，通过 `PUT /api/credentials/identity` 保存（显示名留空则使用用户名）。关注和取关只在身份为 `confirmed` 时执行，两槽不能共用同一个 `user_id`。详见[身份与证据契约](free-evidence.md#身份)。

证据持续供给仍是父把免费插件结果 `POST /api/evidence`。程序不搜索、不调用 X 的 GET。信封字段见 `docs/free-evidence.md`。

账号1的取关池由外部导入建立，不要求伦敦 00:00 导入。进程之后按已保存的取关工作窗、节奏和批量自行执行，助手不在线也会继续；`:15` / `:45`、每槽 10 人仅是默认值。证据缺失或过期只跳过，候选保持 `candidate`。取关证据从 `observed_at` 起最长 25 小时。候选和剩余可执行数是 `GET /api/unfollow/candidates?accountId=1`。72 小时只认本账号 `follow_success.succeeded_at`。following 列表名次大于 1000 的没回关候选用 `followingPage: 41` 或 `followingRank` 导入，不再要求关注时间；名次 1000 以内仍要 72 小时。账号1的 `inactive_48h` 同样只在名次大于 1000 时可以不带关注时间：证据里要有最新公开帖时间，且执行时严格早于 48 小时，`activity_window_complete: false` 也可以。没有帖子时间仍然跳过，不编造 `followedAt`。名次 1000 及以内不取。账号2的不活跃规则不变。`unknown` 可以靠这次带位置的导入回到 `candidate`。

账号1按上述授权规则执行永久池里的 followback 和 new；账号2在回关之后仍可以用 new 补位。新关注要先进入候选池才会被批次执行；把现有 `kind=new` 且 `status=reserved` 的人清出去用：

```json
{ "accountId": 2, "kinds": ["new"], "statuses": ["reserved"], "reason": "hold_new" }
```

`POST /api/follow/reserve/prune` 只处理正文里的 `accountId`。匹配的 reserved 行从活动储备删掉，原字段、`checkedAt`、`createdAt`、`updatedAt` 和原先的 result/reason 写入 `follow_reserve_audit`。`follow_success`、失败和 unknown 行不改。`kinds` 省略时，只移走过期、关系未知或其他当前不能执行的 reserved；写了 `kinds:["new"]` 时，该号全部 reserved new 都移走，回关行留下。`reason` 不能写成 `spam` 或 `not_blue`。审计是 `GET /api/follow/reserve/audit?accountId=2&limit=50`。之后用新鲜且证据合格的 `POST /api/follow/reserve` 可以重新入库；成功、失败和 unknown 不会因此变回可执行。读接口不会自己清理。`13f378e` 还没有这个接口。

## 分账号已筛名单开关

账号1和账号2各有独立的 `approvedListFollow` 开关，按 `account_id` 存在 `follow_account_config.approved_list_follow`，默认关闭（`0`）。进程启动时若列不存在会补上，重复启动不会把开关打开。`PUT /api/follow/config` 带 `approvedListFollow` 只更新请求账号的开关，账号2也可保存，不再锁定。已有储备、成功账、黑名单和证据行都不会被开关保存改写。

关闭（默认）时，各账号继续原有证据和资格筛选。账号1仍要新鲜证据，并继续做蓝V、垃圾内容、是否已关注、中文和资格判断。账号1证据页 `fresh: false` 时，批次可以提交，但结果是 `evidence_pending`，人留在 `reserved`，不会假装已经查过资料。

开启时，只对该账号执行白名单里的人跳过缺证据、非蓝V、受众语言和资格过滤。不在该账号白名单上的人，包括储备请求里自己带 `trusted` 之类字段的人，仍走原筛选。每个账号的执行白名单分别存在 `follow_allowlist_control` 和 `follow_execution_allowlist`，通过 `GET/PUT /api/follow/allowlist?accountId=1|2` 读取和保存，也可在 `/automation` 编辑。两个账号的开关、强制标记和名单完全独立，不共享数据。开启不制造证据，回执原因是 `approved_list`，不是 `new` 或 `followback`。

两个账号开关开启或关闭都保留：本账号永久取关黑名单（账号1和账号2取关成功都会写入各自黑名单）、已经关注过的人、执行白名单强制、身份核对、暂停、`X_API_MODE=live`、429/403 即停，以及 `automation_settings` 里保存的节奏、窗口和上限。账号1还保留固定永不取关 id 和 `kind=new` 的授权（持续授权或当天授权）；其默认设置为台北 15 分钟工作 / 18 分钟休息、05:00–09:00 不关注、每日 350、每轮 13 人。保存开关不改发帖、取关设置或另一账号。

管理页是「自动关注 / 取关」（`/automation`），先选要管理的账号。两个账号区块各有复选框「已筛名单直接关注」、「保存已筛名单开关」和执行白名单编辑器，只保存所选账号。状态句来自接口，不是页面自己编的。保存不开始运行。下面命令和现场记录以账号1为例；管理账号2时使用 `accountId: 2` 或 `?accountId=2`。

已经在储备里的人不用重新导入。2026-11-24 现场的 21 个 `kind=new` 只要仍是 `reserved`、在执行白名单里、不在取关黑名单、也没有成功账，且授权和运行门均满足，打开开关后的下一个工作槽就可执行；当时每轮最多 13 人，当前批量以保存的设置为准。不要为了这 21 人补证据，也不要再 `POST /api/follow/reserve`。

打开：

```bash
curl -sS -X PUT http://127.0.0.1:3847/api/follow/config \
  -H 'content-type: application/json' \
  -d '{"accountId":1,"approvedListFollow":true}'
```

核对。`approvedListFollow` 为 true，`approvedListStatus` 以「开启」开头；批量、日上限和工作/休息分钟应与切换前保存的设置一致。2026-11-24 现场值是每日 350、每轮 13、工作 15 / 休息 18，不是当前必须使用的数字。`savesDoNotStart` 仍是 true。

```bash
curl -sS 'http://127.0.0.1:3847/api/follow/config?accountId=1'
curl -sS 'http://127.0.0.1:3847/api/follow?accountId=1'
curl -sS 'http://127.0.0.1:3847/api/follow/allowlist?accountId=1'
```

若仍使用上述默认设置，`GET /api/follow?accountId=1` 在台北 17:15–17:29 的 `schedule` 为 `work`，槽例如 `taipei:当天T17:15`；05:00–08:59 为 `rest`。使用自定义设置时按当前排程时区和网格核对。证据页可以继续是 `fresh: false`。下一次真实批次的成功行 `reason` 是 `approved_list`。同一槽再调用只回放，不第二次关注。

关闭并恢复原筛选：

```bash
curl -sS -X PUT http://127.0.0.1:3847/api/follow/config \
  -H 'content-type: application/json' \
  -d '{"accountId":1,"approvedListFollow":false}'
```

不必删列，不必重导名单。已经写成 `followed` 的人保持已关注。还是 `reserved` 的人恢复证据和资格筛选。账号2可用同一字段独立开关，不影响账号1。
