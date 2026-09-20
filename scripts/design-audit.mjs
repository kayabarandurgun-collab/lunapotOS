#!/usr/bin/env node
/** Read-only local HTTP / Playwright audit. Writes artifacts to the OS temp folder by default. */
import {mkdir, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const option=(name,fallback)=>{
  const equal=args.find(a=>a.startsWith(name+'='));
  if(equal)return equal.slice(name.length+1);
  const index=args.indexOf(name);
  return index>=0&&args[index+1]&&!args[index+1].startsWith('--')?args[index+1]:fallback;
};
const has=name=>args.includes(name);
const slug=text=>text.replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').slice(0,120)||'launcher';

export async function findPlaywright() {
  const candidates=[process.env.PLAYWRIGHT_MODULE_PATH,'playwright','playwright-core',
    join(homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','node','node_modules','playwright'),
    ...(process.env.NODE_PATH||'').split(process.platform==='win32'?';':':').filter(Boolean).map(p=>join(p,'playwright'))].filter(Boolean);
  const require=createRequire(import.meta.url);
  const attempts=[];
  for(const candidate of candidates) {
    try{return {api:require(candidate),module:require.resolve(candidate),attempts};}
    catch(error){attempts.push({candidate,error:error.code||error.message});}
  }
  return {api:null,attempts};
}

async function launchBrowser(playwright) {
  const attempts=[];
  const executable=option('--browser-executable',process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
  const candidates=executable?[{executablePath:executable}]:[{}, {channel:'chrome'}, {channel:'msedge'}];
  for(const settings of candidates) {
    try{return {browser:await playwright.chromium.launch({headless:true,timeout:20000,...settings}),settings,attempts};}
    catch(error){attempts.push({settings,error:error.message.split('\n').slice(0,3).join(' ')});}
  }
  return {browser:null,attempts};
}

async function main() {
  if(has('--help')) {
    console.log(`Start preview separately: node scripts/design-preview.mjs
Audit: node scripts/design-audit.mjs [--base=http://127.0.0.1:8790] [--browser=auto|required|off]
  --widths=390,1440          Screenshot / DOM widths (add 360 for narrow phones)
  --scenarios=populated     Comma-separated populated,missing,empty
  --role=owner              owner, reader, customer, anonymous
  --smoke                   Five root environments plus store, account and checkout
  --path=/eticaret/#stock   One specific route instead of discovered pages
  --open='selector'         Click a chosen dialog opener; requires --path (no form submission)
  --delay-ms=800            Layout settling time after network and fonts
  --out=ABSOLUTE_PATH       Output folder (default OS temp/lunapot-design-audit/timestamp)
  --browser-executable=...  Installed Chrome/Edge executable fallback
  --require-report-contract Assert the new panorama field contract after backend integration
  --allow-asset-404         Record missing assets without failing during module assembly
  --strict-layout          Fail when a viewport has document horizontal overflow
  --allow-http-fallback    Permit HTTP-only result with --browser=auto (not visual verification)
PLAYWRIGHT_MODULE_PATH may point to an installed Playwright package. No packages or browsers are downloaded.
Screenshots, audit.json and audit.md are written. No live hosts, form submission, commit or deployment.`);
    return;
  }
  const base=new URL(option('--base','http://127.0.0.1:8790'));
  if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||base.username||base.password||base.pathname!=='/'||base.search||base.hash) throw new Error('Only an http://127.0.0.1:PORT preview origin is allowed.');
  const browserMode=option('--browser','auto');
  if(!['auto','required','off'].includes(browserMode))throw new Error('Invalid --browser mode.');
  const widths=option('--widths','390,1440').split(',').map(Number);
  if(widths.some(n=>!Number.isInteger(n)||n<320||n>3000))throw new Error('Invalid viewport width.');
  const scenarios=option('--scenarios','populated').split(',');
  if(scenarios.some(x=>!['populated','missing','empty'].includes(x)))throw new Error('Invalid scenario.');
  const role=option('--role','owner');
  if(!['owner','reader','customer','anonymous'].includes(role))throw new Error('Invalid role.');
  const pathOption=option('--path',null),opener=option('--open',null);
  if(opener&&!pathOption)throw new Error('--open requires one explicit --path.');
  const out=resolve(option('--out',join(tmpdir(),'lunapot-design-audit',new Date().toISOString().replace(/[:.]/g,'-'))));
  await mkdir(out,{recursive:true});
  const report={started_at:new Date().toISOString(),base:base.origin,out,viewports:widths,role,synthetic:true,http:[],pages:[],failures:[],warnings:[],browser:{status:'not-run'},limitations:['Screenshots and DOM measurements are automated evidence, not human visual approval.','No exhaustive form submission, financial regression suite, keyboard flow or assistive-technology audit.','Browser service workers are blocked so screenshots use current local files.']};
  let browser;
  let context;
  const http=async(path,{cookie='',redirect='manual'}={})=>{
    const target=new URL(path,base);
    if(target.origin!==base.origin)throw new Error('External audit URL blocked.');
    return fetch(target,{headers:{Cookie:cookie},redirect,signal:AbortSignal.timeout(20000)});
  };
  const healthResponse=await http('/__preview/health');
  const health=await healthResponse.json();
  if(!healthResponse.ok||health.local_preview!==true||health.synthetic!==true||health.network!=='blocked')throw new Error('Target did not identify as the isolated synthetic preview.');
  report.fixture=health;
  let paths=pathOption?[pathOption]:has('--smoke')?['/','/uretim/','/eticaret/','/webmagaza/','/access','/magaza/','/magaza/magaza.html','/magaza/hesabim.html','/magaza/odeme.html']:health.pages;
  for(const path of paths)if(new URL(path,base).origin!==base.origin)throw new Error('An external page was supplied.');
  paths=[...new Set(paths)];
  try {
    if(browserMode!=='off') {
      const found=await findPlaywright();
      report.browser.module=found.module;
      report.browser.discovery_attempts=found.attempts;
      if(found.api) {
        const launched=await launchBrowser(found.api);
        browser=launched.browser;
        report.browser.launch_attempts=launched.attempts;
        if(browser)report.browser={...report.browser,status:'running',version:browser.version(),settings:launched.settings};
      }
      if(!browser) {
        report.browser.status='unavailable';
        report.warnings.push('Playwright/browser unavailable: HTTP checks only. No screenshots or DOM verification performed.');
        if(browserMode==='required'||!has('--allow-http-fallback'))report.failures.push('A browser audit was requested but no installed browser could launch.');
      }
    } else report.browser.status='disabled';
    for(const scenario of scenarios) {
      const start=await http(`/__preview/start?scenario=${scenario}&role=${role}`);
      if(start.status!==302)throw new Error(`Preview scenario ${scenario} failed to initialize: ${start.status}`);
      const cookie=start.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
      const activeHealth=await (await http('/__preview/health',{cookie})).json();
      const scenarioPaths=paths.map(path=>path==='/magaza/test-odeme.html'&&activeHealth.detail.webOrder?path+'?id='+activeHealth.detail.webOrder:path);
      const apis=role==='owner'?['/api/auth/status','/api/data','/api/ec','/api/ec/panorama','/api/ec/performance','/api/ec/urun-karlilik','/api/lp/production','/api/admin/users','/api/webshop/overview','/api/webshop/orders','/api/webshop/catalog','/api/store/config','/api/store/catalog','/api/store/auth/me','/api/store/orders']:['/api/auth/status','/api/store/config','/api/store/catalog'];
      const since=new Date(Date.parse(activeHealth.today)-6*86400000).toISOString().slice(0,10);
      if(role==='owner')apis.push(`/api/ec/panorama?from=${since}&to=${activeHealth.today}`,`/api/ec/urun-karlilik?from=${since}&to=${activeHealth.today}`);
      const checks=[...new Set([...scenarioPaths.map(p=>new URL(p,base).pathname+new URL(p,base).search),...apis])];
      for(const path of checks) {
        const response=await http(path,{cookie});
        const contentType=response.headers.get('content-type')||'';
        const body=await response.text();
        const check={scenario,path,status:response.status,contentType,csp:response.headers.get('content-security-policy'),bytes:Buffer.byteLength(body)};
        report.http.push(check);
        if(!response.ok)report.failures.push(`${scenario} HTTP ${response.status}: ${path}`);
        if(!check.csp?.includes("script-src 'self'"))report.failures.push(`${scenario} production CSP missing: ${path}`);
        if(contentType.includes('application/json')) {
          let data;
          try{data=JSON.parse(body);}catch{report.failures.push(`${scenario} invalid JSON: ${path}`);continue;}
          if(path==='/api/auth/status'&&role==='owner'&&!data.authenticated)report.failures.push('Owner session is not authenticated.');
          if(path.startsWith('/api/ec/panorama')) {
            check.periods=data.periods?.map(x=>x.key);
            check.pending=data.pending?.packages;
            if(has('--require-report-contract')) {
              const issues=[];
              const periods=data.periods||[];
              if(!periods.some(p=>p.key==='1g'))issues.push('1g');
              if(path.includes('?')&&!periods.some(p=>p.key==='custom')&&!data.selected_period)issues.push('custom period');
              for(const p of periods)for(const key of ['revenue_gross_cents','cash_cents','margin_bps','revenue_missing'])if(!Object.hasOwn(p,key))issues.push(`${p.key}.${key}`);
              const productScope=periods.find(p=>p.key==='custom')||data.selected_period||periods.find(p=>p.key==='tum');
              if(!Array.isArray(productScope?.products?.revenue_top))issues.push('products.revenue_top');
              if(!productScope?.records||!Object.hasOwn(productScope.records,'revenue')||!Object.hasOwn(productScope.records,'profit'))issues.push('records.revenue/profit');
              for(const key of ['net_cents','gross_cents','missing_vat_products','negative_products'])if(!Object.hasOwn(data.inventory||{},key))issues.push(`inventory.${key}`);
              if(issues.length)report.failures.push(`${scenario} report contract ${path}: ${issues.join(', ')}`);
            }
          }
        }
      }
      if(!browser)continue;
      const catalog=await (await http('/api/store/catalog',{cookie})).json();
      const cartVariant=catalog.items?.[0];
      for(const width of widths) {
        context=await browser.newContext({viewport:{width,height:width<600?844:1000},deviceScaleFactor:1,serviceWorkers:'block',locale:'tr-TR',timezoneId:'Europe/Istanbul',reducedMotion:'reduce'});
        await context.addCookies(start.headers.getSetCookie().map(raw=>{const [pair]=raw.split(';');const pos=pair.indexOf('=');return {name:pair.slice(0,pos),value:pair.slice(pos+1),url:base.origin,httpOnly:true,sameSite:'Strict'};}));
        const blocked=[];
        await context.route('**/*',async route=>{
          const request=route.request();
          if(new URL(request.url()).origin!==base.origin){blocked.push(request.url());return route.abort();}
          if(!['GET','HEAD'].includes(request.method())){blocked.push(`${request.method()} ${request.url()}`);return route.abort();}
          return route.continue();
        });
        if(cartVariant)await context.addInitScript(v=>{
          if(!sessionStorage.getItem('lunapot-unified-preview-selections-v1'))sessionStorage.setItem('lunapot-unified-preview-selections-v1',JSON.stringify({cart:[{id:v.product_id,size:v.size,qty:1,name:v.name,image:v.image,price:v.price_cents/100}],favorites:[]}));
        },cartVariant);
        for(const [index,path] of scenarioPaths.entries()) {
          const page=await context.newPage();
          const entry={scenario,width,path,pageErrors:[],consoleErrors:[],responses:[],failedRequests:[],blockedRequests:[]};
          const offset=blocked.length;
          page.on('pageerror',error=>entry.pageErrors.push(error.message));
          page.on('console',message=>{if(message.type()==='error')entry.consoleErrors.push(message.text());});
          page.on('response',response=>{if(response.status()>=400)entry.responses.push({url:response.url(),status:response.status(),type:response.request().resourceType()});});
          page.on('requestfailed',request=>entry.failedRequests.push({url:request.url(),error:request.failure()?.errorText}));
          try {
            await page.goto(new URL(path,base).href,{waitUntil:'domcontentloaded',timeout:25000});
            // Wait for actual UI requests without depending on videos reaching network idle.
            await page.waitForLoadState('networkidle',{timeout:6000}).catch(()=>{});
            await page.evaluate(()=>document.fonts.ready);
            await page.waitForTimeout(Number(option('--delay-ms','800')));
            if(opener) {await page.locator(opener).first().click({timeout:6000});await page.waitForTimeout(400);}
            entry.dom=await page.evaluate(()=>{
              const visible=el=>!!(el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none');
              const describe=el=>({tag:el.tagName.toLowerCase(),id:el.id,classes:String(el.className||'').slice(0,150),text:(el.textContent||'').trim().replace(/\s+/g,' ').slice(0,180)});
              const viewport=document.documentElement.clientWidth;
              const elements=[...document.querySelectorAll('body *')].filter(visible);
              return {
                title:document.title,url:location.href,viewport,documentWidth:document.documentElement.scrollWidth,
                horizontalOverflow:document.documentElement.scrollWidth>viewport+1,
                headings:[...document.querySelectorAll('h1,h2')].filter(visible).map(e=>e.textContent.trim()).slice(0,30),
                textLength:document.body.innerText.trim().length,
                overflowElements:elements.filter(e=>{const b=e.getBoundingClientRect();return b.width&&b.right>viewport+1&&b.left>=0;}).slice(0,35).map(e=>({...describe(e),right:Math.round(e.getBoundingClientRect().right),width:Math.round(e.getBoundingClientRect().width)})),
                dialogs:[...document.querySelectorAll('dialog[open],[role="dialog"]')].filter(visible).map(e=>({...describe(e),width:Math.round(e.getBoundingClientRect().width),height:Math.round(e.getBoundingClientRect().height),clientHeight:e.clientHeight,scrollHeight:e.scrollHeight})),
                unlabeledInputs:[...document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]),select,textarea')].filter(visible).filter(e=>!e.labels?.length&&!e.getAttribute('aria-label')&&!e.getAttribute('aria-labelledby')).map(describe),
                brokenImages:[...document.images].filter(visible).filter(e=>e.complete&&e.naturalWidth===0).map(e=>({src:e.getAttribute('src'),alt:e.alt})),
                tables:[...document.querySelectorAll('table')].filter(visible).map(e=>({rows:e.rows.length,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth})),
                alerts:[...document.querySelectorAll('[role="alert"],.error,.error-state')].filter(visible).map(e=>e.textContent.trim()).filter(Boolean).slice(0,15)
              };
            });
            entry.screenshot=`${scenario}-${width}-${String(index+1).padStart(2,'0')}-${slug(path)}${opener?'-dialog':''}.png`;
            await page.screenshot({path:join(out,entry.screenshot),fullPage:true,animations:'disabled',timeout:20000});
            if(entry.dom.horizontalOverflow) {
              report.warnings.push(`${scenario} ${width}px overflow: ${path}`);
              if(has('--strict-layout'))report.failures.push(`${scenario} ${width}px horizontal overflow: ${path}`);
            }
            if(entry.dom.unlabeledInputs.length)report.warnings.push(`${scenario} ${width}px unlabeled controls (${entry.dom.unlabeledInputs.length}): ${path}`);
            if(entry.dom.textLength<20)report.failures.push(`${scenario} ${width}px empty rendered page: ${path}`);
          } catch(error) {entry.error=error.message;report.failures.push(`${scenario} ${width}px ${path}: ${error.message.split('\n')[0]}`);}
          entry.blockedRequests=blocked.slice(offset);
          for(const error of entry.consoleErrors.filter(x=>/Content Security Policy|violates.*directive|Refused to execute|Refused to apply/i.test(x)))report.failures.push(`${scenario} ${width}px CSP: ${path}: ${error}`);
          if(entry.pageErrors.length)report.failures.push(`${scenario} ${width}px JavaScript errors: ${path}: ${entry.pageErrors.join('; ')}`);
          for(const response of entry.responses) {
            const tolerated=has('--allow-asset-404')&&response.status===404&&['stylesheet','script','image','font'].includes(response.type);
            (tolerated?report.warnings:report.failures).push(`${scenario} ${width}px ${response.status} ${response.url}`);
          }
          report.pages.push(entry);
          console.log(`[${scenario} ${width}px ${index+1}/${paths.length}] ${path} -> ${entry.screenshot||'capture failed'}${entry.dom?.horizontalOverflow?' [overflow]':''}`);
          await page.close();
        }
        await context.close();context=null;
      }
    }
    if(browser)report.browser.status='completed';
  } catch(error) {report.failures.push(error.stack||error.message);}
  finally {
    if(context)await context.close().catch(()=>{});
    if(browser)await browser.close();
    report.finished_at=new Date().toISOString();
    report.failures=[...new Set(report.failures)];report.warnings=[...new Set(report.warnings)];
    report.summary={httpChecks:report.http.length,screenshots:report.pages.filter(p=>p.screenshot).length,domChecks:report.pages.filter(p=>p.dom).length,failures:report.failures.length,warnings:report.warnings.length,humanVisualReview:'not performed'};
    await writeFile(join(out,'audit.json'),JSON.stringify(report,null,2));
    const md=[`# Lunapot local design audit`, `\nRun: ${report.started_at}`, `\nOrigin: ${base.origin}; synthetic in-memory data only.`, `\nHTTP checks: ${report.summary.httpChecks}; screenshots: ${report.summary.screenshots}; DOM checks: ${report.summary.domChecks}.`, `\nBrowser: ${report.browser.status}${report.browser.version?' '+report.browser.version:''}. Human visual approval: not performed.`, '\n## Failures\n',...report.failures.map(x=>'- '+x),'\n## Warnings\n',...report.warnings.map(x=>'- '+x),'\n## Captures\n','| Scenario | Width | Route | Overflow | Screenshot |','| --- | ---: | --- | --- | --- |',...report.pages.map(p=>`| ${p.scenario} | ${p.width} | ${p.path} | ${p.dom?.horizontalOverflow??'unknown'} | ${p.screenshot?`[PNG](${p.screenshot})`:'missing'} |`),'\n## Limits\n',...report.limitations.map(x=>'- '+x)];
    await writeFile(join(out,'audit.md'),md.join('\n'));
    console.log(JSON.stringify({out,summary:report.summary},null,2));
    process.exitCode=report.failures.length?1:0;
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error);process.exitCode=1;});
