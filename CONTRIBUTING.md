# 本地开发与验证

```bash
npm install
npm test                    # 全部测试（合成 Canvas，不需要账号）
npm run test:fast           # 只跑链接解析和下载策略的单元测试
npm run demo                # 本地网页 + 虚构课程，可随意点；--signed-out / --slow 见脚本说明
npm run build:site          # 生成公开网页到 site/
npm run check:pack          # 打包并在临时目录安装 tarball，脱离源码运行 CLI / MCP / 网页
node scripts/screenshots.mjs  # 用虚构课程重新生成 docs/assets 下的截图（需要 Chrome）
```

## 结构

| 路径 | 内容 |
|---|---|
| `bin/cli.js` | 命令行入口（唯一的 bin：`liverpool-canvas`） |
| `src/config.js` | 固定的 Canvas 地址、数据目录、下载目录、记住的课程 |
| `src/browser.js` | 独立浏览器资料中的学校登录、会话保存与续期 |
| `src/canvas.js` | 只读 Canvas 客户端：超时、有限重试、429 处理、cookie 只发给 Canvas |
| `src/links.js` | 用 HTML 解析器识别 Canvas 文件、页面和模块条目链接 |
| `src/discovery.js` | 统一文件发现（CLI、网页、MCP 共用） |
| `src/store.js` | 安全文件名、下载索引、锁、只补缺失的决策 |
| `src/downloader.js` | 下载任务：临时文件、校验、原子放置、取消、记录 |
| `src/tools.js` / `src/server.js` | MCP 工具与 stdio 服务 |
| `src/web/server.js` + `web/` | 本地操作网页 |
| `src/clients.js` | AI 应用配置（备份、只改自己的条目） |
| `docs/` | 公开介绍网页源文件 |
| `test/` | 合成 Canvas（`fake-canvas.js`）与各项测试 |

## 约定

- 测试只用虚构课程、假账号和生成的文件。不要提交任何真实的会话、下载索引、课件或个人路径。
- `LIVERPOOL_CANVAS_TEST_ORIGIN` 只接受本机 http 地址，用于测试和演示；正式使用固定为 `https://canvas.liverpool.ac.uk`。
- 改了文件发现或下载策略，请同时补测试（`test/discovery.test.js`、`test/download.test.js`）。
- 真实账号的只读检查：账号持有人自己运行 `node bin/cli.js login` 后，运行 `node scripts/verify-live.mjs`。它只输出每项检查是否通过，不输出课程内容。
