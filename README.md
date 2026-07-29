# ChatGPT Optimizer

A lightweight Manifest V3 Chrome extension for improving responsiveness in long ChatGPT conversations.

## What version 1.5.0 does

- Hides conversation turns during the initial long-chat load.
- Keeps only the newest 10 turns visible after loading.
- Automatically scrolls to the latest message.
- Lets you reveal 10 more turns, reveal everything, or return to the newest 10.
- Re-trims the page when new turns are added.
- Pauses media inside hidden turns.
- Requests lazy image loading and asynchronous image decoding for visible turns.
- Removes backdrop blur, shadows, smooth scrolling, and most decorative animations.
- Makes no network requests.

Older turns stay in ChatGPT's DOM and are not deleted. They are hidden with `display: none`, so they stop participating in layout and paint until revealed.

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

Then press **Reload** on the extension card and hard-refresh ChatGPT with **Command + Shift + R**.
