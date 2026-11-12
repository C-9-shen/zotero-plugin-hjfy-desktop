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

| 模块                                                     | 职责                                            |
| -------------------------------------------------------- | ----------------------------------------------- |
| `src/modules/arxivTranslation.ts`                        | 菜单入口、已有译文检查、后端选择及附件导入      |
| `src/modules/desktopRuntime.ts`、`desktopTranslation.ts` | 桌面引擎发现、配置和凭据读取、任务通信          |
| `src/modules/lightweightTranslation.ts`                  | 精简后端的原生 HTTP、文件、密码管理器及编译适配 |
| `src/modules/latex/source.ts`                            | 保守 TeX 扫描、标记保护、译文校验与恢复         |
| `src/modules/latex/pipeline.ts`                          | 正文遍历、双并发翻译、重试、分段恢复及缓存      |
| `src/modules/latex/api.ts`、`portableTex.ts`             | 模型协议和固定版本便携编译器                    |
| `src/modules/translationProgressNote.ts`                 | 文献下的进度和日志子笔记                        |
| `src/modules/translationReader.ts`、`readerSync.ts`      | 单标签页分屏、主从阅读和相对页面同步            |

精简后端的纯逻辑模块不依赖 Zotero；归档解包、进度映射和 arXiv 解析位于 `src/utils/`。插件不包含桌面引擎、编译器或 TeX 资源，运行时不调用脚本解释器。

缓存按服务地址、协议、模型、源文本和保护内容计算摘要。只有通过标记、语法和中文检查的结果才会写入缓存；保护标记两次失败后，分段翻译文字，由插件恢复原始结构。变更扫描器或缓存校验时，应验证已有有效缓存仍可复用。标记结构正确不能证明学术译文准确。

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

普通推送及 PR 执行 `.github/workflows/ci.yml`：使用 Node 22、`npm ci`、格式检查、21 项 Node 测试、源码及测试类型检查、生产构建，并上传 XPI 和更新清单作为 Actions 产物。CI 不启动 Zotero，也不调用模型 API。

正式发布使用 `.github/workflows/release.yml`。准备步骤如下：

1. 确认 `package.json` 的版本，使用 npm 同步更新 `package-lock.json`，并完成本地检查及必要的 Zotero 回归。
2. 提交源码和文档；不提交 `.env`、API 凭据、测试资料库、下载的引擎、论文及构建产物。
3. 准备与版本一致的 `v版本号` Git 标签，之后推送分支及该标签。
4. 标签工作流核对版本并重新检查、构建，随后由脚手架创建 GitHub Release、上传 XPI，并维护 `release` 标签下的更新清单。

Release 仅需要仓库提供的 `GITHUB_TOKEN` 及 `contents: write` 权限，不需要在源码中保存个人令牌。普通分支推送只运行 CI，不会发布安装包。`npm run release` 在本地可能修改版本、提交、打标签并推送，不能当作普通验证命令运行。

当前 `package.json` 中的仓库、主页和问题反馈地址指向 `C-9-shen/zotero-plugin-hjfy-desktop`，作者为 `9_shen`。Fork 后发布时应同步这些字段，避免更新清单指向其他仓库。

返回[项目首页](../README.md)，配置与操作见[使用说明](usage.md)。
