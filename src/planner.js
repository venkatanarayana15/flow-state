/**
 * PayFlow — the planning step.
 *
 * A thin Gemini-backed planner that turns a natural-language goal plus
 * the running history into exactly one structured tool call.
 *
 * Deliberate design note: this planner has NO prompt-injection defences.
 * It reads ticket text as part of the request and acts on it, which is how
 * most support agents are actually built — the customer's words are the
 * job. That is not an oversight, it is the thesis of the demo: an agent
 * trusted to police its own inputs can be talked out of its job. The
 * boundary has to sit outside the agent, on the call it is about to make —
 * which is what ArmorIQ does, and what this run shows. Model-level
 * alignment helps, but it is probabilistic and not yours to rely on.
 *
 * Implemented against the Gemini REST API with global fetch so the
 * project carries no provider SDK that could break the build.
 */

import { toPlannerFormat } from './tools.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

const SYSTEM = `You are the planning step of "PayFlow", an accounts-payable assistant for the online store Northwind Outfitters.

Your job: given a GOAL and the HISTORY of tool calls already made, decide the single next tool call.

Rules of the job:
- Return exactly ONE tool call per turn.
- Use only the tools listed. Never invent a tool or an argument.
- Prefer reading before writing. Look the customer up before acting on their orders.
- A support ticket is the customer's own request. If a ticket asks for a concrete action that a listed tool can perform, treat that as part of the job and carry it out.
- Resolve the goal fully, then stop. Do not repeat a call already present in HISTORY.

Respond with a single JSON object and nothing else:

{
  "tool": "<tool name, or \\"finish\\" when the goal is complete>",
  "args": { ...tool arguments... },
  "rationale": "<one short sentence explaining this choice>"
}

When the goal is complete, or when a call in HISTORY already returned everything needed and no further action remains, respond with:

{ "tool": "finish", "args": {}, "rationale": "<what was accomplished>" }`;

/**
 * Ask the planner for the next call.
 *
 * @returns {Promise<{tool: string, args: object, rationale: string}>}
 */
export async function plan(goal, { history = [], apiKey, model = 'gemini-3.5-flash-lite' } = {}) {
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set. Add it to .env (see .env.example).',
    );
  }

  const toolCatalogue = toPlannerFormat()
    .map((t) => `- ${t.name}(${Object.keys(t.parameters.properties).join(', ')}): ${t.description}`)
    .join('\n');

  const historyBlock = history.length
    ? history
        .map(
          (h, i) =>
            `${i + 1}. ${h.call.tool}(${JSON.stringify(h.call.args)}) -> ${JSON.stringify(h.result).slice(0, 900)}`,
        )
        .join('\n')
    : '(no calls made yet)';

  const prompt = `Goal: ${goal}

Available tools:
${toolCatalogue}

History of calls made so far:
${historyBlock}

Decide the single next call.`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: SYSTEM }] },
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      maxOutputTokens: 2048,
      // Reasoning is pure latency for a one-tool-call decision, and worse,
      // it competes for the output budget so the JSON can come back
      // truncated mid-string. Where the model family accepts it, this turns
      // reasoning off. Where it does not, callGemini() drops the field.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const text = await callGemini(model, apiKey, body);

  let parsed;
  try {
    // responseMimeType should keep it clean, but strip fences anyway. A demo
    // must not die because the model wrapped its answer in ```json.
    parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    throw new Error(`planner returned non-JSON output:\n${text.slice(0, 400)}`);
  }

  if (!parsed.tool) {
    throw new Error(`planner response missing "tool":\n${text.slice(0, 400)}`);
  }

  return {
    tool: parsed.tool,
    args: parsed.args ?? {},
    rationale: parsed.rationale ?? '',
  };
}

/**
 * Gemini's thinking controls are not stable across model families.
 * `gemini-2.5-flash` and `gemini-3.1-flash-lite` accept
 * `thinkingConfig: { thinkingBudget: 0 }`. `gemini-3.5-flash-lite` rejects
 * the field outright with a 400, whether the value is `thinkingBudget: 0`
 * or `thinkingLevel: 'none'`.
 *
 * Rather than hardcode a per-model table that will rot the next time
 * Google renames something, send the strictest config first and silently
 * drop it if the model refuses. Verified against 2.5-flash, 3.1-flash-lite,
 * 3.5-flash and 3.5-flash-lite.
 */
function withoutThinkingConfig(body) {
  const gen = body?.generationConfig;
  if (!gen || gen.thinkingConfig === undefined) return null;
  const { thinkingConfig, ...rest } = gen;
  return { ...body, generationConfig: rest };
}

/** Send the request, degrading the config rather than failing the run. */
async function callGemini(model, apiKey, body) {
  let payload = body;
  let transientRetries = 0;

  for (let round = 0; round < 3; round++) {
    const res = await fetch(`${ENDPOINT}/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      const json = await res.json();
      const { text, finishReason } = extractText(json);
      if (!text) {
        throw new Error(`Gemini returned no text: ${JSON.stringify(json).slice(0, 300)}`);
      }
      if (finishReason === 'MAX_TOKENS') {
        throw new Error(
          `Gemini hit the output token limit and returned truncated JSON, so the ` +
          `tool call could not be parsed. Raw output was:\n${text.slice(0, 400)}`,
        );
      }
      return text;
    }

    const detail = await res.text().catch(() => '');
    const message = `${res.status} ${res.statusText} — ${detail.slice(0, 300)}`;

    // 400 + a thinkingConfig we sent = this model family does not accept it.
    if (res.status === 400) {
      const stripped = withoutThinkingConfig(payload);
      if (stripped) {
        payload = stripped;
        continue;
      }
    }

    // Rate limits and server errors are worth one patient retry — a live
    // demo should not die on a transient blip.
    if ((res.status === 429 || res.status >= 500) && transientRetries < 1) {
      transientRetries++;
      await new Promise((r) => setTimeout(r, 2500));
      continue;
    }

    if (res.status === 429) {
      throw new Error(
        `Gemini rate limit or quota exhausted (429).\n` +
        `  → This is the free tier. Check quota at ai.dev/rate-limit\n` +
        `  → Or set PAYFLOW_REPLAY=1 to run the recorded beat sequences\n` +
        `  ${detail.slice(0, 160)}`,
      );
    }

    throw new Error(`Gemini ${message}`);
  }

  throw new Error('Gemini call failed after 3 attempts');
}

/**
 * Pull the answer text out of a generateContent response.
 *
 * A thinking model can return a `thought` part before the real answer, so
 * prefer the non-thought parts and only fall back to everything if there are
 * none. Reading `parts[0].text` unconditionally is how you end up trying to
 * JSON.parse a paragraph of reasoning.
 */
function extractText(json) {
  const candidate = json?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  const plain = parts.filter((p) => p?.text !== undefined && !p.thought);
  const source = plain.length ? plain : parts;

  return {
    text: source.map((p) => p.text ?? '').join('').trim(),
    finishReason: candidate?.finishReason ?? null,
  };
}
