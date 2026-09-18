export function clientName(client: {
  preferredName: string;
  shopifyName: string;
  email: string | null;
}) {
  return (
    client.preferredName.trim() ||
    client.shopifyName.trim() ||
    client.email ||
    "Unnamed client"
  );
}
