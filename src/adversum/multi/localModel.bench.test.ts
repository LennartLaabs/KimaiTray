import { describe, expect, it } from "vitest";
import { buildDraft, readMulti } from "./draft";
import { parseModelOutput } from "./extract";
import { catalog, history, now, SENTENCES } from "./fixtures";
import { HARD_SENTENCES } from "./hardSentences";
import { EXTRACT_GRAMMAR, localInput, localInstructions } from "./localPrompt";
import { draftSignature, matchesExpectation } from "./score";

/**
 * Measures a local language model on our sentences: how often its reading
 * is right, and how long it takes. Not part of `npm run check`; it needs the
 * helper program and a model file:
 *
 * ```sh
 * (cd src-tauri/llm-helper && cargo build --release)
 * ADVERSUM_LLM_HELPER=src-tauri/llm-helper/target/release/kimaitray-llm \
 *   ADVERSUM_LLM_MODEL=/path/model.gguf \
 *   npx vitest run src/adversum/multi/localModel.bench.test.ts --disable-console-intercept
 * ```
 *
 * For the 27 sentences of `sentences.test.ts` the rules' own reading is the
 * truth (it is checked there); for the ten hard ones it is written down in
 * `hardSentences.ts`.
 */
// The app's code is typed for the browser; this file alone runs in Node.
const env =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const helper = env.ADVERSUM_LLM_HELPER;
const model = env.ADVERSUM_LLM_MODEL;
const node = (name: string) => import(/* @vite-ignore */ name);
const evening = new Date(2026, 10, 26, 17, 30);

describe.runIf(helper && model)("a local model on our sentences", () => {
  it("is measured", { timeout: 30 * 60_000 }, async () => {
    const { spawn } = await node("node:child_process");
    const { createInterface } = await node("node:readline");
    const child = spawn(helper!, [model!], { stdio: ["pipe", "pipe", "inherit"] });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const next = async () => JSON.parse((await lines.next()).value as string);
    const loading = Date.now();
    expect(await next()).toMatchObject({ ready: true });
    const loadMs = Date.now() - loading;
    const instructions = localInstructions(catalog, ["Patrick", "Michi"]);

    const ask = async (sentence: string, at: Date) => {
      child.stdin.write(
        `${JSON.stringify({
          instructions,
          input: localInput(sentence),
          grammar: EXTRACT_GRAMMAR,
          maxTokens: 700,
        })}\n`,
      );
      const reply = await next();
      const extraction = reply.ok ? parseModelOutput(reply.text, sentence, at) : null;
      const draft = extraction ? buildDraft(extraction, catalog, history, at, "local") : null;
      return { reply, signature: draftSignature(draft) };
    };

    const times: number[] = [];
    const report: string[] = [];
    let plain = 0;
    for (const sentence of SENTENCES) {
      const expected = draftSignature(readMulti(sentence, catalog, history, now).draft);
      const { reply, signature } = await ask(sentence, now);
      const hit = JSON.stringify(signature) === JSON.stringify(expected);
      plain += hit ? 1 : 0;
      times.push(reply.ms ?? 0);
      report.push(`${hit ? "ok  " : "MISS"} ${String(reply.ms).padStart(5)} ms  ${sentence}`);
      if (!hit) report.push(`       want ${expected.join(" | ")}\n       got  ${signature.join(" | ")}`);
    }
    let hard = 0;
    let hardByRules = 0;
    // What the app does: the rules' reading stands where they are sure,
    // the model is asked where they are not.
    let hardTogether = 0;
    for (const { sentence, expect: expected } of HARD_SENTENCES) {
      const rules = readMulti(sentence, catalog, history, evening);
      const byRules = draftSignature(rules.draft);
      hardByRules += matchesExpectation(byRules, expected) ? 1 : 0;
      const { reply, signature } = await ask(sentence, evening);
      const hit = matchesExpectation(signature, expected);
      hard += hit ? 1 : 0;
      const asked = rules.suspect || !rules.draft || rules.draft.uncertain;
      const together = asked && signature.length > 0 ? signature : byRules;
      hardTogether += matchesExpectation(together, expected) ? 1 : 0;
      times.push(reply.ms ?? 0);
      report.push(`${hit ? "ok  " : "MISS"} ${String(reply.ms).padStart(5)} ms  ${sentence}`);
      if (!hit) {
        report.push(
          `       want ${expected.map((e) => `${e.customer} ${e.amount.join("/")}`).join(" | ")}\n       got  ${signature.join(" | ")}\n       raw  ${reply.text ?? reply.error}`,
        );
      }
    }
    child.stdin.end();

    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(report.join("\n"));
    console.log(
      `\n${model}\n` +
        `  the 27 sentences the rules read: ${plain}/27\n` +
        `  the 10 hard sentences: ${hard}/10 (rules alone: ${hardByRules}/10, rules then model: ${hardTogether}/10)\n` +
        `  load ${loadMs} ms · answer median ${median} ms · slowest ${sorted[sorted.length - 1]} ms`,
    );
    expect(times.length).toBe(37);
  });
});
