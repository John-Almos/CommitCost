import type { Explainer } from "@commitcost/engine";
import { AnthropicExplainer } from "@commitcost/providers";

/** The LLM step is opt-in: COMMITCOST_LLM=anthropic plus Anthropic credentials. */
export function explainerFromEnv(env: NodeJS.ProcessEnv = process.env): Explainer | undefined {
  const choice = env.COMMITCOST_LLM?.toLowerCase();
  if (!choice || choice === "none") return undefined;
  if (choice === "anthropic") return new AnthropicExplainer({ model: env.COMMITCOST_LLM_MODEL || undefined });
  throw new Error(`Unknown COMMITCOST_LLM "${env.COMMITCOST_LLM}". Supported: anthropic, none.`);
}
