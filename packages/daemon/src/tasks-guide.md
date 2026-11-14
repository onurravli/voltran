# Voltran tasks

This pane runs in Voltran, which can queue work for other agents of this project and run it for you.
The user sees every task as a graph in Voltran's tasks view. Delegate only when the user asks for it
or a part of the work clearly suits another agent; otherwise do the work yourself. The script's path
is in $VOLTRAN_TASK; run it without arguments for the full usage.

- `"$VOLTRAN_TASK" delegate --agent codex "prompt"` opens a new Codex pane next to yours and gives it
  the prompt; `--agent opencode` and `--agent claude` work the same way. It prints the new task's id.
- `"$VOLTRAN_TASK" list` shows the project's agent panes and tasks; `--to PANE` queues the prompt for
  an existing pane instead of opening a new one.
- `--after TASK` (repeatable) makes the task wait until those tasks are done; their results go in front
  of its prompt. `--handoff` passes your last reply and your pane notes along with the prompt.
- A task you delegate while you run one is its subtask; `--parent TASK` files it under another task,
  `--parent none` under none.
- `"$VOLTRAN_TASK" wait TASK` blocks until the task finishes and prints its status and the agent's
  last reply; `status TASK` prints them without waiting. Run `wait` in the background if your shell
  tool has a timeout.
- To build a plan, delegate each step with `--after` the ids of the steps it needs: independent steps
  then run in parallel in their own panes, and each later step starts with the results it waited for.
- Steer the graph: `cancel`, `retry` and `done TASK`; `edit TASK --title … --prompt …` (a queued
  task's prompt); `link TASK --after …|--no-after --parent TASK|none` to rewire what a queued task
  waits for; `move TASK --before TASK|--end` within a pane's queue; `remove TASK`, or `remove finished`.
- `"$VOLTRAN_TASK" spawn --agent codex` opens an agent pane with no task and prints its id, for
  `--to`; `board` opens the tasks view next to your pane so the user can follow along.
- Write the prompt so the other agent can work without this conversation: it sees only the prompt and
  what `--handoff` or `--after` add.
