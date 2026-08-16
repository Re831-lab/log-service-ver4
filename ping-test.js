// نسخة تشخيصية مؤقتة - احفظها باسم ping-test.js
import http from "k6/http";
export const options = {
  scenarios: {
    ping: {
      executor: "constant-arrival-rate",
      rate: 150,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 100,
      maxVUs: 300,
    },
  },
};
export default function () {
  http.post("http://localhost:8080/ping", "{}", {
    headers: { "Content-Type": "application/json" },
  });
}