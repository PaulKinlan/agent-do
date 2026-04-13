# Interactive CLI Assistant

A multi-turn interactive assistant that persists files to disk, streams responses in real-time, and tracks usage across your entire session.

## What it does

- **Persistent memory** -- Uses `FilesystemMemoryStore` to read/write files in `.data/`. Files survive across sessions.
- **Multi-turn conversation** -- Maintains conversation history so the agent remembers what you said earlier in the session.
- **Streaming output** -- Shows tool calls and text as they happen, so you see the agent working in real-time.
- **Lifecycle hooks** -- Logs token counts and estimated cost after every LLM call.
- **Session summary** -- When you exit, prints total tokens used, estimated cost, and number of messages exchanged.

## How to run

```bash
# Install repo root dependencies first (if not already done)
# (cd ../.. && npm install)

# Install demo dependencies
npm install

# Set your API key
export ANTHROPIC_API_KEY=sk-ant-...

# Start the assistant
npm start
```

## What to expect

1. The assistant prints a welcome banner explaining its capabilities.
2. You type a message and press Enter.
3. The agent streams its response, showing tool calls (file reads/writes/searches) as they happen.
4. The conversation continues until you type `quit` or press Ctrl+C.
5. On exit, a session summary shows total tokens, cost, and message count.

## Example session

```
You: Save a note about my meeting with Sarah tomorrow at 3pm
  [tool-call] write_file({ path: "notes/meeting-sarah.md", ... })
  [tool-result] Successfully wrote to notes/meeting-sarah.md

  Assistant: I've saved a note about your meeting with Sarah...

You: What notes do I have?
  [tool-call] find_files({ path: "notes" })
  [tool-result] [file] meeting-sarah.md

  Assistant: You have one note: meeting-sarah.md about your meeting with Sarah...

You: quit

Session Summary
  Messages:    4 (2 exchanges)
  Total tokens: 3,421
  Estimated cost: $0.0127
```
