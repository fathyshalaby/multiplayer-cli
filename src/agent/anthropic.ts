import Anthropic from "@anthropic-ai/sdk";
import type { AgentBackend, AgentEvents, BackendOptions, TurnResult } from "./types.js";
import { TOOLS, riskOf, runTool, summarize } from "./tools.js";

/**
 * The built-in backend: one Anthropic conversation shared by the whole room.
 *
 * A manual streaming loop rather than the tool runner, because the room has to
 * get between the model's `tool_use` block and its execution in order to vote
 * on it — and because every delta has to be fanned out to every seat as it
 * arrives, not collected at the end.
 */
export class AnthropicBackend implements AgentBackend {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic;
  private messages: Anthropic.MessageParam[] = [];
  private opts: BackendOptions;

  constructor(opts: BackendOptions, client?: Anthropic) {
    this.opts = opts;
    this.model = opts.model;
    this.client = client ?? new Anthropic();
  }

  async send(prompt: string, events: AgentEvents, signal: AbortSignal): Promise<TurnResult> {
    this.messages.push({ role: "user", content: prompt });
    const usage: Record<string, number> = { input_tokens: 0, output_tokens: 0 };

    try {
      // Each pass is one model response; the loop continues while the model
      // keeps asking for tools that the room lets it run.
      for (let iteration = 0; iteration < 40; iteration++) {
        if (signal.aborted) return this.stopped(usage);

        const stream = this.client.messages.stream(
          {
            model: this.model,
            max_tokens: this.opts.maxTokens,
            system: [
              {
                type: "text",
                text: this.opts.systemPrompt,
                cache_control: { type: "ephemeral" },
              },
            ],
            thinking: this.opts.showThinking
              ? { type: "adaptive", display: "summarized" }
              : { type: "adaptive" },
            tools: TOOLS,
            messages: this.messages,
          },
          { signal },
        );

        stream.on("text", (delta) => events.onText(delta));
        if (this.opts.showThinking) {
          stream.on("thinking", (delta) => events.onThinking(delta));
        }

        const message = await stream.finalMessage();
        usage.input_tokens = (usage.input_tokens ?? 0) + message.usage.input_tokens;
        usage.output_tokens = (usage.output_tokens ?? 0) + message.usage.output_tokens;
        if (message.usage.cache_read_input_tokens) {
          usage.cache_read = (usage.cache_read ?? 0) + message.usage.cache_read_input_tokens;
        }

        this.messages.push({ role: "assistant", content: message.content });

        if (message.stop_reason === "pause_turn") continue;
        if (message.stop_reason === "refusal") {
          return { stopReason: "refusal", usage, error: message.stop_details?.explanation ?? "declined" };
        }
        if (message.stop_reason !== "tool_use") {
          return { stopReason: message.stop_reason ?? "end_turn", usage };
        }

        const calls = message.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );
        const results: Anthropic.ToolResultBlockParam[] = [];

        for (const call of calls) {
          if (signal.aborted) {
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: "The room interrupted this turn before the tool ran.",
              is_error: true,
            });
            continue;
          }

          const decision = await events.onToolRequest({
            toolUseId: call.id,
            name: call.name,
            input: call.input,
            risk: riskOf(call.name),
            summary: summarize(call.name, call.input),
          });

          if (!decision.allow) {
            events.onToolResult(call.id, false, `denied — ${decision.reason}`);
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: `The room declined this tool call (${decision.reason}). Do not retry it; explain what you would have done, or propose a different approach.`,
              is_error: true,
            });
            continue;
          }

          const outcome = await runTool(this.opts.cwd, call.name, call.input);
          events.onToolResult(call.id, outcome.ok, firstLines(outcome.content, 3));
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: outcome.content.slice(0, 100_000) || "(no output)",
            ...(outcome.ok ? {} : { is_error: true }),
          });
        }

        // All results for one assistant turn go back in a single user message.
        this.messages.push({ role: "user", content: results });
      }
      return { stopReason: "max_iterations", usage, error: "hit the tool-call ceiling for one turn" };
    } catch (err) {
      if (signal.aborted) return this.stopped(usage);
      return { stopReason: "error", usage, error: describeError(err) };
    }
  }

  private stopped(usage: Record<string, number>): TurnResult {
    // Leave the history coherent: an interrupted turn still needs an assistant
    // reply, or the next request starts with two user messages in a row.
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role === "user") {
      this.messages.push({ role: "assistant", content: "[interrupted by the room]" });
    }
    return { stopReason: "interrupted", usage };
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}

function firstLines(s: string, n: number): string {
  const lines = s.split("\n");
  const head = lines.slice(0, n).join("\n");
  return lines.length > n ? `${head}\n…` : head;
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "authentication failed — set ANTHROPIC_API_KEY or run `ant auth login`";
  }
  if (err instanceof Anthropic.RateLimitError) return "rate limited — try again shortly";
  if (err instanceof Anthropic.BadRequestError) return `bad request: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
  return (err as Error)?.message ?? String(err);
}
