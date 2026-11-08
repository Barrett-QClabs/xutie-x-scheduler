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

`source_namespace` 只能是 `user-X` 或 `x-public`。`source_tool` 只能是 `get_users_me`、`get_users_me_followers`、`get_users_me_following`、`get_users_posts`、`get_user`。`account_id` 必须等于该槽已授权的用户 id。账号2的信封不能写进账号1。

`GET /api/evidence?accountId=1` 返回最近页面的 `observedAt`、`expiresAt`、`fresh`、`paginationComplete`、`nextToken`、`activityWindowComplete`、`subjectCount`、`errors`，以及 `userDeveloperGets: 0`。

## 不推断

- 蓝 V 只在 `verified` 为 true 且 `verified_type` 为 `blue` 时成立。只有 `verified`、或工具不支持的 `is_blue_verified`，都是未知。
- `connection_status` 必须是数组才算关系证据。原数组会留下。数组缺失就是未知，不能当成未关注或未回关。
- `pagination_complete` 为 false 或仍有 `next_token` 时，不在这一页里的人没有结论。
- 公开帖不排除回复。样本没有命中转帖，所以不把「没看见转帖」说成已经覆盖转帖。
- 空时间线、不完整页、错误，都不能单独当成 48 小时不活跃。只有 `activity_window_complete`、分页完成、没有 errors、没有 excluded，才可以用「没有更新的帖」作为不活跃。看见一条 48 小时内的帖，则证明仍活跃。
- `lang` 没返回就是语言未知，新关注因此跳过。未知不是中文，也不是英文。
- 名单里没有真实关注时间。72 小时只读 `follow_success.succeeded_at`。
- 粉丝数、flb、最近发帖只改变储备排序，不构成拒绝。

缺任何硬条件就 skip 或 unknown，不调用用户 GET 去补。unknown 和 failed 不会在下一批自动重试。

## 身份

启动、resume、补库和批次都不会调用 `GET /2/users/me`。live 下的「重新测试」如果库里已有该槽的 `user_id`，只把已保存的身份读回来，不改槽、不访问 X。如果该槽还没有身份，返回 `identity_reconfirm_blocked`。要用免费供给更新身份，父提交 `source_tool` 为 `get_users_me`、且 id 与该槽授权 id 相同的信封。没有这份信封时，免费的身份再确认在本程序内是阻塞项。

## 还没由程序自动做的事

程序不会自己调用插件去拉粉丝、关注或帖子。候选和证据一开始都是空的。父用已授权的只读流程把信封送进来之后，批次才看缓存。缓存过期后必须再送一份新信封，程序不会用用户 API 刷新。
