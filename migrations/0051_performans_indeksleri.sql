-- HIZ İNDEKSLERİ. Kâr raporu (ana sayfa, sipariş listesi, ürün kârlılığı aynı hesabı kullanır) her paket
-- için aynı siparişin diğer paketlerini (stopaj payı, çift aktarım ikizi) ve rapor satırlarını arıyordu;
-- sipariş numarasına göre indeks olmadığı için her pakette bütün paket tablosu taranıyordu (paket sayısıyla
-- karesel büyür: canlıda 487 pakette sipariş listesi ~5 sn). Yalnız indeks eklenir; veri ve hesap değişmez.
CREATE INDEX IF NOT EXISTS ec_order_packages_order_no ON ec_order_packages(channel,order_no);
CREATE INDEX IF NOT EXISTS ec_order_packages_status_delivered ON ec_order_packages(status,delivered_on);
CREATE INDEX IF NOT EXISTS ec_order_line_components_sale ON ec_order_line_components(sale_id);
CREATE INDEX IF NOT EXISTS ec_report_records_erp_package ON ec_report_records(erp_package_id) WHERE erp_package_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ec_purchase_lines_product ON ec_purchase_lines(product_id);
CREATE INDEX IF NOT EXISTS ec_sale_entries_product ON ec_sale_entries(product_id);
