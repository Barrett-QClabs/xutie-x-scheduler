# 序帖

自托管的 X（Twitter）定时发帖工具。你使用自己的 X 开发者应用凭据发帖，序帖不会带任何共享密钥。

适合已经有 X 开发者账号、想把几十条帖子按固定间隔发出去的人。文本导入后进入本地队列，后台调度器到点调用 X API v2 的 `POST /2/tweets`。

## 功能

- 在设置页填入 OAuth 1.0a 用户上下文的四项凭据，并用 `GET /2/users/me` 测试，成功后显示已连接的 @handle。
- 凭据只存在服务器上，用环境变量里的密钥做 AES-256-GCM 加密。接口不会把密钥回传给浏览器。
- 批量导入：一行一条、空行分段，或用单独一行的 `---` 分隔；也可以上传 `.txt` / `.csv`。
- 按 X 的加权长度检查 280 上限：英文计 1，汉字计 2，每个 http(s) 链接计 23。超限的不会入队。
- 队列可设开始时间、间隔（默认 15 分钟）和可选抖动（例如 ±2 分钟）。每条都能改、删、上移下移；可以暂停或继续全部，也可以重试失败项。
- 调度状态写在 SQLite 里，重启后未发的帖子会继续。遇到 429 会按 `x-rate-limit-reset` 等待；重复内容记为失败并继续后面的帖子；鉴权失败会暂停队列并显示原因。发出去之后保存帖子 id，并链到 `https://x.com/{handle}/status/{id}`。

界面默认简体中文，侧栏可以切到英文。

## 创建自己的 X 开发者应用

序帖使用 **OAuth 1.0a 用户上下文**。发帖必须是「代表某个账号」的 Access Token，不能用应用级 Bearer Token。

1. 打开 [X 开发者控制台](https://console.x.com)（有的账号仍从 [developer.x.com 门户](https://developer.x.com/en/portal/dashboard) 进入），用要发帖的账号登录并开通开发者权限。
2. 创建一个 **Project**。v2 接口要求应用属于某个 Project，单独建在 Project 外面的旧应用经常会调用失败。
3. 在这个 Project 里创建一个 **App**。
4. 打开该 App 的 **User authentication settings**：
   - App permissions 选 **Read and Write**。不需要 Direct Messages。
   - 应用类型选带机密客户端的 Web App 或 Automated App / Bot。
   - 回调地址和网站地址是控制台的必填项。序帖用的是控制台里生成的 Access Token，不会走三方登录跳转，这两项可以先填 `http://127.0.0.1:3847`。
5. 保存权限后，打开 **Keys and tokens**，复制这四项：

   | 在序帖里的名称 | 在 X 控制台里的名称 |
   | --- | --- |
   | API Key | API Key / Consumer Key |
   | API Key Secret | API Key Secret / Consumer Secret |
   | Access Token | Access Token |
   | Access Token Secret | Access Token Secret |

6. **先把权限改成 Read and Write，再生成 Access Token 和 Access Token Secret。** 如果先生成了令牌再改权限，旧令牌往往仍是只读，发帖会 403。改完权限后点 Regenerate，用新的 Access Token 和 Secret。
7. 不要把 Bearer Token 填进序帖。Bearer Token 只能代表应用，不能代表你的账号发帖。
8. 回到序帖的「设置」页，填入四项，点「保存并测试」。成功时会显示你的 @handle。

密钥只在这一次输入时经过浏览器，随后加密写进服务器数据库。刷新页面不会再看到它们。

## 本地运行

需要 Node.js 22 或更新版本。

```bash
cp .env.example .env.local
```

编辑 `.env.local`，把 `CREDENTIALS_ENCRYPTION_KEY` 换成至少 16 位的随机字符串。例如：

```bash
openssl rand -base64 32
```

然后：

```bash
npm install
npm run dev
```

浏览器打开 [http://127.0.0.1:3847](http://127.0.0.1:3847)。

生产模式：

```bash
npm run build
npm start
```

同样监听 `3847`。数据库默认在 `./data/xqueue.sqlite`，第一次启动会自己创建。

### 模拟模式

还没有可用的 X 额度、只想先看队列时，在 `.env.local` 里写：

```bash
X_API_MODE=mock
```

测试连接和发帖都在本地完成，不会请求 X。帖子正文里如果包含 `[[duplicate]]`、`[[rate-limit]]`、`[[auth]]` 或 `[[fail]]`，模拟客户端会分别返回重复内容、429、鉴权失败和临时错误，方便看队列怎么处理。正式发帖前改回 `X_API_MODE=live`。

## 怎么用

1. 设置页保存并测试凭据，确认 @handle。
2. 导入页贴上文本或上传文件。预览里会标出超限的条目。
3. 设定开始时间、间隔和抖动，把通过检查的帖子加入队列。抖动在入队时就算好，队列里看到的是最终时间。
4. 队列页可以改字、删除、上移下移未发送的帖子，也可以暂停全部、继续，或重试失败项。
5. 调度器大约每 5 秒看一次。只有到点的下一条会发出。如果服务停过，积压的多条不会瞬间打出去，而是按当前间隔重新排开。

间隔和抖动也可以在队列页修改。勾选「按这个节奏重排」会从现在起重算还没发的时间。

## 字符计数

计数接近 twitter-text 配置 v3：

- 英文字母、数字和常见符号计 1。
- 汉字和其他默认权重的字符计 2。140 个汉字就是 280，第 141 个会被拒绝。
- 每个 `http://` 或 `https://` 链接计 23，不管原来多长。链接末尾的句号、逗号不算进链接。
- 不带协议的 `www.example.com` 按普通字符计。
- 单个 emoji 大多计 2。带肤色、连字或国旗的组合有时会差 1 到 2，预览里的数字以序帖的计数为准。

## 测试

测试使用模拟的 X 客户端，不会访问 X。

```bash
npm test
```

覆盖字数、导入拆分、OAuth 1.0a 签名、加密、以及「导入 → 入队 → 到点发送」整条路径，包括 429、重复内容和鉴权失败。

## 部署

只运行 **一个** 进程。两个进程共用一个 SQLite 文件时，调度锁能降低重复发送的概率，但这个工具按单实例设计。

序帖没有登录。不要把端口直接暴露到公网。放在本机，或放在已经有认证的反向代理后面。

### Docker

```bash
cp .env.example .env
# 编辑 .env，填入 CREDENTIALS_ENCRYPTION_KEY，并确认 X_API_MODE=live
docker compose up -d --build
```

数据在名为 `xuti-data` 的卷里，容器内路径是 `/data/xqueue.sqlite`。

不用 Compose 时：

```bash
docker build -t xuti .
docker run -d --name xuti \
  -p 3847:3847 \
  -e CREDENTIALS_ENCRYPTION_KEY='你的长随机字符串' \
  -e X_API_MODE=live \
  -e DATABASE_PATH=/data/xqueue.sqlite \
  -v xuti-data:/data \
  xuti
```

### 直接用 Node

在服务器上安装 Node.js 22，配置 `.env.local` 或导出同样的环境变量，然后 `npm ci`、`npm run build`、`npm start`。用 systemd 或进程管理器保住这一个进程即可。把 `./data` 放进备份。

更换 `CREDENTIALS_ENCRYPTION_KEY` 之后，旧凭据无法解密，队列会暂停。到设置页重新填写四项并测试，再点继续发送。

## 费用和频率

X 的价格经常变，以下是 2026 年公开资料里的情况，**以你自己的开发者控制台为准**。

- 新开发者已经没有原来的免费额度。默认是按量计费：购买 credits 之后，创建一条不含链接的帖子大约 0.015 美元，正文里带链接的帖子大约 0.20 美元。`GET /2/users/me` 这类读取也会扣少量额度。
- 旧的 Basic（大约每月 200 美元）和 Pro 只对已经订阅的账号继续有效，新账号一般不能再开通。
- 发得太快会收到 HTTP 429。序帖会读取 `x-rate-limit-reset`（没有这个头则等待 15 分钟），到点再发，这条帖子仍保持待发送。
- 公开资料里，`POST /2/tweets` 常见上限大约是每用户每 15 分钟 100 条、每应用每 24 小时 10000 条。不同套餐不一样。默认 15 分钟一条，是为了看起来不那么像机器连发，也远低于这个量级。
- 重复内容会被 X 拒绝。序帖把这一条标为失败，队列继续。改掉文字后可以重试。
- 401，或 403 且属于令牌、权限问题，会暂停整个队列。常见原因是 Access Token 仍是只读，或四项抄错。改完凭据、测试通过后，再点继续发送。

## 数据

| 位置 | 内容 |
| --- | --- |
| `queue_settings` | 间隔、抖动、是否暂停、限流等到什么时候 |
| `tweets` | 正文、计划时间、状态、帖子 id、错误信息 |
| `credentials` | 加密后的四项凭据，以及测试成功后的 @handle |

加密方式是 scrypt 派生密钥加 AES-256-GCM，盐和随机量跟密文存在一起。没有加密密钥就无法从数据库里读出凭据。

## 限制

- 只发纯文本，不上传图片、视频或投票。
- 只保存一套凭据，也就是一个 X 账号。
- 按单实例设计。
- 没有内置登录，请不要裸露在公网上。
- 使用 OAuth 1.0a 用户上下文，不支持 OAuth 2.0 PKCE。
- 字数是 twitter-text v3 的近似，复杂 emoji 可能差一两个字。
