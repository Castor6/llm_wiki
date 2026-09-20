import { useEffect, useRef, useState } from "react"
import { CheckCircle2, Loader2, XCircle } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useWikiStore } from "@/stores/wiki-store"
import { DEFAULT_JEV_CONFIG, normalizeJevConfig, type JevConfig } from "@/lib/jev-config"
import { evaluateJev } from "@/lib/jev-client"
import { saveJevConfig } from "@/lib/project-store"

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "success"; model: string; inputTokens: number; outputTokens: number }
  | { kind: "error"; message: string }

export function JevSection() {
  const { t } = useTranslation()
  const config = useWikiStore((s) => s.jevConfig)
  const [apiKey, setApiKey] = useState(config.apiKey)
  const [model, setModel] = useState(config.model)
  const [timeout, setTimeout] = useState(String(config.timeoutSeconds))
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const [testState, setTestState] = useState<TestState>({ kind: "idle" })
  const saveRevision = useRef(0)
  const testController = useRef<AbortController | null>(null)

  useEffect(() => {
    setApiKey(config.apiKey)
    setModel(config.model)
    setTimeout(String(config.timeoutSeconds))
  }, [config])

  useEffect(() => () => {
    testController.current?.abort()
    testController.current = null
    saveRevision.current += 1
  }, [])

  function clearTest() {
    testController.current?.abort()
    testController.current = null
    setTestState({ kind: "idle" })
  }

  async function persist(patch: Partial<JevConfig>) {
    clearTest()
    const next = normalizeJevConfig({ ...useWikiStore.getState().jevConfig, ...patch })
    useWikiStore.getState().setJevConfig(next)
    const revision = ++saveRevision.current
    setSaveStatus("saving")
    try {
      await saveJevConfig(next)
      if (revision === saveRevision.current) setSaveStatus("saved")
    } catch {
      // Storage errors can contain serialized values; never display or log them.
      if (revision === saveRevision.current) setSaveStatus("error")
    }
  }

  async function testConnection() {
    clearTest()
    const controller = new AbortController()
    testController.current = controller
    setTestState({ kind: "running" })
    try {
      // Testing is explicit and works while the integration is disabled.
      // Only this synthetic sentence is sent, never project content.
      const response = await evaluateJev(normalizeJevConfig({
        ...useWikiStore.getState().jevConfig,
        enabled: true,
        apiKey,
        model,
        timeoutSeconds: timeout.trim() ? Number(timeout) : DEFAULT_JEV_CONFIG.timeoutSeconds,
      }), {
        state: "The library opens at 9 AM.",
        questions: {
          connection_test: {
            type: "noul",
            instructions: "Does the state say the library opens at 9 AM?",
          },
        },
      }, controller.signal)
      if (testController.current !== controller || controller.signal.aborted) return
      setTestState({
        kind: "success",
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      })
    } catch (error) {
      if (testController.current !== controller || controller.signal.aborted) return
      setTestState({
        kind: "error",
        // The client uses static, credential-free messages for transport/API errors.
        message: error instanceof Error ? error.message : t("settings.sections.jev.testFailed"),
      })
    } finally {
      if (testController.current === controller) testController.current = null
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.jev.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.jev.description")}
        </p>
      </div>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          role="switch"
          checked={config.enabled}
          onChange={(event) => { void persist({ enabled: event.target.checked }) }}
          className="mt-0.5 h-4 w-4"
        />
        <div className="space-y-1">
          <span className="text-sm font-medium">{t("settings.sections.jev.enabled")}</span>
          <p className="text-xs text-muted-foreground">{t("settings.sections.jev.dataNotice")}</p>
        </div>
      </label>

      <div className="space-y-2">
        <Label htmlFor="jev-api-key">{t("settings.sections.jev.apiKey")}</Label>
        <Input
          id="jev-api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          placeholder={t("settings.sections.jev.apiKeyPlaceholder")}
          onChange={(event) => { setApiKey(event.target.value); clearTest() }}
          onBlur={() => { void persist({ apiKey }) }}
        />
        <p className="text-xs text-muted-foreground">{t("settings.sections.jev.storageHint")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="jev-model">{t("settings.sections.jev.model")}</Label>
        <Input
          id="jev-model"
          value={model}
          placeholder={DEFAULT_JEV_CONFIG.model}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => { setModel(event.target.value); clearTest() }}
          onBlur={() => { void persist({ model }) }}
        />
        <p className="text-xs text-muted-foreground">{t("settings.sections.jev.modelHint")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="jev-timeout">{t("settings.sections.jev.timeout")}</Label>
        <Input
          id="jev-timeout"
          type="number"
          min={1}
          max={120}
          step={1}
          className="max-w-32"
          value={timeout}
          onChange={(event) => { setTimeout(event.target.value); clearTest() }}
          onBlur={() => { void persist({
            timeoutSeconds: timeout.trim() ? Number(timeout) : DEFAULT_JEV_CONFIG.timeoutSeconds,
          }) }}
        />
      </div>

      <div className="space-y-3 border-t pt-4">
        <p className="text-xs text-muted-foreground">{t("settings.sections.jev.testHint")}</p>
        <Button
          variant="outline"
          onClick={() => { void testConnection() }}
          disabled={!apiKey.trim() || testState.kind === "running"}
        >
          {testState.kind === "running" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t(testState.kind === "running" ? "settings.sections.jev.testRunning" : "settings.sections.jev.testConnection")}
        </Button>
        <div aria-live="polite">
          {testState.kind === "success" && (
            <p className="flex items-start gap-2 text-sm text-green-600 dark:text-green-400">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t("settings.sections.jev.testSuccess", {
                model: testState.model,
                input: testState.inputTokens,
                output: testState.outputTokens,
              })}</span>
            </p>
          )}
          {testState.kind === "error" && (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{testState.message}</span>
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs" aria-live="polite">
        <p className={saveStatus === "error" ? "text-destructive" : "text-muted-foreground"}>
          {saveStatus === "error" ? t("settings.sections.jev.saveFailed")
            : saveStatus === "saving" ? t("settings.sections.jev.saving")
              : saveStatus === "saved" ? t("settings.savedTick")
                : t("settings.sections.jev.autoSaveHint")}
        </p>
        {saveStatus === "error" && (
          <Button size="sm" variant="outline" onClick={() => { void persist({}) }}>
            {t("settings.sections.jev.retrySave")}
          </Button>
        )}
      </div>
    </div>
  )
}
