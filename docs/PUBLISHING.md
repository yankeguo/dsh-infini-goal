# 发布指南

本仓库是一个 pnpm workspace，包含 **7 个可发布包**（6 个功能包 + 1 个 bundle）：

| 顺序 | 包 | 说明 |
| --- | --- | --- |
| 1 | `@yankeguo/dsh-infini-goal-protocol` | 纯类型 + 调度数学 |
| 2 | `@yankeguo/dsh-infini-goal` | 核心服务 |
| 3 | `@yankeguo/dsh-infini-goal-driver` | 驱动器 |
| 4 | `@yankeguo/dsh-tool-infini-goal` | 模型工具 |
| 5 | `@yankeguo/dsh-command-infini-goal` | `/infini-goal` 命令 |
| 6 | `@yankeguo/dsh-client-ui-infini-goal` | 浏览器状态条 |
| 7 | `@yankeguo/dsh-infini-goal-bundle` | 安装入口 bundle |

`pnpm publish -r` 会按依赖拓扑自动排序，**bundle 最后发布**；bundle 的
`workspace:*` 依赖在打包时会被改写为当前精确版本（`0.1.0` 等）。

## 前置条件

- Node.js ≥ 24.9、pnpm 12（`corepack enable` 或直接安装 pnpm 12.x）。
- npm 账号对 `@yankeguo` scope 有写权限；所有包都声明了 `publishConfig.access: public`。
- 本地发布需要 `npm login`（启用 2FA 时建议改用 CI + Automation Token）。
- CI 发布需要在本仓库配置 secret `NPM_TOKEN`（见 [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)）。

## 发版流程（手动）

### 1. 准备干净的 main

```sh
git checkout main
git pull
git status                 # 必须干净
```

### 2. 统一升级 7 个包的版本

所有包使用同一版本号。一行命令改完（示例 `0.2.0`）：

```sh
export VERSION=0.2.0
node -e '
  const fs = require("node:fs")
  const { execSync } = require("node:child_process")
  const dirs = ["protocol","infini-goal","driver","tool","command","client-ui","bundle"]
  for (const dir of dirs) {
    const file = `packages/${dir}/package.json`
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"))
    manifest.version = process.env.VERSION
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n")
  }
  console.log("bumped to", process.env.VERSION)
' 
pnpm install                # 同步 workspace 锁文件中的版本
```

> 也可以只发布部分包，但**不要**让 bundle 依赖的版本与已发布版本不一致；
> 推荐整套同版本发布。

### 3. 写 release notes

新建 `docs/releases/v<VERSION>.md`（参考 [`v0.1.0.md`](releases/v0.1.0.md)）。
CI 会用它作为 GitHub Release 正文。

### 4. 发布前检查

```sh
pnpm install --frozen-lockfile     # 锁文件一致
pnpm typecheck                     # TS 检查（本项目无独立构建类型，仅做源码检查）
pnpm test                          # 单元测试（vitest）
pnpm build                         # 生成 packages/*/lib（lib 被 gitignore，发布时必须现构建）
pnpm release:dry                   # 递归 dry-run：打印 7 个包的发布计划，不上传
```

抽查打包内容（可选，但推荐在首次发布或改 `files` 后做）：

```sh
mkdir -p /tmp/infini-pkgs
pnpm --filter @yankeguo/dsh-infini-goal-bundle pack --pack-destination /tmp/infini-pkgs
tar -tzf /tmp/infini-pkgs/*.tgz        # 必须包含 package/cordis.patch.yml、README、icon
tar -xzOf /tmp/infini-pkgs/*.tgz package/package.json   # workspace:* 应已改写为精确版本
```

### 5. 发布（二选一）

**A. 本地发布**

```sh
npm login                              # 确保是 @yankeguo 的维护者
pnpm release:publish                   # = pnpm build && pnpm publish -r --access public --no-git-checks --tag latest
```

**B. 推 tag 触发 GitHub Actions（推荐，可复现 + 自动建 Release）**

```sh
git add -A
git commit -m "release: v0.2.0"
git push origin main
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0                 # 触发 .github/workflows/publish.yml
```

流水线会依次执行 install / typecheck / test / build / `pnpm publish -r` / 创建 GitHub Release。
`workflow_dispatch` 也支持手动触发（但不带 tag 时不会创建 Release）。

### 6. 验证发布结果

```sh
npm view @yankeguo/dsh-infini-goal-bundle version dist-tags
npm view @yankeguo/dsh-infini-goal version
npm view @yankeguo/dsh-client-ui-infini-goal version
```

在 DSH 中安装验证：

```sh
dsh plugin --profile desktop add @yankeguo/dsh-infini-goal-bundle@0.2.0
```

然后刷新 Web 页面，执行 `/infini-goal <objective>` 冒烟。

## 版本与 dist-tag 策略

- 稳定版：默认 `latest`（`pnpm release:publish` / CI 已带 `--tag latest`）。
- 试验版：加 `--tag next`，例如 `pnpm publish -r --access public --no-git-checks --tag next`；
  用户安装时需要显式指定版本（DSH 插件市场按版本安装，不受 dist-tag 影响）。
- `engines.dsh` 当前为 `>=0.2.2-rc.1 <0.3.0`；DSH 升级到 0.3 时需更新该范围并回归。
- 破坏性变更：遵循 semver；预发布版本请使用 `-rc.N` / `-alpha.N` 后缀。

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `npm error code ENEEDAUTH` | 未登录：`npm login`；CI 检查 `NPM_TOKEN` secret 是否存在且未过期 |
| `403 Forbidden — You do not have permission to publish` | 账号对 `@yankeguo` scope 无权限，或包名已被占用 |
| `Cannot publish over the previously published versions` | 版本已存在，不能覆盖；必须升版本（或换 dist-tag 发布新版本） |
| 部分包发布失败 | `pnpm publish -r` 会逐个发布；已成功的包会保留。修复后重新执行同一命令会因版本已存在而失败——先 `pnpm --filter <失败包> publish ...` 补齐，或整体升 patch 版本 |
| 启用 2FA 导致本地发布失败 | 用 CI + Automation/Granular Token（`NPM_TOKEN`），或改用支持 OTP 的发布方式 |
| 误发版本 | npm 允许 72 小时内 `npm unpublish <pkg>@<version>`；超过则只能废弃（deprecate）并升版本 |
| 需要 npm provenance 签名 | 在 GitHub Actions 中加 `id-token: write` 权限并在 npm 包设置 Trusted Publisher；或 `NPM_CONFIG_PROVENANCE=true`（公开仓库） |

## 发布后的用户安装方式

```sh
# CLI
dsh plugin --profile desktop add @yankeguo/dsh-infini-goal-bundle

# 或在 Web：Plugins → Add plugin → 输入 @yankeguo/dsh-infini-goal-bundle
```

本地 checkout 开发仍可用 `pnpm install:profile`（见主 [README](../README.md)）。
