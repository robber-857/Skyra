import pino from "pino";
export const log = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: {
    paths: [
      "req.headers",
      "accessToken",
      "refreshToken",
      "email",
      "customer",
      "payload",
      "secret",
    ],
    censor: "[REDACTED]",
  },
});
