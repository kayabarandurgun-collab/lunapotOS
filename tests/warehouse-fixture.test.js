import {appFixture} from './helpers/app-fixture.js';
import {scopedDB} from '../src/scoped-db.js';
import {warehouseApi} from '../src/warehouse-api.js';
import {productProfileApi} from '../src/product-profile-api.js';
export function warehouseFixture(){
 const f=appFixture(),owner={owner:true,id:'owner'};
 const call=(path,body,ns='ec',user=owner)=>warehouseApi(new Request('https://test/api/'+ns+'/warehouse'+path,{method:body===undefined?'GET':'POST'}),{DB:scopedDB(f.env.DB,ns),WORKSPACE:ns,USER:user},'/api/warehouse'+path,async()=>body);
 const profile=(id,ns='ec',user=owner)=>productProfileApi(new Request('https://test/api/'+ns+'/product-profile?id='+id),{DB:scopedDB(f.env.DB,ns),WORKSPACE:ns,USER:user},'/api/product-profile');
 const product=(id,qty=0,value=0)=>{f.sqlite.prepare('INSERT INTO ec_products(id,name,sku,stock_unit,min_stock_milli) VALUES(?,?,?,?,?)').run(id,'Ürün '+id,id,'adet',2000);
  if(qty)f.sqlite.prepare("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on) VALUES(?,?,?,?,'opening',?,'Açılış',date('now','-2 days'))").run('open-'+id,id,qty,value,'open-'+id);};
 const create=async(ids=['a','b'],requestKey=crypto.randomUUID())=>call('/sessions',{request_key:requestKey,title:'Telefon sayımı',product_ids:ids});
 const save=(s,lines)=>call('/sessions/'+s.session.id+'/lines',{revision:s.session.revision,lines});
 const review=s=>call('/sessions/'+s.session.id+'/review',{revision:s.session.revision});
 const apply=s=>call('/sessions/'+s.session.id+'/apply',{revision:s.session.revision,review_token:s.session.review_token});
 return {...f,call,profile,product,create,save,review,apply};
}

