// Read-only finance preview. Never changes marketplace prices, stock, orders or invoices.
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export function integrationStatus(env){return [
 {id:'trendyol',name:'Trendyol',configured:!!(env.TRENDYOL_SELLER_ID&&env.TRENDYOL_API_KEY&&env.TRENDYOL_API_SECRET),available:true,description:'Cari hesap ve kesinti kayıtları için salt okunur önizleme. Otomatik satış/stok aktarımı henüz etkin değil.'},
 {id:'hepsiburada',name:'Hepsiburada',configured:false,available:false,description:'Satıcı API erişimi ve yanıt yapısı doğrulandıktan sonra sipariş ve gider bağlantısı açılacak. Şimdilik satışlar elle kaydedilebilir.'},
 {id:'edm',name:'EDM',configured:false,available:false,description:'Gelen fatura web servis yetkisi bekleniyor. Şimdilik EDM’den dışa aktarılan UBL XML faturaları Alış Faturaları ekranında incelenebilir.'}
 ];}
export async function previewIntegration(env,provider,input,fetcher=fetch){
 if(env.WORKSPACE!=='ec')fail('Bu bağlantı yalnızca e-ticaret panelinde kullanılabilir.',403);
 if(provider!=='trendyol')fail('Bu canlı bağlantı henüz etkin değil.',409);
 if(!integrationStatus(env)[0].configured)fail('Trendyol API bilgileri sunucuda henüz tanımlanmadı.',409);
 if(!/^\d+$/.test(env.TRENDYOL_SELLER_ID))fail('Satıcı kimliği geçersiz.');
 const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v));
 if(!date(input.from)||!date(input.to))fail('Geçerli tarih aralığı seçin.');
 const start=Date.parse(input.from+'T00:00:00+03:00'),end=Date.parse(input.to+'T23:59:59.999+03:00');
 if(end<start||end-start>15*86400000)fail('Trendyol sorgusu en fazla 15 gün olabilir.');
 const page=input.page??0;if(!Number.isInteger(page)||page<0||page>100000)fail('Sayfa numarası geçersiz.');
 const kinds={sale:['settlements','Sale'],return:['settlements','Return'],deductions:['otherfinancials','DeductionInvoices'],payments:['otherfinancials','PaymentOrder']};
 if(!kinds[input.kind])fail('Sorgu türü geçersiz.');const [service,type]=kinds[input.kind];
 const url=new URL(`https://apigw.trendyol.com/integration/finance/che/sellers/${env.TRENDYOL_SELLER_ID}/${service}`);
 for(const [key,value] of Object.entries({startDate:start,endDate:end,page,size:500,transactionType:type}))url.searchParams.set(key,String(value));
 let response;
 try{response=await fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Basic '+btoa(env.TRENDYOL_API_KEY+':'+env.TRENDYOL_API_SECRET),'User-Agent':env.TRENDYOL_SELLER_ID+' - SelfIntegration',Accept:'application/json'}});}catch{fail('Trendyol bağlantısı tamamlanamadı. Daha sonra tekrar deneyin.',502);}
 if([401,403].includes(response.status))fail('Trendyol API erişimi doğrulanamadı.',502);
 if(response.status===429)fail('Trendyol istek sınırı doldu. Daha sonra tekrar deneyin.',429);
 if(!response.ok)fail('Trendyol verileri şu anda alınamıyor.',502);
 const raw=await response.text();if(raw.length>4000000)fail('Yanıt güvenli işleme sınırını aştı.',502);
 let payload;try{payload=JSON.parse(raw);}catch{fail('Trendyol yanıtı beklenen biçimde değil.',502);}
 if(!Array.isArray(payload.content)||!Number.isInteger(payload.totalPages)||payload.content.length>1000)fail('Trendyol yanıt yapısı doğrulanamadı.',502);
 const short=value=>typeof value==='string'||typeof value==='number'?String(value).slice(0,200):'';
 const numeric=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
 const records=payload.content.map(r=>({id:short(r.id),reference:short(r.orderNumber||r.receiptId),barcode:short(r.barcode),type:short(r.transactionType),credit:numeric(r.credit),debt:numeric(r.debt),commission:numeric(r.commissionAmount),sellerRevenue:numeric(r.sellerRevenue)}));
 await env.DB.prepare('INSERT INTO integration_runs(id,provider,kind,status,record_count,message) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),provider,input.kind,'preview',records.length,'Önizleme alındı; muhasebe veya stok kaydı oluşturulmadı.').run();
 return {records,page,totalPages:payload.totalPages,hasMore:page+1<payload.totalPages,message:'Kaynak tutarlarıdır; KDV ayrımı ve satış eşleştirmesi henüz yapılmadı. Raporlara ve stoğa işlenmedi.'};
}
