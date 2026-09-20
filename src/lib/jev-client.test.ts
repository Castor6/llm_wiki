import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock("./tauri-fetch", () => ({ getHttpFetch: async () => mockFetch }))

import { DEFAULT_JEV_CONFIG, normalizeJevConfig } from "./jev-config"
import { evaluateJev, type JevRequest } from "./jev-client"

const config = { ...DEFAULT_JEV_CONFIG, enabled: true, apiKey: "test-secret" }
const request: JevRequest = {
  state: { source: "The library opens at 9 AM." },
  questions: { supported: { type: "noul", instructions: "Does the library open at 9 AM?" } },
}
const result = () => ({
  model: "jev-1.13.0",
  answers: { supported: { type: "noul", noul: 0.98 } },
  usage: { input_tokens: 50, output_tokens: 12 },
})
const response = (body: unknown = result(), status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers })

beforeEach(() => { mockFetch.mockReset() })
afterEach(() => { vi.useRealTimers() })

describe("Jev configuration", () => {
  it("normalizes missing and malformed persisted settings without enabling requests", () => {
    expect(normalizeJevConfig()).toEqual(DEFAULT_JEV_CONFIG)
    expect(normalizeJevConfig({ enabled: "true", apiKey: 42, model: " ", timeoutSeconds: NaN }))
      .toEqual(DEFAULT_JEV_CONFIG)
    expect(normalizeJevConfig({ enabled: true, apiKey: " key ", model: " jev-latest ", timeoutSeconds: 900 }))
      .toEqual({ enabled: true, apiKey: "key", model: "jev-latest", timeoutSeconds: 120 })
    expect(normalizeJevConfig({ timeoutSeconds: -2 }).timeoutSeconds).toBe(1)
  })
})

describe("evaluateJev", () => {
  it("uses the fixed typed endpoint and preserves actual model and token usage", async () => {
    mockFetch.mockResolvedValue(response({ ...result(), ignored: "provider-only data" }))
    const actual = await evaluateJev(config, request)
    expect(actual).toEqual(result())
    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe("https://api.typesafe.ai/v1/systemone")
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe("Bearer test-secret")
    expect(JSON.parse(init.body)).toEqual({ ...request, model: "jev-1.13.0" })
  })

  it("validates Choice and Score against the questions and discards extra provider fields", async () => {
    const mixed: JevRequest = { state: "A fact.", questions: {
      relation: { type: "choice", instructions: "Relation?", criteria: { supports: "Supported", unknown: "Unknown" } },
      relevance: { type: "score", instructions: "Relevance?", criteria: ["Unrelated", "Relevant"] },
    } }
    mockFetch.mockResolvedValue(response({ model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 30 }, answers: {
      relation: { type: "choice", choice: "supports", confidence: 0.9, probabilities: { supports: 0.95, unknown: 0.05 }, debug: "omit" },
      relevance: { type: "score", score: 0.8, confidence: 0.5, probabilities: { "0": 0.2, "1": 0.8 }, legend: { "0": "Unrelated", "1": "Relevant" } },
    } }))
    const actual = await evaluateJev(config, mixed)
    expect(actual.answers.relation).toEqual({ type: "choice", choice: "supports", confidence: 0.9, probabilities: { supports: 0.95, unknown: 0.05 } })
    expect(actual.answers.relevance).toMatchObject({ type: "score", score: 0.8 })
  })

  it.each([
    { answers: {} },
    { answers: { supported: { type: "choice", choice: "yes" } } },
    { answers: { supported: { type: "noul", noul: 1.1 } } },
    { answers: { supported: { type: "noul", noul: "0.98" } } },
    { answers: { ...result().answers, extra: { type: "noul", noul: 1 } } },
    { usage: { input_tokens: -1, output_tokens: 0 } },
    { usage: { input_tokens: 10, output_tokens: 0.5 } },
    { model: "provider-secret-content" },
  ])("rejects a malformed response without echoing its body: %j", async (changes) => {
    mockFetch.mockResolvedValue(response({ ...result(), ...changes, secret: "test-secret" }))
    await expect(evaluateJev(config, request)).rejects.toMatchObject({
      code: "invalid_response", message: "Jev returned an invalid judgment response.",
    })
  })

  it.each([
    { choice: "unrequested" },
    { probabilities: { yes: 0.8 } },
    { probabilities: { yes: 0.8, no: 0.8 } },
    { probabilities: { yes: 0.1, no: 0.9 } },
    { confidence: 2 },
  ])("rejects invalid Choice options or distributions: %j", async (changes) => {
    mockFetch.mockResolvedValue(response({ ...result(), answers: {
      supported: { type: "choice", choice: "yes", confidence: 0.8, probabilities: { yes: 0.9, no: 0.1 }, ...changes },
    } }))
    await expect(evaluateJev(config, { ...request, questions: {
      supported: { type: "choice", instructions: "Supported?", criteria: { yes: "Yes", no: "No" } },
    } })).rejects.toMatchObject({ code: "invalid_response" })
  })

  it.each([
    { score: 2 },
    { score: null },
    { legend: { "0": "Unrelated" } },
    { probabilities: { "0": -0.1, "1": 1.1 } },
  ])("rejects malformed Score levels: %j", async (changes) => {
    mockFetch.mockResolvedValue(response({ ...result(), answers: {
      supported: { type: "score", score: 0.8, confidence: 0.6, probabilities: { "0": 0.2, "1": 0.8 }, legend: { "0": "Unrelated", "1": "Relevant" }, ...changes },
    } }))
    await expect(evaluateJev(config, { ...request, questions: {
      supported: { type: "score", instructions: "Relevant?", criteria: ["Unrelated", "Relevant"] },
    } })).rejects.toMatchObject({ code: "invalid_response" })
  })

  it("fails closed without a key, when disabled, and with empty questions", async () => {
    await expect(evaluateJev(DEFAULT_JEV_CONFIG, request)).rejects.toMatchObject({ code: "disabled" })
    await expect(evaluateJev({ ...config, apiKey: " " }, request)).rejects.toMatchObject({ code: "missing_key" })
    await expect(evaluateJev(config, { state: "", questions: {} })).rejects.toMatchObject({ code: "invalid_request" })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("retries rate limits using Retry-After and temporary overloads using backoff", async () => {
    vi.useFakeTimers()
    mockFetch.mockResolvedValueOnce(response({}, 429, { "Retry-After": "2" }))
      .mockResolvedValueOnce(response({}, 529)).mockResolvedValueOnce(response())
    const pending = evaluateJev(config, request)
    await vi.advanceTimersByTimeAsync(1999)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toEqual(result())
    expect(mockFetch).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("bounds repeated server errors at three attempts", async () => {
    vi.useFakeTimers()
    mockFetch.mockImplementation(async () => response({ message: "test-secret" }, 503))
    const assertion = expect(evaluateJev(config, request)).rejects.toMatchObject({ code: "http", status: 503 })
    await vi.advanceTimersByTimeAsync(1500)
    await assertion
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it("does not retry authentication errors or reveal raw network failures", async () => {
    mockFetch.mockResolvedValueOnce(response({ message: "test-secret" }, 401))
    await expect(evaluateJev(config, request)).rejects.toMatchObject({ code: "http", message: "Jev request failed (HTTP 401)." })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    mockFetch.mockRejectedValueOnce(new Error("Request failed with Authorization: test-secret"))
    await expect(evaluateJev(config, request)).rejects.toMatchObject({ code: "network", message: "Could not reach TypeSafe. Please try again." })
  })

  it("rejects non-JSON success bodies without exposing their contents", async () => {
    mockFetch.mockResolvedValue(new Response("test-secret", { status: 200 }))
    await expect(evaluateJev(config, request)).rejects.toMatchObject({ code: "invalid_response" })
  })

  it("cancels before a request or while a transport ignores cancellation", async () => {
    const cancelled = new AbortController()
    cancelled.abort("sensitive cancellation reason")
    await expect(evaluateJev(config, request, cancelled.signal)).rejects.toMatchObject({ name: "AbortError", message: "Jev evaluation cancelled." })
    expect(mockFetch).not.toHaveBeenCalled()
    mockFetch.mockImplementation(() => new Promise(() => {}))
    const active = new AbortController()
    const assertion = expect(evaluateJev(config, request, active.signal)).rejects.toMatchObject({ name: "AbortError" })
    await Promise.resolve()
    active.abort()
    await assertion
    expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it("cancels during retry backoff without sending another request", async () => {
    vi.useFakeTimers()
    mockFetch.mockResolvedValue(response({}, 429, { "Retry-After": "10" }))
    const controller = new AbortController()
    const assertion = expect(evaluateJev(config, request, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await assertion
    await vi.advanceTimersByTimeAsync(20_000)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("applies the deadline to response-body reading, not only response headers", async () => {
    vi.useFakeTimers()
    mockFetch.mockResolvedValue({ ok: true, json: () => new Promise(() => {}) })
    const assertion = expect(evaluateJev({ ...config, timeoutSeconds: 1 }, request)).rejects.toMatchObject({ code: "timeout" })
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps a long Retry-After within the overall request deadline", async () => {
    vi.useFakeTimers()
    mockFetch.mockResolvedValue(response({}, 429, { "Retry-After": "60" }))
    const assertion = expect(evaluateJev({ ...config, timeoutSeconds: 1 }, request)).rejects.toMatchObject({ code: "timeout" })
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
