import { beforeEach, describe, expect, it, vi } from "vitest"
import { verifyDuplicateGroupsWithJev } from "./jev-dedup"
import { DEFAULT_JEV_CONFIG } from "./jev-config"
import type { EntitySummary } from "./dedup"

const { evaluate } = vi.hoisted(() => ({ evaluate: vi.fn() }))
vi.mock("./jev-client", () => ({ evaluateJev: evaluate }))
const summaries: EntitySummary[] = ["a", "b", "c"].map((slug) => ({
  slug, path: `wiki/entities/${slug}.md`, title: slug, type: "entity", tags: [],
}))
const config = { ...DEFAULT_JEV_CONFIG, enabled: true, apiKey: "test-only" }
const answer = (choice: string, confidence = 0.9) => ({
  model: "jev-test", answers: { identity: { type: "choice", choice, confidence } },
})

beforeEach(() => { evaluate.mockReset() })
describe("Jev duplicate verification", () => {
  it("checks every pair without promoting transitive matches into a merged group", async () => {
    evaluate.mockResolvedValueOnce(answer("same"))
      .mockResolvedValueOnce(answer("different"))
      .mockResolvedValueOnce(answer("same"))
    const result = await verifyDuplicateGroupsWithJev([
      { slugs: ["a", "b", "c"], confidence: "high", reason: "candidate group" },
    ], summaries, config)
    expect(result.map((group) => group.slugs)).toEqual([["a", "b"], ["b", "c"]])
    expect(evaluate).toHaveBeenCalledTimes(3)
  })

  it("keeps uncertain candidates explicitly low-confidence even for a peaked unknown answer", async () => {
    evaluate.mockResolvedValue(answer("uncertain", 1))
    const result = await verifyDuplicateGroupsWithJev([
      { slugs: ["a", "b"], confidence: "high", reason: "candidate" },
      { slugs: ["b", "a"], confidence: "high", reason: "duplicate candidate" },
    ], summaries, config)
    expect(result).toHaveLength(1)
    expect(result[0].confidence).toBe("low")
    expect(result[0].reason).toContain("insufficient context")
    expect(evaluate).toHaveBeenCalledTimes(1)
  })

  it("surfaces service failures instead of returning unchecked candidates", async () => {
    evaluate.mockRejectedValue(new Error("Jev unavailable"))
    await expect(verifyDuplicateGroupsWithJev([
      { slugs: ["a", "b"], confidence: "high", reason: "candidate" },
    ], summaries, config)).rejects.toThrow("Jev unavailable")
  })

  it("preserves low-confidence different judgments for user review", async () => {
    evaluate.mockResolvedValue(answer("different", 0.01))
    const result = await verifyDuplicateGroupsWithJev([
      { slugs: ["a", "b"], confidence: "high", reason: "candidate" },
    ], summaries, config)
    expect(result[0]).toMatchObject({ slugs: ["a", "b"], confidence: "low" })
  })

  it("does not reintroduce excluded pairs from larger proposed groups", async () => {
    evaluate.mockResolvedValue(answer("same"))
    const result = await verifyDuplicateGroupsWithJev([
      { slugs: ["a", "b", "c"], confidence: "high", reason: "candidate group" },
    ], summaries, config, undefined, [["a", "b"]])
    expect(result.map((group) => group.slugs)).toEqual([["a", "c"], ["b", "c"]])
    expect(evaluate).toHaveBeenCalledTimes(2)
  })

  it("honors cancellation before dispatch", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(verifyDuplicateGroupsWithJev([
      { slugs: ["a", "b"], confidence: "high", reason: "candidate" },
    ], summaries, config, controller.signal)).rejects.toThrow()
    expect(evaluate).not.toHaveBeenCalled()
  })
})
