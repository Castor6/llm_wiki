export interface JevConfig {
  enabled: boolean
  apiKey: string
  model: string
  timeoutSeconds: number
}

export const DEFAULT_JEV_CONFIG: JevConfig = {
  enabled: false,
  apiKey: "",
  model: "jev-1.13.0",
  timeoutSeconds: 30,
}

/** Persisted settings may come from an older version or an incomplete import. */
export function normalizeJevConfig(config?: unknown): JevConfig {
  const value = config && typeof config === "object"
    ? config as Partial<JevConfig>
    : {}
  return {
    enabled: value.enabled === true,
    apiKey: typeof value.apiKey === "string" ? value.apiKey.trim() : "",
    model: typeof value.model === "string" && value.model.trim()
      ? value.model.trim()
      : DEFAULT_JEV_CONFIG.model,
    timeoutSeconds: typeof value.timeoutSeconds === "number" && Number.isFinite(value.timeoutSeconds)
      ? Math.max(1, Math.min(120, Math.floor(value.timeoutSeconds)))
      : DEFAULT_JEV_CONFIG.timeoutSeconds,
  }
}
