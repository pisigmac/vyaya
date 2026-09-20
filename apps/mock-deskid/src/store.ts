/**
 * In-memory grant store + reconciliation event log.
 *
 * Reconciliation event shape (GET /v1/admin/reconciliation/events):
 *   { id: number (monotonic, starts at 1),
 *     type: "user.created" | "grant.created",
 *     occurred_at: ISO-8601 string,
 *     data: { user_id: string, ... } }
 *
 * Events are process-local; a restart resets the feed. That is fine for a
 * dev double — consumers (worker reconciliation job) resync by replaying
 * from since_id=0.
 */

export interface ReconciliationEvent {
  id: number;
  type: "user.created" | "grant.created";
  occurred_at: string;
  data: Record<string, unknown>;
}

export class MockDeskIdStore {
  readonly #audiencesByUser = new Map<string, Set<string>>();
  readonly #events: ReconciliationEvent[] = [];
  #nextId = 1;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Record a user the first time they appear; returns true when new. */
  ensureUser(userId: string, email: string): boolean {
    if (this.#audiencesByUser.has(userId)) return false;
    this.#audiencesByUser.set(userId, new Set(["vyaya"]));
    this.#append("user.created", { user_id: userId, email });
    return true;
  }

  grant(userId: string, audience: string, role: string): ReconciliationEvent {
    if (!this.#audiencesByUser.has(userId)) {
      this.#audiencesByUser.set(userId, new Set(["vyaya"]));
    }
    this.#audiencesByUser.get(userId)?.add(audience);
    return this.#append("grant.created", {
      user_id: userId,
      audience,
      role,
    });
  }

  audiencesFor(userId: string): string[] {
    return [...(this.#audiencesByUser.get(userId) ?? new Set(["vyaya"]))];
  }

  eventsSince(sinceId: number): {
    events: ReconciliationEvent[];
    latest_id: number;
  } {
    return {
      events: this.#events.filter((e) => e.id > sinceId),
      latest_id: this.#nextId - 1,
    };
  }

  #append(
    type: ReconciliationEvent["type"],
    data: Record<string, unknown>,
  ): ReconciliationEvent {
    const event: ReconciliationEvent = {
      id: this.#nextId++,
      type,
      occurred_at: new Date(this.#now()).toISOString(),
      data,
    };
    this.#events.push(event);
    return event;
  }
}
