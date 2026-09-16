const channels={trendyol:'Trendyol',hepsiburada:'Hepsiburada'},statuses={draft:'Hazırlanıyor',reserved:'Stok ayrıldı',shipped:'Kargoda',delivered:'Teslim edildi'};
export const resultLabels={all:'Tüm paketler',loss:'Zarar edenler',missing:'Bilgisi eksik',profit:'Kâr edenler'};
export function selectPerformanceRows(rows,{channel='',result='all'}={}){
 // Kar/zarar ayrimi NAKIT sonuca gore yapilir; kullanicinin gordugu rakam odur.
 // Nakit hesaplanamamissa KDV haric katkiya duser, o da yoksa "bilgisi eksik" sayilir.
 const sonuc=r=>r.cash_cents!==null&&r.cash_cents!==undefined?r.cash_cents:r.profit_cents;
 return rows.filter(r=>(!channel||r.channel===channel)&&(result==='loss'?sonuc(r)!==null&&sonuc(r)<0:result==='missing'?sonuc(r)===null:result==='profit'?sonuc(r)!==null&&sonuc(r)>0:true));
}
export function reportDateRange(preset,today){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(today)||new Date(today).toISOString().slice(0,10)!==today)throw Error('Tarih geçersiz.');
 const shift=n=>new Date(Date.parse(today)+n*86400000).toISOString().slice(0,10);
 if(preset==='today')return {from:today,to:today};
 if(preset==='week')return {from:shift(-6),to:today};
 if(preset==='month')return {from:today.slice(0,7)+'-01',to:today};
 if(preset==='previous'){const end=new Date(Date.parse(today.slice(0,7)+'-01')-86400000).toISOString().slice(0,10);return {from:end.slice(0,7)+'-01',to:end};}
 throw Error('Tarih seçimi geçersiz.');
}
// Text from marketplaces must remain text when opened in a spreadsheet.
export function csvCell(value){
 let text=typeof value==='number'?value.toLocaleString('tr-TR',{useGrouping:false,maximumFractionDigits:3}):String(value??'');
 if(typeof value!=='number'&&/^[\s]*[=+@-]/u.test(text))text="'"+text;
 return '"'+text.replaceAll('"','""')+'"';
}
export function performanceCsv(state,selection={}){
 const pending=state.mode==='pending',rows=selectPerformanceRows(state.rows,selection),amount=v=>v==null?'Bilgi eksik':v/100;
 const data=[['Lunapot · '+(pending?'TAHMİNİ kâr / zarar':'Teslim edilen paketler')],['Tarih aralığı',state.from,state.to],['Tarih temeli',pending?'Sipariş tarihi':'Teslim tarihi'],['Kanal',channels[selection.channel]||'İki kanal'],['Seçim',resultLabels[selection.result]||resultLabels.all],['Seçilen paket sayısı',rows.length],['Rapor zamanı',state.as_of],['Dağıtılmamış kesinti faturaları TL',amount(state.unallocated_fee_cents)],['Kapsam',state.cost_notice],['Uyarı','Filtrelenmiş paket dökümüdür. Bilgi eksik satırlar sıfır kâr değildir; dağıtılmamış kesintiler varsa dönem sonucu tamamlanmış sayılmaz.'],[],['Sipariş','Paket','Kanal','Durum','Sipariş tarihi','Teslim tarihi','Satış KDV dahil TL','Ürün maliyeti TL','Kargo TL','Komisyon TL','Diğer gider TL',pending?'TAHMİNİ nakit sonuç TL':'Cebinde kalan (nakit) TL','KDV hariç katkı TL','Eksik bilgiler','İade satırı sayısı'],...rows.map(r=>[r.order_no,r.external_id,channels[r.channel]||r.channel,statuses[r.status]||r.status,r.occurred_on,r.delivered_on,...[r.revenue_gross_cents??r.revenue_net_cents,r.cost_gross_cents??r.cost_net_cents,r.shipping_gross_cents??r.shipping_cents,r.commission_gross_cents??r.commission_cents,r.other_gross_cents??r.other_cents,r.cash_cents,r.profit_cents].map(amount),[(r.missing||[]).join(' '),r.cash_note||''].filter(Boolean).join(' '),r.returns||0])];
 return '\ufeff'+data.map(row=>row.map(csvCell).join(';')).join('\r\n');
}
