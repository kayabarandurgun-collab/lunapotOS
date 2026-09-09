import {summary} from '../public/accounting-math.js';
// A posted sale is created at shipment. Final contribution also requires delivery.
export function packageProfit(p,lines,parts,entries){
 const totals=summary(entries,[]),originals=new Set(entries.filter(s=>s.kind==='sale').map(s=>s.id));
 const complete=lines.length>0&&parts.length>0&&lines.every(l=>parts.filter(c=>c.line_id===l.id).reduce((n,c)=>n+c.revenue_share_bps,0)===10000)&&parts.every(c=>c.sale_id&&originals.has(c.sale_id));
 const reasons=[];let status;
 if(p.source_changed){status='source_changed';reasons.push('Kaynak sipariş değişti; farkı incelemeden kâr doğrulanamaz.');}
 else if(p.status==='cancelled'){status='cancelled';reasons.push('Sipariş iptal edildi; satış kârına dahil edilmez.');}
 else if(!entries.length&&p.status!=='delivered'){status='not_shipped';reasons.push('Gönderim sonrası oluşan satış ve gider kayıtları bekleniyor.');}
 else if(!complete){status='incomplete_records';reasons.push('Paketin tüm ürünlerine bağlı stok ve satış kaydı tamamlanmalı.');}
 else {
  if(p.status!=='delivered')reasons.push('Teslimat bekleniyor. Giderler doğrulansa bile bu sonuç teslim edilenlerin kârına dahil değildir.');
  if(totals.missing)reasons.push('Kargo, komisyon veya diğer giderler eksik. Bilinmeyen tutarlar sıfır sayılmaz.');
  else if(totals.unconfirmed)reasons.push('Kayıtlı kesintiler henüz doğrulanmadı.');
  status=totals.missing||totals.unconfirmed?'pending':p.status==='delivered'?'confirmed':'awaiting_delivery';
 }
 const usable=complete&&!p.source_changed&&['shipped','delivered'].includes(p.status);
 return {status,reasons,totals,profit_cents:usable&&status==='confirmed'?totals.profit:null,estimated_profit_cents:usable?totals.estimatedProfit:null};
}
