import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../../src/worker.js';
export function appFixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../../migrations/'+file,import.meta.url),'utf8'));
 const DB={prepare(sql){return {args:[],bind(...args){this.args=args;return this;},first(){return sqlite.prepare(sql).get(...this.args)||null;},all(){return {results:sqlite.prepare(sql).all(...this.args)};},run(){return sqlite.prepare(sql).run(...this.args);}};},async batch(items){sqlite.exec('BEGIN');try{const r=items.map(s=>s.all());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const env={DB,SETUP_TOKEN:'synthetic-improvement-setup'},origin='https://lunapot.test';let cookie='';
 async function req(path,body,auth=cookie){const response=await worker.fetch(new Request(origin+'/api'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:auth},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:response.status,data:await response.json(),cookie:response.headers.get('Set-Cookie')?.split(';')[0]};}
 async function setup(){const r=await req('/auth/setup',{token:env.SETUP_TOKEN,password:'synthetic-owner-password'});if(r.status!==200)throw Error(JSON.stringify(r));cookie=r.cookie;}
 async function ok(path,body){const r=await req(path,body);if(r.status<200||r.status>=300)throw Error(path+': '+JSON.stringify(r));return r.data;}
 return {sqlite,env,req,ok,setup,close:()=>sqlite.close()};
}
