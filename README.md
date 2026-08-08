# ChatGPT Optimizer

A lightweight Manifest V3 Chrome extension for improving responsiveness in long ChatGPT conversations and keeping ChatGPT working toward a persistent goal.

## What version 2.0.0 does

Every optimization can now be enabled or disabled independently from the extension popup.

### Long-chat performance

- Hide conversation turns during the initial long-chat load.
- Keep only the newest 10 turns visible after loading.
- Automatically jump to the latest message.
- Pause media inside hidden turns.
- Request lazy image loading and asynchronous image decoding for visible turns.
- Re-trim the page when new turns are added while the newest-10 limiter is enabled.
- Reveal 10 more turns, reveal everything, or return to the newest 10 from the in-page status control.

### Visual performance

- Disable smooth scrolling.
- Remove backdrop blur.
- Remove shadows.
- Disable decorative transitions.
- Disable most decorative animations while preserving spinners.

Older turns stay in ChatGPT's DOM and are not deleted. When the newest-10 limiter is enabled, old turns are hidden with `display: none`, so they stop participating in layout and paint until revealed.

### `/goal` mode

The popup now includes a goal field and an **Enable** toggle. When Goal Mode is enabled, the extension watches the current ChatGPT page. After an assistant response has stopped changing and ChatGPT is no longer generating, the extension automatically submits a continuation prompt containing the saved goal.

Goal Mode:

- waits for a completed assistant response before continuing;
- does not overwrite text already typed into the composer;
- waits until the send button is available;
- can start a goal from a blank ChatGPT page;
- automatically stops if ChatGPT returns `[CGO_GOAL_COMPLETE]` or `[CGO_GOAL_BLOCKED]` as instructed by the continuation prompt;
- can be disabled at any time from the extension popup.

The feature works by interacting with the ChatGPT web interface. If ChatGPT changes its composer, send-button, or conversation-turn markup, the relevant selectors may need to be updated.

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
