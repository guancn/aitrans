# 极简划词翻译 · aitrans

[![Manifest Version](https://img.shields.io/badge/Manifest-V3-blue)](https://developer.chrome.com/docs/extensions/mv3/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

高颜值、不打扰的 Chrome 划词翻译扩展。纯原生 JS/HTML/CSS，零依赖，即装即用。

支持 **划词翻译**（图标悬停/直接弹窗）和 **全页翻译** 两种模式，内置 DeepSeek Flash，可自行添加 OpenAI 兼容 / Anthropic 原生模型，另有免费 Google 翻译。全页翻译自动遍历页面文字并批量翻译，进度条实时反馈。

<p align="center">
  <img src="icons/icon128.png" width="128" alt="aitrans icon">
</p>

## 特性

- 🎯 **划词即译** — 选中文本自动弹出翻译，无需额外操作
- 📄 **全页翻译** — 一键翻译整个网页，视口内容优先翻译，每批译完立即显示
- 🤖 **自定义模型** — 内置 DeepSeek Flash，可添加任意 OpenAI 兼容或 Anthropic 原生模型（Base URL / 模型名 / Key / 思考深度 / 高级参数），另有免费 Google 翻译；两种模式各选各的
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
| 翻译服务 | `Google`（免费）或模型管理中添加的任一模型 | DeepSeek Flash |
| 翻译提示词 | 自定义 system prompt | 宝玉翻译理念 |

**全页翻译模式：**

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| 翻译为 | 目标语言 | 简体中文 |
| 翻译服务 | `Google` 或任一模型 | Google（免费） |
| 翻译提示词 | 自定义 system prompt | 宝玉翻译理念 |
| 翻译当前网页 | 点击按钮立即翻译当前页面全部文字 | — |

### 管理模型与 API Key

在设置弹窗点「管理模型」打开模型管理页；保存模型时 Chrome 会请求访问该 API 域名的权限。

1. 内置「DeepSeek Flash」：到 [DeepSeek 开放平台](https://platform.deepseek.com/) 创建 Key，填入该条目
2. 其他模型：点新增，选择协议（OpenAI 兼容 / Anthropic），填写 Base URL、模型名、Key，可选思考深度与高级参数（JSON，深度合并进请求体）
3. 点「测试连接」确认可用

## 架构

```
划词翻译模式：
  用户划选文本
    → content.js 捕获 mouseup，根据 triggerMode 显示图标或弹窗
    → chrome.runtime.connect() 长连接发给 background.js
    → background.js 根据 translationService 路由 Google / 模型列表（providers.js 适配协议）
    → 模型流式回传，译文边生成边显示；Google 一次性回传

全页翻译模式：
  用户点击「翻译当前网页」
    → content.js TreeWalker 遍历页面文本节点
    → 按离视口距离排序，视口内文本先翻
    → 3 路滑动并发，逐批发送 translateBatch，每批返回即回填
    → background.js 工作池并发调用翻译 API
    → node.nodeValue 原位替换（不破坏 React/Vue 虚拟 DOM）
    → 进度条实时反馈
```

三组件，零构建，原生 JS：

```
aitrans/
├── manifest.json     # Chrome 扩展清单
├── background.js     # Service Worker（模型路由、批量翻译工作池）
├── providers.js      # 协议适配（OpenAI 兼容 / Anthropic 请求与流式解析）
├── content.js        # 内容脚本（划词检测、全页翻译、弹窗渲染）
├── content.css       # 注入样式（命名空间隔离 + 进度条）
├── popup.html        # 设置弹窗（分段控件双模式）
├── popup.js          # 设置逻辑（独立配置存储）
├── popup.css         # 设置样式（含暗色模式）
├── options.html/js/css # 模型管理页
└── icons/            # 扩展图标
```

## 隐私

- **无数据收集** — 不接入任何分析、遥测、广告 SDK
- **直连 API** — 翻译文本仅发送至你配置的模型 API 或 Google API，不经第三方服务器
- **本地存储** — API Key 和设置仅存于 Chrome 本地，通过 `chrome.storage.sync` 跨设备同步
- **最小权限** — 仅请求 `storage`、DeepSeek 与 Google 域名权限；自定义模型域名在保存时按需单独授权

## 技术栈

- 纯原生 JavaScript（ES2020+）、HTML5、CSS3
- Chrome Extension Manifest V3
- Service Worker（事件驱动，空闲即终止）
- OpenAI 兼容 Chat Completions 与 Anthropic Messages API（含 SSE 流式）
- Google Translate API（非官方端点）

## 兼容性

| 浏览器 | 支持 |
|--------|------|
| Chrome ≥ 88 | ✅ |
| Edge ≥ 88 | ✅ |
| 其他 Chromium | ✅ |
| Safari | 可转换（`xcrun safari-web-extension-converter`） |
| Firefox | 待适配（Manifest V2 polyfill） |

## License

MIT © [guancn](https://github.com/guancn)
