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
4. 设置页「重新测试已保存的凭据」只调用 `GET /2/users/me`。这一步会请求 X，并可能扣读取额度。队列保持暂停时，调度不会发帖。
5. 只有操作者决定发帖时，才 `POST /api/queue/resume`。

关注自动化页在 supervisor 关闭时不提供启动按钮。`POST /api/automation/start` 返回 403，代码 `automation_disabled`。

## 账号1自动取关

默认关闭。`XUTIE_AUTOMATION_SUPERVISOR` 保持 `off`，否则会尝试启动回关和关键词关注。只在准备按授权跑账号1取关时把 `XUTIE_ACCOUNT1_UNFOLLOW=on`。父定时调用 `POST /api/unfollow/batches`，正文 `{"accountId":1}`。未活跃层级 `inactive_48h` 只在最新公开帖严格早于 48 小时时才算符合；刚好 48 小时不取关。库里旧的 `inactive_36h` 也按这个 48 小时界限判断，不再沿用 36 小时。同一台北整点或半点重复调用不会再取关一次。返回里的 `submitted` 是本批纳入人数，`unfollowed` 才是实际取关成功人数。`executed: false` 表示这一次没有执行。账号2的请求会被拒绝。这个接口不改变发帖队列。取关控制默认暂停，需要另调 `POST /api/unfollow/resume`，正文同样是 `{"accountId":1}`，它不会恢复发帖。

## English

There is no supported Grok Bot browser preview of a service on `127.0.0.1`. Cursor staff confirmed the loopback block on 2026-11-07. The [private-network docs](https://cursor.com/docs/grok-bot/private-networks) require an Enterprise networking setup or a desktop route that still blocks private addresses; this repo does not turn those on. Operators open the UI themselves. A bot may use the shell against loopback. Do not tunnel the port or publish it.

Defaults: anything other than `X_API_MODE=live` is mock; a new database starts paused with `pauseReason=safe_start`; an existing database keeps its pause flag; follow automation stays off unless `XUTIE_AUTOMATION_SUPERVISOR=on`; `npm start` binds `127.0.0.1:3847`. `deployment.sendsWhenDue` is true only when mode is live and the queue is not paused. Do not resume, and do not paste API secrets into chat.
