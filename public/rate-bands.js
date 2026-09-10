// Tarife bantlarinin ust siniri HARICTIR: bir bant [alt, ust) araligini kapsar.
// Yani ust sinir 20000 kurus olan bant 199,99 TL'ye kadar gecerlidir ve 200,00 bir sonraki banda aittir.
// Bu modul yalnizca hesap yapar; kayit engellemez, sunucu kararini degistirmez.
const money=v=>new Intl.NumberFormat('tr-TR',{style:'currency',currency:'TRY'}).format(v/100);
const upper=rate=>rate.price_max_cents===null||rate.price_max_cents===undefined?Infinity:rate.price_max_cents;
const lower=rate=>rate.price_min_cents||0;

// Kullaniciya gosterilen aralik: ust sinir haric oldugu icin bir kurus asagisi yazilir.
export function bandLabel(rate){
 const top=upper(rate);
 return top===Infinity?money(lower(rate))+' ve üzeri':money(lower(rate))+' – '+money(top-1);
}

const overlapsDates=(a,b)=>a.valid_from<=b.valid_to&&b.valid_from<=a.valid_to;
const overlapsDesi=(a,b)=>{
 const aMax=a.billable_max_milli===null||a.billable_max_milli===undefined?Infinity:a.billable_max_milli;
 const bMax=b.billable_max_milli===null||b.billable_max_milli===undefined?Infinity:b.billable_max_milli;
 return (a.billable_min_milli||0)<bMax&&(b.billable_min_milli||0)<aMax;
};
const same=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();

// Ayni anda ayni teklife aday olabilecek tarifeler. Farkli donem, farkli desi araligi
// veya farkli SKU/kategori onceligi rekabet etmez; bunlar cakisma sayilmaz.
export function competingRates(kind,rates,candidate){
 return (rates||[]).filter(r=>
  r.id!==candidate.id&&
  !r.archived_at&&
  same(r.channel,candidate.channel)&&
  overlapsDates(r,candidate)&&
  (kind==='shipping'
   ? same(r.carrier,candidate.carrier)&&overlapsDesi(r,candidate)
   : same(r.sku,candidate.sku)&&same(r.category,candidate.category)));
}

export function rateBandIssues(kind,rates,candidate){
 const competing=competingRates(kind,rates,candidate);
 const overlaps=competing.filter(r=>lower(r)<upper(candidate)&&lower(candidate)<upper(r))
  .map(r=>({id:r.id,label:r.label,band:bandLabel(r)}));
 const gaps=[];
 const sorted=[...competing,candidate].sort((a,b)=>lower(a)-lower(b));
 let covered=lower(sorted[0]);
 for(const rate of sorted){
  if(lower(rate)>covered)gaps.push({from_cents:covered,to_cents:lower(rate),text:money(covered)+' – '+money(lower(rate)-1)});
  covered=Math.max(covered,upper(rate));
  if(covered===Infinity)break;
 }
 return {overlaps,gaps,suggested_next_min_cents:covered===Infinity?null:covered};
}

// Kayit formunda gosterilecek kisa uyari. Bos dizi donerse gosterilecek uyari yoktur.
export function bandWarnings(kind,rates,candidate){
 const {overlaps,gaps}=rateBandIssues(kind,rates,candidate);
 const messages=[];
 if(overlaps.length)messages.push('Bu bant aynı kapsamdaki '+overlaps.length+' tarifeyle çakışıyor: '+overlaps.map(o=>o.label+' ('+o.band+')').join(', ')+'. Aynı fiyat için hangisinin geçerli olacağı belirsiz kalır.');
 for(const gap of gaps)messages.push('Bu kapsamda '+gap.text+' aralığı hiçbir tarifeye girmiyor; o fiyatlarda hesap eksik kalır.');
 return messages;
}
