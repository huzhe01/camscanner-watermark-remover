import { cleanPdf } from './pdf-cleaner.js';

self.onmessage = async (event) => {
  const { id, input } = event.data;
  try {
    const result = await cleanPdf(new Uint8Array(input));
    const transfer = result.bytes instanceof Uint8Array ? [result.bytes.buffer] : [];
    self.postMessage({ id, result }, transfer);
  } catch (error) {
    self.postMessage({ id, error: error?.message || '文件处理失败，请检查 PDF 是否完整。' });
  }
};
