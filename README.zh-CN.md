# electerm AI 订阅代理 —— 自定义 widget 示例

这是一个 [electerm](https://github.com/electerm/electerm) 自定义 widget：登录 **ChatGPT** 或
**SuperGrok** 订阅，把订阅包装成本地的 OpenAI **Responses** 接口，让 electerm 的 AI 面板
——对话、带工具的 agent 模式、AI 书签、主题生成、快捷命令、命令联想——直接使用订阅，而不是 API key。

**登录和配置都在 widget 自己的面板里完成**：导入一次，点 **Sign in**，再点面板上方的
**Use these settings** 就结束。代理随 electerm 启动，令牌只留在主进程；唯一可选的配置是网络需要代理时
填写的上游代理。面板标题栏的 **Run/Stop** 按钮显示并控制代理的运行状态。

> **说明。** 这是一个示例，不是 electerm 的一部分。OAuth 协议细节来自
> [PR #4589](https://github.com/electerm/electerm/pull/4589)（作者
> [@thejohnd0e](https://github.com/thejohnd0e)，他已在 Windows 上跑通该流程）；本仓库作者没有用真实账号
> 登录验证过。凡是无需账号就能验证的部分——代理、令牌存储、上游代理层、面板接口，以及用 electerm 自己的
> 解析器验证请求与流的格式——都在 `npm test` 里。

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

- 支持自定义 widget 的 electerm，并且带上 [issue #4591](https://github.com/electerm/electerm/issues/4591)
  讨论里的几处小改动：带 `electerm.ui` 的 widget 可以自动启动、面板带 Run/Stop 按钮、widget 的
  `aiConfig` 提议可以清空某个设置（面板里显示为 `none`）、面板调用绑定到正在运行的模块实例，
  以及主进程把 agent 工厂交给 widget，让它使用用户自己设置的代理。
- 想跑测试的话需要 Node 20+。widget 本身用的是 electerm 内置的 Node 运行时。
- 一个 provider 允许这种访问方式的 ChatGPT 或 SuperGrok 订阅。如果套餐没有权限，provider 的报错会原样显示，
  **不会**悄悄退回 API 计费。

旧版本 electerm 上这个 widget 仍然可用：在浏览器里打开代理地址登录，再把页面上列出的值抄进
**设置 → AI**。

## 安装与使用

```bash
git clone https://github.com/zxdong262/electerm-ai-auth-widget-example.git
```

1. electerm 里打开 **设置 → Widgets → 导入**，选中刚克隆的目录。它会按 `package.json` 安装为
   `ai-auth-proxy`。
2. 在列表里选中 **AI subscription proxy**。面板会自己把代理拉起来并登记为随 electerm 启动，然后点面板里的
   **Sign in**。如果没起来（比如端口被占用），面板会直接显示错误，并用标题栏的 **Run** 按钮重试；
   **Stop** 用来停掉代理。代理没运行时面板里的按钮都是禁用的。
   - **ChatGPT**：会打开浏览器走 OAuth 登录，回调由应用在一个临时 `127.0.0.1` 端口上接住（只存在于登录期间）；
     浏览器页提示"Sign-in finished"后会自行关闭，面板变成 "Connected as …"。
   - **SuperGrok**：面板直接显示设备码，在 x.ai 上确认后面板自己更新。
   - 用下拉框切换 provider，端口和已应用的 AI 配置都不变。
3. 点面板上方那块 **Use these settings**。它会写入 URL、路径、密钥、认证头、面板名称，**以及模型**
   （登录成功后 widget 会向 provider 取一次模型列表），并清空 **代理** —— 提议里显示为 `none`，因为
   端点是本地回环地址。你不点，什么都不会被写入。

配置就这些。agent 面板、AI 书签、主题生成、快捷命令读的是同一份配置。面板里的 **Send a test request**
会走一遍和 agent 循环完全相同的非流式请求，所以"已连接"和"AI 面板真的能用"不是同一个说法。

浏览器页面 <http://localhost:8788> 仍然保留作兜底：同样的状态、可复制的值、代理密钥、模型列表和
**Recent requests**。手动填的话是 `http://localhost:8788/v1`、`/responses`，以及代理密钥
（`sk-local-…`，不是 provider 的 key）。密钥重启后不变，所以配置只需要应用一次。

## 需要代理的网络

之前的死锁是：**设置 → AI → 代理** 填了地址，electerm 会把 `localhost` 请求也送进远程代理
（`ECONNREFUSED`）；把代理清空，widget 又连不上 OpenAI（OIDC 发现请求被 Cloudflare 挡成 `403`）。
现在两个方向是两个独立设置，都由你自己决定，core 不再对 `localhost` 做特殊处理：

- **Use these settings** 在写入 URL、路径、密钥的同时写入 `proxyAI: ''`，让 electerm 的 AI 客户端
  直连本地端点。提议里明确列出 `代理: none`，清空是看得见的，不是副作用。
- widget 自己的登录和 API 调用用面板里的 **Upstream**（`http://…` 或 `socks5://…`；OIDC 发现、
  令牌交换、刷新、模型列表、Responses 流全部经 `lib/upstream.js` 走它）。留空时按顺序取：标准
  `HTTPS_PROXY` 环境变量 → **系统代理**（VPN 设的那个，Chromium 会跟随而 Node 不会，这正是"VPN 明明能用
  却仍然 403"的原因）→ 直连。保存这个字段会重启监听，好让新的 agent 生效。electerm 只提供 agent 工厂，
  这个值不来自 **设置 → AI**，所以重启或应用提议后都不会丢。面板会显示实际走的路线，例如
  `upstream: http://127.0.0.1:10808 (system)`。

一个要知道的后果：`proxyAI` 是全局设置，应用提议会把它对所有 AI provider 清空，不只是这个 widget；
要切回需要代理的远程 provider，重新填 **代理** 即可，切回来时再应用一次本 widget 的提议。

## 它做不到的事

- **一次只用一个订阅。** 下拉框可以原地切换，但一个端口同一时间只服务一个 provider。
- **只有 `/v1/responses`。** 别的路径会返回一条提示，让你改 API PATH。
- **不做 `chat/completions`，也不做协议翻译。** 请求体和流保持 Responses 格式，只改 `store`、
  `stream` 和认证头。
- **内嵌面板需要较新的 electerm。** 旧版本走浏览器页面 + 手动配置。

## 安全

一个能花订阅额度的本地端口，哪怕在 `127.0.0.1` 上，也值得上锁：

- **代理密钥。** 每个 `/v1` 请求都必须带上页面显示的那个密钥（`Authorization: Bearer` 或 `x-api-key`）。
  密钥只生成一次，和令牌一样用 `safeStorage` 加密保存，重启后不变。没有它，浏览器里任何一个页面
  猜到这个端口就能花掉套餐额度。
- **Host 校验。** 请求必须发给 `localhost:<端口>`、`127.0.0.1:<端口>` 或 `[::1]:<端口>`。互联网上的页面
  通过 DNS rebinding 指到 `127.0.0.1` 时，`Host` 里仍然是它自己的域名，会被拒。
- **Origin 校验。** 跨站 POST 带着页面的 origin，会被拒；代理自己的页面放行。管理接口同样适用。
- **页面令牌。** 会改状态的 `signin` / `signout` / `cancel` 还需要页面 HTML 里那次渲染才有的令牌。
- **只收 `application/json`**（`/v1/responses`），浏览器的表单 POST 设不了这个头。
- **令牌**只存在于 electerm **主进程**，用 Electron `safeStorage`（钥匙串 / DPAPI / libsecret）加密。
  系统无法加密时直接拒绝保存，**不会**退回明文。内嵌面板是独立 origin 的 iframe，通过
  `window.electerm.call` 调主进程函数，只拿得到状态，拿不到令牌。
- 令牌文件放在 `<数据目录>/widgets/.ai-auth-proxy/`，故意放在 widget 目录**之外**：widget 目录里的每个文件
  都会被 `electerm-widget://` 协议投递给 widget 自己的页面。
- 页面上的 **Recent requests** 只记时间、路径、模型和状态码，**不记** prompt。
- **AI 配置是"提议"，不是"写入"。** widget 把配置放在启动结果或面板调用的返回值里递出去，
  host 列出来，只有用户按下按钮时才会写。widget 也没法通过这条路设置系统提示词（`roleAI`）——
  那个字段不在白名单里。
- 装 widget 等于信任一段跑在 electerm 主进程里的代码。这个 widget 持有 refresh token，
  导入前请自己读一遍——它没有任何依赖。

防不住的情况：已经以同一个系统用户身份运行的代码，它能读到页面和密钥。对本地代理来说这不在防护范围里——
那种进程本来也可以直接挂在 electerm 上。

## 开发

```bash
npm test
```

55 个测试覆盖：令牌存储、代理（密钥、Host/Origin、`store: false`、`stream: true`、SSE 透传与折叠、
provider 错误、401、`/v1/models`、请求日志）、SSE 折叠本身、登录页、上游 HTTP 层（重定向、abort、
agent 注入、代理规则解析、config → env → 系统代理的取值顺序）、widget 入口与面板接口（`aiConfig` 提议、
切换 provider 不改端口、上游 agent 上报与在面板里改代理、漏启动时的自愈、显式停止后不自动重启），
以及 OAuth 基础件（PKCE、回环地址精确匹配、ID token 的签名 / nonce / audience / 过期 / 篡改校验）。

已做过的端到端验证（都不需要账号）：

- 用 electerm 自己的 `buildRequest('openai-responses', …)` 构造请求，经过本代理后，再用 electerm 自己的
  `createStreamParser` 解析，能拿到文本和工具调用；
- 非流式路径（agent 循环走的路）由代理折叠后，能被 electerm 自己的 `parseResponse` / `parseUsage` 解析出
  同样的消息和 token 数；
- widget 在真实的 Electron 主进程里能启动，`safeStorage` 可用，页面正常返回，无令牌请求得到可读的 `401`；
- manifest 能通过 electerm 的 widget 注册表（`importWidget`）导入为 `ai-auth-proxy`。

OAuth 登录本身需要真实账号，是这里唯一只有推演、没有实跑的部分。

## 文件

- `index.js` — widget 入口与面板接口（`getStatus`、`signIn`、`getAIConfig`、`setProvider` 等）
- `ui/index.html` — 内嵌的登录面板（`electerm.ui`）
- `lib/proxy.js` — HTTP 服务：`/v1/responses`、`/v1/models`、`/admin/*`，以及访问校验
- `lib/upstream.js` — 带 electerm 代理 agent 的 fetch 风格上游传输层
- `lib/sse.js` — 把 Responses 事件流折成一个响应对象
- `lib/page.js` — `/` 上的浏览器兜底页面
- `lib/chatgpt.js` / `lib/grok.js` / `lib/oauth.js` — 两套登录流程及其基础件
- `lib/store.js` — `safeStorage` 加密的令牌与代理密钥存储

## 致谢

协议细节来自 electerm PR [#4589](https://github.com/electerm/electerm/pull/4589)（
[@thejohnd0e](https://github.com/thejohnd0e)），以及 issue
[#4591](https://github.com/electerm/electerm/issues/4591) 的讨论。

MIT.
