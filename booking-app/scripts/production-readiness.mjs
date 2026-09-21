import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const domain='mf0n6s-zg.myshopify.com';
try {
  const shop=await db.shop.findUnique({where:{domain}});
  const session=await db.session.findFirst({where:{shop:domain,isOnline:false}});
  const required=['read_customers','read_orders','write_products','write_app_proxy','unauthenticated_read_product_listings','unauthenticated_write_checkouts'];
  const scopes=new Set((session?.scope||'').split(',').map(s=>s.trim()));
  const mail=['SKYRA_MAIL_ENABLED','SKYRA_MAIL_PROVIDER','RESEND_API_KEY','SKYRA_MAIL_FROM','SKYRA_BOOKING_MAIL_SHOP','SKYRA_COACH_LOGIN_SHOP','SKYRA_COACH_MAIL_KEY'];
  console.log(JSON.stringify({domain,shopId:shop?.id||null,shopStatus:shop?.status||null,offlineSessionPresent:!!session?.accessToken,
    missingScopes:required.filter(s=>!scopes.has(s)),onlineBookingsEnabled:shop?.rules?.onlineBookingsEnabled===true,
    productionGate:{targetMatches:process.env.SKYRA_BOOKING_PRODUCTION_SHOP===domain,approved:process.env.SKYRA_BOOKING_PRODUCTION_RELEASE_APPROVED==='true',checkout:process.env.SKYRA_BOOKING_PRODUCTION_CHECKOUT_ENABLED==='true',ownedPasses:process.env.SKYRA_BOOKING_PRODUCTION_OWNED_PASSES_ENABLED==='true',emergencyStop:process.env.SKYRA_BOOKING_EMERGENCY_STOP==='true'},
    mailConfigurationPresent:Object.fromEntries(mail.map(k=>[k,!!process.env[k]?.trim()])),
    mailEnabled:process.env.SKYRA_MAIL_ENABLED==='true',mailShopMatches:process.env.SKYRA_BOOKING_MAIL_SHOP===domain,
    operationsEmailPresent:!!shop?.operationsEmail,
    counts:shop?{customers:await db.customerProfile.count({where:{shopId:shop.id}}),services:await db.service.count({where:{shopId:shop.id}}),passes:await db.passPlan.count({where:{shopId:shop.id}}),coaches:await db.coach.count({where:{shopId:shop.id}}),locations:await db.location.count({where:{shopId:shop.id}}),syncedProducts:await db.productMapping.count({where:{shopId:shop.id,syncStatus:'SYNCED'}}),bookings:await db.booking.count({where:{shopId:shop.id}})}:null,
    realUatVerified:false},null,2));
} catch { console.error('PRODUCTION_READINESS_QUERY_FAILED'); process.exitCode=1; }
finally { await db.$disconnect(); }
