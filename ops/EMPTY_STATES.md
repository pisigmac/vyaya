# ops/EMPTY_STATES.md

Every empty state in the UI: what renders, the exact copy, the CTA, and
how the state resolves. Copy here is the contract — change it in the
component first, then update this file.

## Dashboard (`app/dashboard/page.tsx`)

**No traffic yet.** (`requestCount === 0`)

- Copy: "No traffic yet. Nothing has flowed through the proxy, so there's
  nothing to audit. Finish onboarding and send your first request."
- CTA: "Finish setup" -> `/onboarding`.
- Recovery: first proxied request lands; next page load shows the hero.

**No fixes to rank.** (traffic exists, zero waste events)

- Copy: "No fixes to rank yet. Waste events bring their own remediation."
- CTA: none (informational).
- Recovery: the classifier runs (nightly, or the dev button) and finds
  waste — or the traffic is genuinely clean, in which case this state
  staying is the product working.

**No waste events yet.** (events table)

- Copy: "No waste events yet. The classifier runs nightly — or trigger it
  from onboarding in dev."
- CTA: none inline; points at onboarding.
- Recovery: classify run emits events.

**Zero-traffic stats.** Summary renders zeros ($0.00, 0%, 0 requests)
rather than hiding the dashboard — a workspace with traffic but no events
in the 30d window sees a 0.0% waste rate. That's a claim worth making.

## Onboarding (`components/onboarding-flow.tsx`)

Four steps, each with its own states:

1. **Create your first key.** Viewer role: input and button disabled,
   copy "You're a viewer — ask an admin to create keys." After creation:
   "Shown once. Copy it now — we only store the hash." with the plaintext
   in a code block. With existing keys: "You already have N active keys."
2. **Swap one line.** Static TypeScript + Python snippets. Never empty.
3. **Send your first request.** Without a fresh plaintext key, a paste
   input appears ("Paste a vy_live_ key"). Result line reports status and
   latency.
4. **Watch the waste show up.** Waiting state: "The classifier runs
   nightly. This page checks every few seconds and lights up when the
   first event lands." — the page polls `/api/onboarding/workspace` every
   5s. In dev (`AUTH_MODE=dev`): "Run the classifier now" button. Found
   state: "First waste found. N events on the board." with CTA "Open the
   dashboard".

## Settings (`app/settings/page.tsx`)

**Viewer banner.** "You're signed in as a viewer. Everything here is
read-only." All write controls render disabled.

**No API keys.** (`components/keys-manager.tsx`)

- Copy: "No keys yet. Create one and the proxy starts accepting your
  traffic."
- CTA: the create form (name + "Create key").
- Recovery: first key created; plaintext shown once.

**No reports.**

- Copy: "No reports yet. The worker writes one after each completed week."
- CTA: none.
- Recovery: the weekly-report job runs after the first completed ISO week
  (Monday-Sunday UTC). A workspace created on Tuesday waits until next
  Monday's job tick.

**Workspace form placeholders.** Report email: "Empty = every workspace
member." Feature tags: "Empty = accept every X-Vyaya-Tag value." These
explain the null semantics inline.

## Login / landing

Not empty states, but adjacent: `/login` offers GitHub and Google buttons
pointing at `DESKID_BASE_URL`; auth errors land back on `/login?error=...`
(`missing_token`, `invalid_token`). The landing page redirects signed-in
users to `/dashboard`, so an authed user never sees marketing.

## Rules for new empty states

1. Every list/table in the UI has an empty branch. No blank boxes.
2. The copy says why it's empty and what happens next. One CTA maximum.
3. Copy rules apply: contractions, periods, no exclamation spam, banned
   list enforced.
4. Distinguish "nothing yet" (onboarding problem, offer the next step)
   from "nothing found" (the product working — say so).
