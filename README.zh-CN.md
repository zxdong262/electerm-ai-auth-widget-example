# electerm AI 订阅代理 —— 自定义 widget 示例

这是一个 [electerm](https://github.com/electerm/electerm) 自定义 widget：登录 **ChatGPT** 或
**SuperGrok** 订阅，把订阅包装成本地的 OpenAI **Responses** 接口，让 electerm 的 AI 面板
——对话、带工具的 agent 模式、AI 书签、主题生成、快捷命令、命令联想——直接使用订阅，而不是 API key。

它在 `127.0.0.1` 上跑一个小代理，令牌只留在 electerm 的主进程里。**不需要改动 electerm 本身。**

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

所以 widget 只需要是一个 HTTP 端点，做三件事：

1. 把 `Authorization` 换成订阅的 access token；
2. 补上 `store: false`（订阅请求要求，electerm 的请求构造器不会设置）；
3. 把 SSE 原样转发回去。

请求体和数据流完全不需要翻译。

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

这个页面同时列出了要填进 electerm 的几项配置，每项都能一键复制。

## 让 electerm 用上它

**设置 → AI**：

| 字段 | 值 |
| --- | --- |
| API URL | `http://localhost:8788/v1` |
| API PATH | `/responses` |
| API key | `local`（随便填，代理会忽略） |
| Auth Header | 保持默认（`Authorization: Bearer`） |
| 代理 | 留空 |
| 模型 | 在代理页面上点 **Load models**，选一个套餐里有的 |

用 `localhost` 而不是 `127.0.0.1`：面板标题是根据 URL 猜品牌名的，`localhost` 会落到中性的
"Custom AI Model"，而 `127.0.0.1` 会显示成 `0`。

配置就这些。agent 面板、AI 书签、主题生成、快捷命令都读同一份配置，所以会一起切过去。

## 它做不到的事

- **provider 名字显示不出来。** 面板标题是 "Custom AI Model"。要按 provider 命名，得改 electerm 本体。
- **一个实例只服务一个 provider。** ChatGPT 和 SuperGrok 想同时用，需要两个实例、两个端口。
- **不支持上游 HTTP 代理。** widget 直连 provider，会忽略 electerm 里的代理设置。
- **只有 `/v1/responses`。** 别的路径会返回一条提示，让你改 API PATH。

## 安全

- 令牌只存在于 electerm **主进程**，用 Electron `safeStorage`（钥匙串 / DPAPI / libsecret）加密。
  系统无法加密时直接拒绝保存，**不会**退回明文。
- 明文令牌不会进入渲染进程、`userConfig`、AI 历史或同步数据。electerm 里存的只有你手填的那几项配置。
- 令牌文件放在 `<数据目录>/widgets/.ai-auth-proxy/`，故意放在 widget 目录**之外**：widget 目录里的每个文件
  都会被 `electerm-widget://` 协议投递给 widget 自己的页面。
- 代理和登录页面只监听 `127.0.0.1`（同端口的 `::1` 也一起监听）。
- 装 widget 等于信任一段跑在 electerm 主进程里的代码。这个 widget 持有 refresh token，导入前请自己读一遍——
  它只有几百行，且没有任何依赖。

## 开发

```bash
npm test
```

覆盖：令牌存储（加密、拒绝保存、损坏记录）、代理（换头、`store: false`、SSE 原样透传、provider 错误原样
转出、无令牌返回 401、`/v1/models` 归一化、错误路径提示）、登录页面，以及 OAuth 基础件（PKCE、回环地址精确
匹配、ID token 的签名 / nonce / audience / 过期 / 篡改校验）。

已做过的端到端验证（都不需要账号）：

- 用 electerm 自己的 `buildRequest('openai-responses', …)` 构造请求，经过本代理后，再用 electerm 自己的
  `createStreamParser` 解析，能拿到文本和工具调用；
- 非流式路径能被 `parseResponse` / `parseUsage` 解析（也就是 agent 循环走的路）；
- widget 在真实的 Electron 主进程里能启动，`safeStorage` 可用，页面正常返回，无令牌请求得到可读的 `401`；
- manifest 能通过 electerm 的 widget 注册表（`importWidget`）导入为 `ai-auth-proxy`。

OAuth 登录本身需要真实账号，是这里唯一只有推演、没有实跑的部分。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | widget 入口：`widgetInfo`、`widgetRun`（一个实例 = 一个代理） |
| `lib/proxy.js` | HTTP 服务：`/v1/responses`、`/v1/models`、`/admin/*` |
| `lib/page.js` | `/` 上的登录页面 |
| `lib/chatgpt.js` | ChatGPT OAuth（PKCE、回环回调、刷新、吊销） |
| `lib/grok.js` | SuperGrok 设备码流程 |
| `lib/oauth.js` | PKCE、OIDC 发现、表单请求、ID token 校验 |
| `lib/store.js` | `safeStorage` 加密的令牌存储 |

## 致谢

协议细节来自 electerm PR [#4589](https://github.com/electerm/electerm/pull/4589)（
[@thejohnd0e](https://github.com/thejohnd0e)），以及 issue
[#4591](https://github.com/electerm/electerm/issues/4591) 的讨论。

MIT。
