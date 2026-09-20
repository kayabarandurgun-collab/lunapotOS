import test from 'node:test';
import assert from 'node:assert/strict';
import {findPlaywright} from '../scripts/design-audit.mjs';
// Mutations are permitted ONLY against the explicit isolated HTTPS synthetic preview.
const preview=process.env.ACCESS_PREVIEW_URL;
test('HTTPS browser: staff wizard, private invite, six-digit login, hidden money and device revocation', {skip:!preview,timeout:120000}, async()=>{
 const base=new URL(preview);assert.equal(base.protocol,'https:');assert.equal(base.hostname,'127.0.0.1');assert.equal(base.pathname,'/');
 const {api}=await findPlaywright();assert.ok(api);const browser=await api.chromium.launch({headless:true,channel:'chrome'});
 const contexts=[];const errors=[];
 const context=async()=>{const c=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:900},serviceWorkers:'block'});contexts.push(c);await c.route('**/*',r=>new URL(r.request().url()).origin===base.origin?r.continue():r.abort());return c;};
 const pageFor=async c=>{const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));return p;};
 const call=(p,path,body)=>p.evaluate(async({path,body})=>{const r=await fetch(path,{headers:{'Content-Type':'application/json'},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};},{path,body});
 try{
  const ownerContext=await context(),owner=await pageFor(ownerContext);
  await owner.goto(base.origin+'/__preview/start?role=owner&next=/access');
  const health=await call(owner,'/__preview/health');assert.equal(health.body.synthetic,true);assert.equal(health.body.network,'blocked');
  await owner.locator('[data-new-employee]').first().click();const form=owner.locator('[data-form=create]');
  const username='browser.'+Date.now();await form.locator('[name=name]').fill('Sentetik Depo Çalışanı');await form.locator('[name=username]').fill(username);
  await form.locator('[data-wizard-step="0"] [data-wizard-next]').click();await form.locator('[data-preset=warehouse]').click();
  await form.locator('[data-wizard-step="1"] [data-wizard-next]').click();
  assert.equal(await form.locator('[name=permit_ec_stock]').inputValue(),'write');assert.equal(await form.locator('[name=money_ec]').isChecked(),false);
  await form.locator('button[type=submit]').click();await owner.locator('[name=invite_url]').waitFor();
  const invite=await owner.locator('[name=invite_url]').inputValue();assert.equal(new URL(invite).origin,base.origin);
  const staffContext=await context(),staff=await pageFor(staffContext);await staff.goto(base.origin+'/__preview/start?role=anonymous&next='+encodeURIComponent('/access'+new URL(invite).hash));
  const password='synthetic-browser-password';await staff.locator('[data-form=join] [name=password]').fill(password);await staff.locator('[data-form=join] button').click();await staff.getByRole('heading',{name:'Şifren hazır.'}).waitFor();
  await staff.goto(base.origin+'/eticaret/');await staff.locator('#commerce-login [name=username]').fill(username);await staff.locator('#commerce-login [name=password]').fill(password);await staff.locator('#commerce-login button[type=submit]').click();
  await staff.locator('a[href="/access#account"]').first().waitFor({state:'attached'});
  assert.equal((await call(staff,'/api/admin/users')).status,403);assert.equal((await call(staff,'/api/ec/performance')).status,403);
  const accounting=await call(staff,'/api/ec');assert.equal(accounting.status,200);assert.ok(accounting.body.stock.length>0);assert.equal(accounting.body.stock[0].value_cents,null);
  await staff.goto(base.origin+'/access#account');await staff.locator('[data-enroll]').waitFor();
  assert.equal(await staff.locator('[data-new-employee]').count(),0);assert.equal(await staff.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const enroll=staff.locator('[data-enroll]');await enroll.locator('[name=label]').fill('Sentetik telefon');await enroll.locator('[name=current_password]').fill(password);await enroll.locator('[name=pin]').fill('000042');await enroll.locator('[name=pin_confirm]').fill('000042');await enroll.locator('button').click();
  await staff.getByText('Bu cihaz kaydedildi.',{exact:false}).waitFor();const cookie=(await staffContext.cookies()).find(c=>c.name==='__Host-lunapot_device');assert.ok(cookie);assert.equal(cookie.secure,true);assert.equal(cookie.httpOnly,true);assert.equal(cookie.sameSite,'Strict');
  assert.doesNotMatch(await staff.evaluate(()=>document.cookie),/lunapot_device/);
  await staff.locator('[data-account-logout]').click();await staff.getByRole('heading',{name:'6 haneli kodla giriş'}).waitFor();
  await staff.locator('.quick-access-login [name=pin]').fill('000042');await staff.locator('.quick-access-login button[type=submit]').click();await staff.locator('[data-enroll]').waitFor();
  assert.equal((await call(staff,'/api/auth/status')).body.user.name,'Sentetik Depo Çalışanı');
  // Re-enroll through a PIN session: must keep this validated account usable.
  await enroll.locator('[name=label]').fill('Sentetik telefon yenilendi');await enroll.locator('[name=current_password]').fill(password);await enroll.locator('[name=pin]').fill('000043');await enroll.locator('[name=pin_confirm]').fill('000043');await enroll.locator('button').click();
  await staff.getByText('Bu cihaz kaydedildi.',{exact:false}).waitFor();assert.equal((await call(staff,'/api/auth/status')).body.authenticated,true);
  await staff.locator('[data-forget-current]').click();await staff.getByRole('heading',{name:'Hesabına giriş yap'}).waitFor();assert.equal((await call(staff,'/api/auth/status')).body.authenticated,false);
  assert.equal((await call(staff,'/api/auth/quick/status')).body.available,false);
  await call(staff,'/api/auth/logout',{});await staff.goto(base.origin+'/eticaret/');await staff.locator('#commerce-login').waitFor();assert.equal(await staff.locator('.quick-access-login form').count(),0);
  assert.deepEqual(errors,[]);
 }finally{for(const c of contexts)await c.close();await browser.close();}
});
