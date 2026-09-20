import { normalizeJevConfig, type JevConfig } from "./jev-config"
import { getHttpFetch } from "./tauri-fetch"

export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue }
type Description = string | JSONValue[] | { [key: string]: JSONValue }

export interface JevChoiceQuestion {
  type: "choice"
  instructions: Description
  criteria: Record<string, Description | null>
}

export interface JevScoreQuestion {
  type: "score"
  instructions: Description
  criteria: Description[]
}

export interface JevNoulQuestion {
  type: "noul"
  instructions: Description
  criteria?: { true?: Description; false?: Description }
}

export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion
export type JevAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number }

export interface JevResponse {
  model: string
  answers: Record<string, JevAnswer>
  usage: { input_tokens: number; output_tokens: number }
}

export interface JevRequest {
  state: JSONValue
  questions: Record<string, JevQuestion>
}

type JevErrorCode = "disabled" | "missing_key" | "invalid_request" | "invalid_response" | "http" | "network" | "timeout"

/** Only static, safe messages reach the UI; never include response bodies or transport errors. */
export class JevError extends Error {
  constructor(public readonly code: JevErrorCode, message: string, public readonly status?: number) {
    super(message)
    this.name = "JevError"
  }
}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone"
const MAX_ATTEMPTS = 3

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
}

function invalidResponse(): never {
  throw new JevError("invalid_response", "Jev returned an invalid judgment response.")
}

function sameKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function readProbabilities(value: unknown, keys: string[]): Record<string, number> {
  if (!isObject(value) || !sameKeys(value, keys)) invalidResponse()
  let sum = 0
  const entries = keys.map((key) => {
    const probability = value[key]
    if (!isProbability(probability)) invalidResponse()
    sum += probability
    return [key, probability] as const
  })
  if (Math.abs(sum - 1) > 0.001) invalidResponse()
  return Object.fromEntries(entries)
}

function readResponse(raw: unknown, questions: JevRequest["questions"]): JevResponse {
  if (!isObject(raw) || typeof raw.model !== "string" || !/^jev-[\w.-]{1,100}$/.test(raw.model)
    || !isObject(raw.answers) || !sameKeys(raw.answers, Object.keys(questions)) || !isObject(raw.usage)) {
    invalidResponse()
  }
  const { input_tokens, output_tokens } = raw.usage
  if (typeof input_tokens !== "number" || !Number.isSafeInteger(input_tokens) || input_tokens < 0
    || typeof output_tokens !== "number" || !Number.isSafeInteger(output_tokens) || output_tokens < 0) {
    invalidResponse()
  }
  const answers: Record<string, JevAnswer> = Object.create(null)
  for (const [id, question] of Object.entries(questions)) {
    const answer = raw.answers[id]
    if (!isObject(answer) || answer.type !== question.type) invalidResponse()
    if (question.type === "noul") {
      if (!isProbability(answer.noul)) invalidResponse()
      answers[id] = { type: "noul", noul: answer.noul }
      continue
    }
    if (!isProbability(answer.confidence)) invalidResponse()
    const keys = question.type === "choice"
      ? Object.keys(question.criteria)
      : question.criteria.map((_, index) => String(index))
    const probabilities = readProbabilities(answer.probabilities, keys)
    if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !keys.includes(answer.choice)
        || keys.some((key) => probabilities[key] > probabilities[answer.choice as string] + 0.000001)) {
        invalidResponse()
      }
      answers[id] = { type: "choice", choice: answer.choice, probabilities, confidence: answer.confidence }
    } else {
      if (typeof answer.score !== "number" || !Number.isFinite(answer.score)
        || answer.score < 0 || answer.score > question.criteria.length - 1
        || !isObject(answer.legend) || !sameKeys(answer.legend, keys)
        || keys.some((key) => typeof (answer.legend as Record<string, unknown>)[key] !== "string")) {
        invalidResponse()
      }
      answers[id] = {
        type: "score", score: answer.score, probabilities, confidence: answer.confidence,
        legend: Object.fromEntries(keys.map((key) => [key, (answer.legend as Record<string, string>)[key]])),
      }
    }
  }
  return { model: raw.model, answers, usage: { input_tokens, output_tokens } }
}

function validateRequest(request: JevRequest): void {
  const entries = Object.values(request.questions)
  if (!entries.length || entries.some((question) => (
    question.type === "choice" && (Object.keys(question.criteria).length < 1 || Object.keys(question.criteria).length > 255)
  ) || (
    question.type === "score" && (question.criteria.length < 2 || question.criteria.length > 10)
  ))) {
    throw new JevError("invalid_request", "Jev requires questions with valid choice options or score levels.")
  }
}

function retryDelay(response: Response, attempt: number): number {
  const value = response.headers.get("retry-after")
  if (value) {
    const seconds = Number(value)
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
    if (Number.isFinite(delay) && delay >= 0) return Math.min(delay, 120_000)
  }
  return 500 * 2 ** attempt
}

function abortError(): DOMException {
  return new DOMException("Jev evaluation cancelled.", "AbortError")
}

/** Evaluate typed judgments, with one deadline covering transport, body reads, and retries. */
export async function evaluateJev(config: JevConfig, request: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
  if (signal?.aborted) throw abortError()
  const settings = normalizeJevConfig(config)
  if (!settings.enabled) throw new JevError("disabled", "Jev judgments are disabled.")
  if (!settings.apiKey) throw new JevError("missing_key", "A TypeSafe API key is required.")
  validateRequest(request)
  const controller = new AbortController()
  let timedOut = false
  let delayTimer: ReturnType<typeof setTimeout> | undefined
  const onCancel = () => controller.abort()
  signal?.addEventListener("abort", onCancel, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, settings.timeoutSeconds * 1000)
  const cancellation = () => timedOut
    ? new JevError("timeout", "Jev evaluation timed out.")
    : abortError()
  let rejectAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(cancellation())
    controller.signal.addEventListener("abort", rejectAbort, { once: true })
  })
  const checkCancelled = () => {
    if (controller.signal.aborted) throw cancellation()
  }

  try {
    const run = async (): Promise<JevResponse> => {
      const httpFetch = await getHttpFetch()
      const body = JSON.stringify({ state: request.state, model: settings.model, questions: request.questions })
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        checkCancelled()
        const response = await httpFetch(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        })
        checkCancelled()
        if (response.ok) {
          let raw: unknown
          try {
            raw = await response.json()
          } catch {
            checkCancelled()
            invalidResponse()
          }
          checkCancelled()
          return readResponse(raw, request.questions)
        }
        void response.body?.cancel().catch(() => {})
        const retryable = response.status === 429 || response.status === 529 || response.status >= 500
        if (!retryable || attempt === MAX_ATTEMPTS - 1) {
          throw new JevError("http", `Jev request failed (HTTP ${response.status}).`, response.status)
        }
        await Promise.race([
          new Promise<void>((resolve) => { delayTimer = setTimeout(resolve, retryDelay(response, attempt)) }),
          aborted,
        ])
      }
      throw new JevError("network", "Could not reach TypeSafe. Please try again.")
    }
    return await Promise.race([run(), aborted])
  } catch (error) {
    if (controller.signal.aborted) throw cancellation()
    if (error instanceof JevError) throw error
    throw new JevError("network", "Could not reach TypeSafe. Please try again.")
  } finally {
    clearTimeout(timeout)
    clearTimeout(delayTimer)
    signal?.removeEventListener("abort", onCancel)
    controller.signal.removeEventListener("abort", rejectAbort)
  }
}
