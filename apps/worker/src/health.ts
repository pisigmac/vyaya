import { createServer, type Server } from "node:http";
import type { JobStatus } from "./scheduler.js";

/**
 * Health endpoint for the worker (WORKER_PORT). Plain node:http — the
 * worker has no other HTTP surface. GET /healthz returns per-job run
 * statuses + last run timestamps so ops and e2e can see the batch brain
 * without touching the database.
 */
export interface HealthPayload {
  status: "ok";
  service: "vyaya-worker";
  uptimeSec: number;
  jobs: JobStatus[];
}

export function createHealthServer(getJobs: () => JobStatus[]): Server {
  const startedMs = Date.now();
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      const payload: HealthPayload = {
        status: "ok",
        service: "vyaya-worker",
        uptimeSec: Math.round((Date.now() - startedMs) / 1000),
        jobs: getJobs(),
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}

export function listenHealth(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve());
  });
}

export function closeHealth(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
