import { setDefaultAutoSelectFamily } from "node:net";
import { setDefaultResultOrder } from "node:dns";
setDefaultResultOrder("ipv4first");
setDefaultAutoSelectFamily(false);
// Read-only diagnosis. A healthy Horizon root is not proof the Booking app is healthy.
const base = "http://127.0.0.1:9292";
const checks = [
  {name:"theme", url:base + "/", kind:"mount"},
  {name:"app-host", url:"http://127.0.0.1:9293/", kind:"mount"},
  {name:"booking-api", url:base + "/apps/skyra-booking/sessions", kind:"json"},
  {name:"programs", url:base + "/pages/programs", kind:"mount"},
  {name:"shopify-upstream", url:"https://skyra-booking-dev.myshopify.com/?_fd=0&pb=0", kind:"html"}
];
let unhealthy = false;
for (const check of checks) {
  const samples = [];
  for (let probe = 1; probe <= 3; probe++) {
    const started = Date.now();
    try {
      const response = await fetch(check.url, {signal:AbortSignal.timeout(12000), cache:"no-store"});
      const body = await response.text();
      let valid = response.ok;
      if (valid && check.kind === "mount") valid = body.includes("data-skyra-booking-root");
      if (valid && check.kind === "json") { try { valid = Array.isArray(JSON.parse(body).sessions); } catch { valid = false; } }
      samples.push({probe, status:response.status, valid, ms:Date.now()-started});
    } catch (error) { samples.push({probe, valid:false, error:error.cause?.code || error.name, ms:Date.now()-started}); }
  }
  const ok = samples.every(s=>s.valid);
  if (!ok) unhealthy = true;
  console.log(JSON.stringify({check:check.name, result:ok?"OK":"FAILED_OR_INTERMITTENT", samples}));
}
if (unhealthy) {
  console.error("Check theme:9292 and app-host:9293 separately. Restart the affected dev command after checking its terminal. Do not change the live theme.");
  process.exitCode = 1;
}
