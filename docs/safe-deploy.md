# 安全部署

English summary is at the bottom. This file is the operator checklist. It does not deploy a host, open a port, or call X.

## 没有受支持的 bot 浏览器预览

Grok Bot 的浏览器不能打开这台机器上的 `127.0.0.1`。Cursor 团队在 2026-11-07 确认这是镜像更新后的有意安全限制：浏览器只能使用自带代理的 loopback，shell 不受影响。论坛记录：<https://forum.cursor.com/t/grok-bot-browser-blocked-from-loopback-127-0-0-1-since-nov-6-local-services-unreachable-shell-fine/177563>。

官方私网文档（<https://cursor.com/docs/grok-bot/private-networks>）提供的是另一条路径：Enterprise 的 Team Setup Scripts，或把公网流量转到成员桌面。桌面路由不会打开 bot 自己的 loopback，解析到私网或 VPN 地址的站点默认仍被拒绝。这些都需要组织、身份或网络客户端，本仓库不启用。

因此：

- 换端口不能让 bot 浏览器打开本机页面。
- 不要用隧道、公网中继、防火墙或浏览器参数去绕过这个限制。
- 本机页面由操作者在自己的浏览器里打开。bot 侧只用 shell 访问 loopback，例如 `curl` 到下面的只读接口。
- 序帖没有登录。不要把端口暴露到公网。

需要外部 HTTPS 托管、域名或身份认证账号时，先由操作者决定。本文不执行这些步骤。

## 进程默认

| 项 | 默认 | 正式发帖前 |
| --- | --- | --- |
| `X_API_MODE` | 不是精确的 `live` 就是模拟。模拟不请求 `api.x.com` | 只有打算请求 X 时才设为 `live`，然后重启这一个进程 |
| 新数据库 | `queue_settings.paused = 1`，`pause_reason = safe_start` | 已有数据库保持原来的暂停值，不会被改写 |
| `HOST` / `PORT` | `127.0.0.1` / `3847` | 容器内需要 `HOST=0.0.0.0`，端口仍不要直接公开 |
| `XUTIE_AUTOMATION_SUPERVISOR` | 不是精确的 `on` 就不启动关注或取关进程 | 保持 `off` |
| `CREDENTIALS_ENCRYPTION_KEY` | 无默认密钥 | 保存凭据前在服务器上设置为至少 16 位。不要写进仓库，不要发到聊天 |

`POST /api/queue/pause` 没有请求体，只把本库写成 `paused=1`、`pause_reason=manual`。它不发帖，也不请求 X。`POST /api/queue/resume` 会取消暂停；在准备发帖之前不要调用。

已有数据库升级到这一版后，原来的 `paused` 值保留。若那一行仍是未暂停，需要操作者自己调用暂停接口。

## 只读核对

这两个接口不返回密钥，诊断接口本身不请求 X。

```bash
curl -sS 'http://127.0.0.1:3847/api/state?accountId=1'
curl -sS 'http://127.0.0.1:3847/api/diagnostics?accountId=1'
curl -sS 'http://127.0.0.1:3847/api/state?accountId=2'
```

同一进程里有两个槽：账号1、账号2。每个槽单独加密保存自己的四项凭据，并单独拥有队列、暂停状态和发帖记录。请求不带 `accountId` 会返回 400，不会落到另一个号。新数据库两个槽都是暂停。旧的单账号库升级后，原来的凭据和队列留在账号1，暂停值保持原样；账号2是新建的空队列，默认暂停。

安全配置下应看到：

- `deployment.apiMode` 为 `mock`
- `deployment.queuePaused` 为 `true`
- `deployment.sendsWhenDue` 为 `false`
- `deployment.automationSupervisor` 为 `off`
- `deployment.credentialsConfigured` 反映是否已经保存四项，不包含四项本身
- `deployment.encryptionKeyConfigured` 只表示密钥长度是否够，不包含密钥
- `mockMode` 为 `true`
- `/api/diagnostics` 的 `offline` 为 `true`，`callsX` 为 `false`

侧栏会显示「认证模式：模拟」和「关注自动化：关闭」。设置页的四项由操作者在自己的浏览器里填写。保存用的是 `PUT /api/credentials`，随后的测试在模拟模式下不请求 X。不要把四项贴到聊天或工单里。

模拟模式即使队列未暂停，也不会请求 X。它可能把到点的帖子在本地标成已发送。不要把准备真正发出的稿子导入一个还在模拟的队列。

## 切到真实请求之前

1. 确认 `deployment.queuePaused` 仍是 `true`，`sendsWhenDue` 仍是 `false`。
2. 把 `X_API_MODE` 设为 `live` 并重启这一个进程。
3. 再读 `/api/state`。`apiMode` 应为 `live`，`sendsWhenDue` 仍应为 `false`。
4. 设置页「重新测试已保存的凭据」只调用 `GET /2/users/me`。这一步在 `X_API_MODE=live` 时会请求 X。队列保持暂停时，调度不会发帖。
5. 只有操作者决定发帖时，才 `POST /api/queue/resume`。

关注自动化页在 supervisor 关闭时不提供启动按钮。`POST /api/automation/start` 返回 403，代码 `automation_disabled`。

## 分账号关注与取关

`XUTIE_AUTOMATION_SUPERVISOR` 保持 `off`。不要启动 `automation/*.mjs`。四个开关各自默认 `off`：`XUTIE_ACCOUNT1_UNFOLLOW`、`XUTIE_ACCOUNT2_UNFOLLOW`、`XUTIE_ACCOUNT1_FOLLOW`、`XUTIE_ACCOUNT2_FOLLOW`。模拟模式不调用 `xGet`、`xDelete`、`xPost`。正式执行还要该号已 resume，并且库里的 `user_id` 分别是账号1 `1933586991612080128`、账号2 `1468479269701820422`。这些接口不改发帖队列。

时区是 `Europe/London`，含夏令时。取关从当天 00:15 起每 30 分钟最多 10 人，00:00–00:14 不执行。关注从 00:00 起以 45 分钟为一轮：前 15 分钟最多 10 人，随后休息 30 分钟。每个号自己的新关注加回关，每天最多 380，伦敦零点清零。同一伦敦槽重复调用只回放原结果。

取关资格是或关系，未知不算满足：确证非蓝 V，或 `followedAt` 起已满 72 小时且确证未回关，或最新公开帖严格早于 48 小时。`firstRecordedAt` 只留档，不能当成关注时间。公开帖包含回复和转帖，请求不带 `exclude`。账号1白名单仍是原来的 7 个数字 id。账号2白名单是空的，不会抄账号1。

账号2名单库是储备，不是关注记录。`POST /api/follow/reserve` 正文 `{"accountId":2,"checkedAt":"<ISO>","candidates":[{"targetUserId":"123","kind":"followback"|"new"}]}`。`checkedAt` 超过 45 分钟视为陈旧，不能拿来关注。`GET /api/follow?accountId=2` 的 `reserve` 给出 `updatedAt`、`available`、`followbackAvailable`、`newAvailable`、`stale`、`gap`、`constraint`。`constraint` 可以是 `disabled`、`identity_unconfirmed`、`paused`、`rest`、`daily_cap`、`stale_reserve`、`insufficient_candidates`。人数不够时 `gap` 大于 0，本批不凑数，也不放宽蓝 V。回关储备排在新关注前面。动作前重新核验蓝 V、关系和当日剩余额度。实际成功只写在 `follow_success` 和 `GET /api/follow/batches`。储备分页是 `GET /api/follow/reserve`。

新关注在核验时还要满足：账号1为中文（推文 `lang=zh` 且名字、简介或正文符合中文规则），账号2为英文（`lang=en`），粉丝数不超过 20000，最近公开帖在 12 小时内，不是已关注，也不是明显诈骗文案。回关只要求确证蓝 V 且对方已关注自己。非蓝或未知不关注，未知结果不再进入下一批。

取关导入是 `POST /api/unfollow`，正文带 `accountId` 和 `candidates`。`targetUserId` 是数字字符串，`tier` 只能是 `non_blue`、`no_followback_72h`、`inactive_48h`。`followedAt` 才是真实关注时间，可省略；省略时 72 小时那条不成立。`firstRecordedAt` 可以同时留下，但不会被抄进 `followedAt`。批次是 `POST /api/unfollow/batches`，正文只有 `{"accountId":1}` 或 `{"accountId":2}`。幂等键是伦敦槽，例如 `2026-11-08T00:15`。`submitted` 是本批纳入人数，`unfollowed` 只数成功。门没过时 HTTP 200，`executed: false`，`reason` 依次是 `disabled`、`mock_mode`、`outside_window`、`identity_unconfirmed`、`paused`、`verifier_unavailable`，重叠时是 `overlap`。暂停和恢复是 `POST /api/unfollow/pause` 与 `/resume`，只影响该号的取关控制。状态和审计是 `GET /api/unfollow` 与 `GET /api/unfollow/batches`。关注的实际批次是 `POST /api/follow/batches`，`followed` 才是成功人数。

官方调用，每个号只用自己的 OAuth 1.0a：

- `GET https://api.x.com/2/users?ids={target}&user.fields=connection_status,verified,verified_type,public_metrics,description,name,username`
- `GET https://api.x.com/2/users/{target}/tweets?max_results=5&tweet.fields=created_at,lang,text`
- `POST https://api.x.com/2/users/{source}/following`，正文 `{"target_user_id":"{target}"}`
- `DELETE https://api.x.com/2/users/{source}/following/{target}`

## English

There is no supported Grok Bot browser preview of a service on `127.0.0.1`. Cursor staff confirmed the loopback block on 2026-11-07. The [private-network docs](https://cursor.com/docs/grok-bot/private-networks) require an Enterprise networking setup or a desktop route that still blocks private addresses; this repo does not turn those on. Operators open the UI themselves. A bot may use the shell against loopback. Do not tunnel the port or publish it.

Defaults: anything other than `X_API_MODE=live` is mock; a new database starts paused with `pauseReason=safe_start`; an existing database keeps its pause flag; follow automation stays off unless `XUTIE_AUTOMATION_SUPERVISOR=on`; `npm start` binds `127.0.0.1:3847`. `deployment.sendsWhenDue` is true only when mode is live and the queue is not paused. Do not resume, and do not paste API secrets into chat.
