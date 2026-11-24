# 幻觉翻译 arXiv · Zotero 插件

在 Zotero 中将 arXiv 论文翻译为中文 PDF，自动添加为文献附件，并在同一标签页分屏阅读原文与译文。

默认使用本机**幻觉翻译桌面端**，也可选择实验性的**精简实现＋便携 TeX**，自行接入模型 API。两种方式均处理 arXiv LaTeX 源码，插件通过 Zotero 原生接口运行，无需额外安装 PowerShell、Node.js 或 Python。

## 功能

- 识别 arXiv ID 和指定版本，支持批量排队，最多同时翻译两篇，可在任务列表查看进度。
- 在文献的子笔记中实时显示日志；成功后自动删除日志和临时诊断文件，失败时保留。
- 精简模式保留含行内格式和脚注的完整段落，通过段落 ID 合并批量翻译；公式与命令受保护，有效段落即时缓存，仅重试未通过的段落，不强制检查中文字符。
- 已有同版本译文时直接打开，不重复翻译或创建日志。
- 原文在左、译文在右，默认以译文为主，支持跟随翻页、滚动和缩放。

## 安装与使用

面向 Windows x64，声明兼容 Zotero 7–10，运行验证使用 Zotero 10.0.8。目前需要论文有可用的 LaTeX 源码，不支持直接翻译任意 PDF 附件。

1. 从 [Releases](https://github.com/C-9-shen/zotero-plugin-hjfy-desktop/releases) 下载 `.xpi`，在 Zotero 的“工具 → 插件”中从文件安装。尚无发行包时可自行构建。
2. 进入“设置 → 幻觉翻译”，选择并配置翻译方式。桌面端模式需要已启用的模型及本机 TeX；精简模式需要 API 配置，优先使用本机 TeX，否则首次下载便携 TeX 资源；遇到缺包或旧内核时自动下载兼容环境及宏包。
3. 选中文献条目，右键选择“幻觉翻译 arXiv: 翻译当前文章”。

模型 API 可能收费。精简模式保留公式、代码及表格等结构，但复杂模板可能无法处理。

- [使用说明](docs/usage.md)：环境、两种后端配置、分屏阅读、缓存及常见问题。
- [开发说明](docs/development.md)：目录结构、构建、测试和 GitHub 发布。

## 从源码构建

需要 Node.js 22.8+ 和 npm：

```sh
npm ci
npm run test:unit
npm run typecheck
npm run lint:check
npm run build
```

XPI 和更新清单输出到 `build/`，安装包命名为 `zotero-hjfy-desktop-<版本号>.xpi`。本地配置、凭据、测试资料库及构建产物均不提交到源码仓库。

## 致谢与许可

作者：**9_shen**。本项目基于 [zotero-plugin-hjfy](https://github.com/ANGJustinl/zotero-plugin-hjfy)，沿用 [AGPL-3.0-or-later](LICENSE)。

- 分屏参考 [zotero-hjfy-split-reader](https://github.com/Infinity4B/zotero-hjfy-split-reader)。
- 精简框架参考 [TeXlate](https://github.com/WncFht/texlate) 的段落翻译与保护标记思路，以 TypeScript 独立实现。TeXlate 是独立开源复现，并非幻觉翻译官方引擎源码。
- 便携编译使用 [Tectonic](https://github.com/tectonic-typesetting/tectonic) 官方发行物，首次使用时下载。
- 缺包自动恢复使用 [TinyTeX](https://github.com/rstudio/tinytex-releases) 官方发行物与 TeX Live 包管理器，独立安装在插件缓存目录；首次下载校验 SHA-256。
- 开发基础包括 [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template)、[Zotero Plugin Toolkit](https://github.com/windingwind/zotero-plugin-toolkit) 和 [Zotero Plugin Scaffold](https://github.com/zotero-plugin-dev/zotero-plugin-scaffold)。

本插件不是幻觉翻译官方桌面客户端。桌面引擎、编译器和字体不随 XPI 分发，其许可由各自发行方提供。
