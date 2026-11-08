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

进程每 20 秒调用一次内部调度。两号用同一伦敦钟：从 00:00 起每 30 分钟一轮，前 15 分钟最多关注 10 人，后 15 分钟休息。工作槽是 `HH:00` 和 `HH:30`。`HH:15` 和 `HH:45` 是休息，不是关注槽。取关仍是 `HH:15` 和 `HH:45`，每槽最多 10 人。同一槽已完成就回放，不重复写。进程整段窗口不在线时不补跑。已部署的 `f4c713d` 仍是 45 分钟一轮。`GET /api/follow/config` 没有周期字段，`PUT` 只接受 `accountId` 和 `keywords`，所以 30 分钟要换容器后才生效。换容器时沿用原数据卷和 `credentials.key`，不要运行 `install.sh`，不要改待发帖。换完后，伦敦每小时的 15–29 分和 45–59 分，`GET /api/follow?accountId=1` 与 `2` 的 `schedule` 应为 `rest`；00–14 分和 30–44 分应为 `work`。

证据持续供给仍是父把免费插件结果 `POST /api/evidence`。程序不搜索、不调用 X 的 GET。信封字段见 `docs/free-evidence.md`。
