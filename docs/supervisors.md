# Group Supervisors

Open a group and choose **Supervisor** in its composer toolbar. Create a task with a supervisor session, monitored members, an interval, and a prompt describing what the supervisor should check and do. Read, stop, and send permissions default to enabled for each selected target and can be changed individually.

The interval is the delay **after the supervisor's own check finishes**, not after a monitored session finishes. A worker can continue running throughout several checks. Monitoring waits when its executor is busy and does not queue overlapping checks.

## Task controls

| Control | Behavior |
| --- | --- |
| Save & start | Create a task and enable recurring monitoring |
| Monitoring switch off | Let the current check finish, then pause |
| Stop run | Interrupt the current check; keep the monitoring switch unchanged |
| Run once now | Queue one check; a paused task remains paused afterward |
| Save changes | Update configuration without changing the monitoring switch |

Changing only the prompt keeps the existing countdown. Changing the interval updates the next scheduled time. The list shows status and recent results; open task details for check history, and expand a check to load its tool calls. Prompt and usage details are collapsed by default.

Monitored sessions cannot include the executor. A session cannot simultaneously be an executor and another task's monitored target. These roles apply across groups sharing that session.

## Instructions and tools

The supervisor receives your prompt with its current invocation ID and available target permissions. Glad supplies five MCP tools: list targets, read a session, stop an expected turn, send a prompt to an idle target, and end supervision. You can ask it to call `end_supervision` when the goal is reached.

For example:

> Check the worker against the agreed development plan. Read its latest output and inspect the results. If more work is needed, send a specific next instruction. Stop it only if its current work is off track. End supervision when the acceptance criteria are met.

A stop request being accepted does not immediately make a session ready for another prompt. The supervisor should read its state again before sending. Periodic checks can observe several worker turns together; they are not triggered after every worker response.

Internal checks remain in the executor's own conversation and the Supervisor history rather than the group timeline. Commands sent to workers appear in the group with the supervisor author. Routine automated completions are quiet, while failures and requests requiring attention retain notification behavior.

## Manual member operations

Choose **Members → Controls** for an individual session. Read live output or history, stop its current run, and send its next instruction from the same panel. The send button becomes available after the provider is ready. Other members running do not block group messages sent to idle targets.

Hold a group message to select references; in selection mode tap messages to toggle them and use **Cancel** or **Preview** at the top.

## Persistence and access

Closing the browser does not stop monitoring in the daemon. Explicitly closing a group pauses its tasks. Restarting Glad preserves configuration and bounded audit history but pauses monitoring until you restore members and resume it. Unreadable task files are retained and reported without preventing startup.

Credentials and invocation checks apply to the Glad Supervisor tools. They do not isolate the session's existing filesystem, shell, or ordinary HTTP access. Existing CLI permission policies continue to apply; matching ask/deny rules can still require attention. Newly started provider processes receive the Glad MCP configuration.

Monitoring consumes model usage on every invocation and extends the supervisor conversation. The default interval is two minutes, with a one-minute minimum. **Skip unchanged idle sessions** is optional and off by default because file changes or time-based conditions may need checks even when conversation output does not change.
