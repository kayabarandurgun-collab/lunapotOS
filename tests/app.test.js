import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.js';
import {convert,calculate,pricing} from '../public/costs.js';

test('Birim dönüşümü, fire, toplu üretim ve brüt marj',()=>{
 assert.equal(convert(500,'g','kg'),.5);
 assert.equal(convert(2,'L','ml'),2000);
 assert.throws(()=>convert(1,'kg','L'));
 const c=calculate({items:[{material_id:'m',quantity:500,unit:'g'}],waste_pct:10,labor:20,packaging:10,overhead:5,yield_qty:2},[{id:'m',name:'Malzeme',unit:'kg',price:200}]);
 assert.equal(c.raw,100);assert.equal(c.waste,10);assert.equal(c.total,145);assert.equal(c.unitCost,72.5);
 assert.equal(pricing(70,30,20,10).net,100);assert.equal(pricing(70,30,20,10).gross,120);
 assert.equal(pricing(70,30,20,10).orderProfit,300);assert.throws(()=>pricing(10,100,20,1));
});

function database(){const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys = ON');for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const prepare=sql=>({values:[],bind(...args){this.values=args;return this;},first(){return sqlite.prepare(sql).get(...this.values)||null;},all(){return {results:sqlite.prepare(sql).all(...this.values)};},run(){return sqlite.prepare(sql).run(...this.values);}});
 return {prepare,async batch(items){sqlite.exec('BEGIN');try{const result=items.map(i=>i.all());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}},close:()=>sqlite.close()};}

test('Uçtan uca: giriş, güvenlik, kalıcı kayıt, reçete ve fiyat değişikliği',async()=>{
 const DB=database(),env={DB,SETUP_TOKEN:'test-only-bootstrap-token'},origin='https://lunapot.test';let cookie='';
 async function req(path,method='GET',body,overrides={}){const headers={Origin:origin,'Content-Type':'application/json',Cookie:cookie,...overrides};const res=await worker.fetch(new Request(origin+'/api'+path,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})}),env);return {res,status:res.status,data:await res.json()};}
 assert.equal((await req('/data')).status,401);
 assert.equal((await req('/auth/setup','POST',{token:'wrong',password:'a-secure-test-password'})).status,403);
 assert.equal((await req('/auth/setup','POST',{token:env.SETUP_TOKEN,password:'short'})).status,400);
 const setup=await req('/auth/setup','POST',{token:env.SETUP_TOKEN,password:'a-secure-test-password'});assert.equal(setup.status,200);cookie=setup.res.headers.get('Set-Cookie').split(';')[0];
 assert.match(setup.res.headers.get('Set-Cookie'),/HttpOnly/);assert.match(setup.res.headers.get('Set-Cookie'),/Secure/);
 assert.equal((await req('/auth/setup','POST',{token:env.SETUP_TOKEN,password:'other-long-password'})).status,409);
 assert.equal((await req('/materials','POST',{name:'Malzeme',unit:'kg',price:200},{Origin:'https://evil.test'})).status,403);
 const material=await req('/materials','POST',{name:'Test Polyester',unit:'kg',price:200});assert.equal(material.status,201);const m=material.data.id;
 assert.equal((await req('/materials','POST',{name:'Test Polyester',unit:'kg',price:200})).status,409);
 assert.equal((await req('/materials','POST',{name:'Negatif',unit:'kg',price:-1})).status,400);
 assert.equal((await req('/materials','POST',{name:'Geçersiz birim',unit:'invalid',price:1})).status,400);
 const product=await req('/products','POST',{name:'Test Ürün',sku:'TEST-1',sale_price:150,category:'Saksı'});assert.equal(product.status,201);
 const r={product_id:product.data.id,items:[{material_id:m,quantity:500,unit:'g'}],yield_qty:1,waste_pct:0,labor:10,packaging:5,overhead:0};
 const recipe=await req('/recipes','POST',r);assert.equal(recipe.status,201);
 let state=(await req('/data')).data;assert.equal(calculate(state.recipes[0],state.materials).unitCost,115);
 assert.equal((await req('/materials/'+m,'DELETE',{})).status,409);
 assert.equal((await req('/materials/'+m,'PUT',{name:'Test Polyester',unit:'g',price:1})).status,409);
 assert.equal((await req('/materials/'+m,'PUT',{name:'Test Polyester',unit:'kg',price:300})).status,200);
 state=(await req('/data')).data;assert.equal(calculate(state.recipes[0],state.materials).unitCost,165);
 assert.equal((await req('/recipes/'+recipe.data.id,'PUT',{...r,items:[]})).status,400);
 assert.equal((await req('/recipes/'+recipe.data.id,'PUT',{...r,items:[{material_id:m,quantity:1,unit:'L'}]})).status,400);
 assert.equal((await req('/recipes/'+recipe.data.id,'PUT',{...r,items:[...r.items,...r.items]})).status,400);
 assert.equal((await req('/products/'+product.data.id,'DELETE',{})).status,200);
 state=(await req('/data')).data;assert.equal(state.products.length,0);assert.equal(state.recipes.length,0);
 assert.equal((await req('/materials/'+m,'DELETE',{})).status,200);
 assert.equal((await req('/auth/logout','POST',{})).status,200);assert.equal((await req('/data')).status,401);
 const login=await req('/auth/login','POST',{password:'a-secure-test-password'});assert.equal(login.status,200);
 cookie=login.res.headers.get('Set-Cookie').split(';')[0];assert.equal((await req('/data')).status,200);
 const expiredHash=DB.prepare('SELECT token_hash FROM sessions').first().token_hash;DB.prepare('UPDATE sessions SET expires_at=0 WHERE token_hash=?').bind(expiredHash).run();assert.equal((await req('/data')).status,401);
 for(let i=0;i<10;i++)assert.equal((await req('/auth/login','POST',{password:'wrong'})).status,401);
 assert.equal((await req('/auth/login','POST',{password:'wrong'})).status,429);
 DB.close();
});

test('PWA yalnızca uygulama dosyalarını saklar',()=>{const manifest=JSON.parse(readFileSync(new URL('../public/manifest.webmanifest',import.meta.url),'utf8'));assert.equal(manifest.display,'standalone');assert.equal(manifest.icons.length,2);for(const icon of manifest.icons)assert.ok(readFileSync(new URL('../public'+icon.src,import.meta.url)).length>0);const sw=readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');assert.match(sw,/pathname\.startsWith\('\/api\/'\)/);});
