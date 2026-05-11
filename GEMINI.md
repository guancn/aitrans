# 极简划词翻译 (Minimalist Selection Translation)

## Project Overview

"极简划词翻译" is a Chrome extension (Manifest V3) designed for high-aesthetic, non-intrusive automatic text selection translation. It intelligently identifies languages and uses the DeepSeek API (`api.deepseek.com`, utilizing the `deepseek-v4-flash` model) to perform translations.

The project is built entirely with pure native JavaScript, HTML, and CSS, requiring no modern frontend frameworks or build tools.

### Architecture

1.  **User Interaction**: User selects text on a webpage.
2.  **Capture**: `content.js` captures the `mouseup` event.
3.  **Trigger**: Depending on the user's configured `triggerMode`, it either shows a floating icon (which requires hovering for 150ms to translate) or immediately pops up the translation window.
4.  **Message Passing**: `content.js` sends a message `chrome.runtime.sendMessage({action: 'translate', text})` to `background.js`.
5.  **API Call**: `background.js` calls the DeepSeek chat completions API. It includes a retry mechanism (except for 401/403 errors).
6.  **Response**: The background script parses the JSON response (`source_lang` and `translated_text`) and sends the result back to `content.js`.
7.  **Rendering**: `content.js` renders the translation result on the page.

## Building and Running

Because this project uses native web technologies without a build step, no compilation or building commands are necessary.

**Installation/Loading:**
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable "Developer mode" in the top right corner.
3. Click on "Load unpacked" and select the root directory of this project (`/Volumes/ZHITAI 1T/My Project/aitrans/`).

**Debugging/Updating:**
*   **Service Worker (`background.js`)**: If you modify the background script, click the refresh icon on the extension's card in `chrome://extensions/` to reload the Service Worker. You can view its logs by clicking the "service worker" link on the card.
*   **Content Scripts (`content.js`/`content.css`)**: If you modify content scripts, refresh the target web page you are testing on for the changes to take effect. View logs in the webpage's DevTools console.

## Development Conventions

*   **No Frameworks:** Strictly prohibit the introduction of any frameworks or libraries (e.g., React, Vue, jQuery). Keep it pure native JS.
*   **CSS Isolation:** 
    *   All class names in `content.css` MUST be prefixed with `translate-ext-`.
    *   All ID names MUST start with `chrome-ext-translate-`. This prevents CSS pollution on host pages.
*   **Z-Index:** Any injected UI elements should use a `z-index` of `2147483647` (the maximum value) to ensure they always appear on top.
*   **Positioning:** Popups and icons should be positioned using `position: absolute` calculated with scroll offsets.
*   **Dark Mode:** Support `prefers-color-scheme: dark` for dark mode compatibility.
*   **Async/Await:** Use `async/await` for all asynchronous operations instead of synchronous XMLHttpRequest or plain Promises where possible.
*   **Naming/Language:** Code variables and function names must be in English. Documentation and code comments should use Simplified Chinese.
*   **Context Invalidation:** `content.js` includes `isExtensionAlive()` and `markInvalidated()` to handle scenarios where the extension is updated or reloaded, ensuring UI cleanup and event listener detachment to avoid errors.
