import {
  PDFDocument, PDFName, PDFNumber, PDFArray, PDFDict, PDFRef,
  PDFRawStream, PDFStream, PDFString, PDFHexString, decodePDFRawStream,
} from 'pdf-lib';

const KNOWN_LOGO_HASHES = new Set([
  'b7f403eab3409be9a213d3754dfca36b35df761884f5c6323546b836eee8c2ba',
]);
const IDENTITY = [1, 0, 0, 1, 0, 0];
const name = (value) => PDFName.of(value);
const white = (c) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const delimiter = (c) => white(c) || [40, 41, 60, 62, 91, 93, 123, 125, 47, 37].includes(c);

export class PdfCleaningError extends Error {
  constructor(message, code = 'unsupported') {
    super(message);
    this.name = 'PdfCleaningError';
    this.code = code;
  }
}

class UnsupportedPageError extends Error {}

function ascii(bytes, start, end) {
  let text = '';
  for (let i = start; i < end; i += 1) text += String.fromCharCode(bytes[i]);
  return text;
}

/** Lex PDF content without interpreting bytes inside strings or composites. */
function tokenize(bytes) {
  let cursor = 0;
  const skipSpace = () => {
    while (cursor < bytes.length) {
      if (white(bytes[cursor])) { cursor += 1; continue; }
      if (bytes[cursor] === 37) {
        while (cursor < bytes.length && bytes[cursor] !== 10 && bytes[cursor] !== 13) cursor += 1;
        continue;
      }
      break;
    }
  };
  const read = (depth = 0) => {
    if (depth > 100) throw new UnsupportedPageError('页面内容嵌套过深，已跳过。');
    skipSpace();
    if (cursor >= bytes.length) return null;
    const start = cursor;
    const c = bytes[cursor++];
    if (c === 40) {
      let nesting = 1;
      while (cursor < bytes.length && nesting) {
        const part = bytes[cursor++];
        if (part === 92) {
          if (cursor < bytes.length) {
            const escaped = bytes[cursor++];
            if (escaped === 13 && bytes[cursor] === 10) cursor += 1;
          }
        } else if (part === 40) nesting += 1;
        else if (part === 41) nesting -= 1;
      }
      if (nesting) throw new UnsupportedPageError('页面包含未闭合的字符串，已跳过。');
      return { kind: 'value', start, end: cursor };
    }
    if (c === 60 && bytes[cursor] !== 60) {
      while (cursor < bytes.length && bytes[cursor] !== 62) {
        if (!white(bytes[cursor]) && !/[0-9a-f]/i.test(String.fromCharCode(bytes[cursor]))) {
          throw new UnsupportedPageError('页面包含无效的十六进制字符串，已跳过。');
        }
        cursor += 1;
      }
      if (cursor >= bytes.length) throw new UnsupportedPageError('页面字符串未闭合，已跳过。');
      cursor += 1;
      return { kind: 'value', start, end: cursor };
    }
    if (c === 91 || (c === 60 && bytes[cursor] === 60)) {
      const dictionary = c === 60;
      if (dictionary) cursor += 1;
      while (true) {
        skipSpace();
        if (cursor >= bytes.length) throw new UnsupportedPageError('页面数组或字典未闭合，已跳过。');
        if ((!dictionary && bytes[cursor] === 93)
            || (dictionary && bytes[cursor] === 62 && bytes[cursor + 1] === 62)) {
          cursor += dictionary ? 2 : 1;
          break;
        }
        read(depth + 1);
      }
      return { kind: 'value', start, end: cursor };
    }
    if (c === 47) {
      while (cursor < bytes.length && !delimiter(bytes[cursor])) cursor += 1;
      const value = ascii(bytes, start + 1, cursor).replace(/#([0-9a-f]{2})/gi,
        (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      return { kind: 'name', value, start, end: cursor };
    }
    if ([41, 62, 93, 123, 125].includes(c)) {
      throw new UnsupportedPageError('页面内容结构无法安全识别，已跳过。');
    }
    while (cursor < bytes.length && !delimiter(bytes[cursor])) cursor += 1;
    const value = ascii(bytes, start, cursor);
    if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(value)) {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new UnsupportedPageError('页面包含无效数字，已跳过。');
      return { kind: 'number', value: number, start, end: cursor };
    }
    return { kind: ['true', 'false', 'null'].includes(value) ? 'value' : 'operator', value, start, end: cursor };
  };
  const tokens = [];
  let token;
  while ((token = read())) tokens.push(token);
  return tokens;
}

function concat(left, right) {
  const [a, b, c, d, e, f] = left;
  const [A, B, C, D, E, F] = right;
  return [a*A+c*B, b*A+d*B, a*C+c*D, b*C+d*D, a*E+c*F+e, b*E+d*F+f];
}

function bounds([a, b, c, d, e, f]) {
  const points = [[e, f], [a+e, b+f], [c+e, d+f], [a+c+e, b+d+f]];
  return [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))];
}

function isFooter(box, media) {
  const [left, bottom, right, top] = media;
  const [x0, y0, x1, y1] = box;
  return box.every(Number.isFinite) && x0 >= left+(right-left)*0.5 && x1 <= right+1
    && y0 >= bottom-1 && y1 <= bottom+(top-bottom)*0.15 && x1 > x0 && y1 > y0;
}

async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new PdfCleaningError('浏览器未提供安全加密接口，请使用 HTTPS 或 localhost 打开工具。', 'crypto');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('');
}

function numericArray(array, length) {
  if (!(array instanceof PDFArray) || array.size() !== length) return null;
  const values = array.asArray().map((v) => array.context.lookup(v));
  if (!values.every((v) => v instanceof PDFNumber && Number.isFinite(v.asNumber()))) return null;
  return values.map((v) => v.asNumber());
}

function decodeContents(page, context) {
  const contents = page.node.Contents();
  if (!contents) return new Uint8Array();
  const streams = contents instanceof PDFArray ? contents.asArray().map((v) => context.lookup(v)) : [contents];
  if (!streams.every((stream) => stream instanceof PDFRawStream)) {
    throw new UnsupportedPageError('页面使用了暂不支持的内容流，已跳过。');
  }
  let parts;
  try {
    parts = streams.map((stream) => decodePDFRawStream(stream).decode());
  } catch {
    throw new UnsupportedPageError('页面内容流无法解码，已跳过。');
  }
  const joined = new Uint8Array(parts.reduce((sum, part) => sum+part.length+1, 0));
  let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.length; joined[offset++] = 10; }
  return joined;
}

function planRemovals(bytes, candidates, media) {
  const tokens = tokenize(bytes);
  const ranges = [];
  const regions = [];
  const removedNames = new Set();
  const retainedNames = new Set();
  let operands = [];
  let matrix = IDENTITY;
  const stack = [];
  for (const token of tokens) {
    if (token.kind !== 'operator') { operands.push(token); continue; }
    if (['BI', 'ID', 'EI'].includes(token.value)) {
      throw new UnsupportedPageError('页面含内嵌图片，暂不自动修改，已跳过。');
    }
    if (token.value === 'q' || token.value === 'Q') {
      if (operands.length) throw new UnsupportedPageError('页面图形状态格式异常，已跳过。');
      if (token.value === 'q') stack.push(matrix);
      else {
        if (!stack.length) throw new UnsupportedPageError('页面图形状态不平衡，已跳过。');
        matrix = stack.pop();
      }
    } else if (token.value === 'cm') {
      if (operands.length !== 6 || !operands.every((v) => v.kind === 'number')) {
        throw new UnsupportedPageError('页面坐标变换无法识别，已跳过。');
      }
      matrix = concat(matrix, operands.map((v) => v.value));
    } else if (token.value === 'Do') {
      if (operands.length !== 1 || operands[0].kind !== 'name') {
        throw new UnsupportedPageError('页面图片调用无法安全识别，已跳过。');
      }
      const objectName = operands[0].value;
      const box = bounds(matrix);
      if (candidates.has(objectName) && isFooter(box, media)) {
        ranges.push([operands[0].start, token.end]);
        regions.push(box);
        removedNames.add(objectName);
      } else retainedNames.add(objectName);
    }
    operands = [];
  }
  if (stack.length || operands.length) throw new UnsupportedPageError('页面内容未完整闭合，已跳过。');
  for (const retained of retainedNames) removedNames.delete(retained);
  return { ranges, regions, unusedNames: removedNames };
}

function removeRanges(bytes, ranges) {
  const removedLength = ranges.reduce((sum, [start, end]) => sum+end-start, 0);
  const result = new Uint8Array(bytes.length-removedLength);
  let sourceOffset = 0;
  let destinationOffset = 0;
  for (const [start, end] of ranges) {
    const part = bytes.subarray(sourceOffset, start);
    result.set(part, destinationOffset);
    destinationOffset += part.length;
    sourceOffset = end;
  }
  result.set(bytes.subarray(sourceOffset), destinationOffset);
  return result;
}

function removeFooterLinks(page, context, regions) {
  const annotations = page.node.Annots();
  if (!annotations) return 0;
  const retained = [];
  let count = 0;
  for (const reference of annotations.asArray()) {
    let remove = false;
    try {
      const annotation = context.lookup(reference);
      if (annotation instanceof PDFDict && annotation.get(name('Subtype')) === name('Link')) {
        const rect = numericArray(annotation.lookupMaybe(name('Rect'), PDFArray), 4);
        const action = annotation.lookupMaybe(name('A'), PDFDict);
        const uri = action?.lookup(name('URI'));
        const text = uri instanceof PDFString || uri instanceof PDFHexString ? uri.decodeText() : '';
        let hostname = '';
        try { hostname = new URL(text).hostname.toLowerCase(); } catch { /* Keep unknown links. */ }
        remove = Boolean(rect && regions.some((box) => box.every((v, i) => Math.abs(v-rect[i]) <= 2))
          && (hostname === 'camscanner.com' || hostname.endsWith('.camscanner.com')));
      }
    } catch { /* Keep malformed or unfamiliar annotations. */ }
    if (remove) count += 1;
    else retained.push(reference);
  }
  if (count) {
    if (retained.length) page.node.set(name('Annots'), context.obj(retained));
    else page.node.delete(name('Annots'));
  }
  return count;
}

function assertUnsigned(context) {
  const pending = context.enumerateIndirectObjects().map(([, object]) => object);
  const seen = new Set();
  while (pending.length) {
    const object = pending.pop();
    if (!object || seen.has(object)) continue;
    seen.add(object);
    if (object instanceof PDFArray) { pending.push(...object.asArray()); continue; }
    if (object instanceof PDFStream) { pending.push(object.dict); continue; }
    if (!(object instanceof PDFDict)) continue;
    const dict = object;
    if (dict.get(name('Type')) === name('Sig') || dict.has(name('ByteRange'))
      || (dict.get(name('FT')) === name('Sig') && dict.has(name('V')))) {
      throw new PdfCleaningError('这份 PDF 含数字签名。修改会使签名失效，工具已停止处理。', 'signed');
    }
    pending.push(...dict.values());
  }
}

// Once leaves have their own resource maps, a page-tree resource map may be
// entirely shadowed. Dropping only those maps avoids retaining a hidden logo
// merely because an unused inherited dictionary still references it.
function removeShadowedPageTreeResources(context) {
  const dependsOnAncestor = (tree) => {
    const children = tree.lookupMaybe(name('Kids'), PDFArray);
    if (!children) return true;
    const pending = children.asArray();
    const visited = new Set();
    while (pending.length) {
      const child = context.lookup(pending.pop());
      if (!(child instanceof PDFDict) || visited.has(child)) return true;
      visited.add(child);
      if (child.has(name('Resources'))) continue;
      if (child.get(name('Type')) === name('Page')) return true;
      if (child.get(name('Type')) !== name('Pages')) return true;
      const kids = child.lookupMaybe(name('Kids'), PDFArray);
      if (!kids) return true;
      pending.push(...kids.asArray());
    }
    return false;
  };
  for (const [, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && object.get(name('Type')) === name('Pages')
      && object.has(name('Resources'))) {
      try {
        if (!dependsOnAncestor(object)) object.delete(name('Resources'));
      } catch { /* Preserve unfamiliar inheritance structures. */ }
    }
  }
}

/** Remove unreachable objects instead of keeping a hidden copy of the logo. */
function removeUnreachableObjects(context) {
  const pending = Object.values(context.trailerInfo).filter(Boolean);
  const references = new Set();
  const directObjects = new Set();
  while (pending.length) {
    const object = pending.pop();
    if (object instanceof PDFRef) {
      const key = object.toString();
      if (references.has(key)) continue;
      references.add(key);
      const target = context.lookup(object);
      if (target) pending.push(target);
    } else if (object && typeof object === 'object' && !directObjects.has(object)) {
      directObjects.add(object);
      if (object instanceof PDFDict) pending.push(...object.values());
      else if (object instanceof PDFArray) pending.push(...object.asArray());
      else if (object instanceof PDFStream) pending.push(object.dict);
    }
  }
  for (const [reference] of context.enumerateIndirectObjects()) {
    if (!references.has(reference.toString())) context.delete(reference);
  }
}

/**
 * Clean a PDF locally. Only the verified independent CamScanner footer image
 * is eligible. Unknown images and unsupported page structures are preserved.
 * `pages[].index` is zero-based; `pages[].pageNumber` is one-based.
 */
export async function cleanPdf(input) {
  if (!(input instanceof Uint8Array) || !input.length) {
    throw new PdfCleaningError('请选择有效的 PDF 文件。', 'invalid');
  }
  let document;
  try {
    document = await PDFDocument.load(input, { updateMetadata: false, ignoreEncryption: false });
  } catch (error) {
    if (String(error?.name).includes('Encrypted') || String(error?.message).includes('encrypted')) {
      throw new PdfCleaningError('这份 PDF 已加密，请先用密码解锁后再处理。', 'encrypted');
    }
    throw new PdfCleaningError('无法读取这份 PDF，请检查文件是否完整。', 'invalid');
  }
  const context = document.context;
  assertUnsigned(context);
  const pageResults = [];
  const hashes = new Map();
  let removedWatermarks = 0;
  let removedLinks = 0;
  for (const [index, page] of document.getPages().entries()) {
    const result = { index, pageNumber: index+1, status: 'skipped', removedWatermarks: 0, removedLinks: 0, regions: [] };
    pageResults.push(result);
    const originalEntries = ['Resources', 'Contents', 'Annots'].map((key) => [name(key), page.node.get(name(key))]);
    try {
      const resources = page.node.Resources();
      const objects = resources?.lookupMaybe(name('XObject'), PDFDict);
      if (!objects) { result.reason = '未发现已知的独立水印。'; continue; }
      const candidates = new Set();
      let hasForms = false;
      for (const [key, reference] of objects.entries()) {
        const object = context.lookup(reference);
        if (!(object instanceof PDFStream)) continue;
        if (object.dict.get(name('Subtype')) === name('Form')) hasForms = true;
        if (!(object instanceof PDFRawStream) || object.dict.get(name('Subtype')) !== name('Image')) continue;
        const width = object.dict.lookupMaybe(name('Width'), PDFNumber)?.asNumber();
        const height = object.dict.lookupMaybe(name('Height'), PDFNumber)?.asNumber();
        if (width !== 312 || height !== 90 || object.dict.lookup(name('Filter')) !== name('DCTDecode')) continue;
        if (!hashes.has(object)) hashes.set(object, await sha256(object.contents));
        if (KNOWN_LOGO_HASHES.has(hashes.get(object))) candidates.add(key.decodeText());
      }
      if (!candidates.size) { result.reason = '未发现已知的独立水印；不自动涂白页面。'; continue; }
      if (hasForms) { result.reason = '页面包含嵌套图形对象，暂不自动修改。'; continue; }
      const media = numericArray(page.node.MediaBox(), 4);
      if (!media) throw new UnsupportedPageError('页面尺寸无法识别，已跳过。');
      const content = decodeContents(page, context);
      const plan = planRemovals(content, candidates, media);
      if (!plan.ranges.length) { result.reason = '已知标记不在可安全处理的右下页脚区域。'; continue; }
      const resourceCopy = resources.clone(context);
      const objectCopy = objects.clone(context);
      for (const unused of plan.unusedNames) objectCopy.delete(name(unused));
      resourceCopy.set(name('XObject'), objectCopy);
      page.node.set(name('Resources'), resourceCopy);
      page.node.set(name('Contents'), context.register(context.flateStream(removeRanges(content, plan.ranges))));
      result.removedLinks = removeFooterLinks(page, context, plan.regions);
      result.status = 'cleaned';
      result.removedWatermarks = plan.ranges.length;
      result.regions = plan.regions;
      removedWatermarks += result.removedWatermarks;
      removedLinks += result.removedLinks;
    } catch (error) {
      for (const [key, value] of originalEntries) {
        if (value === undefined) page.node.delete(key);
        else page.node.set(key, value);
      }
      if (error instanceof PdfCleaningError) throw error;
      result.reason = error instanceof UnsupportedPageError ? error.message : '页面结构暂不支持，已保留原页。';
    }
  }
  const base = { pageCount: document.getPageCount(), changedPages: pageResults.filter((p) => p.status === 'cleaned').length,
    removedWatermarks, removedLinks, pages: pageResults };
  if (!removedWatermarks) return { ...base, status: 'skipped', reason: '未找到可安全移除的已知扫描全能王页脚水印。' };
  removeShadowedPageTreeResources(context);
  removeUnreachableObjects(context);
  const bytes = await document.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  return { ...base, status: 'cleaned', bytes };
}
