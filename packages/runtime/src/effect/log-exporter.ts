import { Duration, Effect, Option, Scope } from "effect"
import { HttpClient } from "effect/unstable/http"
import { OtlpLogger } from "effect/unstable/observability"

// Effect's size-triggered OTLP batches run in scope-owned fibers. Closing that
// scope interrupts a batch that has already left its buffer, so the exporter's
// final buffer flush cannot recover it. Keep its scope behind a request drain.
export const make = (options: Parameters<typeof OtlpLogger.make>[0]) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const client = yield* Effect.service(HttpClient.HttpClient)
    const active = new Map<number, { promise: Promise<void>; complete: () => void }>()
    const timeout = Duration.toMillis(Duration.fromInputUnsafe(options.shutdownTimeout ?? "3 seconds"))
    let deadline: number | undefined
    const tracked = client.pipe(
      HttpClient.transformResponse((request) =>
        Effect.withFiber((fiber) => {
          if (!active.has(fiber.id)) {
            const done = Promise.withResolvers<void>()
            const complete = () => {
              active.delete(fiber.id)
              done.resolve()
              unobserve()
            }
            const unobserve = fiber.addObserver(complete)
            active.set(fiber.id, { promise: done.promise, complete })
          }
          return Effect.suspend(() => {
            if (deadline === undefined) return request
            const remaining = deadline - Date.now()
            if (remaining <= 0) return Effect.interrupt
            return request.pipe(
              Effect.timeoutOption(remaining),
              Effect.flatMap((response) =>
                Option.isSome(response) ? Effect.succeed(response.value) : Effect.interrupt,
              ),
            )
          }).pipe(
            Effect.tap((response) =>
              Effect.sync(() => {
                // Keep failed attempts pending across the upstream retry delay.
                // Its batch fiber completion also releases terminal failures.
                if (response.status >= 200 && response.status < 300) active.get(fiber.id)?.complete()
              }),
            ),
          )
        }),
      ),
    )
    const drain = Effect.gen(function* () {
      // Allow any batch fibers scheduled by the final synchronous log call to
      // enter their request before inspecting the pending set.
      yield* Effect.yieldNow
      while (active.size) {
        yield* Effect.promise(() => Promise.all(Array.from(active.values(), (entry) => entry.promise)))
      }
    }).pipe(Effect.interruptible, Effect.timeoutOption(timeout), Effect.asVoid)
    yield* Effect.addFinalizer((exit) =>
      Effect.sync(() => {
        deadline = Date.now() + timeout
      }).pipe(
        Effect.andThen(drain),
        Effect.andThen(
          Effect.suspend(() =>
            Scope.close(scope, exit).pipe(
              // Bound the entire final flush, including upstream retry sleeps.
              // Effect's timeout awaits interruption and request cleanup.
              Effect.interruptible,
              Effect.timeoutOption(Math.max(0, deadline! - Date.now())),
              Effect.asVoid,
            ),
          ),
        ),
        Effect.ensuring(Effect.sync(() => Array.from(active.values()).forEach((entry) => entry.complete()))),
      ),
    )
    return yield* OtlpLogger.make(options).pipe(
      Effect.provideService(HttpClient.HttpClient, tracked),
      Scope.provide(scope),
    )
  })
