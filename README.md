# ChatGPT Optimizer

A lightweight Manifest V3 Chrome extension for improving responsiveness in long ChatGPT conversations.

## What it does

- Uses `content-visibility: auto` so Chrome can skip rendering off-screen conversation turns.
- Optimizes off-screen sidebar conversations.
- Removes expensive backdrop blur by default.
- Provides optional animation and shadow reduction.
- Makes no network requests and does not repeatedly scan or mutate the ChatGPT page.

## Why version 1.2 is safer

The earlier local version used a `MutationObserver` that reacted to nearly every DOM update and repeatedly rescanned the whole conversation. ChatGPT changes the page constantly while streaming, so that design could create a feedback loop and freeze the tab.

This version has no DOM observer and no page-wide scanning loop. Dynamic messages are handled directly by CSS selectors.

## Install on macOS

```bash
cd ~/Desktop
mv chatgpt-optimizer "chatgpt-optimizer-old-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
git clone https://github.com/brandonlign/chatgpt-optimizer.git
open -a "Google Chrome" "chrome://extensions"
```

Then enable **Developer mode**, choose **Load unpacked**, and select `~/Desktop/chatgpt-optimizer`.

## Update

```bash
bash ~/Desktop/chatgpt-optimizer/update.sh
```

Then press **Reload** on the extension card and refresh ChatGPT.

## Settings

Click the extension icon in Chrome. Off-screen message optimization is always enabled. Blur and sidebar optimization are enabled by default; animation and shadow reduction are optional.
