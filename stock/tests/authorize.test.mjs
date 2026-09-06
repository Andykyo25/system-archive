import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeServiceRequest } from '../supabase/functions/_shared/authorize.ts';
const request=token=>new Request('https://fixture.invalid',{headers:token?{Authorization:`Bearer ${token}`}:{}});
test('runtime key and a distinct trusted cron key are both accepted',async()=>{
  assert.equal(await authorizeServiceRequest(request('runtime'),'runtime',async()=>{throw Error('must not need Vault');}),true);
  assert.equal(await authorizeServiceRequest(request('cron'),'runtime',async()=>'cron'),true);
});
test('unverified service_role claims, missing headers and failed secret reads are rejected',async()=>{
  const forged=`e30.${Buffer.from('{"role":"service_role"}').toString('base64url')}.fake`;
  assert.equal(await authorizeServiceRequest(request(forged),'runtime',async()=>'cron'),false);
  assert.equal(await authorizeServiceRequest(request(null),'runtime',async()=>'cron'),false);
  assert.equal(await authorizeServiceRequest(request('cron'),'runtime',async()=>null),false);
});
