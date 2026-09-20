import { beforeAll, describe, expect, it, vi } from "vitest"

// Keep Node tests independent of desktop storage; HTTP uses the real transport fallback.
vi.mock("@/stores/wiki-store", () => ({ useWikiStore: { getState: () => ({}) } }))

import { evaluateJev, type JevQuestion } from "./jev-client"
import { DEFAULT_JEV_CONFIG } from "./jev-config"
import { checkCitationsWithJev } from "./jev-citations"

const enabled = process.env.RUN_JEV_LIVE_TESTS === "1"
const apiKey = process.env.TYPESAFE_API_KEY ?? ""
const model = process.env.TYPESAFE_MODEL || DEFAULT_JEV_CONFIG.model
const criteria = {
  supported: "The evidence explicitly supports the entire claim.",
  contradicted: "The evidence explicitly contradicts the claim.",
  insufficient: "The evidence does not establish whether the claim is true or false.",
}

describe.skipIf(!enabled)("Jev live synthetic evidence judgments", () => {
  beforeAll(() => {
    expect(Boolean(apiKey), "RUN_JEV_LIVE_TESTS requires TYPESAFE_API_KEY").toBe(true)
  })

  it.each([
    {
      language: "English",
      evidence: "The Cedar Library opens at 9 AM on Mondays. It closes at 5 PM on Mondays.",
      claims: { supported: "The Cedar Library opens at 9 AM on Mondays.", contradicted: "The Cedar Library opens at 10 AM on Mondays.", insufficient: "The Cedar Library is open on Sundays." },
    },
    {
      language: "Chinese",
      evidence: "松林图书馆星期一上午九点开门，星期一下午五点关门。",
      claims: { supported: "松林图书馆星期一上午九点开门。", contradicted: "松林图书馆星期一上午十点开门。", insufficient: "松林图书馆星期日开放。" },
    },
  ])("distinguishes support, contradiction and missing evidence in $language", async ({ evidence, claims }) => {
    const questions: Record<string, JevQuestion> = Object.fromEntries(Object.entries(claims).map(([id, claim]) => [id, {
      type: "choice",
      instructions: { question: "Using only `evidence`, classify the relationship to `claim`. Do not use outside knowledge.", claim },
      criteria,
    }]))
    const result = await evaluateJev({ ...DEFAULT_JEV_CONFIG, enabled: true, apiKey, model }, { state: { evidence }, questions })
    const verdict = Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => [id, answer.type === "choice" ? answer.choice : "invalid_type"]))
    // Do not log settings, headers, request content, or raw provider responses.
    console.log(JSON.stringify({ model: result.model, usage: result.usage, verdict }))
    expect(result.usage.input_tokens).toBeGreaterThan(0)
    expect(verdict).toEqual({ supported: "supported", contradicted: "contradicted", insufficient: "insufficient" })
  }, 35_000)

  it("checks a saved-summary claim through the citation pipeline", async () => {
    const [result] = await checkCitationsWithJev("The library is open on Monday. It is closed on Sunday.",
      [{ claim: "The library is open on Sunday.", quote: "It is closed on Sunday." }],
      { ...DEFAULT_JEV_CONFIG, enabled: true, apiKey, model })
    console.log(JSON.stringify({ model: result.model, inputTokens: result.inputTokens, verdict: result.verdict }))
    expect(result.verdict).toBe("contradicts")
  }, 35_000)
})
