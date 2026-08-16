import http from "k6/http";
import { check } from "k6";

// المشروع بيطلب: "Support one aggregation request per second during the ingestion test"
export const options = {
  scenarios: {
    aggregate: {
      executor: "constant-arrival-rate",
      rate: 1,
      timeUnit: "1s",
      duration: "90s",
      preAllocatedVUs: 5,
      maxVUs: 10,
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<1000"], // المطلوب: تحت ثانية واحدة عند p95
  },
};

export default function () {
  const until = new Date().toISOString();
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // آخر ساعة

  const url = `http://localhost:8080/logs/aggregate?since=${since}&until=${until}&bucket=5m&group_by=service`;

  const res = http.get(url);

  check(res, {
    "status is 200": (r) => r.status === 200,
    "has buckets array": (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.buckets);
      } catch {
        return false;
      }
    },
  });
}
