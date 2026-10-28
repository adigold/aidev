# AGenda configuration

AGenda is a self-hosted issue tracker with an `@aidev` job queue: when the owner writes `@aidev` in an issue description or comment, the server queues a job for that issue. With `PROVIDER=agenda`, the open jobs of one workspace are aidev's task list, so one aidev project (one `.env.aidev`, one git checkout) serves one AGenda workspace.

| Variable | Default | Description |
|---|---|---|
| `AGENDA_URL` | `http://127.0.0.1:7420` | Base URL of the AGenda server |
| `AGENDA_TOKEN` | required | AGenda API key with the `dispatcher` role |
| `AGENDA_WORKSPACE_ID` | required | Workspace id, or its exact name |
| `AGENDA_PENDING_STATUS` | `Pending` | Status aidev writes when it asks a question |
| `AGENDA_IN_REVIEW_STATUS` | `In Review` | Status aidev writes after implementation; also the workflow state it reads for the review phase |

## How jobs map to tasks

| AGenda job | Task id | Task status |
|---|---|---|
| `queued` (`task` or `push`) | issue identifier, e.g. `SEN-72` | `open` |
| `queued` (`reply`: the owner answered a question) | issue identifier | `AGENDA_PENDING_STATUS` |
| `claimed` / `running` | issue identifier | `in progress` |
| `needs_input` (waiting for the owner) | issue identifier | `needs input` (skipped) |

The task description is the issue description; when the job was triggered from a comment, the comment text is appended as the request. Issue labels become task tags. Comments are read from and written to the issue's own comments.

## How status changes are written

| aidev status | What the provider does |
|---|---|
| `in progress` | Claims the job, then reports it `running` (AGenda moves the issue to its first started state) |
| `AGENDA_PENDING_STATUS` | Reports the job `needs_input` (AGenda posts its question notice and notifies the owner) |
| `AGENDA_IN_REVIEW_STATUS` | Reports the job `done` (AGenda moves the issue to `In Review` and notifies the owner) |
| anything else, or no open job | Sets the issue's workflow state by name, then by state type (`done` matches a `completed` state) |

Every comment aidev posts (`[aidev-<project>] ...`) goes to the issue first, so the owner's push notification points at an issue that already shows the branch, the PR link or the question.

## Limits

- A `dispatcher` key may read issues, comment, use the job queue and change an issue's state, nothing else. Label changes (`AUTO_APPROVE`, `AUTO_REVIEW`, the thinking tag, removing the `agent review` tag), creating sub-issues (`PLANNING_TAG`) and deleting issues need an `admin` key; with a dispatcher key, add the `accepted` or `agent review` labels in AGenda by hand.
- The review phases (code review, agent review, auto-merge) read issues in the `AGENDA_IN_REVIEW_STATUS` workflow state and, like every provider, only consider issues that carry the project tag (`CLICKUP_TAG`, default: folder name) or the `accepted` / `agent review` labels.
- Re-processing an issue that already has a branch needs the trigger word (default `aidev-continue`) in the last comment. Setting `AIDEV_TRIGGER_WORD=@aidev` makes every new `@aidev` comment re-trigger the task.

[← Back to configuration overview](/guide/configuration)
