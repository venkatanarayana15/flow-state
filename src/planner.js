/**
 * PayFlow — the planning step.
 *
 * A thin Gemini-backed planner that turns a natural-language goal plus
 * the running history into exactly one structured tool call.
 *
 * Deliberate design note: this planner has NO prompt-injection defences.
 * That is not an oversight, it is the thesis of the demo. An agent that
 * is trusted to police its own inputs is an agent that can be talked out
 * of its job. The boundary has to sit outside the agent, on the call it
 * is about to make — which is what ArmorIQ does, and what this run shows.
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
export async function plan(goal, { history = [], apiKey, model = 'gemini-2.5-flash' } = {}) {
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
      // Gemini 2.5 Flash reasons by default. For a one-tool-call decision that
      // reasoning is pure latency, and worse: it competes for the output token
      // budget, so the JSON comes back truncated mid-string and JSON.parse dies.
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

/** One retry on transient failures — demos do not get to fall over. */
async function callGemini(model, apiKey, body, attempt = 1) {
  const res = await fetch(`${ENDPOINT}/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const transient = res.status === 429 || res.status >= 500;
    if (transient && attempt === 1) {
      await new Promise((r) => setTimeout(r, 2500));
      return callGemini(model, apiKey, body, 2);
    }
    throw new Error(
      `Gemini ${res.status} ${res.statusText} — ${detail.slice(0, 300)}`,
    );
  }

  const json = await res.json();
  const { text, finishReason } = extractText(json);

  if (!text) {
    throw new Error(`Gemini returned no text: ${JSON.stringify(json).slice(0, 300)}`);
  }
  if (finishReason === 'MAX_TOKENS') {
    throw new Error(
      `Gemini hit the output token limit and returned truncated JSON, so the ` +
      `tool call could not be parsed. This means the model spent its budget on ` +
      `reasoning. Raw output was:\n${text.slice(0, 400)}`,
    );
  }
  return text;
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
