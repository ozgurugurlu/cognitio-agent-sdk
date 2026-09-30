import { mergeDeep } from "remeda"

/**
 * Provenance layers for file-discovered resources (agents, commands, skills).
 * "user"/"project"/"local" are gateable via session-level settingSources;
 * "direct" entries are caller/operator/policy input (COGNITIO_CONFIG_CONTENT,
 * explicit COGNITIO_CONFIG file, console/org, managed/MDM, runtime, plugin)
 * and always apply.
 */
export type Gate = "user" | "project" | "local"
export type Source = Gate | "direct"

export interface Contribution<T> {
  name: string
  def: T
  source: Source
}

export function allowed(sources: readonly Gate[] | undefined, source: Source) {
  return source === "direct" || sources === undefined || sources.includes(source as Gate)
}

/**
 * Merge allowed contributions per name in contribution (merge event) order so
 * the folded definition matches what mergeDeep produced in the merged config.
 */
export function fold<T extends object>(
  contributions: readonly Contribution<T>[],
  sources: readonly Gate[] | undefined,
): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of contributions) {
    if (!allowed(sources, item.source)) continue
    const existing = map.get(item.name)
    map.set(item.name, existing === undefined ? item.def : (mergeDeep(existing, item.def) as T))
  }
  return map
}

export * as ConfigResources from "./resources"
