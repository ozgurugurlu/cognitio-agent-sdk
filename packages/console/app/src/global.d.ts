/// <reference types="@solidjs/start/env" />

declare global {
  namespace App {
    interface RequestEventLocals {
      actor?: Promise<import("@cognitio/console-core/actor.js").Actor.Info>
    }
  }
}

export {}
