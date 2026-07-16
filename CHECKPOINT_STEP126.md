# KaChat Desktop Checkpoint — Step 126

This folder is the frozen working baseline after the Step 126 fixes.

## Baseline status

- Main Chats search bar appears only on the main Chats list.
- Search bar remains visible after returning from a message thread.
- Search bar is hidden in Settings and Profile.
- Profile NAME label is positioned above the account-name card.
- Message actions open only when the actual message bubble is clicked.
- Top-right create-chat icon is 5% smaller.
- Send KAS icon uses the mirrored original icon from Step 119.
- Ready-state LEDs use true green.
- Seed phrase reveal uses a five-second hold with progress bar.
- Message-thread header/composer and scrolling fixes are preserved.

## Run

```bash
cd ~/Downloads && unzip -o KaspaEngine_KaChatShell_Checkpoint_Step126.zip && cd KaspaEngine && npm run dev
```

Open: http://localhost:5173/

## Rule for future edits

Use this checkpoint as the baseline. Change only the requested scope and create a new incremented ZIP.
