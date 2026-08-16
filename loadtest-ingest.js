import http from "k6/http";
import { check } from "k6";

const BATCH_SIZE = 100; 
const TARGET_LOGS_PER_SEC = 15000;
const TARGET_REQUESTS_PER_SEC = TARGET_LOGS_PER_SEC / BATCH_SIZE; // 150 request/s

export const options = {
  scenarios: {
    ingest: {
      executor: "constant-arrival-rate",
      rate: TARGET_REQUESTS_PER_SEC,
      timeUnit: "1s",
      duration: "90s",
      preAllocatedVUs: 100,
      maxVUs: 500,

    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
  },
};

const LEVELS = ["debug", "info", "warn", "error"];
const SERVICES = ["checkout", "auth", "payments", "inventory", "shipping"];

function randomLog() {
  return {
    timestamp: new Date().toISOString(),
    level: LEVELS[Math.floor(Math.random() * LEVELS.length)],
    service: SERVICES[Math.floor(Math.random() * SERVICES.length)],
    message: `event occurred at ${Date.now()}`,
    attributes: {
      user_id: String(Math.floor(Math.random() * 10000)),
      region: "eu-west",
      retries: Math.floor(Math.random() * 5),
    },
  };
}

function randomBatch() {
  const logs = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    logs.push(randomLog());
  }
  return logs;
}

export default function () {
  const payload = JSON.stringify({ logs: randomBatch() });

  const res = http.post("http://localhost:8080/logs", payload, {
    headers: { "Content-Type": "application/json" },
  });

  check(res, {
    "status is 200": (r) => r.status === 200,
  });
}