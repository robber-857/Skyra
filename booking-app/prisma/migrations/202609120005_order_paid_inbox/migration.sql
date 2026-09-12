CREATE INDEX "WebhookReceipt_status_receivedAt_idx"
  ON "WebhookReceipt"("status", "receivedAt");

ALTER TABLE "WebhookReceipt" ADD CONSTRAINT webhook_receipt_values CHECK (
  length("webhookId") BETWEEN 1 AND 255
  AND length(topic) BETWEEN 1 AND 100
  AND "payloadHash" ~ '^[a-f0-9]{64}$'
  AND status IN ('RECEIVED','QUEUED','PROCESSED','NEEDS_ATTENTION','FAILED')
);
