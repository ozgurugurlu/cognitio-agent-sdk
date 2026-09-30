import type { Event as CognitioEvent, CognitioClient } from "../internal/runtime-client/index.js"

export interface EventSubscription {
  stream: AsyncGenerator<CognitioEvent>
}

export async function subscribeEvents(
  client: CognitioClient,
  input: {
    directory: string
    workspaceId?: string
    signal: AbortSignal
  },
): Promise<EventSubscription> {
  return (await client.event.subscribe(
    { directory: input.directory, workspace: input.workspaceId },
    {
      signal: input.signal,
      sseMaxRetryAttempts: 1,
    },
  )) as EventSubscription
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

export function backoffDelay(attempt: number, options: { initialDelayMs: number; maxDelayMs: number }): number {
  return Math.min(options.initialDelayMs * 2 ** Math.max(0, attempt - 1), options.maxDelayMs)
}
