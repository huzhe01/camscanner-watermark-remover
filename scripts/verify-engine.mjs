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
  assert.equal(forms.status, 'skipped');
  passed('nested Form XObject pages are conservatively skipped');
} else {
  console.log('INFO external sample checks skipped; set SAMPLE_PDF_PATH to a local PDF to include them.');
}

console.log(`Verified ${checks} checks. No document content was printed.`);
