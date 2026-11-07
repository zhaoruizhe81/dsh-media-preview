# dsh-media-preview

在 dsh 的右侧栏「文档预览」中内联播放**视频**和**音频**文件。这是官方
`@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 的扩展：通过它公开的
`ctx.documentPreviews.register()` 注册两个渲染器实现，因此视频/音频会像
Markdown、图片、PDF 一样在同一个预览面板里打开，而不是落到「无法预览」的
空状态。

## 支持的格式

| 类型 | 扩展名 | MIME |
| --- | --- | --- |
| 视频 | `mp4` `m4v` `webm` `ogv` `mov` | video/mp4, video/webm, video/ogg, video/quicktime |
| 音频 | `mp3` `wav` `ogg` `oga` `m4a` `aac` `flac` `opus` `weba` | audio/* |

能否真正解码取决于浏览器内置解码器：Chromium 原生支持 H.264/AAC 的 mp4、
VP8/VP9/Opus 的 webm、Vorbis/Opus 的 ogg、mp3、wav、flac 等；HEVC、AV1
（无硬解时）、部分 `.mov`/`.mkv` 可能无法播放，此时会提示「浏览器无法播放该
文件的音视频编码，建议用系统应用打开」。

## 为什么不是简单的 `bytes-complete`

文档预览的 `bytes-complete` 模式会通过 `workspaceFiles.readBytes` 一次性读入
整个文件，受 Host 的 `maxFileBytes`（默认 **32 MB**）限制；超过就直接报
「单页内容超过 32 MB 上限，无法读取」。视频/音频动辄几十上百 MB，必然踩中。

本插件改用 `loading: "renderer"` 模式，由渲染器自己负责读取：借助
`workspaceFiles.readBytes` 的 **字节区间**能力，按 1 MiB 窗口分段读取
（每个窗口都远低于 Host 的 `maxBytes` 上限），拼接成 `Blob` 后交给原生
`<video>` / `<audio>` 播放。因此可以打开远超 32 MB 的文件。

## 限制

- 单文件内联预览上限 **512 MB**（客户端内存保护），超过时提示改用系统应用打开。
- 采用「先读入 Blob 再播放」的方式，播放前需要完成整个文件的区间读取；
  本地文件很快，但超大文件首次打开会有等待，且会占用等量内存。
- 不改变 Host 的 `maxFileBytes`（默认 32 MB，用于 `stat`/其它一次性读取）。

## 文件说明

- `client.js` — 浏览器端：注册 `video` / `audio` 两个 `documentPreviews` 实现及其
  `sidebar.right.tab.document` 槽位主体，分段读取并播放。
- `index.js` — Host 端为空实现（无需 Host 逻辑）。
- `cordis.patch.yml` — 插入插件行。
- `locale/en.json`、`locale/zh.json` — 插件管理页显示的标题/描述。
- `icon.svg` — 插件图标。
- `test-media/` — 用于本地验证的 3 秒测试视频/音频（可删除）。

## 安装

已通过 `plugin_manager install_bundle` 以当前工作目录链接方式安装到 desktop profile。
客户端改动会经 `dsh-client-hmr` 自动热更新；若界面未刷新，按 `Cmd+R` 重新加载页面。

## License

[MIT](./LICENSE)
