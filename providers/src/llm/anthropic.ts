import Anthropic from "@anthropic-ai/sdk";
import { buildExplanationPrompt, type ExplanationInput, type Explainer } from "@commitcost/engine";

export interface AnthropicExplainerOptions {
  /** Defaults to ANTHROPIC_API_KEY / the SDK's standard credential chain. */
  client?: Pick<Anthropic, "beta">;
  model?: string;
}

/**
 * Explainer backed by Claude. Optional: enable with COMMITCOST_LLM=anthropic.
 * Sends the suspect's diff (capped) and cost context; nothing else.
 */
export class AnthropicExplainer implements Explainer {
  readonly name = "anthropic";
  private readonly client: Pick<Anthropic, "beta">;
  private readonly model: string;

  constructor(options: AnthropicExplainerOptions = {}) {
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? "claude-opus-5-5";
  }

  async explain(input: ExplanationInput): Promise<string> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 2000,
      // A short explanation doesn't need deep thinking.
      output_config: { effort: "low" },
      // If a safety classifier declines, retry on a fallback model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: buildExplanationPrompt(input) }],
    });
    if (response.stop_reason === "refusal") throw new Error("The model declined to explain this change");
    return response.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("")
      .trim();
  }
}
