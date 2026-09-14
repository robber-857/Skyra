import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'vitest';
const source=readFileSync(new URL('../theme-extension-src/attempt.js',import.meta.url),'utf8');
function accountUrl(config:unknown,origin='http://127.0.0.1:9292') {
  const window={location:new URL(origin),SkyraBookingAttempt:undefined as unknown as (root:unknown)=>{accountUrl:()=>string}};
  runInNewContext(source,{window,URL,document:{querySelector:()=>({textContent:JSON.stringify(config)}),dispatchEvent:()=>{}},Event:class {}});
  return window.SkyraBookingAttempt({dataset:{surface:'home'}}).accountUrl();
}
test.each([
  ['/account','https://skyra-booking-dev.myshopify.com/account'],
  ['/en/account','https://skyra-booking-dev.myshopify.com/en/account'],
  ['https://shopify.com/102807240996/account?locale=en','https://shopify.com/102807240996/account?locale=en'],
  ['javascript:alert(1)','https://skyra-booking-dev.myshopify.com/account'],
  ['https://user:password@example.com/account','https://skyra-booking-dev.myshopify.com/account'],
])('My account uses hosted routes without proxying authentication through localhost: %s',(route,expected)=>{
  expect(accountUrl({shopDomain:'skyra-booking-dev.myshopify.com',accountUrl:route})).toBe(expected);
});
test('missing route supports old extension config and missing domain supports a hosted storefront',()=>{
  expect(accountUrl({shopDomain:'skyra-booking-dev.myshopify.com'})).toBe('https://skyra-booking-dev.myshopify.com/account');
  expect(accountUrl({},'https://skyrastudio.com.au')).toBe('https://skyrastudio.com.au/account');
});
