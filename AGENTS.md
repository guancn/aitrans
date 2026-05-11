# AGENTS.md

本文件面向 OpenCode 会话 — 仅包含代理人容易推断错误或遗漏的信息。
详细架构说明见 `CLAUDE.md`。

## 项目概要

"极简划词翻译" — Chrome 划词翻译扩展（Manifest V3）。纯原生 JS/HTML/CSS，零构建工具、零框架、零依赖。

## 加载与调试

```bash
# 没有构建命令。直接加载目录到 Chrome：
1. chrome://extensions/ → 开启"开发者模式"
2. "加载已解压的扩展程序" → 选择本目录
3. 修改 background.js 后 → 点击扩展卡片刷新按钮重载 Service Worker
4. 修改 content.js/css 后 → 刷新测试页面
```

**日志位置：**
- Service Worker (background.js): 点击扩展卡片上的 "service worker" 链接
- Content Script (content.js): 目标网页的 DevTools console

## 架构（三组件）

```
content.js (注入所有页面)
  → chrome.runtime.sendMessage({action: 'translate', text})
    → background.js (Service Worker, 随事件启停)
      → POST https://api.deepseek.com/v1/chat/completions (model: deepseek-v4-flash)
    ← {success, translatedText, sourceLang, error}
  ← 渲染翻译结果
```

popup.html/js 仅负责设置页面，通过 `chrome.storage.sync` 读写配置。

## 配置存储区域

| 键 | 存储区域 | 理由 |
|---|---|---|
| `targetLang` | `sync` | 跨设备同步 |
| `triggerMode` | `sync` | 跨设备同步 |
| `apiKey` | `sync` | 跨设备同步 |
| `systemPrompt` | `sync` | 跨设备同步 |

所有组件（popup、background、content）统一读写 `chrome.storage.sync`，并通过 `onChanged`（sync 区域）保持内存缓存同步。如果你新增配置键，保持一致——全部走 `sync`。

## 关键约束

- **禁止引入任何框架或库**（React、Vue、jQuery、npm 包等）—— 纯原生 JS
- **content.css 所有 class 以 `translate-ext-` 为前缀，ID 以 `chrome-ext-translate-` 开头** —— 防止污染宿主页面 CSS
- **注入 UI 元素的 z-index 必须为 `2147483647`**（最大值）
- **定位必须用 `position: absolute` + scroll 偏移计算** —— 不能用 fixed，因为宿主页面可能有自己的 transform/stacking context
- **支持 `prefers-color-scheme: dark`** —— 所有新样式都要配暗色方案
- **API 调用重试策略**：429 指数退避（1s/2s），401/403 立即熔断不重试
- **content.js 的 debounce**：mouseup 200ms 防抖 + icon 模式额外 150ms hover 延迟
- **代码命名用英文，注释用简体中文**

## 触发模式

- `icon`（默认）：划词后显示蓝色圆形图标，鼠标悬停 150ms 后发起翻译
- `direct`：划词后直接弹出翻译窗，立即请求

## 上游下游

- **上游**：DeepSeek API（`api.deepseek.com`），需要用户自备 API Key
- **下游**：通过 `safari-web-extension-converter` 可转换为 Safari 扩展（见 `.claude/settings.local.json` 中的 Xcode 构建命令）。Safari 版本源文件在 `../aitrans-safari/`

## 不存在的东西

- 无测试（无测试框架、无测试文件）
- 无 CI/CD
- 无 `.gitignore`
- 无 linter / formatter 配置
- 打包靠手动 zip：`zip -r aitrans-chrome-vX.Y.Z.zip manifest.json background.js content.js content.css popup.html popup.js popup.css icons/ -x "*.DS_Store"`
