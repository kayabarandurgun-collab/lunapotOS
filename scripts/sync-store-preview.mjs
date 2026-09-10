// Copy only the approved preview assets into the Worker static directory.
import {copyFile,mkdir,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),source=path.resolve(root,'../lunapot-store-preview'),target=path.join(root,'public/magaza');
const files=['index.html','home.html','shop.html','magaza.html','hakkimizda.html','kurumsal.html','iletisim.html','yardim.html','hesabim.html','odeme.html','test-odeme.html','yasal.html','shop.css','shop-dialogs.css','shop-mobile.css','professional.css','store-flow.css','shop.js','unified.js','professional.js','home-story.js','store-commerce.js','store-account.js'];
await mkdir(path.join(target,'assets'),{recursive:true});
for(const name of files)await copyFile(path.join(source,name),path.join(target,name));
for(const entry of await readdir(path.join(source,'assets'),{withFileTypes:true}))if(entry.isFile()&&/\.(webp|png|jpg|svg|woff2|txt)$/i.test(entry.name))await copyFile(path.join(source,'assets',entry.name),path.join(target,'assets',entry.name));
console.log('Approved storefront copied to public/magaza. No work files or credentials copied.');
