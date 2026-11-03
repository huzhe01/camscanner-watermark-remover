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

function bounds([a, b, c, d, e, f], rectangle = [0, 0, 1, 1]) {
  const [x0, y0, x1, y1] = rectangle;
  const points = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]
    .map(([x, y]) => [a*x+c*y+e, b*x+d*y+f]);
  return [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))];
}

function isFooter(box, media) {
  const [left, bottom, right, top] = media;
  const [x0, y0, x1, y1] = box;
  const pageWidth = right-left;
  const pageHeight = top-bottom;
  const width = x1-x0;
  const height = y1-y0;
  return box.every(Number.isFinite) && pageWidth > 0 && pageHeight > 0
    && width >= 16 && width <= Math.min(180, pageWidth*0.25)
    && height >= 5 && height <= Math.min(54, pageHeight*0.10)
    && width/height >= 1.5 && width/height <= 12
    && x0 >= left+pageWidth*0.5 && x1 <= right+0.75
    && right-x1 <= Math.max(24, pageWidth*0.08)
    && y0 >= bottom-0.75 && y0 <= bottom+36
    && y1 <= bottom+Math.min(72, pageHeight*0.12);
}

const sameRectangle = (a, b) => a && b && a.every((value, index) => Math.abs(value-b[index]) <= 0.75);
const intersects = (a, b, gap = 2) => a[0] < b[2]+gap && a[2] > b[0]-gap
  && a[1] < b[3]+gap && a[3] > b[1]-gap;

function isCamScannerDownload(text) {
  try {
    const url = new URL(text);
    const hostname = url.hostname.toLowerCase();
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      && (hostname === 'camscanner.com' || hostname.endsWith('.camscanner.com'))
      && /^\/(?:user\/)?download(?:\.html)?\/?$/i.test(url.pathname);
  } catch { return false; }
}

function hasOnlyEmptyAppearances(annotation, context) {
  if (!annotation.has(name('AP'))) return true;
  const seen = new Set();
  const empty = (value, depth = 0) => {
    const object = context.lookup(value);
    if (!object || seen.has(object) || depth > 12) return false;
    seen.add(object);
    if (object instanceof PDFRawStream) {
      try {
        const tokens = tokenize(decodePDFRawStream(object).decode());
        let balance = 0;
        for (const token of tokens) {
          if (token.kind !== 'operator' || !['q', 'Q'].includes(token.value)) return false;
          balance += token.value === 'q' ? 1 : -1;
          if (balance < 0) return false;
        }
        return balance === 0;
      } catch { return false; }
    }
    return object instanceof PDFDict && object.values().every((child) => empty(child, depth+1));
  };
  return empty(annotation.get(name('AP')));
}

function sourceLinks(page, context) {
  const result = [];
  let annotations;
  try { annotations = page.node.Annots(); } catch { return result; }
  if (!annotations) return result;
  for (const reference of annotations.asArray()) {
    try {
      const annotation = context.lookup(reference);
      if (!(annotation instanceof PDFDict) || annotation.get(name('Subtype')) !== name('Link')) continue;
      const action = annotation.lookupMaybe(name('A'), PDFDict);
      if (action?.get(name('S')) !== name('URI')) continue;
      if (!hasOnlyEmptyAppearances(annotation, context) || annotation.has(name('AA')) || action.has(name('Next'))) continue;
      const uri = action.lookup(name('URI'));
      if (!(uri instanceof PDFString || uri instanceof PDFHexString) || !isCamScannerDownload(uri.decodeText())) continue;
      const rectangle = numericArray(annotation.lookupMaybe(name('Rect'), PDFArray), 4);
      if (rectangle && rectangle[2] > rectangle[0] && rectangle[3] > rectangle[1]) result.push({ reference, rectangle });
    } catch { /* An unfamiliar annotation cannot establish watermark identity. */ }
  }
  return result;
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

function inspectContent(bytes, objects, context) {
  const tokens = tokenize(bytes);
  const calls = [];
  let simpleScanOperations = true;
  let operands = [];
  let matrix = IDENTITY;
  const stack = [];
  for (const token of tokens) {
    if (token.kind !== 'operator') { operands.push(token); continue; }
    if (['BI', 'ID', 'EI'].includes(token.value)) {
      throw new UnsupportedPageError('页面含内嵌图片，暂不自动修改，已跳过。');
    }
    if (!['q', 'Q', 'cm', 'Do', 'ri'].includes(token.value)) simpleScanOperations = false;
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
      const object = context.lookup(objects.get(name(objectName)));
      if (!(object instanceof PDFStream)) throw new UnsupportedPageError('页面图像资源无法识别，已跳过。');
      const subtype = object.dict.get(name('Subtype'));
      let box;
      let independentResources = true;
      if (subtype === name('Image')) {
        box = bounds(matrix);
      } else if (subtype === name('Form')) {
        const rectangle = numericArray(object.dict.lookupMaybe(name('BBox'), PDFArray), 4);
        const transformObject = object.dict.lookupMaybe(name('Matrix'), PDFArray);
        const transform = transformObject ? numericArray(transformObject, 6) : IDENTITY;
        if (!rectangle || !transform) throw new UnsupportedPageError('嵌套图形的占用范围无法确定，已跳过。');
        box = bounds(concat(matrix, transform), rectangle);
        independentResources = object.dict.lookupMaybe(name('Resources'), PDFDict) !== undefined;
      } else {
        throw new UnsupportedPageError('页面含未知的可绘制资源，已跳过。');
      }
      calls.push({ objectName, object, subtype, box, independentResources, matrix,
        range: [operands[0].start, token.end] });
    } else if (token.value === 'ri' && (operands.length !== 1 || operands[0].kind !== 'name')) {
      throw new UnsupportedPageError('页面渲染参数格式异常，已跳过。');
    }
    operands = [];
  }
  if (stack.length || operands.length) throw new UnsupportedPageError('页面内容未完整闭合，已跳过。');
  return { calls, simpleScanOperations };
}

function objectGraphContains(root, target, context) {
  const pending = [root];
  const seen = new Set();
  while (pending.length) {
    const object = context.lookup(pending.pop());
    if (object === target) return true;
    if (!object || seen.has(object)) continue;
    seen.add(object);
    if (object instanceof PDFDict) pending.push(...object.values());
    else if (object instanceof PDFArray) pending.push(...object.asArray());
    else if (object instanceof PDFStream) pending.push(object.dict);
  }
  return false;
}

async function planRemovals(content, media, links, hashes, context, standardPageCoordinates) {
  const { calls, simpleScanOperations } = content;
  const chosen = [];
  const rejectedReasons = [];
  const forms = calls.filter((call) => call.subtype === name('Form'));
  for (const call of calls) {
    if (call.subtype !== name('Image') || !(call.object instanceof PDFRawStream) || !isFooter(call.box, media)) continue;
    if (!hashes.has(call.object)) hashes.set(call.object, await sha256(call.object.contents));
    const signature = KNOWN_LOGO_HASHES.has(hashes.get(call.object));
    const linked = links.some((link) => sameRectangle(call.box, link.rectangle));
    if (!signature && !linked) {
      rejectedReasons.push('页脚图片缺少同位置的扫描全能王下载链接，且未命中已知标记。');
      continue;
    }
    if (calls.some((other) => other !== call && intersects(call.box, other.box))) {
      rejectedReasons.push('页脚图片与其他正文图形区域重叠或间距不足，已保留原页。');
      continue;
    }
    if (forms.some((form) => !form.independentResources || objectGraphContains(form.object, call.object, context))) {
      rejectedReasons.push('嵌套图形与页脚可能共享图片资源，无法安全分离，已保留原页。');
      continue;
    }
    if (calls.some((other) => other.object !== call.object
      && objectGraphContains(other.object, call.object, context))) {
      rejectedReasons.push('页脚图片仍被正文图形作为蒙版或资源引用，已保留原页。');
      continue;
    }
    if (!signature) {
      if (!standardPageCoordinates || call.matrix[0] <= 0 || call.matrix[3] <= 0
        || Math.abs(call.matrix[1]) > 1e-6 || Math.abs(call.matrix[2]) > 1e-6) {
        rejectedReasons.push('页面或页脚图片采用旋转、倾斜或特殊裁剪边界，结构识别暂不自动处理。');
        continue;
      }
      if (!simpleScanOperations) {
        rejectedReasons.push('页面含文字、绘制或裁剪操作，无法确认页脚图片与正文分离。');
        continue;
      }
      const pageArea = (media[2]-media[0])*(media[3]-media[1]);
      const hasSeparateBody = calls.some((other) => other !== call
        && other.box[1] >= call.box[3]+2
        && other.box[2]-other.box[0] >= (media[2]-media[0])*0.5
        && other.box[3]-other.box[1] >= (media[3]-media[1])*0.35
        && (other.box[2]-other.box[0])*(other.box[3]-other.box[1]) >= pageArea*0.20);
      if (!hasSeparateBody) {
        rejectedReasons.push('未找到与页脚分离的主要正文图像，已保留原页。');
        continue;
      }
    }
    chosen.push({ ...call, method: signature ? 'known-signature' : 'camscanner-link' });
  }
  const unusedNames = new Set(chosen.map((call) => call.objectName));
  const selectedRanges = new Set(chosen.map((call) => call.range));
  for (const call of calls) if (!selectedRanges.has(call.range)) unusedNames.delete(call.objectName);
  return { ranges: chosen.map((call) => call.range), regions: chosen.map((call) => call.box),
    methods: [...new Set(chosen.map((call) => call.method))],
    detections: chosen.map((call) => ({ region: call.box, method: call.method })), unusedNames,
    reason: rejectedReasons[0] || '未发现符合大小与位置要求的独立右下页脚图片。' };
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
  let annotations;
  try { annotations = page.node.Annots(); } catch { return 0; }
  if (!annotations) return 0;
  const matched = new Set(sourceLinks(page, context)
    .filter((link) => regions.some((box) => sameRectangle(box, link.rectangle)))
    .map((link) => link.reference));
  const retained = [];
  let count = 0;
  for (const reference of annotations.asArray()) {
    if (matched.has(reference)) count += 1;
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
 * Clean a PDF locally. Identify independent footer images either by a verified
 * signature or by a matching CamScanner download link, small physical bounds,
 * simple scan drawing operations, and clear separation from the body image.
 * Unknown or ambiguous structures are preserved rather than painted over.
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
    const result = { index, pageNumber: index+1, status: 'skipped', removedWatermarks: 0,
      removedLinks: 0, regions: [], methods: [] };
    pageResults.push(result);
    const originalEntries = ['Resources', 'Contents', 'Annots'].map((key) => [name(key), page.node.get(name(key))]);
    try {
      const resources = page.node.Resources();
      const objects = resources?.lookupMaybe(name('XObject'), PDFDict);
      if (!objects) { result.reason = '未发现独立图片资源；水印可能已融入整页扫描图。'; continue; }
      const media = numericArray(page.node.MediaBox(), 4);
      if (!media) throw new UnsupportedPageError('页面尺寸无法识别，已跳过。');
      const content = decodeContents(page, context);
      const crop = numericArray(page.node.CropBox() || page.node.MediaBox(), 4);
      const angle = page.getRotation().angle;
      const unit = context.lookup(page.node.get(name('UserUnit')));
      const standardPageCoordinates = sameRectangle(media, crop) && ((angle % 360)+360)%360 === 0
        && (unit === undefined || (unit instanceof PDFNumber && unit.asNumber() === 1));
      const parsed = inspectContent(content, objects, context);
      const plan = await planRemovals(parsed, media, sourceLinks(page, context), hashes, context, standardPageCoordinates);
      if (!plan.ranges.length) { result.reason = plan.reason; continue; }
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
      result.methods = plan.methods;
      result.method = plan.methods.length === 1 ? plan.methods[0] : 'mixed';
      result.detections = plan.detections;
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
    removedWatermarks, removedLinks, pages: pageResults,
    methods: [...new Set(pageResults.flatMap((page) => page.methods))] };
  if (!removedWatermarks) return { ...base, status: 'skipped', reason: '未找到同时满足标记依据、页脚位置和正文分离条件的独立水印。' };
  removeShadowedPageTreeResources(context);
  removeUnreachableObjects(context);
  const bytes = await document.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  return { ...base, status: 'cleaned', bytes };
}
