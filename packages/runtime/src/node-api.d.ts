/** Typed embedding boundary for the desktop's Node runtime bundle. */
import type { Config as RuntimeConfig } from "@cognitio/sdk/v2"
import type { DatabaseSync } from "node:sqlite"
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite"

export namespace Server {
  type Listener = { hostname: string; port: number; url: URL; stop(close?: boolean): Promise<void> }
  function listen(options: {
    port: number
    hostname: string
    mdns?: boolean
    mdnsDomain?: string
    cors?: string[]
  }): Promise<Listener>
}

export namespace Config {
  type Info = RuntimeConfig
  function get(): Promise<Info>
}

export namespace Log {
  function init(options: { print: boolean; dev?: boolean; level?: "DEBUG" | "INFO" | "WARN" | "ERROR" }): Promise<void>
}

export namespace Database {
  const Path: string
  function Client(): NodeSQLiteDatabase & { $client: DatabaseSync }
}

export namespace JsonMigration {
  type Progress = { current: number; total: number; label: string }
  function run(
    database: NodeSQLiteDatabase,
    options?: { progress?: (event: Progress) => void },
  ): Promise<{
    projects: number
    sessions: number
    messages: number
    parts: number
    todos: number
    permissions: number
    shares: number
    errors: string[]
  }>
}

export function bootstrap<T>(directory: string, callback: () => Promise<T>): Promise<T>
