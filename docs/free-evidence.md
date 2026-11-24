# 免费证据契约

用户自己的 X 开发者额度只允许三件写入：关注 `POST /2/users/{id}/following`、取关 `DELETE /2/users/{source}/following/{target}`、发帖。所有 GET，包括 `/2/users/me`、蓝 V、关系、回关、公开帖、名单分页和搜索，都在发出请求之前被拒绝。模拟模式同样不打开这些读取。

云端没有父的 user-X 插件连接，也不会保存插件 token。父把已经读到的结果按下面的信封交给 `POST /api/evidence`。程序只保存这份证据，不按批重扫，也不用用户额度补洞。免费供给自身大约 30 次/分钟、1000 次/天，这个限额不由本程序去打用户 API。

## 信封

`POST /api/evidence`，正文：

```json
{
  "accountId": 1,
  "evidence": {
    "schema_version": 1,
    "account_id": "1933586991612080128",
    "source_namespace": "user-X",
    "source_tool": "get_users_me_following",
    "observed_at": "2026-11-08T07:50:00.000Z",
    "expires_at": "2026-11-08T08:30:00.000Z",
    "request_fields": ["verified", "verified_type", "connection_status"],
    "coverage": {
      "pagination_complete": false,
      "next_token": "page-2",
      "activity_window_complete": false,
      "excluded": []
    },
    "errors": [],
    "evidence_refs": ["contract_082a"],
    "subjects": [
      {
        "id": "555",
        "username": "ada",
        "verified": true,
        "verified_type": "blue",
        "connection_status": ["following", "followed_by"],
        "public_metrics": { "followers_count": 1200 },
        "posts": [{ "id": "1", "created_at": "2026-11-08T07:00:00.000Z", "lang": "zh", "text": "你好" }]
      }
    ]
  }
}
```

`source_namespace` 按实际值保存：中文插件 `user-X`，英文插件 `user-X--english`，公共读 `x`。旧名 `x-public` 仍可收，规范化来源记为 `public`，插件记为 `user-plugin`。`source_tool` 原样保存，包括 `get_posts_by_ids`、`search_posts_all` 和 `search_users`，不会改写成别的工具名。`user-X` 只接受账号1的 id，`user-X--english` 只接受账号2的 id。搜索词里的 `lang:en` 不是帖子的 `lang`。这两种抽样工具即使声明 `activity_window_complete`，入库后的有效完整标记仍是 false。

`GET /api/evidence?accountId=1` 返回最近页面的 `observedAt`、`expiresAt`、`fresh`、`paginationComplete`、`nextToken`、`activityWindowComplete`、`subjectCount`、`errors`，以及 `userDeveloperGets: 0`。

## 账号1晚间新关注：search_users

`user-X` 的 `search_users` 在请求了 `connection_status` 时，没有关系的用户对象不会带这个字段。账号1把这种缺失当成空关系。用户对象不要自己补 `connection_status: []`。`lang` 仍要有，名字或简介里要有中文，否则语言未知，新关注仍然不会执行。蓝 V 仍要 `verified: true` 且 `verified_type: "blue"`。

`POST /api/evidence`

```json
{
  "accountId": 1,
  "evidence": {
    "schema_version": 1,
    "account_id": "1933586991612080128",
    "source_namespace": "user-X",
    "source_tool": "search_users",
    "observed_at": "2026-11-12T10:00:00.000Z",
    "expires_at": "2026-11-12T10:40:00.000Z",
    "request_fields": ["id", "username", "name", "description", "verified", "verified_type", "connection_status", "lang"],
    "coverage": {
      "pagination_complete": true,
      "next_token": null,
      "activity_window_complete": false,
      "excluded": []
    },
    "errors": [],
    "evidence_refs": ["search_users:connection_status"],
    "subjects": [
      {
        "id": "91001",
        "username": "xinren",
        "name": "中文名",
        "description": "人工智能",
        "verified": true,
        "verified_type": "blue",
        "lang": "zh"
      }
    ]
  }
}
```

`POST /api/follow/reserve`

```json
{
  "accountId": 1,
  "checkedAt": "2026-11-12T10:00:00.000Z",
  "candidates": [
    { "targetUserId": "91001", "username": "xinren", "kind": "new" }
  ]
}
```

`checkedAt` 是 `2026-11-12` 台北 18:00。晚间窗口只执行 `kind=new`。若该人已经是 `unknown` / `following_unconfirmed`，先送上面的证据，再用一份仍在 45 分钟内的储备把同一 id 重新放回 `reserved`。

## 账号1日池开关

账号1的运营数字存在 `follow_account_config.ops_json`。没有这份 JSON 时，账号1按已批准的日池默认运行；账号2读到 `{ "dailyPool": false, "locked": true }`，保存 `ops` 会得到 400。`GET /api/follow/config?accountId=1` 返回当前值。`PUT` 带 `ops` 时改日池数字；带 `keywords` 时只保存关键词；带 `approvedListFollow` 时只改账号1的已筛名单开关。这三个字段可以单独提交。管理页账号1有「每天一次候选池」、回关每轮、新关注每轮、取关每批、取关日上限，以及「已筛名单直接关注」。保存不开始运行，也不写晚间新关注授权。

真正可调的是日池开关、回关每轮、新关注每轮、取关每批，以及取关日上限。批量是 1–20 的整数。取关日上限是 0–80 的整数，默认 80；不能写成 81 或 380。这个上限不随 `dailyPool` 关闭而消失。时区固定 `Asia/Taipei`，只展示。`slotClock` 固定 `compiled`。账号1的关注槽是 09:00 锚定的 15/18 循环，05:00–09:00 关闭；取关仍是 05:15–08:45。保存不能改这些分钟或窗口。执行不读保存下来的窗口数字。账号1的 `validUntil` 是 `permanent`：未用候选不按日期过期。取关证据仍是 `next_09_capped_25h`。关闭 `dailyPool` 不会把账号1关注库存退回 45 分钟门，也不改变取关上限。

槽位键就是幂等身份，例如 `taipei:2026-11-15T00:00` 和 `taipei-new:2026-11-15T18:00`。若改工作/休息或窗口，同一时刻会落到另一串键，已完成的槽无法再被认成同一槽，可能重跑。所以现在不把时窗做成可调。以后若要调，只能让新网格对还没写过的槽生效，旧键保持原样；那是单独迁移，这次不改。

账号1已经入库的关注和回关不因 `checkedAt` 到了 05:00 或次日 00:00 而失效，下一次导入同一个 id 也不会覆盖仍是 `reserved` 的行。执行不发起新的外部读取。默认资格仍读本地证据：证据缺失就跳过并保持 `reserved`。账号1的「已筛名单直接关注」默认关闭；打开后只对执行白名单上的人跳过证据、蓝V、中文和资格过滤，不补写证据。不在白名单上的人仍按这句话处理。见 `docs/account-automation.md`。取关证据仍是 `min(expires_at, observed_at + 25h)`。账号1的 `kind=new` 必须有当天、且不晚于 24:00 的 `follow_new_approval`；程序不会自己补写授权，昨日的记录不能沿用。这份授权覆盖该台北日里 05:00–09:00 以外的全部工作槽，不必等到 18:00。回关不看这份授权。白名单、已关注、暂停、429/403 即停都保留。05:00–09:00 只是没有槽，程序不会因此把关注队列改成暂停。

```json
{
  "accountId": 1,
  "ops": {
    "dailyPool": true,
    "followback": { "batchSize": 13, "workMinutes": 15, "restMinutes": 18 },
    "newFollow": { "batchSize": 9, "workMinutes": 15, "restMinutes": 20 },
    "unfollow": { "batchSize": 10, "dailyCap": 80 }
  }
}
```

## 账号1回关跨夜储备

账号1已入库的关注和回关不按 `checkedAt` 的日期过期，跨日仍可抽取。执行仍读本地证据：证据缺失时这一轮跳过并保持 `reserved`，不关注，也不把 `checkedAt` 改成现在。资格仍是蓝 V、不是已关注；回关还要确认对方关注了本账号。账号2的 45 分钟门不变。取关证据仍是 `min(expires_at, observed_at + 25h)`；23:00 的证据只要 `expires_at` 盖过次日 09:00，并且不超过这 25 小时，09:00 仍然有效。

## 账号1新关注入池

账号1、`kind=new` 可以不靠 45 分钟储备新鲜度，也不在每个槽重读蓝 V、语言或关系。`POST /api/follow/new-admission` 只收账号1。资格用请求里的快照核一次。`qualificationCheckedAt` 和 `admittedAt` 必须是可解析时间，不能晚于现在 5 分钟以上；服务端不会改成导入时间。已关注、白名单、非蓝 V、仍在关注、或不是中文的人会被拒绝。重复 id 不改原来的核实时间。

`kind=new` 还要当天的 `POST /api/follow/new-approval`。起止必须在同一个台北日内，结束不晚于当天 24:00。没有这份授权时，新人留在池里，回关仍可执行；只有新人可执行时批次原因是 `approval_required`。授权不刷新证据。没用完的人留到以后；下一天要新的授权才会再执行新人。节奏与回关相同，不再单独使用 18:00–24:00 或每轮 9 人。429 或 403 会暂停账号1的关注并停下这一批。账号2仍走原来的 45 分钟储备。

`GET /api/follow?accountId=1` 的 `newAdmission` 给出 `admitted`、`executable`、`succeeded`。

```json
{
  "accountId": 1,
  "candidates": [{
    "targetUserId": "91001",
    "username": "xinren",
    "qualificationCheckedAt": "2026-11-13T06:00:00.000Z",
    "admittedAt": "2026-11-13T06:00:00.000Z",
    "snapshot": {
      "verified": true,
      "verifiedType": "blue",
      "following": false,
      "lang": "zh",
      "name": "中文名",
      "description": "人工智能"
    }
  }]
}
```

```json
{ "accountId": 1, "approvedStart": "2026-11-13T10:00:00.000Z", "approvedEnd": "2026-11-13T16:00:00.000Z" }
```

`10:00Z` 到 `16:00Z` 是台北 18:00–24:00，现在和白天一样可以抽永久池。

## 不推断

- 蓝 V 只在 `verified` 为 true 且 `verified_type` 为 `blue` 时成立。只有 `verified`、或工具不支持的 `is_blue_verified`，都是未知。
- `connection_status` 必须是数组才算关系证据。原数组会留下。数组缺失就是未知，不能当成未关注或未回关。唯一例外是账号1、`source_tool` 为 `search_users`、并且 `request_fields` 含 `connection_status`：该用户对象没有这个字段时，记为空关系（未关注、未回关）。程序不补写 `[]`。`source_tool` 和 `connection_omission_empty` 留在 `evidence_subjects` 里。带 `following` 的数组仍是已关注。账号2以及其他工具缺字段时仍是未知。账号1里因 `following_unconfirmed` 变成 `unknown` 的储备，之后若新证据已经合格，再次 `POST /api/follow/reserve` 可以回到 `reserved`。账号2的 unknown 不会因此重开。
- `pagination_complete` 为 false 或仍有 `next_token` 时，不在这一页里的人没有结论。
- 公开帖不排除回复。样本没有命中转帖，所以不把「没看见转帖」说成已经覆盖转帖。
- 空时间线、不完整页、错误，都不能单独当成 48 小时不活跃。只有 `activity_window_complete`、分页完成、没有 errors、没有 excluded，才可以用「没有更新的帖」作为不活跃。看见一条 48 小时内的帖，则证明仍活跃。账号1另有一条：following 名次大于 1000，且免费公共读里带了最新公开帖的 `created_at`，执行时该时间严格早于 48 小时，则即使 `activity_window_complete` 为 false 也可以取关。不补写 `followedAt`。名次 1000 及以内、没有帖子时间、以及账号2，仍按原规则跳过。成功原因是 `inactive_48h_beyond_1000`。
- `lang` 没返回就是语言未知，新关注因此跳过。未知不是中文，也不是英文。
- 取关证据的有效期最长是 `observed_at` 之后 25 小时。`expires_at` 更晚时，取关只认到这 25 小时；过了就当过期。关注储备不使用这 25 小时上限。
- 取关执行时如果这个人的证据缺失或已经过期，本槽跳过，`status` 保持 `candidate`，`reason` 记 `evidence_missing` 或 `evidence_expired`。这不是不可再打开的 `unknown`。同一天后面的 `:15` / `:45` 槽还会再看。
- 72 小时未回关只认同一 `accountId` 的 `follow_success.succeeded_at`。导入没传 `followedAt` 时用这个时间。传了就必须和账本一致，否则该人被拒绝。没有账本、也没有位置依据时，不抄 `firstRecordedAt`，也不把观察时间当成关注时间，72 小时这条保持 `follow_time_unknown`。
- 位置依据是 `followingRank`，或 `followingPage`（默认每页 25 人，页内位置默认 1）。1 是 following 列表最浅的人。只有名次大于 1000，也就是第 41 页及之后，才取消 72 小时检查。第 40 页和名次 1000 以内仍走 72 小时。执行时仍要有 25 小时内的证据：`connection_status` 含 `following`、不含 `followed_by`。
- 粉丝数、flb、最近发帖只改变储备排序，不构成拒绝。

缺任何硬条件就 skip 或 unknown，不调用用户 GET 去补。证据缺失或过期的取关候选保持 `candidate`，下个取关槽可以再试。其他 unknown 和 failed 不会在下一批自动重试。

## 身份

启动、resume、补库和批次都不会调用 `GET /2/users/me`。live 下的「重新测试」如果库里已有该槽的 `user_id`，只把已保存的身份读回来，不改槽、不访问 X。如果该槽还没有身份，返回 `identity_reconfirm_blocked`。要用免费供给更新身份，父提交 `source_tool` 为 `get_users_me`、且 id 与该槽授权 id 相同的信封。没有这份信封时，免费的身份再确认在本程序内是阻塞项。

## 还没由程序自动做的事

程序不会自己调用插件去拉粉丝、关注或帖子。候选和证据一开始都是空的。父用已授权的只读流程把信封送进来之后，批次才看缓存。缓存过期后必须再送一份新信封，程序不会用用户 API 刷新。
