// PDF yerleşimi tarayıcı API'si olmadan da doğrulanabilsin diye kit dışarıdan verilir.
export async function pdfKit() {
  const lib = await import('pdf-lib');
  const fontkit = (await import('@pdf-lib/fontkit')).default;
  const {readFileSync} = await import('node:fs');
  return {lib, fontkit, fontBytes: readFileSync(new URL('../../public/vendor/NotoSans-tr.ttf', import.meta.url))};
}
