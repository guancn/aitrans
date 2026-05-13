# 极简划词翻译 · aitrans

[![Manifest Version](https://img.shields.io/badge/Manifest-V3-blue)](https://developer.chrome.com/docs/extensions/mv3/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

高颜值、不打扰的 Chrome 划词翻译扩展。纯原生 JS/HTML/CSS，零依赖，即装即用。

支持 **划词翻译**（图标悬停/直接弹窗）和 **全页翻译** 两种模式，DeepSeek V4 Flash AI 翻译 + Google 免费双引擎。全页翻译自动遍历页面文字并批量翻译，进度条实时反馈。

<p align="center">
  <img src="icons/icon128.png" width="128" alt="aitrans icon">
</p>

## 特性

- 🎯 **划词即译** — 选中文本自动弹出翻译，无需额外操作
- 📄 **全页翻译** — 一键翻译整个网页，TreeWalker + 并发批量调度
- 🤖 **双引擎** — DeepSeek V4 Flash（AI 意译）+ Google 翻译（免费），两种模式独立配置
- 🌙 **暗色模式** — 自动适配系统 `prefers-color-scheme`
- ⚡ **极致轻量** — 完整扩展仅 ~60KB，每页注入约 20KB
- 🔒 **零隐私泄漏** — 翻译请求直连 API，无中间服务器
- 🎨 **美观不打扰** — 毛玻璃弹窗 + 流畅动画，融入页面不突兀
- 🌍 **8 种目标语言** — 简中/英/日/韩/法/德/西/俄

## 安装

### Chrome Web Store（推荐）

> 即将上架

### 开发者模式加载

1. 下载 [最新 release](https://github.com/guancn/aitrans/releases) 中的 `aitrans-chrome-vX.X.X.zip` 并解压
2. 打开 `chrome://extensions/`，开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择解压后的目录
4. 完成！

## 配置

点击扩展图标，通过顶部分段控件切换「划词翻译」和「全页翻译」两种模式，各自独立配置：

**划词翻译模式：**

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| 翻译为 | 目标语言 | 简体中文 |
| 划词后行为 | `图标`（悬停翻译）/ `直接`（立即翻译） | 图标 |
| 翻译服务 | `DeepSeek`（需 API Key）/ `Google`（免费） | DeepSeek |
| API Key | DeepSeek API Key（选 Google 时隐藏） | — |
| 翻译提示词 | 自定义 system prompt | 宝玉翻译理念 |

**全页翻译模式：**

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| 翻译为 | 目标语言 | 简体中文 |
| 翻译服务 | `DeepSeek` / `Google` | Google（免费） |
| API Key | DeepSeek API Key（选 Google 时隐藏） | — |
| 翻译提示词 | 自定义 system prompt | 宝玉翻译理念 |
| 翻译当前网页 | 点击按钮立即翻译当前页面全部文字 | — |

### 获取 DeepSeek API Key

1. 注册 [DeepSeek 开放平台](https://platform.deepseek.com/)
2. 在「API Keys」页面创建新 Key
3. 复制粘贴到扩展设置中

## 架构

```
划词翻译模式：
  用户划选文本
    → content.js 捕获 mouseup，根据 triggerMode 显示图标或弹窗
    → chrome.runtime.sendMessage() 发给 background.js
    → background.js 根据 translationService 路由 DeepSeek / Google
    → 回传译文，content.js 渲染弹窗

全页翻译模式：
  用户点击「翻译当前网页」
    → content.js TreeWalker 遍历页面文本节点
    → 并发批量调度（每次 3 批），逐批发送 translateBatch
    → background.js 工作池并发调用翻译 API
    → node.nodeValue 原位替换（不破坏 React/Vue 虚拟 DOM）
    → 进度条实时反馈
```

三组件，零构建，原生 JS：

```
aitrans/
├── manifest.json     # Chrome 扩展清单
├── background.js     # Service Worker（API 调用、批量翻译工作池）
├── content.js        # 内容脚本（划词检测、全页翻译、弹窗渲染）
├── content.css       # 注入样式（命名空间隔离 + 进度条）
├── popup.html        # 设置弹窗（分段控件双模式）
├── popup.js          # 设置逻辑（独立配置存储）
├── popup.css         # 设置样式（含暗色模式）
└── icons/            # 扩展图标
```

## 隐私

- **无数据收集** — 不接入任何分析、遥测、广告 SDK
- **直连 API** — 翻译文本仅发送至 DeepSeek 或 Google API，不经第三方服务器
- **本地存储** — API Key 和设置仅存于 Chrome 本地，通过 `chrome.storage.sync` 跨设备同步
- **最小权限** — 仅请求 `storage` 和两个 API 域名权限

## 技术栈

- 纯原生 JavaScript（ES2020+）、HTML5、CSS3
- Chrome Extension Manifest V3
- Service Worker（事件驱动，空闲即终止）
- DeepSeek Chat Completions API（OpenAI 兼容）
- Google Translate API（非官方端点）

## 兼容性

| 浏览器 | 支持 |
|--------|------|
| Chrome ≥ 88 | ✅ |
| Edge ≥ 88 | ✅ |
| 其他 Chromium | ✅ |
| Safari | 可转换（见 `.claude/settings.local.json`） |
| Firefox | 待适配（Manifest V2 polyfill） |

## License

MIT © [guancn](https://github.com/guancn)
