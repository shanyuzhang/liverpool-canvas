# 隐私与数据流 / Privacy

## 留在你电脑上的

| 内容 | 位置 | 说明 |
|---|---|---|
| 设置（下载文件夹、记住的课程） | `~/.liverpool-canvas/config.json` | 仅当前系统用户可读（POSIX 权限 600/700；Windows 使用用户目录的默认权限） |
| 登录会话 cookie | `~/.liverpool-canvas/session.json` | 等同于登录状态，请像密码一样对待 |
| 登录用的独立浏览器资料 | `~/.liverpool-canvas/browser-profile/` | 与你日常的 Chrome/Edge 完全分开 |
| 下载索引与下载记录 | `~/.liverpool-canvas/accounts/<账号>/` | 按“Canvas 地址 + 账号 + 下载文件夹”分开，不同同学互不共享 |
| 课件 | 你选择的下载文件夹 | 不会被本工具删除、覆盖或移动 |

清除登录状态：运行 `logout`，或在本地网页点“退出登录”。它删除 `session.json` 和浏览器资料，不删除课件。删除整个 `~/.liverpool-canvas` 会同时清除设置和下载索引。

## 网络请求

- 只访问 `https://canvas.liverpool.ac.uk`（以及登录时学校的单点登录页面，由浏览器按学校流程访问）。
- Canvas 下载文件时会把请求转到它的文件存储服务器；这些请求**不带** Canvas cookie，只用 Canvas 给出的一次性签名链接。
- 对 Canvas 只发送 GET 请求：不提交作业、不发帖、不修改任何内容。
- 没有统计、遥测、广告或其他第三方请求。公开介绍网页是纯静态页面，无法读取你电脑上的文件或登录状态。
- 日志中不打印 cookie、密码、令牌、登录跳转地址或下载签名链接。

## AI 应用会收到什么

当你把本工具接入 Claude、Codex 等 AI 应用后，AI 通过工具读到的 Canvas 内容（课程列表、公告、作业说明、文件文字、成绩等）会作为对话内容发送给该 AI 应用及其服务商，处理方式取决于你使用的 AI 服务。登录 cookie、密码和浏览器资料不会发给 AI。

请遵守学校的 IT 使用规定和各课程关于 AI 使用的要求，不要外传课程资料。

## 本地网页

`web` 命令启动的网页只监听 `127.0.0.1`，需要终端打印的一次性链接才能进入；登录、下载、修改设置、打开文件夹等操作都校验来源（Host、Origin）、会话和 CSRF 令牌，其他网站无法触发。能打开的文件夹仅限你确认过的下载文件夹及其课程子文件夹。

---

**English.** Settings, the session cookies, the separate sign-in browser profile and the download index live in `~/.liverpool-canvas`, readable only by your user. Course files go to the folder you choose and are never deleted, replaced or moved by this tool. Network traffic goes only to canvas.liverpool.ac.uk (plus your university sign-in pages inside the browser window); file downloads that Canvas redirects to its storage servers are fetched without Canvas cookies. Only GET requests are sent to Canvas. There is no analytics or telemetry. Content your AI app reads through this tool is sent to that AI app and its provider like any chat content; cookies and passwords are not. Run `logout` to remove the saved sign-in.
