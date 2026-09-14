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
// An optional public App URL distinguishes a dead tunnel from a healthy theme shell.
const appUrlIndex = process.argv.indexOf('--app-url');
if (appUrlIndex !== -1) {
  const appUrl = new URL(process.argv[appUrlIndex + 1]);
  if (appUrl.protocol !== 'https:' || appUrl.username || appUrl.password || appUrl.search || appUrl.hash || appUrl.pathname !== '/') throw new Error('Use the HTTPS App origin without credentials, path or query.');
  checks.push({name:'app-tunnel',url:new URL('/health',appUrl).href,kind:'health'});
}
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
      if (valid && check.kind === "health") { try { valid = JSON.parse(body).status === "ok"; } catch { valid = false; } }
      let diagnosis;
      if (!valid && check.kind === 'json' && body.includes('There was an error in the third-party application')) diagnosis = 'APP_PROXY_UPSTREAM_ERROR_CHECK_TUNNEL';
      else if (!valid && body.includes('1033')) diagnosis = 'CLOUDFLARE_TUNNEL_DISCONNECTED';
      else if (!valid && (check.kind === 'json' || check.kind === 'health') && response.ok) diagnosis = 'INVALID_API_RESPONSE';
      samples.push({probe, status:response.status, valid, ...(diagnosis ? {diagnosis} : {}), ms:Date.now()-started});
    } catch (error) { samples.push({probe, valid:false, error:error.cause?.code || error.name, ms:Date.now()-started}); }
  }
  const ok = samples.every(s=>s.valid);
  if (!ok) unhealthy = true;
  console.log(JSON.stringify({check:check.name, result:ok?"OK":"FAILED_OR_INTERMITTENT", samples}));
}
if (unhealthy) {
  console.error("Check theme:9292 and app-host:9293 separately. Check the public App /health and tunnel process as well: theme HTTP 200 does not prove the App Proxy works. Restore only the affected development services. Do not change the live theme.");
  process.exitCode = 1;
}
