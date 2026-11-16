# 开发、测试与发布

## 环境

使用 Node.js 22.8+ 和 npm。`.nvmrc` 固定开发及 CI 使用 Node 22，`package-lock.json` 固定依赖树。源码不依赖本机的绝对路径。

```sh
npm ci
npm run test:unit
npm run typecheck
npm run lint:check
npm run build
```

`npm run build` 输出 `.scaffold/build/*.xpi`、`update.json` 和 `update-beta.json`。这些是生成文件，不提交到 Git。`build/` 可存放本地待安装包，`output/` 可存放本地翻译结果；两者均已忽略。

## 目录约定

| 路径                   | 说明                                       |
| ---------------------- | ------------------------------------------ |
| `addon/`               | 随 XPI 打包的入口、设置页、本地化与图标    |
| `src/`                 | 插件 TypeScript 源码                       |
| `test/*.test.ts`       | 需要真实 Zotero 的集成测试                 |
| `test/unit/*.test.mjs` | Node 环境下的逻辑回归测试                  |
| `test/fixtures/`       | 测试专用模拟服务，不打包进 XPI             |
| `docs/`                | 使用说明和开发说明                         |
| `.scaffold/`           | 脚手架生成的构建、测试资料库和缓存，不提交 |

## 主要模块

| 模块                                                        | 职责                                            |
| ----------------------------------------------------------- | ----------------------------------------------- |
| `src/modules/arxivTranslation.ts`                           | 菜单入口、已有译文检查、后端选择及附件导入      |
| `src/modules/translationTasks.ts`、`src/utils/taskQueue.ts` | 两任务并发、FIFO 排队、条目去重及任务列表窗口   |
| `src/modules/desktopRuntime.ts`、`desktopTranslation.ts`    | 桌面引擎发现、配置和凭据读取、任务通信          |
| `src/modules/lightweightTranslation.ts`                     | 精简后端的原生 HTTP、文件、密码管理器及编译适配 |
| `src/modules/latex/source.ts`                               | 段落与块边界扫描、行内语法保护、译文校验与恢复  |
| `src/modules/latex/pipeline.ts`                             | 正文遍历、段落合并、双并发批量翻译、重试及缓存  |
| `src/modules/latex/api.ts`、`portableTex.ts`                | 模型协议和固定版本便携编译器                    |
| `src/modules/translationProgressNote.ts`                    | 进度子笔记，成功删除、失败保留                  |
| `src/modules/translationReader.ts`、`readerSync.ts`         | 单标签页分屏、主从阅读和相对页面同步            |

精简后端的纯逻辑模块不依赖 Zotero；归档解包、进度映射和 arXiv 解析位于 `src/utils/`。插件不包含桌面引擎、编译器或 TeX 资源，运行时不调用脚本解释器。

全局最多同时处理两篇论文，同条目运行中或排队时复用任务；队列仅保存在内存中。已有译文绕过队列直接打开分屏，并在排队任务开始时再次检查附件。便携 TeX 首次准备和桌面引擎复制共享初始化过程；精简模式每篇正文保持双并发请求，共享 TeX 缓存的编译阶段串行执行。任务列表关闭后继续执行，插件关闭后等待中的任务不会启动。

附件导入成功后先删除后端记录的临时任务目录，再等待进度笔记写入结束并删除笔记；错误路径保留诊断目录及失败笔记。翻译缓存和运行环境位于任务目录之外，不随成功任务删除。成功任务在列表中只保留状态，不保留逐条日志。

缓存按服务地址、协议、模型、源文本和保护内容计算摘要。先逐段读取旧缓存，再按源码文件合并未缓存段落；每批最多 32 段、约 12000 字符及 48 个语法标记。单段保持完整，最多 16000 字符，可单独超过批次标记预算。

0.3.7 起区分块级文本与行内文本命令：标题、章节和图注独立提取；加粗、强调、脚注等参数递归扫描，命令、选项及花括号分别保护，参数中的文字留在所属段落。列表项、环境、独立公式及文件引用形成边界；行内参数中的空行保留为语法标记，避免递归扫描切断外层段落。未知宏及其参数仍整体保护，不猜测参数用途。批量 JSON 协议和缓存摘要格式保持不变；提取文本或保护内容变化的段落重新翻译，其余旧缓存继续复用。

批量请求和返回使用 `{"segments":[{"id":1,"text":"..."}]}`，ID 是文件内的原始段落序号，语法标记在每段从零编号，无额外边界标记。响应数组可重新排序；未知、重复或非数字段落 ID 拒绝整次响应。0.3.8 起保护标记按桌面端实测规则校验：每个原始标记至少出现一次，不得出现未知标记，按编号替换每次出现的内容；允许换序和重复，不比较出现顺序或次数。段落 ID 仍必须唯一，这与段内保护标记的规则不同。

有效 JSON 中逐段检查非空文本、标记覆盖与未知标记及新增 TeX 语法，合格结果立即写入原有逐段缓存，仅将缺失或无效段落合并重试一次；仍失败则终止，不拆成短句请求，也不静默回退原文。完整标记中的转义方括号、全角方括号、空格及单层反引号可规范化，不推测缺失标记、不重排模型输出。提示词要求保留格式与花括号范围；标记集合校验不证明嵌套格式、引用位置或学术译文准确。旧缓存继续使用同一摘要格式，并按新规则读取。

校验失败时将该次请求文本、模型返回及逐段预期/实际标记、缺失/重复/未知标记写入任务目录 `diagnostics/batch-N-attempt-N.json`；不保存 API 配置、密钥或 HTTP 请求头。诊断写入失败不会覆盖原错误。整个任务成功后随临时任务目录清理，任务失败则保留。HTTP 或协议层失败只保留已有的简要错误，不把原始 HTTP 响应写入日志笔记。

0.3.5 起不再要求结果含中文，已删除名称例外规则。恢复保护标记时，裸控制词后直接跟字母（含中文）会补入分隔空格；该修复同样适用于旧缓存。扫描器整体保护 `looseness` 等已知整数排版参数及其数值；这只改变受影响段落的缓存键，避免复用曾丢失排版参数值的译文。

## 桌面端实现参考

精简后端参考桌面端 1.0.6.0 的本机模拟 API 验证结果，独立实现段落提取和保护标记恢复，不包含反编译代码、桌面引擎或分析工具。桌面端的 C# 层主要负责配置、队列和命令行适配，LaTeX 翻译由原生 Office 引擎处理。

正文尽量按完整段落提取，保留加粗、强调和脚注中的上下文，标题、图注和列表项分别处理。保护标记按名称覆盖校验，允许换序和重复；缺失或未知标记判为无效。桌面引擎在无效结果上可能回退原文，插件桌面适配层会拒绝存在原文回退的结果。

精简后端继续使用带段落 ID 的 JSON 批量协议、逐段缓存和局部重试，未知自定义宏及其参数仍整体保护。单元测试覆盖段落边界、标记换序与重复、缺失与未知编号、缓存复用及无效段落重试；模拟响应验证不代表真实译文质量或模板编译兼容性。

## 本地开发与 Zotero 集成测试

复制 `.env.example` 为 `.env`，填写本机 Zotero 程序路径和独立的开发资料库路径。不要使用日常资料库。示例配置覆盖脚手架的全局退出命令，避免结束其他 Zotero 会话；开发实例需在必要时自行关闭。

```sh
npm start
```

运行集成测试时，使用独立测试 profile 与 data 目录。以下是 Windows PowerShell 中的本地开发示例，PowerShell 仅用于开发命令，插件运行不依赖它：

```powershell
$env:ZOTERO_PLUGIN_ZOTERO_BIN_PATH = 'C:/Program Files/Zotero/zotero.exe'
$env:ZOTERO_PLUGIN_PROFILE_PATH = Join-Path (Get-Location) '.scaffold/test/profile'
$env:ZOTERO_PLUGIN_DATA_DIR = Join-Path (Get-Location) '.scaffold/test/data'
$env:ZOTERO_PLUGIN_KILL_COMMAND = 'echo Isolated test process stopped'
$env:MOZ_NO_REMOTE = '1'
$env:MOZ_HEADLESS = '1'
npm test -- --exit-on-finish
```

桌面运行环境自检需要本机安装兼容的幻觉翻译桌面端。其他可选测试按夹具环境变量启用，未提供时跳过相应测试。

| 环境变量                                | 用途                                                     |
| --------------------------------------- | -------------------------------------------------------- |
| `HJFY_TEST_PDF`                         | 现有 PDF 路径；验证分屏、主从滚动、缩放及已有日志不变    |
| `HJFY_TEST_ARCHIVE` + `HJFY_TEST_CACHE` | 指定论文源码归档与完整译文 CSV；验证桌面端缓存编译及导入 |
| `HJFY_TEST_DOWNLOAD=1`                  | 启用 arXiv 源码真实下载检查                              |
| `HJFY_TEST_TECTONIC_ARCHIVE`            | 固定版本官方 Tectonic ZIP；轻量后端下载校验的本地夹具    |
| `HJFY_TEST_TEX_CACHE`                   | 已准备的 Tectonic 资源缓存目录                           |
| `HJFY_TEST_LITE_BASE_URL`               | 本机模拟 API 地址，例如 `http://127.0.0.1:19086/v1`      |

桌面缓存编译测试复用此前译文，并将模型地址临时改为不可用的本机端口，防止缓存缺失时发起付费请求。它仍需本机已有桌面模型配置与 TeX 环境，不是可在任意机器上执行的纯逻辑测试。

### 轻量后端夹具

先在另一个终端启动：

```sh
node test/fixtures/mock-latex-api.mjs
```

模拟服务只监听本机，返回固定测试中文，不访问远程模型。设置上述三个轻量后端环境变量后运行 Zotero 测试，可验证原生 HTTP、密码管理器、便携 TeX、附件和日志链路。测试服务使用公开的固定测试密钥；不要将真实 API 密钥填入夹具。

便携编译器固定为官方 Tectonic `0.17.0` Windows x64 MSVC ZIP，SHA-256 为 `f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f`。版本、下载地址和校验逻辑集中在 `src/modules/latex/portableTex.ts`；升级时同步更新摘要及测试夹具。编译使用 `--untrusted`，不为论文开启 shell escape。

预先准备资源缓存可以避免回归测试重复下载宏包。测试需同时提供 ZIP、缓存和本机 API 地址。

## GitHub 检查与发布

普通推送及 PR 执行 `.github/workflows/ci.yml`：使用 Node 22、`npm ci`、格式检查、Node 逻辑测试、源码及测试类型检查、生产构建，并上传 XPI 和更新清单作为 Actions 产物。回归覆盖队列并发和去重、失败隔离、已有译文绕过忙碌队列、日志清理、批量请求和缓存复用、命令边界和整数参数保护；Zotero 集成测试另验证实际任务窗口和笔记删除。CI 不启动 Zotero，也不调用模型 API。

正式发布使用 `.github/workflows/release.yml`。准备步骤如下：

1. 确认 `package.json` 的版本，使用 npm 同步更新 `package-lock.json`，并完成本地检查及必要的 Zotero 回归。
2. 提交源码和文档；不提交 `.env`、API 凭据、测试资料库、下载的引擎、论文及构建产物。
3. 准备与版本一致的 `v版本号` Git 标签，之后推送分支及该标签。
4. 标签工作流核对版本并重新检查、构建，随后由脚手架创建 GitHub Release、上传 XPI，并维护 `release` 标签下的更新清单。

Release 仅需要仓库提供的 `GITHUB_TOKEN` 及 `contents: write` 权限，不需要在源码中保存个人令牌。普通分支推送只运行 CI，不会发布安装包。`npm run release` 在本地可能修改版本、提交、打标签并推送，不能当作普通验证命令运行。

当前 `package.json` 中的仓库、主页和问题反馈地址指向 `C-9-shen/zotero-plugin-hjfy-desktop`，作者为 `9_shen`。Fork 后发布时应同步这些字段，避免更新清单指向其他仓库。

返回[项目首页](../README.md)，配置与操作见[使用说明](usage.md)。
