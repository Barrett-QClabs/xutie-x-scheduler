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

进程每 20 秒调用一次内部调度。关注在伦敦 00:00 起的 45 分钟循环里，前 15 分钟最多 10 人，其余时间是休息。取关从伦敦 00:15 起每 30 分钟一槽，例如 `2026-11-08T00:15` 和 `2026-11-08T00:45`。同一槽已完成就回放，不重复写。进程整段窗口不在线时不补跑。外部半点 cron 会漏掉 00:45 这种关注窗，所以不能只靠它。

证据持续供给仍是父把免费插件结果 `POST /api/evidence`。程序不搜索、不调用 X 的 GET。信封字段见 `docs/free-evidence.md`。
