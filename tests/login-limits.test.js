import {test} from 'node:test';import assert from 'node:assert/strict';import {loginLimitSubjects} from '../src/login-limits.js';
test('login limits isolate staff accounts sharing one gateway address',()=>{const a=loginLimitSubjects('/api/auth/login',{username:'personel.a'},'shared');const b=loginLimitSubjects('/api/auth/login',{username:'personel.b'},'shared');assert.equal(a[0].subject,b[0].subject);assert.notEqual(a[1].subject,b[1].subject);assert.equal(a[0].max,100);assert.equal(a[1].max,10);});
test('owner aliases and username case cannot bypass the account limit',()=>{const key=x=>loginLimitSubjects('/api/auth/login',{username:x},'shared')[1].subject;assert.equal(key(''),key('ADMIN'));assert.equal(key('owner'),key(' admin '));assert.equal(key(' Personel.A '),key('personel.a'));});
test('setup and invitations cannot consume the owner login bucket',()=>{const key=p=>loginLimitSubjects(p,{},'shared')[1].subject;assert.notEqual(key('/api/auth/login'),key('/api/auth/setup'));assert.notEqual(key('/api/auth/login'),key('/api/auth/accept-invite'));});

import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.js';
test('staff login failures behind one gateway do not lock out owner login',async()=>{
 const sqlite=new DatabaseSync(':memory:');
 for(const f of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 const prepare=sql=>({args:[],bind(...args){this.args=args;return this;},first(){return sqlite.prepare(sql).get(...this.args)||null;},all(){return {results:sqlite.prepare(sql).all(...this.args)};},run(){return sqlite.prepare(sql).run(...this.args);}});
 const DB={prepare,async batch(items){sqlite.exec('BEGIN');try{const r=items.map(x=>x.all());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const env={DB,SETUP_TOKEN:'synthetic-setup'};const origin='https://gateway.test';
 const req=(path,input)=>worker.fetch(new Request(origin+'/api/auth/'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':'shared-gateway'},body:JSON.stringify(input)}),env);
 try{
  assert.equal((await req('setup',{token:'synthetic-setup',password:'synthetic-owner-password'})).status,200);
  for(let i=0;i<10;i++)assert.equal((await req('login',{username:'missing.staff',password:'incorrect-test-password'})).status,401);
  assert.equal((await req('login',{username:'missing.staff',password:'incorrect-test-password'})).status,429);
  const good=await req('login',{username:'OWNER',password:'synthetic-owner-password'});assert.equal(good.status,200);assert.match(good.headers.get('set-cookie'),/HttpOnly/);
  assert.equal(sqlite.prepare('SELECT MAX(attempts) AS n FROM login_limits').get().n,13);
 }finally{sqlite.close();}
});
