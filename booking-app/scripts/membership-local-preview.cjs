/* eslint-env node */
// Isolated UI fixtures only: no environment files, database, Shopify, or remote API calls.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const app = path.resolve(__dirname, "..");
const port = 9394;
const pass = { kind: "NEW_PASS", id: "monthly", version: 1, name: "SKYRA Lifestyle 1 month", priceCents: 29900, currency: "AUD", credits: 12, validityMonths: 1, autoRenew: { available: true, termsVersion: "2026-10-02.v1" } };
const pack = { kind: "NEW_PASS", id: "pack", version: 1, name: "5 Aerial Access", priceCents: 22000, currency: "AUD", credits: 5, validityMonths: 2 };
const assets = {
  "/membership.js": "../shopify-theme/assets/skyra-memberships.js",
  "/membership.css": "../shopify-theme/assets/skyra-membership.css",
  "/transaction.js": "extensions/skyra-booking-embed/assets/transaction.js",
  "/attempt.js": "extensions/skyra-booking-embed/assets/attempt.js",
  "/booking.css": "extensions/skyra-booking-embed/assets/booking.css",
};
const safetyScript = `<script>
document.addEventListener('click',event=>{const a=event.target.closest('a');if(a&&new URL(a.href,location.href).origin!==location.origin){event.preventDefault();alert('本地预览不会打开外部网站。这里仅演示条款和授权交互。');}},true);
const localFetch=window.fetch.bind(window);
window.fetch=async function(input,options){const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin!==location.origin)throw new Error('Only local fixture requests are allowed.');const response=await localFetch(input,options);if(url.pathname==='/apps/skyra-booking/checkout'){const data=await response.clone().json();if(data.status==='LOCAL_PREVIEW_CONFIRMED'){location.assign('/confirmation?source=booking');return new Promise(()=>{});}}return response;};
</script>`;
function membershipDisplay() {
  const source = fs.readFileSync(path.resolve(app, "../shopify-theme/sections/skyra-membership.liquid"), "utf8");
  const start = source.indexOf('      <section class="membership-catalog');
  const end = source.indexOf("{% unless section.settings.separate_footer %}", start);
  return source.slice(start, end);
}
function page(content, head = "") {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SKYRA · 本地交互预览</title>${head}<style>
  *{box-sizing:border-box}body{margin:0;color:#302820;background:#fbf8f3;font-family:Arial,sans-serif}.preview-banner{padding:14px 22px;background:#5c3815;color:white;border-bottom:4px solid #e6b667;position:relative;z-index:20}.preview-banner strong{display:block;font-size:18px}.preview-banner small{display:block;margin-top:6px;line-height:1.5}.preview-nav{display:flex;gap:12px;flex-wrap:wrap;padding:16px 22px;background:white;border-bottom:1px solid #eadbc8}.preview-nav a,.preview-link{display:inline-block;color:#70400d;padding:10px 16px;border:1px solid #bf9b6e;border-radius:8px;background:white;text-decoration:none;font-weight:600}.preview-content{max-width:1120px;margin:32px auto;padding:0 22px}.preview-card{background:white;border:1px solid #eadbc8;border-radius:16px;padding:28px;margin:20px 0}.preview-card p{line-height:1.8}#booking{padding:24px;max-width:1260px;margin:auto;background:white}.membership-page{padding:20px}.preview-links{display:flex;gap:16px;flex-wrap:wrap} @media(max-width:600px){#booking{padding:14px}.preview-banner strong{font-size:16px}}
  </style>${safetyScript}</head><body><div class="preview-banner"><strong>本地交互预览 · 模拟数据 · 不会真实扣款</strong><small>复用当前 Membership / Booking 界面。付款按钮只展示模拟确认；这里没有连接真实订单、数据库或 Shopify 付款。</small></div><nav class="preview-nav" aria-label="本地预览导航"><a href="/">预览首页</a><a href="/pages/membership">Membership 独立买卡</a><a href="/booking">Booking 选卡</a><a href="/reset">重新开始预览</a></nav>${content}</body></html>`;
}
const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'");
  const pathname = new URL(req.url, "http://localhost:" + port).pathname;
  const json = (data, status = 200) => { res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(data)); };
  try {
    if (pathname === "/health") return json({ status: "ok", fixtureOnly: true, database: false, externalPayments: false, port });
    if (assets[pathname]) { res.setHeader("Content-Type", pathname.endsWith("css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8"); return res.end(fs.readFileSync(path.resolve(app, assets[pathname]))); }
    if (pathname.startsWith("/apps/skyra-booking/")) {
      if (req.method !== "POST") return json({ error: "Local fixture expects POST" }, 405);
      let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 16384) return json({ error: "Request too large" }, 413); }
      const body = JSON.parse(raw || "{}");
      const route = pathname.slice("/apps/skyra-booking/".length);
      if (route === "memberships/catalog") return json({ passes: [pass], memberships: [], authenticated: true, checkoutAvailable: true });
      if (route === "memberships/purchase") return json({ status: "PAID", purchaseId: "local-simulated-purchase", name: (body.passPlanId === "pack" ? pack : pass).name, simulated: true });
      if (route === "memberships/result") return json({ status: "PAID", name: pass.name, simulated: true });
      if (route === "memberships/cancel") return json({ status: "CANCELLED", message: "Local simulation: future renewals are off. No real subscription was changed." });
      if (route === "result") return json({ status: "NOT_CONFIRMED" });
      if (route === "pass-options") return json({ passes: [pass, pack], selected: [pass, pack].find(item => item.id === body.passPlanId) || null, checkoutAvailable: true, ownedPassesAvailable: true });
      if (route === "comment") return json({ saved: true, simulated: true });
      if (route === "checkout") return json({ status: "LOCAL_PREVIEW_CONFIRMED", simulated: true });
      return json({ error: "No real API is available in this local preview" }, 404);
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (pathname === "/reset") return res.end(page(`<main class="preview-content"><p>正在重置本地预览…</p></main><script>sessionStorage.removeItem('skyra-memberships:purchase');location.replace('/');</script>`));
    if (["/booking", "/booking-ui", "/pages/programs"].includes(pathname)) return res.end(page(`<main id="booking" class="skyra-booking" data-proxy-base="/apps/skyra-booking"></main><script>document.addEventListener('DOMContentLoaded',()=>{const root=document.getElementById('booking');window.SkyraBookingTransaction({root,attempt:{token:()=> 'a'.repeat(43),remember:()=>{}},session:{service:{name:'[Preview] Aerial Tone & Stretch',durationMin:55},startsAt:'2026-10-08T09:00:00Z',endsAt:'2026-10-08T09:55:00Z',coach:{name:'Preview coach'},location:{name:'SKYRA preview studio'}},timezone:'Australia/Sydney',back:()=>location.assign('/'),shell:host=>root.replaceChildren(host),restart:()=>location.reload(),signIn:()=>alert('This preview uses a simulated signed-in customer.')});});</script>`, `<link rel="stylesheet" href="/booking.css"><script src="/attempt.js" defer></script><script src="/transaction.js" defer></script>`));
    if (["/membership", "/pages/membership"].includes(pathname)) return res.end(page(`<main class="membership-page"><div class="membership-main">${membershipDisplay()}<section class="membership-catalog membership-purchase" id="membership-purchase-preview" aria-label="Buy a pass"><div id="membership-purchase" class="membership-shop" data-skyra-memberships></div></section></div></main>`, `<link rel="stylesheet" href="/membership.css"><script src="/membership.js" defer></script>`));
    if (pathname === "/confirmation") return res.end(page(`<main class="preview-content"><section class="preview-card"><h1>模拟付款已完成</h1><p>你已走完 Booking 选卡、自动续费授权和 Review。没有真实扣款、订单或预约。</p><p>正式规则：首期与每次续费月卡都在该期第一次实际到课时开始计算一个月；本地预览仅展示交互。</p><div class="preview-links"><a class="preview-link" href="/pages/membership">体验 Membership</a><a class="preview-link" href="/booking">重新体验 Booking</a></div></section></main>`));
    if (pathname !== "/") { res.statusCode = 404; return res.end(page(`<main class="preview-content"><h1>此路径不在本地预览中</h1><a href="/">返回首页</a></main>`)); }
    return res.end(page(`<main class="preview-content"><h1>月卡自动续费 · 本地预览</h1><section class="preview-card"><h2>两个购买入口</h2><p>选择 SKYRA Lifestyle 1 month → 选择自动续费 → Review → 分别勾选条款与自动续费授权。付款按钮会完成本地模拟。</p><div class="preview-links"><a class="preview-link" href="/pages/membership">Membership：单独购买 Pass</a><a class="preview-link" href="/booking">Booking：预约时选择 Pass</a></div></section><section class="preview-card"><h2>本次展示的规则</h2><p>月卡每期 12 节，AUD 299。首期和每次续费都从该期第一次实际到课开始计算一个月；未上课的取消或缺席不会激活。到期后续费的新卡等待下一次实际到课。</p><p>这是使用真实界面代码的模拟预览，不能用于确认真实支付、出勤或自动续费验收。</p></section></main>`));
  } catch (error) { console.error("Local preview request failed:", error.message); if (!res.headersSent) return json({ error: "Local preview request failed" }, 400); res.end(); }
});
server.listen(port, "127.0.0.1", () => console.log(`Local fixture preview listening at http://localhost:${port} (PID ${process.pid}). No database or external payment connections.`));
