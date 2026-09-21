import { beforeEach, describe, expect, it, vi } from "vitest"
import { checkCitationsWithJev, parseCitationCandidates } from "./jev-citations"
import { DEFAULT_JEV_CONFIG } from "./jev-config"

const { evaluate } = vi.hoisted(() => ({ evaluate: vi.fn() }))
vi.mock("./jev-client", () => ({ evaluateJev: evaluate }))
const config = { ...DEFAULT_JEV_CONFIG, enabled: true, apiKey: "test-only" }
beforeEach(() => { evaluate.mockReset() })

describe("citation candidates", () => {
  it("rejects claims invented by the extraction model", () => {
    expect(() => parseCitationCandidates(JSON.stringify([
      { claim: "An invented claim not in the page.", quote: "Evidence" },
    ]), "The actual summary.")).toThrow("does not match")
  })
  it("accepts exact claims with normalized whitespace and keeps unsupported candidates", () => {
    expect(parseCitationCandidates('```json\n[{"claim":"English only is supported.","quote":""}]\n```',
      "English only\nis supported.")).toEqual([{ claim: "English only is supported.", quote: "" }])
  })
})

describe("Jev citation checks", () => {
  it("does not spend an API call on missing or nonexistent quotes", async () => {
    const results = await checkCitationsWithJev("Actual source text", [
      { claim: "First claim", quote: "Invented quotation" },
      { claim: "Second claim", quote: "" },
    ], config)
    expect(results.map((result) => result.verdict)).toEqual(["quote_not_found", "insufficient"])
    expect(evaluate).not.toHaveBeenCalled()
  })
  it("includes nearby restrictions when judging a matching quote", async () => {
    evaluate.mockResolvedValue({ model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 10 },
      answers: { relation: { type: "choice", choice: "insufficient", confidence: 0.9,
        probabilities: { supports: 0.02, contradicts: 0.01, insufficient: 0.97 } } } })
    const [result] = await checkCitationsWithJev(
      "This result applies only to the internal English dataset. Model A outperformed model B.",
      [{ claim: "Model A always outperforms model B.", quote: "Model A outperformed model B." }], config)
    expect(evaluate.mock.calls[0][1].state.source_context).toContain("only to the internal English dataset")
    expect(result).toMatchObject({ verdict: "insufficient", model: "jev-1.13.0", inputTokens: 100 })
  })
  it("cancels before sending evidence", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(checkCitationsWithJev("Evidence", [{ claim: "Claim", quote: "Evidence" }], config,
      controller.signal)).rejects.toThrow()
    expect(evaluate).not.toHaveBeenCalled()
  })
})
