export function EmailStatus({
  status,
  deliveryStatus,
}: {
  status: string;
  deliveryStatus?: string | null;
}) {
  const delivery: Record<string, string> = {
    delivered: "Delivered to recipient mail server",
    bounced: "Bounced",
    complained: "Spam complaint",
    delivery_delayed: "Delivery delayed",
    opened: "Provider recorded an open",
    clicked: "Provider recorded a click",
    sent: "Sent · delivery unconfirmed",
    failed: "Delivery failed",
    suppressed: "Delivery suppressed",
  };
  const queue: Record<string, string> = {
    PENDING: "Queued",
    SENDING: "Sending",
    ACCEPTED: "Provider accepted · delivery unconfirmed",
    FAILED: "Sending failed",
    UNKNOWN: "Sending outcome unknown · review required",
    SUPPRESSED: "Not sent · obsolete",
  };
  return (
    <span>
      {deliveryStatus
        ? delivery[deliveryStatus] || deliveryStatus
        : queue[status] || status}
    </span>
  );
}
