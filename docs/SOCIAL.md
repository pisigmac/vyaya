# Social + launch

Ten ready-to-post drafts and the launch checklist. Copy rules apply:
contractions, fragments mixed with long sentences, periods at the end, no
exclamation spam, banned-word list enforced. Swap in real numbers from
your own audit before posting — the placeholder-free rule means these ship
with the numbers we can defend (our measured latency, the five detectors,
the e2e audit run), not invented customer stats.

## X / Twitter drafts

**1. The announcement.**
> Your LLM invoice says tokens. It doesn't say how many were wasted — retried, unread, or burned on output your schema rejected. Vyaya sits in front of your LLM traffic and prices the waste. Five detectors. Dollars, not vibes. See what your spend is actually buying.

**2. The taxonomy.**
> Five kinds of LLM waste we detect: ghost output (responses nobody read), retry storms (the same prompt 3+ times in a minute), schema failure burn (JSON your schema rejected), context amnesia (every turn re-sends the same background), overprovisioned max_tokens (you reserved 4,096 and used 60). Each one comes with a fix.

**3. The latency receipt.**
> "Won't a proxy slow down my LLM calls?" We measured. p95 added latency: 3.7ms isolated, under 7ms with the full test suite hammering the box. Budget is 10ms p95 and the test suite enforces it — with the logging database down.

**4. The stance.**
> The enemy is waste. Not tokens. Not models. Waste — the spend that produces nothing. Teams guess at it from invoices and vibes, and the guess is always low.

**5. The privacy one.**
> Vyaya doesn't read your prompts. Metadata-only by default. If you opt into body logging, prompts are AES-256-GCM encrypted under your workspace key and deleted after 7 days. One detector needs bodies to work; it stays silent without them. That's the deal, stated plainly.

**6. The determinism one.**
> No LLM judging your LLM. That would cost money too. Vyaya's waste detectors are deterministic heuristics — same logs, same findings, every time. Every event pins its detector version so re-runs reproduce exactly.

**7. The fix-first one.**
> Most dashboards end at "here's a chart." Every Vyaya waste event ships with a suggested fix — a code snippet, a config change, or a prompt fix you can paste today. Waste with a receipt and a remedy.

**8. The onboarding one.**
> Five minutes. One line changed in your SDK — swap base_url, add one header. Your code doesn't change; your traffic flows through the proxy and the dashboard starts talking.

**9. The retry-storm story.**
> A retry loop fired four times before anyone noticed. One answer, several bills. Vyaya clusters identical prompt hashes inside a 60-second window and prices every attempt before the one that succeeded.

**10. The launch-day one.**
> We built Vyaya because the LLM line item kept growing and nobody could say why. It's a proxy, five deterministic waste detectors, and a dashboard that ranks waste by dollars. Self-hostable. OpenAPI documented. Find your first wasted dollar today.

## LinkedIn variants

LinkedIn tolerates longer. Combine drafts, lead with the problem, and keep
the formatting spare.

**LI-1 (from 1+4).**
> The LLM invoice says tokens. It doesn't say how many were wasted — retried, unread, or burned on output your schema rejected.
>
> We built Vyaya to answer one question: what is your LLM spend actually buying? It's a proxy that observes your traffic, five deterministic detectors that classify the waste, and a dashboard that puts a dollar figure on every kind — with a fix attached.
>
> The enemy is waste. Not tokens. Waste — the spend that produces nothing.

**LI-2 (from 3+8).**
> The obvious objection to a traffic-auditing proxy is latency. So we made it a contract: under 10ms added at p95, enforced by a test that runs with the logging database switched off. Measured at 3.7ms isolated, under 7ms under full-suite load.
>
> Setup is one line: swap base_url in your OpenAI SDK, add your Vyaya key. The first waste findings land the same day.

## Launch checklist

### Hacker News (Show HN)

- [ ] Title: `Show HN: Vyaya – audit wasted LLM spend through a <10ms proxy`
- [ ] First comment ready: why we built it, the five detectors, the
      determinism choice, the self-host path (`docker compose up`), and
      the honest limits (heuristics v1, OpenAI-compatible endpoints only).
- [ ] Demo ready: seeded workspace shows a 63% waste rate on the demo
      data set; keep the seed numbers consistent with `packages/db` seed.
- [ ] Post Tuesday-Thursday, morning US Pacific. Be around for comments
      for 4+ hours. Answer the latency question with the pair-delta
      methodology from `ops/PERF_BUDGET.md`.

### Product Hunt

- [ ] Tagline: "See what your LLM spend is actually buying."
- [ ] Gallery: dashboard hero (waste rate), the five waste cards, a waste
      event with evidence and fix, the onboarding snippet screen.
- [ ] First comment: the taxonomy table from `docs/FEATURES.md`, plus the
      privacy stance (metadata-only by default).
- [ ] Hunter lined up, or self-hunt with a prepared maker comment.

### Reddit

- [ ] r/LocalLLaMA and r/OpenAI: lead with self-host + deterministic
      detectors, no LLM judging your LLM. Reddit punishes marketing voice;
      post the technical story (prompt-hash clustering, Jaccard shingles,
      the retention sweeper) and let the product speak.
- [ ] r/webdev or r/SaaS only if there's a genuine build-story angle
      (RLS-everywhere, the <10ms latency gate). Check self-promotion rules
      per sub.

### Everywhere

- [ ] Landing page live, SSL clean, security headers verified (CSP, HSTS,
      X-Frame-Options, nosniff, Referrer-Policy — all five ship already).
- [ ] Demo workspace seeded and the classifier has run — no empty
      dashboards in screenshots.
- [ ] `docs/` linked from the landing footer or README; the docs are part
      of the pitch to engineers.
- [ ] Status contact: one person owns replies for launch day.
- [ ] Post-mortem slot booked for the next day: what got clicked, what got
      asked, what confused people.
