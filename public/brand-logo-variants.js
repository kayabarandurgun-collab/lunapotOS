// Onayli logo varyant kimlikleri. Kaynak: public/marka/logo/manifest.json
// Bu liste manifestten uretildi; tests/marka-logo-varliklari.test.js manifestle
// birebir ayni kalmasini olcer. Belge sunumunda yalniz bu kimlikler kabul edilir.
export const APPROVED_LOGO_VARIANTS=Object.freeze([
 'lunapot-amblem-antrasit','lunapot-amblem-beyaz','lunapot-amblem-gri',
 'lunapot-amblem-kirikbeyaz','lunapot-amblem-lime','lunapot-amblem-siyah',
 'lunapot-amblem-tas','lunapot-dikey-antrasit','lunapot-dikey-beyaz',
 'lunapot-dikey-gri','lunapot-dikey-kirikbeyaz','lunapot-dikey-lime',
 'lunapot-dikey-lime-antrasit','lunapot-dikey-lime-beyaz','lunapot-dikey-siyah',
 'lunapot-dikey-tas','lunapot-yatay-antrasit','lunapot-yatay-beyaz',
 'lunapot-yatay-gri','lunapot-yatay-kirikbeyaz','lunapot-yatay-lime',
 'lunapot-yatay-lime-antrasit','lunapot-yatay-lime-beyaz','lunapot-yatay-siyah',
 'lunapot-yatay-tas','lunapot-yazi-antrasit','lunapot-yazi-beyaz',
 'lunapot-yazi-gri','lunapot-yazi-kirikbeyaz','lunapot-yazi-lime',
 'lunapot-yazi-siyah','lunapot-yazi-tas'
]);
export const LOGO_VARIANT_SET=new Set(APPROVED_LOGO_VARIANTS);
export const isApprovedLogoVariant=id=>typeof id==='string'&&LOGO_VARIANT_SET.has(id);
