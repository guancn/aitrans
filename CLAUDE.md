# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

"极简划词翻译" — Chrome 划词翻译扩展（Manifest V3），纯原生 JS/HTML/CSS，无框架、无构建工具。调用 DeepSeek API（`api.deepseek.com`，OpenAI 兼容端点 `/v1/chat/completions`，模型 `deepseek-v4-flash`，284B 总参/13B 激活）或 Google 翻译（`translate.googleapis.com`，免费，无需 API Key）进行翻译。用户在 popup 中选择翻译服务。

## 加载与调试

1. 打开 `chrome://extensions/`，开启"开发者模式"
2. 点击"加载已解压的扩展程序"，选择本目录
3. 修改代码后：点击扩展卡片上的刷新按钮重载 Service Worker，然后刷新测试页面使新的 content script 生效
4. 查看 content script 日志：打开目标网页的 DevTools console；查看 Service Worker 日志：点击扩展卡片上的 "service worker" 链接

## 架构

```
用户划选文本 → content.js 捕获 mouseup 事件
  → 根据 triggerMode 显示悬浮图标或直接弹出翻译窗
  → 通过 chrome.runtime.sendMessage({action: 'translate', text}) 发送到 background.js
  → background.js 根据 translationService 配置路由：
    - deepseek: 调用 chat completions API（含重试：maxRetries=2，401/403 不重试，429 指数退避 1s/2s）
    - google: 调用 Google 翻译 API（translate.googleapis.com，免费，无需 API Key）
  → 结果回传 content.js，渲染翻译结果
```

**消息协议：** content script 发送 `{action: 'translate', text}`，background 通过 `sendResponse` 返回 `{success, translatedText, sourceLang, error}`。

**DeepSeek 翻译流程：** background.js 构造 system prompt 要求模型输出 JSON（`source_lang` + `translated_text`），解析后转为兼容的消息格式返回。如果 JSON 解析失败，回退到直接使用模型原始输出。

**Google 翻译流程：** background.js 使用 `translate.googleapis.com/translate_a/single` 端点，`dj=1` 参数获得结构化 JSON（`sentences[].trans` + `src`），POST 传参避免 GET URL 长度限制。无需 API Key，无重试机制。

**配置流：** popup.js 将 `targetLang`、`triggerMode`、`translationService`、`apiKey`、`systemPrompt` 写入 `chrome.storage.sync`；background.js 缓存全部五项，content.js 缓存 `triggerMode`（均监听 `onChanged` 保持同步）。选择 Google 翻译时，popup 自动隐藏 API Key 和提示词设置区域。

**两种触发模式：**
- `icon`（默认）：划词后显示蓝色圆形图标，鼠标悬停 150ms 后才发起翻译请求
- `direct`：划词后直接弹出翻译窗，立即请求

**扩展上下文失效处理：** content.js 中 `isExtensionAlive()` / `markInvalidated()` 检测插件更新/重载导致的上下文失效，自动清理 UI 并解除事件监听。

**翻译超时保护：** content.js 在 `sendMessage` 时设置 15 秒超时定时器。超时后若弹窗仍存在则显示「翻译超时，请重试」；消息回调返回时自动清除定时器。同时将所有 `lastError`（含非上下文失效错误如 "Could not establish connection"）都通过弹窗提示用户，不再静默卡死在 loading 状态。

## 关键约束

- **禁止引入任何框架或库**（React、Vue、jQuery 等），保持纯原生 JS
- **content.css 所有类名必须以 `translate-ext-` 为前缀**，ID 以 `chrome-ext-translate-` 开头，防止污染宿主页面
- 注入的 UI 元素 z-index 设为 `2147483647`（最大值），确保在最上层
- 弹出层和图标使用 `position: absolute` + scroll 偏移计算定位
- 支持 `prefers-color-scheme: dark` 暗色模式
- 异步操作统一使用 async/await，不使用同步 XMLHttpRequest
- 代码变量/函数使用英文命名，文档和注释使用简体中文
