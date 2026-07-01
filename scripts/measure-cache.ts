// One-off diagnostic: does the analysis system prompt actually get cached?
// Run: npx tsx --env-file-if-exists=.env.local scripts/measure-cache.ts
//
// It (1) counts the real built system-prompt tokens vs each model's minimum
// cacheable prefix, and (2) fires two identical cached calls per model and reads
// cache_creation / cache_read from usage to prove empirically whether the
// ephemeral cache fires. Deletes nothing, changes no app code.
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { buildProfiledAnalysisPrompt } from "../lib/prompts.ts";

// Self-load .env.local (tsx doesn't reliably forward node's --env-file to its
// ESM child). Only fills vars that aren't already set.
if (!process.env.ANTHROPIC_API_KEY) {
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env.local — rely on ambient env */
  }
}

const MIN_PREFIX: Record<string, number> = {
  "claude-opus-4-8": 4096,
  "claude-sonnet-4-6": 2048,
};

async function main() {
  const client = new Anthropic();
  const systemPrompt = buildProfiledAnalysisPrompt("hard_goods");
  console.log(`system prompt: ${systemPrompt.length} chars\n`);

  for (const model of Object.keys(MIN_PREFIX)) {
    const min = MIN_PREFIX[model];

    // (1) exact token count of the system block
    const counted = await client.messages.countTokens({
      model,
      system: [{ type: "text", text: systemPrompt }],
      messages: [{ role: "user", content: "x" }],
    });
    const verdict = counted.input_tokens >= min ? "≥ min — CACHEABLE" : "< min — WILL NOT CACHE";
    console.log(`[${model}] count_tokens=${counted.input_tokens}  min_prefix=${min}  → ${verdict}`);

    // (2) live probe: two identical cached calls, read usage on each
    const req = {
      model,
      max_tokens: 16,
      system: [
        { type: "text" as const, text: systemPrompt, cache_control: { type: "ephemeral" as const } },
      ],
      messages: [{ role: "user" as const, content: "Reply with the single word OK." }],
    };
    const first = await client.messages.create(req);
    const second = await client.messages.create(req);
    const fmt = (u: Anthropic.Usage) =>
      `input=${u.input_tokens} cache_write=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0}`;
    console.log(`  call 1: ${fmt(first.usage)}`);
    console.log(`  call 2: ${fmt(second.usage)}`);
    const hit = (second.usage.cache_read_input_tokens ?? 0) > 0;
    console.log(`  → cache ${hit ? "HIT on 2nd call (working)" : "MISS on 2nd call (no-op)"}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
