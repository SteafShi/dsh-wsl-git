# dsh-wsl-git

**在 WSL 发行版内执行 `git` 的 IDE 级 Git 工具窗口 —— 作为 [dsh-ide-git](https://github.com/KannaKuron/dsh-ide-git) 0.15.0 的 fork 补丁发布。**

[![baseline](https://img.shields.io/badge/baseline-dsh--ide--git%400.15.0-blue)](#相对-baseline-的改动)
[![license](https://img.shields.io/badge/license-MIT-green)](#许可与署名)

面板本身**未作改动**:分支树、提交图谱、变更与暂存、提交详情、逐行 diff、右键发送到对话、删除可撤回、动作条可配置、21 种界面语言——全部来自基线。唯一的区别是 **`git` 在哪里执行**:会话工作区属于哪个 WSL 发行版,就在那个发行版里跑。

```
基线  dsh-ide-git 0.15.0 (MIT, © 2026 KannaKuron)
本件  0.15.0-wsl = 基线 + 一层 WSL 执行与路径翻译补丁
```

---

## 主要特点

### 一、`git` 在发行版内执行,而且发行版由工作区决定

这是本补丁存在的理由。DSH 把一个 WSL 工作区存成 UNC 路径,**那条路径自己就带着发行版名**,所以不需要任何配置:

| 工作区路径 | 解析结果 | 实际执行的 git |
|---|---|---|
| `\\wsl.localhost\Ubuntu-24.04\home\you\proj` | `Ubuntu-24.04` | 发行版内的 `git`(实测 `2.43.0`) |
| `\\wsl.localhost\Ubuntu-20.04\home\you\proj` | `Ubuntu-20.04` | 发行版内的 `git`(实测 `2.25.1`) |
| `C:\Users\you\proj`(未注册) | — | Windows `git`,与基线逐字节一致 |

一份安装服务任意多个发行版;**非 WSL 工作区行为完全不变**。选项 `distro` / `user` / `gitPath` 全部默认空,只在工作区说不出时兜底,永远不覆盖工作区。

配置 `distro` 只在一种情况下生效:工作区是盘符路径、且注册表里没有它。默认关闭。

### 二、失败会被点名,而不是伪装成"不是 git 仓库"

这是基线在 WSL 下最容易误导人的地方。

| 情况 | 基线说 | 本件说 |
|---|---|---|
| 发行版未注册 | `not a git repository` | `wsl-distro-missing`,点名发行版并提示 `wsl -l -v` |
| WSL 服务异常 | `not a git repository` | `wsl-launcher`,带与语言无关的 `Wsl/…` 错误码 |
| 发行版内没装 git | `not a git repository` | `git-missing`,点名发行版并给出安装命令 |
| `cwd` 是 Linux 路径 | 静默解析成 `C:\home\…`(指向空处) | `bad-request`,`cwd must be a host path …, not a Linux path` |

### 三、路径按你思考的方式显示

仓库选择器显示 **`Ubuntu-24.04 · /home/steaf/workspace/device_xcar_1.0`** 而不是 `\\wsl.localhost\Ubuntu-24.04\home\…`;鼠标悬停可看原始宿主路径。仓库名也从"整条 UNC 路径"恢复成目录名。

> 交互契约不变:请求里流转的路径**始终是宿主拼写**,与 DSH 给会话存的 cwd 同一种。客户端不需要知道自己在跟哪个世界说话。

### 四、继承自基线的面板能力(未改动)

| 区域 | 能力 |
|---|---|
| 分支 | `HEAD / 本地 / 远程 / 标签` 分组树、过滤、ahead/behind 角标、worktree 占用标记;右键签出 / 变基 / 合并 / 比较 / 新建 / 重命名 / 删除 / 更新 / 推送 |
| 历史 | lane 拓扑提交图谱 + refs 徽章 + 分页(120/页);筛选:文本或哈希、分支或标签、提交人、日期、路径(服务端 `git log -- <path>`)、排序方向 |
| 提交 | 详情(完整信息 / 作者 / 日期 / 变更文件 +/−)、逐行 diff(行号 + hunk 高亮 + 红绿底 + 复制 / 换行) |
| 变更 | 冲突 / 已暂存 / 更改 / 未跟踪 四组;行内暂存 / 取消 / 丢弃;分组级全部暂存 / 取消;点击看 diff |
| 提交框 | 多行信息、`Ctrl+Enter` 提交、`--amend` |
| 发到对话 | 提交、分支、文件(`@路径` chip,含空格自动加引号)、**diff 选中行**(换算成新文件行号,删除行标旧行号)一键送进当前会话输入框 |
| 安全 | 破坏性操作要 `confirm: true` + 二次确认;`main`/`master`/`trunk` 删除要输入分支名;同仓库写操作宿主串行;merge / rebase / cherry-pick / revert / bisect 未结束时相关动作置灰 |
| 撤回 | 删除分支 / 删除贮藏 / 丢弃更改都留浮窗可撤回(按删除前记下的对象 id 重建,一次性、30 分钟有效) |
| 布局 | 同一个注册自适应:底部工作台三栏、侧边栏纵向堆叠、主对话区标签页;靠 `ResizeObserver` 量容器,不猜 |
| 语言 | 21 种词典,跟随 DSH 语言设置实时切换,缺键回退英文 |

四个可挂载面(底座 Tab / 底部工作台 / DSH 原生右侧栏 / 主对话区标签页)、完整的动作条配置、撤销栈等细节见**[上游原文](README.upstream.md)**。

### 五、随基线 0.15.0 一并带来的能力

本件已 rebase 到 **0.15.0**,上游在这两个基线之间新增的功能**全部继承**,且每一项都已套用 WSL 执行层:

| 能力 | 说明 |
|---|---|
| 两阶段变更 | `stats` / `statsDeferred`:先出变更行,`+/-` 数字随后单独取;树里变更上千项时不再一次算完 |
| 并发读链 | `summary` 的独立查询并发执行(分支链因依赖仍顺序),只剩两条链的等待时间 |
| 未跟踪文件预览 | 未跟踪文件也能看 diff —— 走 `git diff --no-index /dev/null <文件>` 生成真实的「新文件」补丁 |
| Clone | 面板内从 URL 克隆到指定目录(父目录必须存在,git 自己保证目标非空则不覆盖) |
| Git 输出视图 | 最近 200 次 git 调用的环形缓冲(VS Code 的 `scm showOutput` 等价物),**每条都标明执行世界**:`[Ubuntu-24.04] status --porcelain` |
| 沉浸式对话席位 | 主对话区的沉浸布局开关 |

---

## 相对 baseline 的改动

### 新增文件

| 文件 | 作用 |
|---|---|
| `src/target.js` | 纯函数:UNC 解析、**双向**路径映射、注册表查找、执行世界解析 |
| `src/wsl-git.js` | 纯函数:`wsl.exe` argv、spawn 规格、失败分类 |
| `tests/target.test.mjs` | 38 条纯函数断言(含历史 bug 的正/反回归,以及逆映射与 git 自身输出一致的基准) |
| `scripts/acceptance.mjs` | 真实传输 + 映射闭环 + **参数方向** + HTTP 面验收,只读 |

### 修改的文件

**`src/index.js`**

| 改动 | 说明 |
|---|---|
| `runGit` → `runGitTarget` | 唯一的 spawn 出口按 `cwd` 解析执行世界;约 40 个调用点因此一行未改 |
| 新增 `hostPathOf()` | git **输出**的绝对路径映射回宿主拼写,**5 处**:`repoRootOf`、`worktreesOf`、`operationOf`、`collectSubmoduleRepos`、`scanRepos` |
| 新增 `linuxSpellingOf()` | **参数**方向的逆映射,用于上游 0.15.0 新增的 2 处:`clone` 的目标目录、`diff --no-index` 的文件。`diff` 那一处**参数与头部改写必须用同一个拼写**(否则预览头部会残留绝对路径) |
| `requireAbsolute` | 拒绝 Linux 绝对路径(基线会静默变成 `C:\home\…`) |
| `undoApply` | 写回后逐个文件读回比对哈希;不符即抛且**保留 undo 条目**以便重试 |
| `version` | 增加 `world` / `target` 字段(超集,面板未调用) |
| `gitLogs` | 环形缓冲的每条记录标明执行世界 |
| Config | 新增 `distro` / `user` / `gitPath`,默认空;`apply(ctx, config)` 发布设置 |

**`src/client.js`**

| 改动 | 说明 |
|---|---|
| `baseName` / `dirName` | 先归一化 `\`→`/` 再切分:基线对 UNC 路径会把整条路径当名字返回 |
| 新增 `distroOf` / `displayPath` / `workspaceLocation` | 仓库选择器显示发行版 + Linux 路径,悬停看原始宿主路径 |

**`package.json` / `dsh.plugin.json` / `cordis.patch.yml`**

包名、版本、描述;cordis 行 id `ide-git` → `wsl-git`(设置按行 id 持久化,共用会读写同一份文档);`files` 收录整个 `src/` —— 基线只列了 `src/index.js` 与 `src/client.js`,新增模块在打包式安装下会丢。

**标识符改名**(两半共 41 处):插件 id、路由前缀 `/dsh-wsl-git/api`、Tab id、locale 命名空间、localStorage 前缀、全部 effect 标签与日志前缀。

### 明确未改动

面板 UI 与布局算法、21 种 i18n 词典、CSS、提交图谱算法、右键菜单与"发送到对话"链路、AI 提交信息链路、以及全部安全语义(确认守卫、仓库串行锁、撤回栈、受保护分支)——**逐字保留**。上游两个 README 原文保留为 `README.upstream.md` / `README.upstream.en.md`。

### 关键设计决定

1. **`-d` 从不省略。** 本机默认发行版与工作区所属发行版可能不同,交给 `wsl.exe` 选会跑错 git、读错文件系统。
2. **`git -C <dir>`,不用 `wsl.exe --cd`。** `-C` 只要求 git,不要求 wsl.exe 的版本;而且整条命令是 **argv 数组、无 shell**,提交信息里的引号、换行、`$` 原样穿过边界。
3. **git 环境用 `-e env KEY=VALUE` 注入**,不动 `WSLENV` —— 不修改你和其它插件共享的变量。
4. **`cwd` 绝不用 UNC。** 用 UNC 工作目录启动 Windows 子进程是 Node/Windows 的已知缺陷;`git -C` 已经决定了 Linux 侧,Windows 侧只需一个真实存在的目录。
5. **`WSL_UTF8=1` 是必需的**,否则 `wsl.exe` 用 UTF-16 输出,下游所有模式匹配都会失配。
6. **`/mnt/*` 走盘符,ext4 走 UNC。** 9P 共享只服务 ext4,drvfs 经 UNC 读取会 `EPERM`(本机实测)。
7. **只映射 git 输出里"定义为绝对路径"的字段**,不整段重写 stdout —— diff 正文里合法出现的绝对路径不能被改。

完整设计与实测数据见 **[FORK.md](FORK.md)**。

---

## 安装

```sh
# 从 npm
dsh plugin --profile desktop add dsh-wsl-git

# 从 git 仓库
dsh plugin --profile desktop add github:SteafShi/dsh-wsl-git

# 从本地目录开发(link,改动即时生效)
dsh plugin --profile desktop add "link:/path/to/dsh-wsl-git"
```

可选底座 `dsh-better-sidebar`(装了才有底部工作台;没装也能挂 DSH 原生右侧栏)。装完**重启宿主**。

> ⚠️ **宿主半不会热重载。** 新增 bundle 会被立即识别,但**修改已挂载的宿主模块不会重新导入**——本机实测:改了 `src/index.js` 后同一路由仍返回旧代码。请用应用内「设置 → 插件 → 立即重启」或把插件关掉再打开。客户端半改动只需刷新页面。

**不要和 `dsh-ide-git` 同时启用**:两者各注册一个 Git 页签,而基线在 WSL 工作区里是坏的。

---

## 验收

```sh
node --test tests/target.test.mjs     # 38 条:纯决策,不需要 WSL
node scripts/acceptance.mjs           # 真实传输 + 映射闭环 + 面板自己的 HTTP 路由
```

`scripts/acceptance.mjs` **只读**,不会改动任何仓库。它会自动发现 DSH 已注册的 WSL 工作区,所以有 WSL 工作区的机器上无需参数;harness 不可达时跳过 HTTP 部分。

本机验收结果(`acceptance.mjs`,全部通过):

```
Ubuntu-24.04  git 2.43.0 · toplevel 映射后宿主可 stat/readdir/readFile · 再解析回同一世界 · git 目录可读(merge/rebase 标记)
Ubuntu-20.04  git 2.25.1 · 同上
HTTP 面       version/repos/summary/branches/log/stashList/undoList 全 200
              未注册发行版 → wsl-distro-missing;Linux 路径 → bad-request
```

---

## 已知限制

- **上游需手动跟进。** 本件已 rebase 到基线 0.15.0;上游此后的改动不会自动合并——[PUBLISHING.md](PUBLISHING.md) 记着 rebase 流程,以及 rebase 时**必须重新确认**的那份「绝对路径点」清单。
- **宿主侧文件访问走 9P**(ext4 仓库):仓库发现与丢弃撤回的快照都读 `\\wsl.localhost\…`。本机实测很便宜(`existsSync` 2–3 ms、`realpathSync` 7–9 ms、22 目录扫 `.git` 44 ms),所以仓库发现**有意**留在宿主;条目多得多的容器工作区值得重新测量。
- **丢弃撤回会校验自己的写入** —— 快照是用户手上唯一一份被丢弃的字节,写不进就抛错并保留撤回条目,而不是假装成功。
- **`/mnt/<盘>` 工作区**需要 dsh-wsl-workspace 先把发行版写进 `<DSH_HOME>/wsl-workspaces.json`;没有该记录时按普通 Windows 工作区处理。
- 面板功能本身的路线图(多选批量、交互式变基、冲突编辑器、blame、worktree 视图)沿用上游,见 [上游原文](README.upstream.md)。

---

## 许可与署名

MIT。`LICENSE` 逐字保留基线原文与版权声明,未作任何改动:

```
MIT License · Copyright (c) 2026 KannaKuron
```

本补丁的署名与出处记在 `NOTICE`,分发的副本必须同时保留 `LICENSE` 与 `NOTICE`。

| | |
|---|---|
| **基线** | [dsh-ide-git](https://github.com/KannaKuron/dsh-ide-git) 0.15.0 — MIT, © 2026 KannaKuron |
| **本 fork** | [dsh-wsl-git](https://github.com/SteafShi/dsh-wsl-git) 0.15.0-wsl — MIT, © 2026 SteafShi |
| **基线↔本件** | [`patch/dsh-wsl-git-0.15.0-wsl.on-dsh-ide-git-0.15.0.patch`](patch/README.md)(该补丁已实测:打到纯净 0.15.0 上得到的 27 个文件与本包逐字节一致) |
| **依赖的兄弟插件** | [dsh-wsl-workspace](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace)(WSL 工作区注册表)、[dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)(可选底座) |

---

## English summary

An IDE-grade Git tool window that runs `git` **inside the WSL distribution the
session workspace belongs to** — released as a patch on
[dsh-ide-git](https://github.com/KannaKuron/dsh-ide-git) 0.15.0 (MIT).

**The panel is unchanged.** What differs is where `git` executes: a WSL workspace
path already names its own distribution (`\\wsl.localhost\Ubuntu-24.04\…`), so
nothing is hard-coded and one install serves every distribution. A workspace that
is not a WSL workspace runs the local `git` exactly as the baseline did.

Failures are named instead of being misread as "not a git repository": an
unregistered distribution (`wsl-distro-missing`), an unhealthy WSL service
(`wsl-launcher`), a distribution without git (`git-missing`), and a Linux path at
the API boundary (`bad-request`, rather than the silent `C:\home\…` resolution).

Two pure modules carry it — `src/target.js` (distribution resolution and
bidirectional path translation) and `src/wsl-git.js` (the `wsl.exe` argv, the
spawn spec, failure classification) — pinned by 35 unit assertions; the live
transport, the path-mapping loop and the panel's own HTTP route are covered by
the read-only `scripts/acceptance.mjs`. Design rationale and measurements:
[FORK.md](FORK.md). Baseline documentation is kept verbatim as
[README.upstream.md](README.upstream.md) and
[README.upstream.en.md](README.upstream.en.md).
