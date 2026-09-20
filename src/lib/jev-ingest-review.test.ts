import { beforeEach, describe, expect, it, vi } from "vitest"
import { reviewSourceSummaryWithJev, syncJevCitationReviews } from "./jev-ingest-review"
import { useReviewStore } from "@/stores/review-store"
import { DEFAULT_JEV_CONFIG } from "./jev-config"
import type { LlmConfig } from "@/stores/wiki-store"

const { read, write, stream, evaluate } = vi.hoisted(() => ({
  read: vi.fn(), write: vi.fn(), stream: vi.fn(), evaluate: vi.fn(),
}))
vi.mock("@/commands/fs", () => ({ readFile: read, writeFileAtomic: write, createDirectory: vi.fn() }))
vi.mock("./llm-client", () => ({ streamChat: stream }))
vi.mock("./jev-client", () => ({ evaluateJev: evaluate }))

const summary = "---\ntitle: Source\n---\nThe feature supports all languages."
const input = {
  projectPath: "/project", sourcePath: "/project/raw/sources/source.md", sourceIdentity: "source.md",
  sourceText: "The feature supports English only.", summaryPath: "wiki/sources/source.md",
  config: { ...DEFAULT_JEV_CONFIG, enabled: true, apiKey: "secret-must-not-be-saved" },
  llmConfig: {} as LlmConfig, chinese: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  useReviewStore.setState({ items: [] })
  read.mockImplementation(async (path: string) => {
    if (path.endsWith("wiki/sources/source.md")) return summary
    throw new Error("missing")
  })
  stream.mockImplementation(async (_config, _messages, callbacks) => {
    callbacks.onToken(JSON.stringify([{ claim: "The feature supports all languages.", quote: "The feature supports English only." }]))
    callbacks.onDone()
  })
  evaluate.mockResolvedValue({ model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 10 },
    answers: { relation: { type: "choice", choice: "contradicts", confidence: 0.99,
      probabilities: { supports: 0, contradicts: 1, insufficient: 0 } } } })
})

describe("source-summary review", () => {
  it("does nothing when disabled", async () => {
    expect(await reviewSourceSummaryWithJev({ ...input, config: DEFAULT_JEV_CONFIG })).toEqual({ items: [], detail: "" })
    expect(read).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
  })
  it("checks saved text and returns an actionable review without modifying Wiki files or saving credentials", async () => {
    const result = await reviewSourceSummaryWithJev(input)
    expect(result.items[0]).toMatchObject({ type: "contradiction", affectedPages: [input.summaryPath] })
    expect(result.items[0].description).toContain("English only")
    expect(result.items[0].options[0].action).toBe(`open:${input.summaryPath}`)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0]).toContain("/.llm-wiki/jev-citations/")
    expect(write.mock.calls[0][1]).not.toContain(input.config.apiKey)
    expect(JSON.parse(write.mock.calls[0][1]).scope).toBe("sampled-source-summary")
  })
  it("reuses an exact-source/summary/model report", async () => {
    await reviewSourceSummaryWithJev(input)
    const [cachePath, cached] = write.mock.calls[0]
    read.mockImplementation(async (path: string) => path === cachePath ? cached : summary)
    stream.mockClear()
    evaluate.mockClear()
    const result = await reviewSourceSummaryWithJev(input)
    expect(result.items[0].type).toBe("contradiction")
    expect(stream).not.toHaveBeenCalled()
    expect(evaluate).not.toHaveBeenCalled()
  })
  it("does not attach an old verdict after the saved summary is edited", async () => {
    read.mockResolvedValueOnce(summary).mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce("The user edited this page during checking.")
    const result = await reviewSourceSummaryWithJev(input)
    expect(result.detail).toBe("Jev citation check pending")
    expect(write).not.toHaveBeenCalled()
  })

  it("rechecks moving model aliases instead of reusing old model judgments", async () => {
    const aliasInput = { ...input, config: { ...input.config, model: "jev-latest" } }
    await reviewSourceSummaryWithJev(aliasInput)
    const [cachePath, cached] = write.mock.calls[0]
    read.mockImplementation(async (path: string) => path === cachePath ? cached : summary)
    evaluate.mockClear()
    await reviewSourceSummaryWithJev(aliasInput)
    expect(evaluate).toHaveBeenCalledTimes(1)
  })

  it("does not attach cached judgments after an edit during cache lookup", async () => {
    await reviewSourceSummaryWithJev(input)
    const cached = write.mock.calls[0][1]
    read.mockResolvedValueOnce(summary).mockResolvedValueOnce(cached).mockResolvedValueOnce("Edited summary")
    const result = await reviewSourceSummaryWithJev(input)
    expect(result.detail).toBe("Jev citation check pending")
  })

  it("retires obsolete Jev findings without resolving unrelated user reviews", async () => {
    const result = await reviewSourceSummaryWithJev(input)
    syncJevCitationReviews(input.sourcePath, result.items)
    useReviewStore.getState().addItem({ type: "confirm", title: "User question", description: "Keep this",
      sourcePath: input.sourcePath, options: [] })
    syncJevCitationReviews(input.sourcePath, [])
    expect(useReviewStore.getState().items.find((item) => item.origin === "jev-citation")?.resolved).toBe(true)
    expect(useReviewStore.getState().items.find((item) => item.title === "User question")?.resolved).toBe(false)
  })
  it("marks failures pending and does not leak provider errors", async () => {
    evaluate.mockRejectedValue(new Error(`Request failed: ${input.config.apiKey}`))
    const result = await reviewSourceSummaryWithJev(input)
    expect(result.detail).toBe("Jev citation check pending")
    expect(JSON.stringify(result)).not.toContain(input.config.apiKey)
    expect(write).not.toHaveBeenCalled()
  })
  it("reopens automatically superseded findings after retry while retaining user decisions", async () => {
    const finding = await reviewSourceSummaryWithJev(input)
    syncJevCitationReviews(input.sourcePath, finding.items)
    const findingId = useReviewStore.getState().items[0].id
    evaluate.mockRejectedValueOnce(new Error("Temporary failure"))
    const pending = await reviewSourceSummaryWithJev(input)
    syncJevCitationReviews(input.sourcePath, pending.items)
    expect(useReviewStore.getState().items.find((item) => item.id === findingId)?.resolved).toBe(true)
    syncJevCitationReviews(input.sourcePath, finding.items)
    expect(useReviewStore.getState().items.find((item) => item.id === findingId)).toMatchObject({ resolved: false, resolvedAction: undefined })
    useReviewStore.getState().resolveItem(findingId, "User reviewed this claim")
    syncJevCitationReviews(input.sourcePath, pending.items)
    syncJevCitationReviews(input.sourcePath, finding.items)
    expect(useReviewStore.getState().items.find((item) => item.id === findingId)).toMatchObject({ resolved: true, resolvedAction: "User reviewed this claim" })
  })
  it("does not silently truncate large sources and present them as verified", async () => {
    const result = await reviewSourceSummaryWithJev({ ...input, sourceText: "x".repeat(28_001) })
    expect(result.detail).toBe("Jev citation check pending")
    expect(stream).not.toHaveBeenCalled()
  })
})
