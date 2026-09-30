interface PendingRequest {
  id: string
  controller: AbortController
}

export const DEFAULT_MAX_COMPLETED_CONTROL_IDS = 1_000

export class LocalControlRegistry {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly completed = new Set<string>()
  private readonly completedOrder: string[] = []

  constructor(private readonly maxCompleted = DEFAULT_MAX_COMPLETED_CONTROL_IDS) {}

  add(id: string): AbortController | undefined {
    if (this.pending.has(id)) return
    if (this.completed.has(id)) return
    const controller = new AbortController()
    this.pending.set(id, { id, controller })
    return controller
  }

  complete(id: string): void {
    this.pending.delete(id)
    if (this.completed.has(id)) return
    this.completed.add(id)
    this.completedOrder.push(id)
    const overflow = this.completedOrder.length - this.maxCompleted
    if (overflow <= 0) return
    this.completedOrder.splice(0, overflow).forEach((item) => this.completed.delete(item))
  }

  release(id: string): void {
    this.pending.delete(id)
  }

  cancel(id: string): boolean {
    const pending = this.pending.get(id)
    if (!pending) {
      this.complete(id)
      return false
    }
    pending.controller.abort()
    this.complete(id)
    return true
  }

  stop(): void {
    this.pending.forEach((entry) => entry.controller.abort())
    this.pending.clear()
  }
}
