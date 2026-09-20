import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
const publicRoot=new URL('../public/',import.meta.url);
test('offline shell covers static and explicit dynamic workspace modules',()=>{
 const sw=readFileSync(new URL('sw.js',publicRoot),'utf8');
 const shell=Function('return '+sw.match(/const SHELL=(\[[^;]+\]);/)[1])();
 const seen=new Set(),queue=['app.js','ecommerce.js','ui-shell.js','launcher.js','access.js'];
 while(queue.length){
  const name=queue.shift();if(seen.has(name))continue;seen.add(name);
  const source=readFileSync(new URL(name,publicRoot),'utf8');
  for(const match of source.matchAll(/(?:\b(?:import|export)\s+(?:[^;'"\n]*?\s+from\s*)?['"](\.\.?\/[^'"]+)['"]|\bimport\s*\(\s*['"](\.\.?\/[^'"]+)['"])/g)){
   const next=path.posix.normalize(path.posix.join(path.posix.dirname(name),match[1]||match[2]));if(next.endsWith('.js'))queue.push(next);
  }
 }
 assert.ok(seen.size>50,'walk all workspaces including dynamic route imports');
 assert.deepEqual([...seen].filter(name=>!shell.includes('/'+name)),[],'every reachable local module is available to the offline shell');
 assert.equal(shell.some(name=>name.startsWith('/api/')||name.startsWith('/magaza/')),false);
 for(const name of shell.filter(name=>/\.(js|css|woff2)$/.test(name)))assert.ok(existsSync(new URL(name.slice(1),publicRoot)),name);
 assert.equal(new Set(shell).size,shell.length,'no duplicate shell URLs');
});
