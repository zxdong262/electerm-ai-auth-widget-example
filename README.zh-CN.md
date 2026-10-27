# electerm AI 订阅代理 —— 自定义 widget 示例

这是一个 [electerm](https://github.com/electerm/electerm) 自定义 widget：登录 **ChatGPT** 或
**SuperGrok** 订阅，把订阅包装成本地的 OpenAI **Responses** 接口，让 electerm 的 AI 面板
——对话、带工具的 agent 模式、AI 书签、主题生成、快捷命令、命令联想——直接使用订阅，而不是 API key。

它在 `127.0.0.1` 上跑一个小代理，令牌只留在 electerm 的主进程里。**使用它不需要改动 electerm 本体**：
代理是通过 AI 配置访问的，而 widget 也会把这份配置一并递出去，让用户一键应用（这需要 electerm 认识
widget 的 `aiConfig` 提议，见[让 electerm 用上它](#让-electerm-用上它)）。

> **说明。** 这是一个示例，不是 electerm 的一部分。OAuth 协议细节来自
> [PR #4589](https://github.com/electerm/electerm/pull/4589)（作者
> [@thejohnd0e](https://github.com/thejohnd0e)，他已在 Windows 上跑通该流程）；本仓库作者没有用真实账号
> 登录验证过。凡是无需账号就能验证的部分——代理、令牌存储、请求与流的格式（用 electerm 自己的解析器验证）——
> 都在 `npm test` 里。

## 为什么代理可行

electerm 本来就原生支持 Responses 协议（`src/app/lib/ai-format.js`：`detectFormat` 把任何含
`/responses` 的路径识别为该协议，`buildRequest` 会生成 `input` + `instructions` + 摊平后的 tools，
流式解析器认得 `response.output_text.delta` / `function_call_arguments.delta` / `response.completed`）。
而且每个 AI 功能都是在调用时读取 `baseURLAI` / `apiPathAI` / `apiKeyAI`。

所以 widget 只需要是一个 HTTP 端点，做四件事：

1. 把 `Authorization` 换成订阅的 access token；
2. 补上 `store: false`（订阅请求要求，electerm 的请求构造器不会设置）；
3. 向上游一律请求 `stream: true`——订阅后端对 `stream: false` 直接回
   `{"detail":"Stream must be set to true"}`——再把事件流折回成一个 JSON 对象，给那些只要一个答案的调用方；
4. 对于要流的调用方，把 SSE 原样转发回去。

第 3 条是 agent 模式能用的关键。`AIchatWithTools`（agent 面板调用工具走的就是它）永远是
`stream: false`；AI 书签、主题生成、快捷命令、命令联想也一样。这些请求会被读到结尾，重新拼成非流式接口
本来会返回的那个 Response 对象，连 `usage` 和 `function_call` 条目都不缺（见 `lib/sse.js`）。

## 环境要求

- 支持自定义 widget 的 electerm 版本（`设置 → Widgets` 里有 **导入** 按钮）。
- 想跑测试的话需要 Node 20+。widget 本身用的是 electerm 内置的 Node 运行时。
- 一个 provider 允许这种访问方式的 ChatGPT 或 SuperGrok 订阅。如果套餐没有权限，provider 的报错会原样显示，
  **不会**悄悄退回 API 计费。

## 安装

```bash
git clone https://github.com/zxdong262/electerm-ai-auth-widget-example.git
```

1. electerm 里打开 **设置 → Widgets**。
2. 点 **导入**，选中刚克隆的目录。（目录名不影响安装，widget 会按 `package.json` 里的 `electerm.id`
   安装为 `ai-auth-proxy`。）
3. 在列表里选中 **AI subscription proxy**，provider 保持 `ChatGPT` 或 `SuperGrok`，端口保持 `8788`，
   勾上 **Start with electerm**。
4. 点 **运行**。会弹出一个提示，显示代理地址，此时它已经在监听了。

日常使用中关键是那个 **Start with electerm**：它让 electerm 每次启动时自动把代理拉起来，AI 面板就不用每次
先去开一遍 widget。之后也可以在实例列表里（运行中实例上的闪电图标）随时开关。

## 登录

打开提示里的地址 —— <http://localhost:8788> —— 点 **Sign in**。

- **ChatGPT**：会打开浏览器走 OAuth 登录，回调由应用在一个临时 `127.0.0.1` 端口上接住（只存在于登录期间），
  成功后页面显示 "Connected as …"。
- **SuperGrok**：页面给出一个短码，在 x.ai 上确认，页面会自己变成已连接。

这个页面同时也是配置清单：要填进 electerm 的三项值都列在上面，各自可一键复制，并且带着代理密钥（见下）。
**Send a test request** 会走一遍和 agent 面板完全相同的非流式请求，所以"已连接"和"AI 面板真的能用"不是同一个说法。

## 让 electerm 用上它

**一键**：在 electerm 里打开 **设置 → Widgets → 运行中实例**，选中这个实例，点 **Use these
settings**。widget 的启动结果里带了一份现成的 AI 配置（URL、路径、密钥、认证头、以及 AI 面板显示的
名字），electerm 会把它列出来并配上这个按钮——你不点，什么都不会被写入。

**或者手动填**，在 **设置 → AI**：

| 字段 | 值 |
| --- | --- |
| API URL | `http://localhost:8788/v1` |
| API PATH | `/responses` |
| API key | 页面上的代理密钥（`sk-local-…`），不是 provider 的 key |
| Auth Header | 保持默认（`Authorization: Bearer`） |
| 代理 | 留空 |
| 模型 | 在 electerm 里点 **Load models**，或者在代理页面上点一下再复制一个 |

走一键路径时面板标题来自配置本身，所以会显示 "ChatGPT subscription"，而不是从 URL 猜出来的名字。
这对本地端点有影响：electerm 猜标题时取的是域名倒数第二段，`localhost` 没有可取的段，`127.0.0.1`
则会显示成 `0`。设了名字之后两个地址都可以——不管是点按钮设的，还是在 **Settings → AI** 里手填
**Name**（`0` 那种情况需要支持 `aiConfig` 的同一个新版本）。

模型是这份配置唯一没有带上的东西：这个 widget 在用户主动去问之前，并不知道套餐里有哪些模型，所以在
electerm 的 AI 设置里点一次 **Load models** 填上即可。

配置就这些。agent 面板、AI 书签、主题生成、快捷命令都读同一份配置，所以会一起切过去。如果密钥填错了，
electerm 会显示代理返回的 `401` 信息，代理页面的 **Recent requests** 里也会把这条请求标出来。

> 一键路径需要 electerm 支持读取 widget 结果里的 `aiConfig`（见 electerm 的
> `app/widgets/ai-config.js`）。旧版本只会显示实例日志，上面的几项值仍然可以在代理页面上复制。

## 它做不到的事

- **面板标题来自配置，不是 widget 自己说了算。** AI 面板标题是从 URL 推出来的，本地地址会落到
  "Custom AI Model"；这个 widget 在配置里带了 `nameAI`，应用之后面板会显示 "ChatGPT subscription"。
- **一个实例只服务一个 provider。** ChatGPT 和 SuperGrok 想同时用，需要两个实例、两个端口。
- **不支持上游 HTTP 代理。** widget 直连 provider，会忽略 electerm 里的代理设置。
- **只有 `/v1/responses`。** 别的路径会返回一条提示，让你改 API PATH。

## 安全

一个能花订阅额度的本地端口，哪怕在 `127.0.0.1` 上，也值得上锁：

- **代理密钥。** 每个 `/v1` 请求都必须带上页面显示的那个密钥（`Authorization: Bearer` 或 `x-api-key`）。
  密钥只生成一次，和令牌一样用 `safeStorage` 加密保存，重启后不变，所以只需要粘贴一次。没有它，浏览器里
  任何一个页面猜到这个端口就能花掉套餐额度。
- **Host 校验。** 请求必须发给 `localhost:<端口>`、`127.0.0.1:<端口>` 或 `[::1]:<端口>`。互联网上的页面
  通过 DNS rebinding 指到 `127.0.0.1` 时，`Host` 里仍然是它自己的域名，会被拒——这是阻止它和代理变成
  同源的关键。
- **Origin 校验。** 跨站 POST 带着页面的 origin，会被拒；代理自己的页面放行。管理接口同样适用。
- **页面令牌。** 会改状态的 `signin` / `signout` / `cancel` 还需要页面 HTML 里那次渲染才有的令牌，
  本地进程不先读页面就驱动不了登录。
- **只收 `application/json`**（`/v1/responses`），浏览器的表单 POST 设不了这个头。
- **令牌**只存在于 electerm **主进程**，用 Electron `safeStorage`（钥匙串 / DPAPI / libsecret）加密。
  系统无法加密时直接拒绝保存，**不会**退回明文。
- 明文令牌不会进入渲染进程、`userConfig`、AI 历史或同步数据。electerm 里存的只有你手填的那几项配置。
- 令牌文件放在 `<数据目录>/widgets/.ai-auth-proxy/`，故意放在 widget 目录**之外**：widget 目录里的每个文件
  都会被 `electerm-widget://` 协议投递给 widget 自己的页面。
- 页面上的 **Recent requests** 只记时间、路径、模型和状态码，**不记** prompt。
- **AI 配置是"提议"，不是"写入"。** widget 把配置放在启动结果里递出去，electerm 列出来，只有用户按下
  按钮时才会写。widget 也没法通过这条路设置系统提示词（`roleAI`）——那个字段不在白名单里。
- 装 widget 等于信任一段跑在 electerm 主进程里的代码。这个 widget 持有 refresh token，导入前请自己读一遍——
  它只有几百行，且没有任何依赖。

防不住的情况：已经以同一个系统用户身份运行的代码，它能读到页面和密钥。对本地代理来说这不在防护范围里——
那种进程本来也可以直接挂在 electerm 上。

## 开发

```bash
npm test
```

覆盖：令牌存储（加密、拒绝保存、损坏记录、代理密钥）、代理（必须带密钥、Host 与 Origin 拒绝、
`store: false`、`stream: true`、SSE 原样透传、非流式调用方的折叠、provider 错误连状态码一起转出、
无令牌返回 401、`/v1/models` 归一化、错误路径提示、请求日志）、SSE 折叠本身、登录页面、widget 入口
本身（`aiConfig` 提议、它的密钥就是页面显示且代理接受的那个、重启后不变），以及 OAuth 基础件
（PKCE、回环地址精确匹配、ID token 的签名 / nonce / audience / 过期 / 篡改校验）。

已做过的端到端验证（都不需要账号）：

- 用 electerm 自己的 `buildRequest('openai-responses', …)` 构造请求，经过本代理后，再用 electerm 自己的
  `createStreamParser` 解析，能拿到文本和工具调用；
- 非流式路径（agent 循环走的路）由代理折叠后，能被 electerm 自己的 `parseResponse` / `parseUsage` 解析出
  同样的消息和 token 数；
- widget 在真实的 Electron 主进程里能启动，`safeStorage` 可用，页面正常返回，无令牌请求得到可读的 `401`；
- manifest 能通过 electerm 的 widget 注册表（`importWidget`）导入为 `ai-auth-proxy`。

OAuth 登录本身需要真实账号，是这里唯一只有推演、没有实跑的部分。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | widget 入口：`widgetInfo`、`widgetRun`（一个实例 = 一个代理） |
| `lib/proxy.js` | HTTP 服务：`/v1/responses`、`/v1/models`、`/admin/*`，以及访问校验 |
| `lib/sse.js` | 把 Responses 事件流折成一个响应对象 |
| `lib/page.js` | `/` 上的登录与配置页面 |
| `lib/chatgpt.js` | ChatGPT OAuth（PKCE、回环回调、刷新、吊销） |
| `lib/grok.js` | SuperGrok 设备码流程 |
| `lib/oauth.js` | PKCE、OIDC 发现、表单请求、ID token 校验 |
| `lib/store.js` | `safeStorage` 加密的令牌与代理密钥存储 |

## 致谢

协议细节来自 electerm PR [#4589](https://github.com/electerm/electerm/pull/4589)（
[@thejohnd0e](https://github.com/thejohnd0e)），以及 issue
[#4591](https://github.com/electerm/electerm/issues/4591) 的讨论。

MIT。
