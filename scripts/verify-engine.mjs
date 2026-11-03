import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import {
  PDFDocument, PDFName, PDFArray, PDFDict, PDFRawStream, PDFString, PDFHexString,
  decodePDFRawStream,
} from 'pdf-lib';
import { cleanPdf } from '../src/pdf-cleaner.js';

const N = (value) => PDFName.of(value);
const knownHash = 'b7f403eab3409be9a213d3754dfca36b35df761884f5c6323546b836eee8c2ba';
const digest = async (bytes) => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
let checks = 0;
function passed(label) { checks += 1; console.log(`PASS ${label}`); }

function contents(page, context) {
  const item = page.node.Contents();
  if (!item) return '';
  const streams = item instanceof PDFArray ? item.asArray().map((ref) => context.lookup(ref)) : [item];
  return streams.map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')).join('\n');
}

function images(page, context) {
  const objects = page.node.Resources()?.lookupMaybe(N('XObject'), PDFDict);
  return objects ? objects.entries().map(([name, ref]) => [name.decodeText(), context.lookup(ref)])
    .filter(([, object]) => object instanceof PDFRawStream && object.dict.get(N('Subtype')) === N('Image')) : [];
}

async function fixture({ logo, pages = ['q 104 0 0 30 476 10 cm /Mark Do Q'], shared = false,
  inherited = false, annotationSpecs = [], nestedForm = false } = {}) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const context = doc.context;
  const logoRef = context.register(context.stream(logo || new Uint8Array([255, 216, 255, 217]), {
    Type: 'XObject', Subtype: 'Image', Width: 312, Height: 90, ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8, Filter: 'DCTDecode',
  }));
  const resources = context.obj({ XObject: { Mark: logoRef } });
  if (nestedForm) {
    const form = context.register(context.stream(new Uint8Array(), {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Resources: {},
    }));
    resources.lookup(N('XObject'), PDFDict).set(N('Nested'), form);
  }
  const sharedRef = shared || inherited ? context.register(resources) : null;
  for (const text of pages) {
    const page = doc.addPage([595, 842]);
    page.node.set(N('Resources'), sharedRef || resources.clone(context));
    const parts = Array.isArray(text) ? text : [text];
    const streams = parts.map((part) => context.register(context.flateStream(Buffer.from(part, 'latin1'))));
    page.node.set(N('Contents'), streams.length === 1 ? streams[0] : context.obj(streams));
    if (inherited) page.node.delete(N('Resources'));
    if (annotationSpecs.length) {
      page.node.set(N('Annots'), context.obj(annotationSpecs.map(({ host, rect = [476, 10, 580, 40], subtype = 'Link' }) =>
        context.register(context.obj({ Type: 'Annot', Subtype: subtype, Rect: rect,
          A: { S: 'URI', URI: PDFString.of(`https://${host}/download`) } })))));
    }
  }
  if (inherited) doc.catalog.Pages().set(N('Resources'), sharedRef);
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

const tinyJpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAABAAMDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKAALFf/2Q==', 'base64');

// Entirely synthetic scans let CI exercise structural detection without any
// personal PDF or copied brand image in the repository.
async function structuralFixture(options = {}) {
  const { encoding = 'FlateDecode', pixels = [240, 90], media = [0, 0, 595, 842],
    resourceName = 'A_Renamed_Image', body = true, bodyForm = false, extraForm = false,
    footer, bodyTransform, prefix = '', annotationSpecs, linksByPage = [true],
    duplicateMarker = false, crop, rotation = 0, userUnit = 1, maskUsesMarker = false } = options;
  const [left, bottom, right, top] = media;
  const width = right-left;
  const height = top-bottom;
  const transform = footer || [80, 0, 0, 30, right-95, bottom+10];
  const box = [transform[4], transform[5], transform[4]+transform[0], transform[5]+transform[3]];
  const doc = await PDFDocument.create({ updateMetadata: false });
  const context = doc.context;
  const pixelDimensions = encoding === 'DCTDecode' ? [3, 1] : pixels;
  const data = encoding === 'DCTDecode' ? tinyJpeg
    : Uint8Array.from({ length: pixelDimensions[0]*pixelDimensions[1]*3 }, (_, index) => (index*19+37)%251);
  const dict = { Type: 'XObject', Subtype: 'Image', Width: pixelDimensions[0], Height: pixelDimensions[1],
    ColorSpace: 'DeviceRGB', BitsPerComponent: 8 };
  const marker = encoding === 'FlateDecode' ? context.flateStream(data, dict)
    : context.stream(data, encoding ? { ...dict, Filter: encoding } : dict);
  const markerRef = context.register(marker);
  let bodyObject = context.flateStream(new Uint8Array([235, 237, 240, 230, 232, 235, 225, 227, 230, 220, 222, 225]), {
    Type: 'XObject', Subtype: 'Image', Width: 2, Height: 2, ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
  });
  if (maskUsesMarker) bodyObject.dict.set(N('SMask'), markerRef);
  if (bodyForm) bodyObject = context.flateStream(Buffer.from('1 1 1 rg 0 0 1 1 re f'), {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Resources: {},
  });
  const bodyRef = context.register(bodyObject);
  const resourceMap = { [resourceName]: markerRef, Body: bodyRef };
  if (extraForm) resourceMap.UnrelatedForm = context.register(context.flateStream(Buffer.from('q Q'), {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Resources: {},
  }));
  const resources = context.register(context.obj({ XObject: resourceMap }));
  const main = bodyTransform || [width-10, 0, 0, height-62, left+5, bottom+52];
  const bodyCall = body ? `q ${main.join(' ')} cm /Body Do Q\n` : '';
  const footerCall = `q ${transform.join(' ')} cm /${resourceName} Do Q`;
  const formCall = extraForm ? 'q 10 0 0 10 100 100 cm /UnrelatedForm Do Q\n' : '';
  const text = `${prefix}${bodyCall}${formCall}${footerCall}${duplicateMarker ? `\n${footerCall}` : ''}`;
  const sharedContents = context.register(context.flateStream(Buffer.from(text, 'latin1')));
  for (const hasLink of linksByPage) {
    const page = doc.addPage([width, height]);
    page.node.set(N('MediaBox'), context.obj(media));
    page.node.set(N('Resources'), resources);
    page.node.set(N('Contents'), sharedContents);
    if (crop) page.node.set(N('CropBox'), context.obj(crop));
    if (rotation) page.node.set(N('Rotate'), context.obj(rotation));
    if (userUnit !== 1) page.node.set(N('UserUnit'), context.obj(userUnit));
    const specs = hasLink ? annotationSpecs || [{ uri: 'https://v3.camscanner.com/user/download' }] : [];
    if (specs.length) {
      page.node.set(N('Annots'), context.obj(specs.map((spec) => {
        const annotation = context.obj({ Type: 'Annot', Subtype: spec.subtype || 'Link', Rect: spec.rect || box,
          A: { S: spec.actionType || 'URI', URI: PDFString.of(spec.uri || 'https://v3.camscanner.com/user/download') } });
        if (spec.appearance) annotation.set(N('AP'), context.obj({ N: context.register(context.flateStream(
          Buffer.from(spec.appearance === 'empty' ? 'q Q' : '1 0 0 rg 0 0 80 30 re f'),
          { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 80, 30], Resources: {} })) }));
        if (spec.additionalAction) annotation.set(N('AA'), context.obj({ E: { S: 'URI', URI: PDFString.of('https://other.example') } }));
        if (spec.chain) annotation.lookup(N('A'), PDFDict).set(N('Next'), context.obj({ S: 'URI', URI: PDFString.of('https://other.example') }));
        return context.register(annotation);
      })));
    }
  }
  return { bytes: await doc.save({ useObjectStreams: false, updateFieldAppearances: false }), markerBytes: marker.contents };
}

async function verifyStructuralFixture(options, expected = 'cleaned') {
  const test = await structuralFixture(options);
  const result = await cleanPdf(test.bytes);
  assert.equal(result.status, expected);
  if (expected === 'cleaned') {
    assert.deepEqual(result.methods, ['camscanner-link']);
    const before = await PDFDocument.load(test.bytes, { updateMetadata: false });
    const after = await PDFDocument.load(result.bytes, { updateMetadata: false });
    assert.equal(after.getPageCount(), before.getPageCount());
    for (const [index, page] of before.getPages().entries()) {
      const cleaned = after.getPage(index);
      assert.deepEqual(cleaned.getMediaBox(), page.getMediaBox());
      assert.deepEqual(cleaned.getCropBox(), page.getCropBox());
      const body = page.node.Resources().lookup(N('XObject'), PDFDict).lookup(N('Body'), PDFRawStream);
      const outputBody = cleaned.node.Resources().lookup(N('XObject'), PDFDict).lookup(N('Body'), PDFRawStream);
      assert.deepEqual(outputBody.contents, body.contents);
    }
    if (!options?.linksByPage?.includes(false)) assert.equal(Buffer.from(result.bytes).includes(Buffer.from(test.markerBytes)), false);
  } else assert.equal(result.bytes, undefined);
  return result;
}

await assert.rejects(cleanPdf(new Uint8Array()), (error) => error.code === 'invalid');
await assert.rejects(cleanPdf(new TextEncoder().encode('This is not a PDF.')), (error) => error.code === 'invalid');
passed('invalid files rejected');

const plain = await PDFDocument.create({ updateMetadata: false });
plain.addPage([595, 842]);
assert.equal((await cleanPdf(await plain.save())).status, 'skipped');
passed('documents without known watermarks are unchanged');

const unknown = await fixture();
const unknownBefore = await digest(unknown);
const unknownResult = await cleanPdf(unknown);
assert.equal(unknownResult.status, 'skipped');
assert.equal(unknownResult.bytes, undefined);
assert.equal(await digest(unknown), unknownBefore);
passed('same-size unknown logo is not removed, input bytes are not mutated');

const signed = await PDFDocument.create({ updateMetadata: false });
signed.addPage();
signed.catalog.set(N('AcroForm'), signed.context.obj({
  Fields: [{ FT: 'Sig', T: PDFString.of('Signature'), V: { Type: 'Sig', ByteRange: [0, 0, 0, 0] } }],
}));
await assert.rejects(cleanPdf(await signed.save({ updateFieldAppearances: false })), (error) => error.code === 'signed');
passed('direct nested digital signature dictionaries rejected');

const encrypted = await PDFDocument.create({ updateMetadata: false });
encrypted.addPage();
encrypted.context.trailerInfo.Encrypt = encrypted.context.register(encrypted.context.obj({
  Filter: 'Standard', V: 1, R: 2, O: PDFHexString.of('00'.repeat(32)),
  U: PDFHexString.of('00'.repeat(32)), P: -4,
}));
await assert.rejects(cleanPdf(await encrypted.save()), (error) => error.code === 'encrypted');
passed('encrypted PDF trailer rejected');

for (const options of [
  { encoding: 'DCTDecode', resourceName: 'OtherVersion' },
  { encoding: 'FlateDecode', pixels: [240, 90] },
  { encoding: 'FlateDecode', pixels: [480, 180], resourceName: 'ChangedSize' },
  { encoding: null, pixels: [48, 18], resourceName: 'Uncompressed' },
  { encoding: 'FlateDecode', media: [0, 0, 842, 595] },
  { encoding: 'FlateDecode', media: [20, 30, 615, 872] },
  { encoding: 'FlateDecode', bodyForm: true, extraForm: true },
  { annotationSpecs: [{ appearance: 'empty' }] },
]) await verifyStructuralFixture(options);
passed('structural detection supports changed pixel dimensions, resource names, DCT/Flate/raw images, landscape and nonzero origins');

for (const uri of [
  'https://camscanner.com.evil.example/user/download',
  'https://evilcamscanner.com/user/download',
  'https://camscanner.com@evil.example/user/download',
  'https://v3.camscanner.com/share/show',
  'https://v3.camscanner.com/document/download-copy',
  'https://other.example/user/download',
  'javascript:alert(1)',
]) await verifyStructuralFixture({ annotationSpecs: [{ uri }] }, 'skipped');
passed('spoofed domains, non-promotion paths, and non-HTTP actions cannot establish watermark identity');

for (const options of [
  { linksByPage: [false] },
  { body: false },
  { annotationSpecs: [{ rect: [501.5, 10, 581.5, 40] }] },
  { annotationSpecs: [{ subtype: 'Text' }] },
  { annotationSpecs: [{ actionType: 'GoTo' }] },
  { annotationSpecs: [{ appearance: 'painted' }] },
  { annotationSpecs: [{ additionalAction: true }] },
  { annotationSpecs: [{ chain: true }] },
]) await verifyStructuralFixture(options, 'skipped');
passed('anonymous footers, missing body evidence, mismatched rectangles, and links with visible appearances or extra actions are preserved');

for (const options of [
  { footer: [595, 0, 0, 842, 0, 0] },
  { footer: [160, 0, 0, 30, 420, 10] },
  { footer: [80, 0, 0, 60, 500, 10] },
  { footer: [30, 0, 0, 30, 550, 10] },
  { footer: [80, 0, 0, 30, 10, 10] },
  { bodyTransform: [595, 0, 0, 842, 0, 0] },
  { duplicateMarker: true },
  { maskUsesMarker: true },
]) await verifyStructuralFixture(options, 'skipped');
passed('linked body images, abnormal physical dimensions, overlapping content, duplicate calls, and masks cannot be mistaken for a footer');

for (const options of [
  { prefix: 'BT (Text) Tj ET\n' },
  { prefix: '0 0 20 20 re f\n' },
  { prefix: '0 0 595 842 re W n\n' },
  { crop: [0, 0, 590, 840] },
  { rotation: 90 },
  { userUnit: 2 },
  { footer: [80, 2, 0, 30, 500, 10], annotationSpecs: [{ rect: [500, 10, 580, 42] }] },
  { footer: [-80, 0, 0, 30, 580, 10], annotationSpecs: [{ rect: [500, 10, 580, 40] }] },
]) await verifyStructuralFixture(options, 'skipped');
passed('structural mode preserves text/paint/clip pages and ambiguous crop, rotation, scaling, or skew');

const sharedStructural = await verifyStructuralFixture({ linksByPage: [true, false] });
assert.equal(sharedStructural.changedPages, 1);
assert.equal(sharedStructural.pages[1].status, 'skipped');
const sharedStructuralSource = await structuralFixture({ linksByPage: [true, false] });
const sharedStructuralResult = await cleanPdf(sharedStructuralSource.bytes);
const sharedBefore = await PDFDocument.load(sharedStructuralSource.bytes);
const sharedAfter = await PDFDocument.load(sharedStructuralResult.bytes);
assert.equal(contents(sharedBefore.getPage(1), sharedBefore.context), contents(sharedAfter.getPage(1), sharedAfter.context));
assert.equal(images(sharedAfter.getPage(1), sharedAfter.context).length, 2);
passed('cross-page shared resources and shared Contents remain intact on pages without matching links');

if (process.env.SAMPLE_PDF_PATH) {
  let source;
  try { source = new Uint8Array(await readFile(process.env.SAMPLE_PDF_PATH)); }
  catch { throw new Error('Could not read the external sample PDF.'); }
  const sourceHash = await digest(source);
  const inputDoc = await PDFDocument.load(source, { updateMetadata: false });
  let logo;
  for (const page of inputDoc.getPages()) {
    for (const [, object] of images(page, inputDoc.context)) {
      if (await digest(object.contents) === knownHash) logo = object.contents.slice();
    }
  }
  assert.ok(logo, 'External sample must contain the verified logo.');
  const result = await cleanPdf(source);
  assert.equal(result.status, 'cleaned');
  assert.ok(result.changedPages > 0);
  assert.equal(await digest(source), sourceHash);
  const cleanedDoc = await PDFDocument.load(result.bytes, { updateMetadata: false });
  assert.equal(cleanedDoc.getPageCount(), inputDoc.getPageCount());
  for (const [index, before] of inputDoc.getPages().entries()) {
    const after = cleanedDoc.getPage(index);
    assert.deepEqual(after.getMediaBox(), before.getMediaBox());
    assert.deepEqual(after.getCropBox(), before.getCropBox());
    assert.deepEqual(after.getRotation(), before.getRotation());
    const beforeImages = new Map();
    for (const [key, object] of images(before, inputDoc.context)) {
      const hash = await digest(object.contents);
      if (hash !== knownHash) beforeImages.set(key, hash);
    }
    const afterImages = new Map();
    for (const [key, object] of images(after, cleanedDoc.context)) afterImages.set(key, await digest(object.contents));
    assert.deepEqual(afterImages, beforeImages, 'Body image bytes must remain identical.');
  }
  assert.equal(Buffer.from(result.bytes).includes(Buffer.from(logo)), false);
  const rerun = await cleanPdf(result.bytes);
  assert.equal(rerun.status, 'skipped');
  passed('external sample: all body image bytes and page geometry retained; logo stream absent; rerun skips');
  if (process.env.CLEANED_PDF_OUTPUT) await writeFile(process.env.CLEANED_PDF_OUTPUT, result.bytes);

  const prefix = 'BT (/Mark Do BI (nested) \\(escaped\\)) Tj [(/Mark Do) 12 <2f4d61726b20446f>] TJ ET\n% /Mark Do BI in comment\n';
  const text = `${prefix}q 104 0 0 30 476 10 cm /Mark Do Q`;
  const lexical = await cleanPdf(await fixture({ logo, pages: [text] }));
  assert.equal(lexical.removedWatermarks, 1);
  const lexicalDoc = await PDFDocument.load(lexical.bytes);
  assert.equal(contents(lexicalDoc.getPage(0), lexicalDoc.context), `${prefix}q 104 0 0 30 476 10 cm  Q\n`);
  passed('comments, nested/escaped strings, arrays, and hex strings stay byte-for-byte intact');

  const split = await cleanPdf(await fixture({ logo, pages: [['q 104 0 0 30 476 10 cm /Mark', 'Do Q']] }));
  assert.equal(split.removedWatermarks, 1);
  passed('graphics state and operands crossing content-stream boundaries supported');

  for (const text of [
    'q 104 0 0 30 476 10 cm /Mark Do Q\nBI /W 1 /H 1 /CS /RGB /BPC 8 ID abc EI',
    'q 104 0 0 30 476 10 cm /Mark Do Q\n(unclosed string',
    'q 104 0 0 30 476 10 cm /Mark Do',
  ]) {
    const skipped = await cleanPdf(await fixture({ logo, pages: [text] }));
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.bytes, undefined);
  }
  passed('inline images and malformed content skip the entire page without partial edits');

  const nonFooter = 'q 104 0 0 30 30 600 cm /Mark Do Q';
  const both = await cleanPdf(await fixture({ logo, pages: [`${nonFooter}\nq 104 0 0 30 476 10 cm /Mark Do Q`] }));
  assert.equal(both.removedWatermarks, 1);
  const bothDoc = await PDFDocument.load(both.bytes);
  assert.ok(contents(bothDoc.getPage(0), bothDoc.context).startsWith(nonFooter));
  assert.equal(images(bothDoc.getPage(0), bothDoc.context).length, 1);
  assert.ok(Buffer.from(both.bytes).includes(Buffer.from(logo)));
  passed('same image used outside the footer is retained with its resource');

  for (const inherited of [false, true]) {
    const shared = await cleanPdf(await fixture({ logo, shared: true, inherited,
      pages: ['q 104 0 0 30 476 10 cm /Mark Do Q', nonFooter] }));
    assert.equal(shared.changedPages, 1);
    const sharedDoc = await PDFDocument.load(shared.bytes);
    assert.equal(images(sharedDoc.getPage(0), sharedDoc.context).length, 0);
    assert.equal(images(sharedDoc.getPage(1), sharedDoc.context).length, 1);
    assert.equal(contents(sharedDoc.getPage(1), sharedDoc.context), nonFooter);
  }
  passed('shared and inherited resource dictionaries cannot corrupt untouched pages');

  const inheritedCleaned = await cleanPdf(await fixture({ logo, inherited: true,
    pages: ['q 104 0 0 30 476 10 cm /Mark Do Q', 'q 104 0 0 30 476 10 cm /Mark Do Q'] }));
  assert.equal(inheritedCleaned.changedPages, 2);
  assert.equal(Buffer.from(inheritedCleaned.bytes).includes(Buffer.from(logo)), false);
  passed('shadowed inherited resources do not retain a hidden watermark stream');

  const annotated = await cleanPdf(await fixture({ logo, annotationSpecs: [
    { host: 'camscanner.com' }, { host: 'v3.camscanner.com' },
    { host: 'camscanner.com.evil.test' }, { host: 'other.example' },
    { host: 'camscanner.com', rect: [10, 10, 20, 20] },
    { host: 'camscanner.com', subtype: 'Text' },
  ] }));
  assert.equal(annotated.removedLinks, 2);
  const annotatedDoc = await PDFDocument.load(annotated.bytes);
  assert.equal(annotatedDoc.getPage(0).node.Annots().size(), 4);
  passed('link cleanup requires matching region, Link subtype, and exact CamScanner domain');

  const forms = await cleanPdf(await fixture({ logo, nestedForm: true }));
  assert.equal(forms.status, 'cleaned');
  passed('unused unrelated Form XObjects do not block a verified footer');
} else {
  console.log('INFO external sample checks skipped; set SAMPLE_PDF_PATH to a local PDF to include them.');
}

if (process.env.EXTRA_SAMPLE_PDF_PATH) {
  let source;
  try { source = new Uint8Array(await readFile(process.env.EXTRA_SAMPLE_PDF_PATH)); }
  catch { throw new Error('Could not read the extra external sample PDF.'); }
  const sourceHash = await digest(source);
  const before = await PDFDocument.load(source, { updateMetadata: false });
  const result = await cleanPdf(source);
  assert.equal(result.status, 'cleaned');
  assert.equal(result.changedPages, before.getPageCount());
  assert.equal(result.removedWatermarks, before.getPageCount());
  assert.equal(result.removedLinks, before.getPageCount());
  assert.deepEqual(result.methods, ['camscanner-link']);
  assert.equal(await digest(source), sourceHash);
  const after = await PDFDocument.load(result.bytes, { updateMetadata: false });
  const removedStreams = new Map();
  assert.equal(after.getPageCount(), before.getPageCount());
  for (const [index, original] of before.getPages().entries()) {
    const cleaned = after.getPage(index);
    assert.deepEqual(cleaned.getMediaBox(), original.getMediaBox());
    assert.deepEqual(cleaned.getCropBox(), original.getCropBox());
    assert.deepEqual(cleaned.getRotation(), original.getRotation());
    const inputImages = new Map(images(original, before.context));
    const outputImages = new Map(images(cleaned, after.context));
    for (const [key, object] of outputImages) {
      assert.ok(inputImages.has(key));
      assert.deepEqual(object.contents, inputImages.get(key).contents);
      assert.equal(object.dict.get(N('Width')).toString(), inputImages.get(key).dict.get(N('Width')).toString());
      assert.equal(object.dict.get(N('Height')).toString(), inputImages.get(key).dict.get(N('Height')).toString());
    }
    const removed = [...inputImages].filter(([key]) => !outputImages.has(key));
    assert.equal(removed.length, 1);
    for (const [, object] of removed) removedStreams.set(await digest(object.contents), object.contents);
    assert.equal(cleaned.node.Annots()?.size() || 0, 0);
  }
  for (const data of removedStreams.values()) assert.equal(Buffer.from(result.bytes).includes(Buffer.from(data)), false);
  assert.equal((await cleanPdf(result.bytes)).status, 'skipped');
  if (process.env.EXTRA_CLEANED_PDF_OUTPUT) await writeFile(process.env.EXTRA_CLEANED_PDF_OUTPUT, result.bytes);
  passed(`extra external sample: ${before.getPageCount()} pages structurally cleaned; body bytes and geometry identical; logo streams absent`);
}

console.log(`Verified ${checks} checks. No document content was printed.`);
