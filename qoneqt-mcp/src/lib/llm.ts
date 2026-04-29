/**
 * Optional LLM summarization for explain_why narratives.
 * Default OFF. Opt-in via summarize:true in the tool args.
 *
 * Provider preference:
 *   1. Anthropic (claude-haiku-4-5)  via ANTHROPIC_API_KEY
 *   2. OpenAI    (gpt-4o-mini)       via OPENAI_API_KEY
 */

export interface LLMSummary {
  text: string;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  summarize(systemPrompt: string, userPrompt: string): Promise<LLMSummary>;
}

export function pickLLMProvider(): LLMProvider | null {
  if (process.env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider(
      process.env.ANTHROPIC_API_KEY,
      process.env.QONEQT_MCP_LLM_MODEL ?? "claude-haiku-4-5",
    );
  }
  if (process.env.OPENAI_API_KEY) {
    return new OpenAIProvider(
      process.env.OPENAI_API_KEY,
      process.env.QONEQT_MCP_LLM_MODEL ?? "gpt-4o-mini",
    );
  }
  return null;
}

class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  constructor(private apiKey: string, public readonly model: string) {}

  async summarize(systemPrompt: string, userPrompt: string): Promise<LLMSummary> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 600,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (!res.ok) {
      throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = json.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n")
      .trim();
    return {
      text,
      provider: this.name,
      model: this.model,
      inputTokens: json.usage?.input_tokens,
      outputTokens: json.usage?.output_tokens,
    };
  }
}

class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  constructor(private apiKey: string, public readonly model: string) {}

  async summarize(systemPrompt: string, userPrompt: string): Promise<LLMSummary> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 600,
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`openai ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      choices: Array<{ message: { content: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = (json.choices[0]?.message.content ?? "").trim();
    return {
      text,
      provider: this.name,
      model: this.model,
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
    };
  }
}
