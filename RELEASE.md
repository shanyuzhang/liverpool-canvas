# 发布、回滚与配置

当前状态：**npm 未发布**。包名已定为 `@shanyuzhang/liverpool-canvas`（`publishConfig.access = public`），仓库 https://github.com/shanyuzhang/liverpool-canvas ，网页 https://shanyuzhang.com/liverpool-canvas/ 。`release.json` 中 `published: false`，网页和程序据此仍显示 git clone 的安装方式。

## 唯一的发布配置

`release.json` + `package.json`（`name`、`version`）是唯一来源。公开网页、AI 安装 Prompt、错误提示里的命令都从这里生成。不要在别处手写包名或仓库地址；用脚本修改：

```bash
node scripts/configure-release.mjs --scope <npm-scope> --repo <owner>/liverpool-canvas --pages https://<owner>.github.io/liverpool-canvas/
```

它同时设置 `package.json` 的 `name`、`repository`、`homepage`、`publishConfig.access=public`，以及 `release.json`。

## 1. GitHub 仓库与网页

1. 在 GitHub 创建空仓库（建议名 `liverpool-canvas`，公开），把本地 `main` 推上去。
2. 仓库 Settings → Pages → Source 选 “GitHub Actions”。`.github/workflows/pages.yml` 会在 `docs/`、`release.json` 等变化时构建 `site/` 并部署。
3. `.github/workflows/ci.yml` 在 macOS / Windows / Linux × Node 22 / 24 上跑测试，并做 tarball 安装检查。第一次推送后请确认 Windows 和 Linux 任务通过（本地只在 macOS 上测过）。

## 2. npm 发布（需要账号持有人授权和操作）

1. 确认 npm 账号或组织拥有要用的 scope（`npm whoami`；组织 scope 需要在 npmjs.com 创建）。公开 scoped 包的发布方式以 npm 官方文档为准：https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/
2. 运行上面的 `configure-release.mjs`，提交。
3. 发布前检查（会拒绝占位符、未提交改动，并跑完整测试和 tarball 安装检查）：

   ```bash
   npm run check:release
   ```

4. 发布：

   ```bash
   npm publish
   ```

5. 发布成功后标记已发布并更新网页：

   ```bash
   node scripts/configure-release.mjs --published
   ```

   提交并推送；Pages 工作流会把网页上的命令切换为可用的 `npx -y <包名>@latest`。

## 版本

- 修改 `package.json` 的 `version`（例如 `npm version patch --no-git-tag-version`），提交后按上面第 3–5 步发布。
- 公开入口用 `@latest`。AI 应用启动的是装在 `~/.liverpool-canvas/app` 里的**固定版本**（`setup`/`connect` 时按当前版本精确安装），不会每次启动都去拉远端。同学用 `liverpool-canvas update` 显式更新那份本地副本。

## 回滚

- 有问题的版本：`npm deprecate <包名>@<版本> "原因"`，然后发布修复版本。npm 只允许在发布后短时间内 `unpublish`，且会影响已安装的人，一般用 deprecate。
- 已经更新到问题版本的同学：`npm install --prefix ~/.liverpool-canvas/app --save-exact <包名>@<好的版本>`，AI 应用配置不需要改（路径不变）。
- 网页：回退 `release.json` / `docs/` 的提交并推送，Pages 会重新部署。

## 发布前不要包含

`npm run check:pack` 会检查 tarball 只含 `bin/`、`src/`、`web/`、`release.json`、`README.md`、`PRIVACY.md`、`LICENSE`、`package.json`，且没有本机路径、会话 cookie。任何真实的课程文件、下载索引、浏览器资料都不应出现在仓库里（`.gitignore` 已排除 `site/`、`*.tgz` 等生成物）。
