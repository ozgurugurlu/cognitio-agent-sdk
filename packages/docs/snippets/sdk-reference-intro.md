Use this reference for the JavaScript and TypeScript API exported by `cognitio-agent-sdk`. If you are starting a new project, begin with the [quickstart](/quickstart) and return here for exact options and return types.

## Start with these APIs

| API | Use it for |
| --- | --- |
| [Agent](/api-reference/classes/Agent) | Reusable configuration, one-off tasks, streams, and conversations. |
| [Session](/api-reference/classes/Session) | Multiple messages in one conversation, forks, and checkpoints. |
| [query](/api-reference/functions/query) | One streamed task without managing an Agent object. |
| [defineTool](/api-reference/functions/defineTool) | A function the model can call in your application. |
| [createAgentClient](/api-reference/functions/createAgentClient) | Direct control over a local or remote runtime and session handles. |
| [shutdown](/api-reference/functions/shutdown) | Application teardown for facade-owned runtimes. |

See [AgentOptions](/api-reference/interfaces/AgentOptions) for agent configuration and [RunResult](/api-reference/interfaces/RunResult) for completed high-level runs. Low-level session operations return [ResultMessage](/api-reference/interfaces/ResultMessage).

The **SDK reference** is the interface most applications use. The **[runtime HTTP API](/http-api/overview)** and protocol types under **Advanced** describe the underlying server for direct integrations; you do not need them to use `Agent`.

## Exported API
