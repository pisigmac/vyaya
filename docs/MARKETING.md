# Marketing

Positioning and messaging for Vyaya. The copy rules from the build spec
apply to everything derived from this doc: contractions, mix short
fragments with long sentences, name the enemy, end with periods, no
exclamation spam, and the banned-word list is law.

## Tagline

**See what your LLM spend is actually buying.**

It does three jobs. It names the gap (spend vs. value), it promises
visibility, and it avoids the word "cost" — every observability tool says
cost. We say what the spend bought, which lets us say: some of it bought
nothing.

## Positioning

Observability tools show you spend. Vyaya shows you waste.

Spend is a number that goes up. Waste is a bug with a receipt. That's the
whole positioning wedge: we don't tell you that you spent $40k on tokens
last month — you knew that. We tell you $9k of it was retried prompts,
unread responses, and completions your own schema rejected, and we hand
you the fix for each one.

Category: token-waste auditor. Not an LLM gateway, not an observability
platform, not a cost dashboard. Those categories are crowded with tools
that count. Vyaya accuses.

## Ideal customer profile

| Trait | Detail |
| --- | --- |
| Who | Platform or backend lead at a company shipping LLM features to production. |
| Stack | OpenAI-compatible APIs, TypeScript or Python services, Postgres somewhere in the stack. |
| Pain | LLM line item growing 20%+ month over month; no one can say why; finance has started asking. |
| Trigger | The first five-figure monthly invoice, or the first "why did yesterday cost 3x" incident. |
| Anti-ICP | Hobbyists on free tiers; teams whose entire LLM usage is one chatbot. Waste needs volume to matter. |

The buyer is the person who gets paged by the invoice. Usually an
engineering lead, occasionally a founder at a seed-stage company burning
$5-50k/month on tokens.

## Messaging pillars

### 1. Name the enemy: waste.

Not tokens, not models, not "AI costs". Waste — the spend that produces
nothing. The site says it outright: "The enemy is waste." Every wasted
dollar is a bug, and every bug gets a fix.

### 2. Dollars, not vibes.

Every finding has a dollar figure, computed from a versioned price table,
with evidence attached. No severity scores. No "consider reviewing". A
retry storm cost you $61.40 this month; here's the idempotency fix.

### 3. Five kinds, each with a fix.

Ghost output, retry storms, schema failure burn, context amnesia,
overprovisioned max tokens. The taxonomy is the product. It's small enough
to memorize and specific enough to act on. Every event ships with a
suggested fix — a code snippet, a config change, or a prompt fix you can
paste today.

### 4. Five minutes, one line.

Onboarding is a base-URL swap. TypeScript and Python snippets on the
onboarding screen, copy-paste ready. The first waste event can show up the
same afternoon.

### 5. We don't read your prompts.

Metadata-only by default. Bodies are opt-in, AES-256-GCM encrypted under
your workspace key, deleted after 7 days. One detector (context amnesia)
needs bodies and stays silent without them — we say that out loud instead
of quietly hoovering up prompts.

## Competitor contrast

| | Observability platforms (LangSmith, Helicone, Langfuse) | Cloud cost tools (Vantage, CloudZero) | Vyaya |
| --- | --- | --- | --- |
| Primary unit | Traces and spans | Dollars by service | Wasted dollars by cause |
| Question answered | "What happened?" | "What did we spend?" | "What should we stop paying for?" |
| Judgment | Shows data; you judge | Allocates cost; you judge | Classifies waste; attaches the fix |
| Latency contract | Varies | Batch (hours) | <10ms p95 added, measured |
| Setup | SDK instrumentation | Cloud account linking | One base-URL swap |

Don't trash the neighbors. LangSmith and friends are good at what they do
— debugging and evals. The contrast is purpose: they record, we accuse.
When you write comparison copy, lead with the question each tool answers,
not with their shortcomings.

## Landing page rationale

The landing page (`apps/web/app/page.tsx`) is the messaging doc rendered.

- **Hero**: tagline, then a paragraph that names the three most relatable
  waste types (retried, unread, schema-rejected). No screenshots above the
  fold — the number that matters doesn't exist until you connect traffic.
- **"The enemy is waste."**: the stance section. Two short paragraphs.
  This is where we stop sounding like a cost tool.
- **"What the invoice hides"**: three concrete examples (retry loop,
  unread chatbot answer, 4,096-token cap on a 60-word model). Specific
  beats abstract.
- **Five waste cards**: the taxonomy, one card per type, plus a sixth card
  promising evidence and a fix on every event. The grid deliberately
  breaks itself (offset cards) per the UI rules.
- **"How it works"**: three steps — point, classify, fix. Step two says
  "No LLM judging your LLM — that would cost money too." That line tests
  well with the ICP; keep it.
- **CTA**: "Start auditing." Verbs on buttons, always. Never "Submit",
  never "Get started".

What the page refuses: testimonials we don't have, logos we don't have,
star ratings, gradients, marquees. The UI rules ban them; the brand agrees
with the ban.

## Pricing pointer

Proposed tiers and the math behind them live in `docs/PRICING.md`. Short
version for positioning: free tier for evaluation (real proxy, real
detectors, real dashboard — not a crippled demo), team tier for the ICP,
business tier for multi-workspace and compliance needs. Metered billing
via Stripe usage records is plumbed in test mode; pricing is a decision,
not a guess — the doc shows the cost model.

## Voice checklist

Before shipping copy, check:

- Contractions. "It's", "doesn't", "you'll". Formal tone is off-brand.
- Sentences end with periods. Headlines too, when they're sentences.
- Fragments are fine. "One answer, several bills."
- The enemy is named. Waste, not spend, not costs.
- Buttons use specific verbs: "Create key", "Start auditing", "Send test
  request".
- No exclamation spam. One per page, maximum, and it had better earn it.
- Zero banned words. The list is in the build spec and enforced by scan.
