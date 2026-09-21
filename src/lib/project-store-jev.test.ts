import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_JEV_CONFIG } from "./jev-config"
import { loadJevConfig, saveJevConfig } from "./project-store"
import { resetProjectState } from "./reset-project-state"
import { useWikiStore } from "@/stores/wiki-store"

const storage = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }))
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => storage),
}))
vi.mock("@/lib/ingest-queue", () => ({ pauseQueue: vi.fn() }))
vi.mock("@/lib/dedup-queue", () => ({ pauseQueue: vi.fn() }))
vi.mock("@/lib/graph-relevance", () => ({ clearGraphCache: vi.fn() }))
vi.mock("@/lib/project-file-sync", () => ({ stopProjectFileSync: vi.fn() }))
vi.mock("@/lib/scheduled-import", () => ({ stopScheduledImport: vi.fn() }))

const entries = new Map<string, unknown>()

beforeEach(() => {
  entries.clear()
  storage.get.mockReset().mockImplementation(async (key: string) => entries.get(key))
  storage.set.mockReset().mockImplementation(async (key: string, value: unknown) => {
    entries.set(key, value)
  })
  useWikiStore.getState().setJevConfig({ ...DEFAULT_JEV_CONFIG })
})

describe("global Jev settings", () => {
  it("starts disabled when older installations have no Jev settings", async () => {
    expect(await loadJevConfig()).toEqual(DEFAULT_JEV_CONFIG)
  })

  it("round-trips normalized credentials and preferences in the app store", async () => {
    await saveJevConfig({
      enabled: true,
      apiKey: " synthetic-test-key ",
      model: " jev-1.13.0 ",
      timeoutSeconds: 15,
    })

    expect(await loadJevConfig()).toEqual({
      enabled: true,
      apiKey: "synthetic-test-key",
      model: "jev-1.13.0",
      timeoutSeconds: 15,
    })
    expect([...entries.keys()]).toEqual(["jevConfig"])
  })

  it("keeps rapid edits in order even when the first storage write is slow", async () => {
    let releaseFirst!: () => void
    let markStarted!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    storage.set.mockImplementationOnce(async (key: string, value: unknown) => {
      markStarted()
      await gate
      entries.set(key, value)
    })

    const first = saveJevConfig({ ...DEFAULT_JEV_CONFIG, apiKey: "old-test-key" })
    const second = saveJevConfig({ ...DEFAULT_JEV_CONFIG, apiKey: "new-test-key" })
    await started
    expect(storage.set).toHaveBeenCalledTimes(1)
    releaseFirst()
    await Promise.all([first, second])

    expect((await loadJevConfig()).apiKey).toBe("new-test-key")
  })

  it("can save again after a failed write", async () => {
    storage.set.mockRejectedValueOnce(new Error("disk unavailable"))
    await expect(saveJevConfig(DEFAULT_JEV_CONFIG)).rejects.toThrow("disk unavailable")
    await saveJevConfig({ ...DEFAULT_JEV_CONFIG, model: "jev-latest" })
    expect((await loadJevConfig()).model).toBe("jev-latest")
  })

  it("preserves the global Jev settings across project resets", async () => {
    const config = { ...DEFAULT_JEV_CONFIG, enabled: true, apiKey: "synthetic-test-key" }
    useWikiStore.getState().setJevConfig(config)
    await resetProjectState()
    expect(useWikiStore.getState().jevConfig).toEqual(config)
  })
})
