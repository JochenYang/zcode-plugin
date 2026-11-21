/**
 * model-speed — show the current model's output speed in the composer toolbar.
 *
 * Runtime is zero-dependency: the host injects `ctx` with all capabilities, so
 * there is nothing to import or build. The API contract is
 * docs/plugins/extension-host.md §10 (models.onDidGenerate) and §6
 * (composer.status slot).
 *
 * Data source: models.onDidGenerate fires with `phase: "streaming"` estimates
 * every 500 ms and one `phase: "final"` value per main-turn request with the
 * provider-reported output token count. We display only the final value —
 * the official user decision (2026-11-06) is not to show streaming estimates;
 * the slot keeps the last accurate value for that session.
 *
 * Anomaly guard: a few requests have an almost-zero generation window after
 * TTFT (e.g. 74 tokens with 31 ms of generation → 7,483 tok/s). Those values
 * are timing artifacts, not real throughput. Ignore a sample when the implied
 * generation time is below 300 ms or the computed speed is above 500 tok/s;
 * keep the previous value for that session instead.
 */

const MAX_PLAUSIBLE_TPS = 500;
const MIN_GENERATION_MS = 300;
const MIN_OUTPUT_TOKENS = 20;

const TEXTS = {
  en: {
    label: (tps) => `${Math.round(tps)} tok/s`,
    tooltip: ({ model, output, ttft }) =>
      `Model: ${model}\nOutput: ${output} tok\nTTFT: ${ttft} s`,
    last: (tps) => `Last request: ${Math.round(tps)} tok/s`,
    empty: "No completed generation yet",
  },
  zh: {
    label: (tps) => `${Math.round(tps)} tok/s`,
    tooltip: ({ model, output, ttft }) =>
      `模型：${model}\n输出：${output} tok\n首 token 用时：${ttft} 秒`,
    last: (tps) => `上一次请求：${Math.round(tps)} tok/s`,
    empty: "本会话还没有完成过生成",
  },
};

function strings(locale) {
  return String(locale || "").toLowerCase().startsWith("zh") ? TEXTS.zh : TEXTS.en;
}

function isPlausible(metrics) {
  if (metrics.phase !== "final") return false;
  const output = metrics.outputTokens;
  if (typeof output !== "number" || output < MIN_OUTPUT_TOKENS) return false;
  const tps = metrics.outputTokensPerSecond;
  if (!Number.isFinite(tps) || tps <= 0 || tps > MAX_PLAUSIBLE_TPS) return false;
  // The generation window is what the host divides by: duration - TTFT.
  // Reconstruct it from output/tps; anything below the floor is a timer artifact.
  const generationMs = (output / tps) * 1000;
  return generationMs >= MIN_GENERATION_MS;
}

export function activate(ctx) {
  // Locale can change at runtime; keep a live copy.
  let locale = "";
  if (typeof ctx.env?.get === "function") {
    try {
      locale = ctx.env.get().locale || "";
    } catch {
      /* capability may be unavailable in an older host */
    }
  }
  if (typeof ctx.env?.onDidChange === "function") {
    try {
      ctx.env.onDidChange((env) => {
        if (env && typeof env.locale === "string") locale = env.locale;
      });
    } catch {
      /* optional */
    }
  }

  // Track the last accepted sample per session so re-renders/tooltips stay stable.
  const lastBySession = new Map();

  if (typeof ctx.models?.onDidGenerate === "function") {
    ctx.models.onDidGenerate((metrics) => {
      if (!metrics || !metrics.sessionId || !isPlausible(metrics)) return;

      const tps = metrics.outputTokensPerSecond;
      const output = metrics.outputTokens;
      const ttftMs = metrics.timeToFirstTokenMs;
      const model = `${metrics.model?.modelId || ""}`.trim() || "unknown";
      const s = strings(locale);
      const tooltip = s.tooltip({
        model,
        output,
        ttft: typeof ttftMs === "number" ? (ttftMs / 1000).toFixed(1) : "-",
      });

      lastBySession.set(metrics.sessionId, { tps, tooltip, model });
      // Scope by session so two conversations never overwrite each other.
      ctx.slots.update("tps", { text: s.label(tps), tooltip }, { sessionId: metrics.sessionId });
    });
  }

  if (typeof ctx.commands?.register === "function") {
    ctx.commands.register("model-speed.show", (call) => {
      const sessionId = call?.scope?.kind === "session" ? call.scope.sessionId : null;
      const last = sessionId ? lastBySession.get(sessionId) : null;
      const s = strings(locale);
      return {
        ok: true,
        message: last ? s.last(last.tps) : s.empty,
      };
    });
  }
}
