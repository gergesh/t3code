# Chat from the terminal

`t3 tui` opens a chat with an agent in the folder you run it from, without
leaving the terminal. It talks to the T3 Code that is already running on this
machine, such as the desktop app or `t3 serve`. Threads you start here show up
in every other client, and you can pick them up anywhere.

```sh
cd ~/code/my-app
t3 tui                 # a new thread in this folder
t3 tui -c              # reopen the latest thread in this folder
t3 tui --provider <instance-id> --model <model-slug>
```

The terminal renderer needs Node 26.4 or newer. The `t3` command the desktop app
installs runs on the app's own older Node, so `t3 tui` there uses the `node` on
your PATH instead; install Node 26 if it says it cannot find one.

The thread belongs to the project whose folder contains the current one. In a
git worktree of a project's repository, it belongs to that project and runs in
the worktree. Anywhere else, your first message adds the folder as a new
project. A new thread uses the project's default model and the permission mode
from settings.

## Talking to the agent

Press Enter to send, and Shift+Enter, Alt+Enter, or Ctrl+J for a new line.
While the agent works, Enter steers the running turn and Tab queues the message
to run after it. Esc stops the turn. ↑ and ↓ bring back your earlier messages
in the thread.

When the agent asks a question, its choices appear above the message box. Use
↑↓ and Enter, or press a choice's number; Space marks choices when several are
allowed. Type in the message box to give your own answer instead. Approvals
work the same way. When you decline one, what you typed is sent as the reason.

To attach an image, drop the file onto the terminal or press Ctrl+V with an
image on the clipboard. On Linux, pasting an image needs `wl-paste` or `xclip`.
Backspace in an empty message box removes the last image.

## Commands

Type `/` to list the commands. `/help` lists them with their keys.

| Command      | Key       |                                                     |
| ------------ | --------- | --------------------------------------------------- |
| `/new`       | Ctrl+N    | start a new thread in this folder                   |
| `/threads`   | Ctrl+T    | open another thread in this folder                  |
| `/model`     | Ctrl+L    | choose the model; it applies from your next message |
| `/mode`      |           | choose the permission mode                          |
| `/plan`      | Shift+Tab | turn plan mode on or off                            |
| `/implement` |           | leave plan mode and build the proposed plan         |
| `/verbose`   | Ctrl+O    | show thinking and tool output in full               |
| `/copy`      |           | copy the last reply                                 |
| `/quit`      | Ctrl+D    | leave                                               |

PageUp and PageDown scroll the conversation; PageUp at the top loads earlier
messages. Ctrl+C clears the message box, stops the running turn when it is
empty, and quits when nothing is running.
