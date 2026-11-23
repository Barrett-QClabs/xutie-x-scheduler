# 账号1统一关注池：升级命令、控制项和回滚

只改账号1的关注和回关。发帖队列、取关窗口和白名单、账号2的调度都不要动。不要用落后于 `0fbb2db34ca3327b703df88c87d3e8929c953583` 的 `main` 覆盖生产。

已登记、可复制的源码包：

- `/opt/cursor/artifacts/xutie-account1-unified-0d8a.tar.gz`
- sha256 `11a232b2e260b9fdc0ab919c50f60966603fa48def7a92535567f8b9d54fbcbc`
- 对应提交 `ccd9bc26c12252b36ad35d825524911049cf1bfa`，CI 已通过

这个包不含本段补充说明的后续文档提交。运行行为与该提交相同。部署前先核对 sha256。

本说明不访问 X，不在用户机器上执行。`X_API_MODE` 维持现场原值，不要为了这次升级改它。

## 已完成槽不会被新网格重跑

旧回关键是当天 `taipei:YYYY-MM-DDT` 加上 00:00、00:33、01:06、01:39、02:12、02:45、03:18、03:51、04:24、04:57。旧新关注键用前缀 `taipei-new:`。新网格不生成这些键。00:00 现在属于前一天的 `taipei:前一天T23:51`，14:35 属于 `taipei:当天T14:30`。

因此 2026-11-23 已经写成 `completed` 的旧槽保持 `completed`，`followed` 不变。新槽是另一条主键，只会处理还没成功关注、也不在取关黑名单里的人。同一条新槽再次调用只回放，不第二次关注。

## 控制项：要改的和不要动的

程序本身不会在 05:00 把账号1关注写成暂停，也不会等到 18:00 才给槽。05:00–09:00 只是 `followSlot` 为空，原因 `rest`。09:00 只要 `follow_control` 仍是未暂停，就会自己进入 `taipei:当天T09:00`。

要改的只有账号1关注这一侧：

1. 停掉还会在 05:00 调用 `POST /api/follow/pause` 且 `accountId` 为 1、并要等到 00:00 才 `resume` 的外部例程。那个例程会把 09:00–24:00 整段关掉。05:00–09:00 的空窗由槽钟负责，不需要暂停开关。
2. 若升级时账号1关注已经是暂停，只对账号1调用一次下面的 resume。不要对账号2调用。
3. 每个台北日用现有的审批接口写一条覆盖当天 00:00 到次日 00:00 的 `kind=new` 授权。这不是绕过审批。18:00 才授权会让 09:00–18:00 的新人停着；回关不看这份授权，所以缺授权不会关掉回关。程序不会自动补授权，昨日授权也不能用到今天。

不要改这些：

- `POST /api/queue/resume` 或发帖暂停。那是发帖。
- `XUTIE_ACCOUNT2_FOLLOW`、`XUTIE_ACCOUNT2_UNFOLLOW`、账号2的 `follow_control`。
- `XUTIE_ACCOUNT1_UNFOLLOW` 和取关暂停。取关仍只在台北 05:00–09:00 的 :15 和 :45。
- `XUTIE_AUTOMATION_SUPERVISOR`，保持 `off`。不要启动 `automation/*.mjs`。
- 白名单、关键词是否降低资格、`CREDENTIALS_ENCRYPTION_KEY`。

## 顺序

下面的地址按现场反代替换。只在已确认身份的本机或现有管理入口上调用。

1. 复制数据库，例如 `data/xqueue.sqlite` 和它的 `-wal`、`-shm`。不要运行 `install.sh`。
2. 用本包构建并换上进程，挂载原数据卷和原加密密钥。进程打开数据库时自动做迁移，重复启动不会再插同一条黑名单，也不会改已完成关注。

```bash
docker build -t xutie-account1-unified:ccd9bc2 .
```

3. 核对迁移没有改写成功账。`follow_success` 和已完成 `follow_batches` 的行数应与升级前一致。`follow_blocklist` 里账号1、`source=unfollow_confirmed` 的人数应等于升级前 `unfollow_candidates` 中账号1且 `result=success` 的人数。

4. 只在账号1关注仍暂停时恢复它：

```bash
curl -sS -X POST http://127.0.0.1:3847/api/follow/resume \
  -H 'content-type: application/json' \
  -d '{"accountId":1}'
```

5. 写当天的新人授权。2026-11-23 的整段开放时间都在这一条里，不必再等 18:00。次日 00:00 之后要另写 2026-11-24 的授权，才能在 00:00–05:00 执行新人。

```bash
curl -sS -X POST http://127.0.0.1:3847/api/follow/new-approval \
  -H 'content-type: application/json' \
  -d '{"accountId":1,"approvedStart":"2026-11-22T16:00:00.000Z","approvedEnd":"2026-11-23T16:00:00.000Z"}'
```

`2026-11-22T16:00:00.000Z` 是台北 2026-11-23 00:00，结束是台北次日 00:00。接口拒绝跨出同一个台北日的授权。

6. 把用户给出的名单导入永久池。调度器不会自己搜索。两条接口可以都用，同一个人只执行一次。

回关或已经带 `kind` 的明确名单：

```bash
curl -sS -X POST http://127.0.0.1:3847/api/follow/reserve \
  -H 'content-type: application/json' \
  -d '{"accountId":1,"checkedAt":"2026-11-23T06:35:00.000Z","candidates":[{"targetUserId":"123","kind":"followback"},{"targetUserId":"456","kind":"new"}]}'
```

带快照的新人：

```bash
curl -sS -X POST http://127.0.0.1:3847/api/follow/new-admission \
  -H 'content-type: application/json' \
  -d '{"accountId":1,"candidates":[{"targetUserId":"456","username":"example","qualificationCheckedAt":"2026-11-23T06:35:00.000Z","snapshot":{"verified":true,"verifiedType":"blue","following":false,"lang":"zh","name":"示例","description":"人工智能"}}]}'
```

`checkedAt` 和 `qualificationCheckedAt` 必须是真实核实时间，不能晚于现在 5 分钟以上。已关注返回 `already_followed`，已确认取关返回 `unfollowed`，重复的在库 id 进入 `existing` 且不改原来的核实时间。

7. 读状态确认。09:00–09:14、14:30–14:44 应看到账号1 `schedule` 为 `work`；05:00–08:59 为 `rest`，且 `paused` 仍是升级后那一次 resume 的结果，而不是被 05:00 例程改回去。

```bash
curl -sS 'http://127.0.0.1:3847/api/follow?accountId=1'
```

## 回滚

1. 停掉新进程，换回 `0fbb2db34ca3327b703df88c87d3e8929c953583` 的镜像。
2. 继续用同一数据卷和同一加密密钥。
3. 不要删除 `follow_success`、`follow_batches` 或取关表。旧程序不读 `follow_blocklist` 和 `follow_inflight`。
4. 只有确定不再需要黑名单时才 `DROP TABLE follow_blocklist;` 和 `DROP TABLE follow_inflight;`。这不会重跑已完成关注。
5. 回滚后若外部 05:00 暂停例程还指着账号1，白天仍会被关掉；那是旧例程，不是这次槽钟。
