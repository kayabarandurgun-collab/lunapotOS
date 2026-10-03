import test from 'node:test';
import assert from 'node:assert/strict';
import {provisionalLabel} from '../public/business-ui.js';
test('supplier statement separates partial invoicing, verified completion and unlinked legacy entries',()=>{
 const entry={source_key:'gecici:receipt'};
 assert.equal(provisionalLabel({...entry,provisional_status:'open'}),'Faturası bekleniyor');
 assert.equal(provisionalLabel({...entry,provisional_status:'partial'}),'Kısmen faturalandı');
 assert.equal(provisionalLabel({...entry,provisional_status:'invoiced'}),'Faturalandı');
 assert.match(provisionalLabel({...entry,provisional_status:'legacy_unlinked'}),/kontrol edilmeli/);
 assert.match(provisionalLabel({...entry,reversed_by:'manual-reversal'}),/Ters kayıt var/);
 assert.doesNotMatch(provisionalLabel({...entry,reversed_by:'manual-reversal'}),/Faturalandı/);
 assert.equal(provisionalLabel({source_key:'invoice:real'}),'');
});
