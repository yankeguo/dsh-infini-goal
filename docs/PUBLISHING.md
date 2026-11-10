# 发布指南

本仓库是一个 pnpm workspace，包含 **8 个可发布包**（6 个功能包 + 2 个 bundle）：

| 顺序 | 包 | 说明 |
| --- | --- | --- |
| 1 | `@yankeguo/dsh-infini-goal-protocol` | 纯类型 + 调度数学 |
| 2 | `@yankeguo/dsh-infini-goal` | 核心服务 |
| 3 | `@yankeguo/dsh-infini-goal-driver` | 驱动器 |
| 4 | `@yankeguo/dsh-tool-infini-goal` | 模型工具 |
| 5 | `@yankeguo/dsh-command-infini-goal` | `/infini-goal` 命令 |
| 6 | `@yankeguo/dsh-client-ui-infini-goal` | 浏览器状态条 |
| 7 | `@yankeguo/dsh-disable-goal-bundle` | 独立 bundle：关闭系统自带 dsh-goal（patch 层 + 小型 `preset-filter` 运行时插件） |
| 8 | `@yankeguo/dsh-infini-goal-bundle` | 安装入口 bundle（已内嵌同一关闭层，并把它声明为运行时依赖） |

本节表格只是阅读顺序：实际 stage 顺序由 `scripts/stage-release.mjs` 按 **workspace 依赖拓扑**
计算（先被依赖的包先 stage，主 bundle 最后），每次运行都会打印。`workspace:*` 依赖在打包时
会被 pnpm 改写为当前精确版本（`0.2.0` 等）；`@yankeguo/dsh-disable-goal-bundle` 自身没有
workspace 依赖，但含一个运行时插件（`preset-filter`，构建产物 `lib/preset-filter.js`）与 patch
文件，主 bundle 在 `dependencies` 里声明了它，因此它总在主 bundle 之前 stage。

## 发布模型：staged publish（CI 只暂存，人审批后公开）

发布分成两个物理上分开的步骤：

| 步骤 | 在哪里执行 | 认证 | 结果 |
| --- | --- | --- | --- |
| **stage**（暂存） | GitHub Actions（OIDC，无需 2FA） | 短时 OIDC token，只能 `npm stage publish` / `npm publish` | 8 个版本进入 registry 的 **私有暂存区**，用户不可安装 |
| **approve**（审批） | 维护者本机（`npm login` + 2FA） | 长期会话凭据 + 每包一次 2FA | 暂存版本逐个转为公开；随后创建 GitHub Release |
| **reject**（清理） | 维护者本机（2FA） | 同上 | 删除暂存记录（不可恢复）；版本号可重新 stage |

这样设计的原因：

- **失败原子性**：stage 阶段任何一步失败，最多留下一批**未公开**的暂存版本；reject 掉重跑即可，
  不会出现「一部分包已公开、另一部分没有」的半发布状态。
- **人在回路（proof-of-presence）**：npm 的短时 OIDC token **只能用于 staging**，不能 approve；
  approve/reject 必须由人类用 2FA 完成。CI 被攻破最多产生一批待清理的私有暂存版本，无法把
  版本公开。
- **不再允许直接 publish**：trusted publisher 只授予 `--allow-stage-publish`，不授予
  `--allow-publish`。常规发布路径里没有任何「CI 直接公开版本」的能力。

发布顺序固定为 **stage（CI）→ 审查（维护者）→ approve + GitHub Release（维护者）**，
CI **不再**创建 GitHub Release。

## 前置条件

- Node.js ≥ 24.9、pnpm 12（CI 固定 `pnpm@12.16.1`）。
- npm 账号对 `@yankeguo` scope 有写权限；所有包都声明了 `publishConfig.access: public`。
- npm 账号已开启 **2FA**（approve/reject/`npm trust` 都会要求）。
- `gh` CLI 已在本机登录（创建 GitHub Release 用；CI 不再创建）。
- 发布用 npm CLI **≥ 11.20.0**（本仓库验证版本；`npm stage` 系列子命令与
  `--allow-stage-publish` 需要新版 npm）：`npm install -g npm@latest`。
- GitHub Actions 运行在 **GitHub-hosted runner**（npm 不支持 self-hosted runner 的 trusted publishing）。
- 仓库是公开仓库（本仓库已是 public）：trusted publishing 可在私有仓库使用，但
  **provenance 需要公开仓库**；公开仓库下会自动生成 provenance。

## 一次性配置：trusted publisher（只允许 staged publish）

npm 只接受来自「被信任的 CI 工作流」的 OIDC 请求。每个包都要配置一次，把 **本仓库 +
`publish.yml` 工作流** 声明为该包的 trusted publisher，且**只授予 stage 权限**。

### 从旧的 `--allow-publish` 配置迁移（重要）

0.2.0 之前每个包配置的是 `--allow-publish`（CI 可直接 `pnpm publish`）。新流程要求
**revoke 旧配置 → 重建 stage-only 配置**；同一 workflow 只允许一个 trust 配置，不能原地叠加。

```sh
npm login                                    # 确认是 @yankeguo 维护者，2FA 已开启
npx npm@latest --version                     # 确认 >= 11.20.0
scripts/trusted-publishers.sh --migrate      # 逐包：revoke 旧配置（2FA）→ 重建 stage-only（2FA）
scripts/trusted-publishers.sh --list         # 校验：必须显示 permissions: stage publish
```

`--migrate` 对每个包执行：`npm trust list` 找到现有 id → `npm trust revoke <pkg> --id=<id>`
→ `npm trust github <pkg> --allow-stage-publish`。手工迁移等价于：

```sh
npm trust list @yankeguo/dsh-infini-goal          # 记下 id
npm trust revoke @yankeguo/dsh-infini-goal --id=<id>
scripts/trusted-publishers.sh                     # 重建全部 8 个包（stage-only）
```

也可以在 npmjs.com 网页逐包操作：**Settings → Trusted Publisher → GitHub Actions**，
`Organization or user = yankeguo`、`Repository = dsh-infini-goal`、`Workflow filename = publish.yml`，
**Allowed actions 只勾选 npm stage publish**（不要勾 npm publish），保存前删掉旧配置。

### 方式 A：脚本批量配置（推荐）

```sh
npm login                                # @yankeguo 维护者，2FA 账号
scripts/trusted-publishers.sh --dry-run  # 先看会执行什么（离线可跑）
scripts/trusted-publishers.sh            # 逐个配置全部 8 个包（脚本自动发现，新增包无需改脚本）
scripts/trusted-publishers.sh --list     # 校验结果
```

脚本等价于对每个包执行：

```sh
npm trust github @yankeguo/dsh-infini-goal \
  --file publish.yml \
  --repo yankeguo/dsh-infini-goal \
  --allow-stage-publish \
  --yes
```

- `--file` 必须只是工作流文件名（`publish.yml`），不能带路径，且文件必须位于
  `.github/workflows/` 下；
- `--allow-stage-publish` 只允许 CI **stage**；`--allow-publish`（直接公开）**刻意不授予**；
- 若使用 GitHub Environments 做发布审批，加 `--env <环境名>`，并同时在工作流 job 上写
  `environment: <环境名>`，两边必须一致；
- 每个包最多 10 个 trusted publisher；同一包已有一个配置时需先 revoke（脚本 `--migrate`
  会处理）；
- npm 建议批量配置时每次调用间隔约 2 秒（脚本已处理）。

### 校验

```sh
scripts/trusted-publishers.sh --list
# 或逐包
npm trust list @yankeguo/dsh-infini-goal
```

合格输出必须包含：

```text
file: publish.yml
repository: yankeguo/dsh-infini-goal
permissions: stage publish
```

`permissions:` 行出现 `publish`（不带 `stage`）或 `publish, stage publish` 都表示**仍在直接发布**，
`--list` 会失败，需 `--migrate`。未登录时 `--list` 会报 `no response from the registry`。

### 全新包：第一次发布是唯一例外

npm 要求 **包必须已存在于 registry** 才能配置 trusted publisher，暂存也要求包已存在。因此
**全新包的第一个版本**仍需维护者本地用 `npm login` 凭据直接发布一次（明确的一次性例外）：

```sh
pnpm build
pnpm --filter @yankeguo/<新包> publish --access public --no-git-checks --tag latest
scripts/trusted-publishers.sh            # 然后配置 stage-only trust
```

之后该包的所有版本都走 staged 流程，不再直接 publish。

## 发版流程

### 1. 准备干净的 main

```sh
git checkout main
git pull
git status                 # 必须干净
```

### 2. 统一升级 8 个包的版本

所有包使用同一版本号。一行命令改完（示例 `0.2.1`）：

```sh
export VERSION=0.2.1
node -e '
  const fs = require("node:fs")
  const dirs = ["protocol","infini-goal","driver","tool","command","client-ui","bundle","disable-goal-bundle"]
  for (const dir of dirs) {
    const file = `packages/${dir}/package.json`
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"))
    manifest.version = process.env.VERSION
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n")
  }
  console.log("bumped to", process.env.VERSION)
'
# 根 package.json 也同步（CI 的 tag 门禁会校验根版本）
node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync("package.json","utf8"));m.version=process.env.VERSION;fs.writeFileSync("package.json",JSON.stringify(m,null,2)+"\n")'
pnpm install                # 同步 workspace 锁文件中的版本
```

> 也可以只发布部分包，但**不要**让 bundle 依赖的版本与已发布版本不一致；
> 推荐整套同版本发布。发布前检查所有包的 `version` 一致（含 `disable-goal-bundle` 与根
> `package.json`）。

### 3. 写 release notes

新建 `docs/releases/v<VERSION>.md`（参考 [`v0.2.0.md`](releases/v0.2.0.md)）。审批通过后
`scripts/promote-release.mjs` 会把它作为 GitHub Release 正文。

### 4. 发布前检查

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
node scripts/build-disable-goal-bundle.mjs --check

# 发布计划：版本/tag/依赖顺序/构建产物是否齐全（不联网，不上传）
node scripts/stage-release.mjs --check

# 打包演练：逐个 pnpm stage publish --dry-run，验证 8 个包的 tarball 与顺序（不上传）
node scripts/stage-release.mjs --dry-run --no-git-checks
```

`--check` 会校验：8 个包与根 `package.json` 版本一致、workspace 内部依赖使用 `workspace:`
协议、依赖拓扑无环、每个包 `files` 里的字面条目都已构建出来。`--dry-run` 额外逐个运行
`pnpm stage publish --dry-run`，确认打包内容（含 `locale/*.json`、patch、icon）。
（快捷命令：`pnpm release:check` 等价 `--check`；`pnpm release:stage:dry` 等价 build + `--dry-run`。）

抽查打包内容（可选，但推荐在首次发布或改 `files`/`locale` 后做）：

```sh
mkdir -p /tmp/infini-pkgs
pnpm --filter @yankeguo/dsh-infini-goal-bundle pack --pack-destination /tmp/infini-pkgs
pnpm --filter @yankeguo/dsh-disable-goal-bundle pack --pack-destination /tmp/infini-pkgs
pnpm --filter @yankeguo/dsh-client-ui-infini-goal pack --pack-destination /tmp/infini-pkgs

MAIN=/tmp/infini-pkgs/*dsh-infini-goal-bundle-*.tgz
DISABLE=/tmp/infini-pkgs/*dsh-disable-goal-bundle-*.tgz
UI=/tmp/infini-pkgs/*dsh-client-ui-infini-goal-*.tgz
tar -tzf $MAIN        # 必须包含 package/cordis.patch.yml、package/cordis.disable-goal.patch.yml、package/locale/en.json、package/locale/zh.json、icon.svg、README.md
tar -tzf $DISABLE     # 必须包含 package/cordis.patch.yml、package/lib/preset-filter.js、package/locale/en.json
tar -tzf $UI          # 必须包含 package/lib/client.js、package/locale/en.json、package/locale/zh.json
tar -xzOf $MAIN package/package.json   # workspace:* 应已改写为精确版本
```

发布前同时确认插件展示元数据仍完整（`pnpm test` 的 `plugin-metadata.spec.ts` 也会检查）：
每个包都有 `locale/en.json` + `locale/zh.json`，`meta.title`/`meta.description` 非空，
`package.json` 的 `files` 含 `locale/*.json`、`exports` 含 `"./locale/*.json"`，
且 `package.json` 的 `description` 与英文 locale 一致。**新增包必须一并补齐这些字段**，
否则测试与打包抽查都会失败；维护方式见 [README 的「插件展示元数据」](../README.zh.md#插件展示元数据)。

### 5. 提交并推 tag → CI stage

```sh
git add -A
git commit -m "chore(release): v0.2.1"
git push origin main
git tag -a v0.2.1 -m "v0.2.1"
git push origin v0.2.1                 # 触发 .github/workflows/publish.yml
```

CI（`.github/workflows/publish.yml`）依次执行：

1. 解析 release tag（tag push 用 `github.ref_name`；手动触发用 `release_tag` 输入）；
2. checkout 该 tag；
3. **tag/版本门禁**：`node scripts/stage-release.mjs --release-tag <tag> --gate`，tag 必须与
   8 个包 + 根 `package.json` 的 `version` 完全一致，否则 job 失败；
4. install / typecheck / test / build / `build-disable-goal-bundle.mjs --check`；
5. **逐包 stage**：`node scripts/stage-release.mjs --release-tag <tag> --provenance --no-git-checks`，
   按依赖拓扑顺序逐个执行 `pnpm stage publish --access public --tag <自动：稳定版 latest / 预发布版 next>`；
6. job summary 输出 stage 摘要（版本、8 个包、下一步 approve 命令）。

工作流权限只需：

```yaml
permissions:
  contents: read      # checkout；CI 不再创建 GitHub Release
  id-token: write     # OIDC：pnpm 换取 npm 短时 stage token
```

工作流里**没有** `NODE_AUTH_TOKEN`、也没有 `NPM_TOKEN`，也**没有**创建 GitHub Release 的步骤。

### 6. 手动重跑已存在的 tag（不移动 tag、不改历史）

stage 因基础设施/trust/网络原因失败时，**不要**删 tag 或强推：在已修复的工作流上手动触发，
用 `release_tag` 指向**已存在的 tag**：

```sh
gh workflow run publish.yml --ref main -f release_tag=v0.2.1
# 或 Actions 页面 → publish → Run workflow → release_tag = v0.2.1
```

- 工作流逻辑取自 dispatch 的 ref（通常是 `main`），**包内容取自 `release_tag` 对应的 commit**；
  因此「修工作流后重跑旧 tag」是安全的；
- tag 永远不会被移动，staged 内容始终对应已发布的 commit；
- 如果修复需要改**包代码**，不能重跑旧 tag（那仍会 stage 旧代码）——必须升下一个版本、打新 tag；
- 重新 stage 前必须先 reject 上次残留的暂存版本（见「失败与恢复」）；
- dispatch 支持 `dry_run: true`：只做 `pnpm --dry-run` 演练，不上传（不验证 OIDC/trust）。
- CI 完全不可用时的兜底：维护者在干净的 `main` 上 `npm login` 后执行 `pnpm release:stage`
  （本机 session 凭据，不带 OIDC/provenance；stage 本身不需要 2FA），后续审查与 approve 流程不变。
  常规发布不要走这条路，CI 的 OIDC stage 才是受信任路径。

### 7. 审查暂存结果（approve 之前）

approve 之后版本即公开，**先审查再 approve**：

```sh
node scripts/promote-release.mjs --version 0.2.1 --list-only
# 下面这些命令也可以单独使用（npm >= 11.20.0）：
npm stage list --json                                  # 列出全部暂存版本与 stage-id
npm stage view <stage-id>                              # 单个暂存版本的详情
npm stage download <stage-id>                          # 下载暂存 tarball 到本地检查
```

`--list-only` 会校验：该版本 8 个包都恰好有一个暂存记录、dist-tag 与预期一致（稳定版 `latest`、预发布版 `next`）、stage-id 合法，
并打印每个包的 stage-id/时间/操作者。任何缺失、重复、tag 不一致都会直接失败。

建议对将要公开的 tarball 做一次抽查（尤其改过 `files`/`locale`/patch 的版本）：

```sh
mkdir -p /tmp/infini-staged && cd /tmp/infini-staged
npm stage download <bundle-stage-id>       # 下载暂存 tarball 到当前目录，输出文件名
tar -tzf *bundle*.tgz                      # 确认 locale/、patch、icon、lib 都在
tar -xzOf *bundle*.tgz package/package.json  # workspace:* 应已改写为精确版本
```

`npm stage list --json` 中每个条目还带有 `shasum`，可与本地 `pnpm pack` 的产物对比。

### 8. 审批（2FA）+ 创建 GitHub Release

```sh
npm login                                   # 维护者账号，2FA 已开启
gh auth status                              # 创建 GitHub Release 需要已登录的 gh
node scripts/promote-release.mjs --version 0.2.1 --dry-run   # 先看会执行的 approve/gh 命令
node scripts/promote-release.mjs --version 0.2.1             # 正式审批
```

`promote-release.mjs` 会：

1. 重新列出一遍暂存版本并做与 `--list-only` 相同的校验；
2. 打印确认提示（`--yes` 可跳过；非交互终端必须显式 `--yes`）；
3. 按依赖顺序逐个执行 `npm stage approve <stage-id>`，**npm 会为每个包提示一次一次性密码**
   （2FA）；
4. 用 `npm view <pkg>@<version> version` 逐个确认已公开；
5. 用 `gh release create v<version> --title v<version> --notes-file docs/releases/v<version>.md`
   创建 GitHub Release（笔记缺失时退回 `--generate-notes`）。

可选参数：

- `--dry-run`：只打印 approve 与 gh 命令，不做任何修改；
- `--no-github-release`：只 approve 包，不创建 GitHub Release；
- `--tag <dist-tag>`：暂存版本应带的 dist-tag（稳定版默认 `latest`，预发布版默认 `next`，
  必须与 CI stage 时一致）；
- `--reject`：不 approve，改为清理该版本的暂存记录（见下节）。

> 注意：approve 需要人工 2FA，无法在 CI 里自动完成——这是设计目标，不是缺陷。

### 9. 验证发布结果

```sh
npm view @yankeguo/dsh-infini-goal-bundle version dist-tags
npm view @yankeguo/dsh-infini-goal version
npm view @yankeguo/dsh-client-ui-infini-goal version
gh release view v0.2.1
```

在 DSH 中安装验证：

```sh
dsh plugin --profile desktop add @yankeguo/dsh-infini-goal-bundle@0.2.1
```

然后刷新 Web 页面，执行 `/infini-goal <objective>` 冒烟。插件管理页应显示
locale 里的友好名称与一句话描述（例如 “Infini Goal”、“无限目标”）。

## 失败与恢复

staged 发布把状态分成三段：**未 stage / 已 stage 未公开 / 已 approve 公开**。
只有最后一段不可回滚，前两段都可安全重试。

| 失败点 | 公开状态 | 恢复动作 |
| --- | --- | --- |
| stage 中途失败（某包报错） | **没有任何版本公开** | 先清理：`node scripts/promote-release.mjs --version <v> --reject`（2FA，逐包）；修复原因后用 `workflow_dispatch` + 同一 `release_tag` 重跑。若失败因包内容，必须升版本打新 tag |
| stage 成功但内容有误（尚未 approve） | 无 | `--reject` 掉全部暂存版本（2FA），修复后升版本/新 tag 重新 stage。版本号在 reject 后可重新使用，但代码修正通常伴随版本升级 |
| 暂存版本缺失/重复/tag 不一致 | 无 | `promote-release.mjs` 会在 approve 前失败；`--reject` 后重跑 CI stage |
| stage 时 OIDC/trust 报错 | 无 | 修 `.github/workflows/publish.yml` 或 `scripts/trusted-publishers.sh --migrate`，然后 dispatch 同一 tag 重跑（不移动 tag） |
| approve 中途失败 | **已 approve 的包已公开**；其余仍私有 | 重跑 `promote-release.mjs --version <v>` 继续 approve 剩余暂存版本；若内容本身有误，reject 剩余包并升 patch 版本发布修正版（已公开版本无法安全撤回） |
| 全部 approve 成功但 `gh release create` 失败 | 包已公开 | 按脚本打印的命令手动创建：`gh release create v<v> --title v<v> --notes-file docs/releases/v<v>.md` |
| `npm login`/2FA 失败 | 无 | 重新 `npm login`（不要用 bypass-2FA token）；`npm stage list` 会报 401 |

清理命令会要求 2FA，并**永久删除**暂存记录（含 tarball）：

```sh
node scripts/promote-release.mjs --version 0.2.1 --reject
```

## 安全模型（为什么这样安全）

- **OIDC 短时 token 的能力边界**：trusted publishing 换到的 token 只能用于
  `npm stage publish` 与 `npm publish`；其它 `npm stage` 子命令（list/view/approve/reject/download）
  需要长期登录凭据，approve/reject 还必须 2FA。
- **CI 最小权限**：trusted publisher 只授予 `--allow-stage-publish`。即使 workflow 被改动/攻破，
  最多能产生一批**私有暂存版本**（用户不可安装，维护者可 reject），无法直接公开版本。
- **人在回路**：approve 只能由维护者本地 2FA 完成；GitHub Release 也只能由维护者本地 `gh` 创建。
- **暂存的 tag 不可变**：一个暂存版本只能带一个 dist-tag；改 tag 必须先 reject 再重新 stage。
- **版本号唯一索引共享**：同一版本不能既已公开又被暂存；已发布版本无法重新 stage。
- **provenance**：CI stage 时由 pnpm 生成 Sigstore provenance 并随暂存 tarball 上传，approve
  后公开可验证；要求公开仓库 + GitHub-hosted runner。工作流显式传 `--provenance`。
- **`reject` 是删除**：暂存记录与 tarball 会被永久删除，但删除的只是私有暂存内容，不影响已公开版本。

### 与旧的直接发布流程对比

| | 旧流程（0.2.0 及以前） | 新流程（staged） |
| --- | --- | --- |
| CI 权限 | `--allow-publish`，可直接公开版本 | `--allow-stage-publish`，只能暂存 |
| 2FA | CI 无法 2FA，等于没有 proof-of-presence | 每个包 approve 时人工 2FA |
| 中途失败 | 可能出现部分包已公开的半发布 | 未 approve 前全部私有，可 reject 重来 |
| GitHub Release | CI 用 `contents: write` 自动创建 | 维护者本地 `gh` 在 approve 成功后创建 |
| 长期 token | 无（OIDC） | 无（OIDC，且 token 只能 stage） |

## Keyless OIDC 与 staged publish 工作原理（研究笔记）

1. 工作流声明 `permissions: id-token: write` 后，GitHub Actions 通过
   `ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN` 暴露短时 OIDC ID token。
2. `pnpm stage publish` 检测到该环境后，请求受众为 `npm:registry.npmjs.org` 的 ID token，
   向 registry 的 `/-/npm/v1/oidc/token/exchange/package/<pkg>` 换取**一次性的暂存 token**。
3. registry 校验 OIDC claims（仓库、工作流文件名、可选 environment、权限）与包的 trusted
   publisher 配置一致后接受暂存请求：`POST /-/stage/package/<pkg>`，响应带 `stageId`。
   审批相关端点：`GET /-/stage`（列表）、`POST /-/stage/<id>/approve`（公开）、
   `DELETE /-/stage/<id>`（reject）。
4. 因此 CI 端不需要任何长期 `NPM_TOKEN`，token 泄露面只剩单次 workflow run，且只能 stage。
5. provenance 由 pnpm 在 trusted publishing 下自动生成（Sigstore，要求公开仓库）；工作流同时
   显式传 `--provenance`，签名随暂存 tarball 上传。
6. **为什么用 `pnpm stage publish` 而不是 `npm stage publish`**：npm 打包 `package.json` 时
   原样保留 `workspace:*` 依赖（用本地 registry stub 实测），bundle 的 manifest 会带着未解析的
   workspace 协议上架；pnpm 打包时会把 `workspace:` 改写成精确版本（`0.2.0`），与 `pnpm publish`
   的行为一致。审批端使用 `npm stage`（交互 2FA 体验最好、命令集完整）。
7. npm CLI 的 staged 子命令：`npm stage publish|list|view|approve|reject|download`；
   `list/view/download --json` 可脚本化；`approve/reject` 需要 2FA。

## 版本与 dist-tag 策略

- 稳定版（版本号无 `-` 后缀）：dist-tag 自动为 `latest`。
- 试验版：版本号用 `-rc.N` / `-alpha.N`，dist-tag **自动为 `next`**，避免预发布版本顶掉 `latest`；
  `scripts/stage-release.mjs` 与 `scripts/promote-release.mjs` 都支持 `--tag` 显式覆盖，
  但两边的值必须一致（审批会校验暂存时携带的 dist-tag）。用户安装预发布版时需要显式指定版本
  （DSH 插件市场按版本安装，不受 dist-tag 影响）。
- 暂存版本的 dist-tag 不可变；需要换 tag 时必须先 reject 再重新 stage。
- `engines.dsh` 当前为 `>=0.2.2-rc.1 <0.3.0`，**8 个包都声明**；DSH 升级到 0.3 时需更新该范围并回归。
- 破坏性变更：遵循 semver；预发布版本请使用 `-rc.N` / `-alpha.N` 后缀。

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| CI 报 `ERR_PNPM_ID_TOKEN_GITHUB_WORKFLOW_INCORRECT_PERMISSIONS` | 工作流缺少 `permissions: id-token: write`（或 job 级权限覆盖了它） |
| CI 报 401/403 / `no trust evidence` / `package not found` | trusted publisher 配置与本次运行不匹配：核对 repo、**工作流文件名**、environment 三项；或该包尚未配置/尚未首次发布 |
| CI stage 报 `no trust evidence` 但配置看起来正确 | 旧配置仍是 `--allow-publish`；运行 `scripts/trusted-publishers.sh --migrate` 重建为 stage-only |
| `npm trust` 报 401/ENEEDAUTH | 未 `npm login`；OIDC 只用于 CI stage，配置 trust 仍需要登录凭据 |
| `npm trust` 报 2FA / 权限错误 | 账号未开启 2FA，或使用了 "bypass 2FA" 的 Granular Token（不支持）；改用交互登录或网页 |
| `npm trust` 报 package 不存在 | 先手动发布一次该包（见「全新包：第一次发布是唯一例外」），再配置 trusted publisher |
| `--list` 报 `old direct-publish configuration` | 旧 `--allow-publish` 配置；`scripts/trusted-publishers.sh --migrate` |
| `--list` 报 `no response from the registry` | 未 `npm login` 或网络不通 |
| CI 报 `tag v… expects version …, but: …` | `v*` tag 与包 `version` 不一致；把 8 个包 + 根 `package.json` 统一升到 tag 的版本后重推 tag（若已推送则用新版本） |
| stage 报某版本已存在 | 该版本已公开或已有暂存记录；公开版本不能覆盖 → 升版本；暂存记录用 `promote-release.mjs --reject` 清理 |
| stage 失败但部分包已 stage | 没有公开；`--reject` 清理后重跑（同一 tag 用 `workflow_dispatch`） |
| `promote-release.mjs` 报 `is not staged` | CI stage 未完成/该包失败；查看 CI 日志，reject 后重跑 |
| `promote-release.mjs` 报 `staged with tag ..., expected ...` | 暂存时 dist-tag 与审批预期不一致；`--reject` 后用正确 `--tag` 重新 stage |
| approve 时反复要求 OTP | 预期行为：每个包一次 2FA。保持认证器就绪；`--otp` 不适合批量的多包审批 |
| `gh release create` 失败 | `gh auth status` 未登录/无权限；按脚本打印的命令手动创建 |
| provenance 未生成 / 报 provenance 错误 | 仓库非公开、runner 非 GitHub-hosted、或使用了 `--no-provenance`；公开仓库 + hosted runner 应自动生成 |
| 误发版本 | approve 后不可撤回；npm 允许 72 小时内 `npm unpublish <pkg>@<version>`；超过则只能 deprecate 并升版本 |
| 想改用新工作流文件名/环境 | 一个包只能存在一个 trust 配置：`--migrate` 或先 `npm trust list` + `npm trust revoke --id`，再重新配置 |

## 发布后的用户安装方式

```sh
# CLI
dsh plugin --profile desktop add @yankeguo/dsh-infini-goal-bundle

# 或在 Web：Plugins → Add plugin → 输入 @yankeguo/dsh-infini-goal-bundle
```

本地 checkout 开发仍可用 `pnpm install:profile`（见主 [README](../README.md)）。

## 参考

- npm 文档：[Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers/)
- npm staged publishing：`npm help stage`；`npm help trust`
- `npm trust` 命令：[npm-trust](https://docs.npmjs.com/cli/v11/commands/npm-trust)
- pnpm：`pnpm help stage`、`pnpm help publish`，[pnpm publish 文档](https://pnpm.io/cli/publish)
- OpenSSF [Trusted Publishers](https://repos.openssf.org/trusted-publishers) 标准
