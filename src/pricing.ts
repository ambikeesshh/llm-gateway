// USD per 1M tokens, Standard (paid) tier, text, from
// https://ai.google.dev/gemini-api/docs/pricing (checked 2026-10-12). Output prices
// include thinking tokens. We charge list price even on the free tier: the budget
// models what the traffic *would* cost, so moving to a paid key doesn't change
// anyone's cap semantics.
export interface Price {
  inputPerM: number;
  outputPerM: number;
}

interface PricePeriod extends Price {
  /** Inclusive start, ISO date (UTC). Periods are listed oldest first. */
  from: string;
}

const PRICES: Record<string, PricePeriod[]> = {
  "gemini-3.8-flash": [
    { from: "2000-01-01", inputPerM: 0.75, outputPerM: 3.75 },
    { from: "2027-01-01", inputPerM: 1.5, outputPerM: 7.5 },
  ],
  "gemini-3.6-flash": [
    { from: "2000-01-01", inputPerM: 0.75, outputPerM: 3.75 },
    { from: "2027-01-01", inputPerM: 1.5, outputPerM: 7.5 },
  ],
  "gemini-3.5-flash-lite": [{ from: "2000-01-01", inputPerM: 0.3, outputPerM: 2.5 }],
  "gemini-3.1-flash-lite": [{ from: "2000-01-01", inputPerM: 0.25, outputPerM: 1.5 }],
  "gemini-3-flash-preview": [{ from: "2000-01-01", inputPerM: 0.5, outputPerM: 3 }],
  "gemini-3.1-pro-preview": [{ from: "2000-01-01", inputPerM: 2, outputPerM: 12 }],
  "gemini-2.5-pro": [{ from: "2000-01-01", inputPerM: 1.25, outputPerM: 10 }],
  "gemini-2.5-flash": [{ from: "2000-01-01", inputPerM: 0.3, outputPerM: 2.5 }],
  "gemini-2.5-flash-lite": [{ from: "2000-01-01", inputPerM: 0.1, outputPerM: 0.4 }],
};

// Unknown models (including aliases like gemini-flash-latest, whose target moves) are
// priced high so a misconfiguration over-reserves rather than under-charges.
const UNKNOWN: Price = { inputPerM: 2.5, outputPerM: 15 };
const FREE: Price = { inputPerM: 0, outputPerM: 0 };

export function priceFor(provider: string, model: string, at: Date = new Date()): Price {
  if (provider === "ollama" || provider === "mock") return FREE;
  const periods = PRICES[model];
  if (!periods) return UNKNOWN;
  const day = at.toISOString().slice(0, 10);
  return periods.findLast((p) => p.from <= day) ?? UNKNOWN;
}

// 1M tokens * (USD/1M) * (INR/USD) * (1e6 micros/INR) / 1M tokens == tokens * usdPerM * rate.
export function costMicros(
  price: Price,
  inputTokens: number,
  outputTokens: number,
  usdToInr: number,
): number {
  return Math.ceil(
    (inputTokens * price.inputPerM + outputTokens * price.outputPerM) * usdToInr,
  );
}

// Deliberately pessimistic (~3 chars/token; real English is closer to 4) because
// this number backs a budget reservation, and under-reserving lets keys overshoot.
export function estimateInputTokens(messages: { content: string }[]): number {
  let chars = 0;
  for (const m of messages) chars += m.content.length;
  return Math.ceil(chars / 3) + messages.length * 4 + 3;
}

export const microsToInr = (m: number) => Math.round(m) / 1_000_000;
export const inrToMicros = (inr: number) => Math.round(inr * 1_000_000);
