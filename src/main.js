import './style.css';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

const $ = (id) => document.getElementById(id);
const input = $('file-input');
const dropZone = $('drop-zone');
const processButton = $('process-button');
const clearButton = $('clear-button');
const MAX_SIZE = 100 * 1024 * 1024;
let selected = [];
let outputs = [];
let busy = false;
let previewGeneration = 0;
let sequence = 0;
let worker;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./cleaner-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return;
    pending.delete(data.id);
    data.error ? job.reject(new Error(data.error)) : job.resolve(data.result);
  };
  worker.onerror = () => {
    for (const job of pending.values()) job.reject(new Error('处理程序未能启动，请刷新页面后重试。'));
    pending.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

function processPdf(buffer) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    try {
      const activeWorker = getWorker();
      pending.set(id, { resolve, reject });
      activeWorker.postMessage({ id, input: buffer }, [buffer]);
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

function setStatus(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}

function fileSize(size) {
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderQueue() {
  $('queue').hidden = selected.length === 0;
  $('queue-count').textContent = `已选择 ${selected.length} 个文件`;
  const list = $('file-list');
  list.replaceChildren();
  selected.forEach((file, index) => {
    const item = createElement('li', 'file-item');
    item.append(createElement('span', 'file-icon', 'PDF'));
    const info = createElement('div', 'file-details');
    const name = createElement('p', 'file-name', file.name);
    name.title = file.name;
    info.append(name, createElement('p', 'file-size', fileSize(file.size)));
    const remove = createElement('button', 'remove-file', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `移除 ${file.name}`);
    remove.disabled = busy;
    remove.onclick = () => {
      selected.splice(index, 1);
      renderQueue();
      setStatus('');
    };
    item.append(info, remove);
    list.append(item);
  });
  processButton.disabled = busy || selected.length === 0;
  clearButton.disabled = busy;
  processButton.querySelector('span').textContent = busy ? '正在处理…' : '去除水印';
  dropZone.setAttribute('aria-disabled', String(busy));
  input.disabled = busy;
}

function addFiles(files) {
  if (busy) return;
  const errors = [];
  for (const file of files) {
    if (!/\.pdf$/i.test(file.name)) {
      errors.push(`${file.name}：请选择 PDF 文件。`);
    } else if (file.size === 0) {
      errors.push(`${file.name}：文件为空。`);
    } else if (file.size > MAX_SIZE) {
      errors.push(`${file.name}：超过 100 MB，请拆分后处理。`);
    } else if (!selected.some((old) => old.name === file.name && old.size === file.size && old.lastModified === file.lastModified)) {
      selected.push(file);
    }
  }
  input.value = '';
  renderQueue();
  setStatus(errors.join(' '), errors.length > 0);
}

function resetOutputs() {
  for (const output of outputs) if (output.url) URL.revokeObjectURL(output.url);
  outputs = [];
  $('results').hidden = true;
  $('result-list').replaceChildren();
  $('demo-preview').hidden = false;
  $('real-preview').hidden = true;
  previewGeneration += 1;
  for (const id of ['before-canvas', 'after-canvas']) {
    $(id).width = 0;
    $(id).height = 0;
  }
}

function download(output) {
  if (!output.url) return;
  const link = document.createElement('a');
  link.href = output.url;
  link.download = output.filename;
  document.body.append(link);
  link.click();
  link.remove();
}

function renderResult(output) {
  const item = createElement('li', 'result-item');
  const state = createElement('span', `result-state ${output.status}`, output.status === 'cleaned' ? '✓' : output.status === 'skipped' ? '—' : '!');
  state.setAttribute('aria-hidden', 'true');
  const info = createElement('div', 'result-info');
  const name = createElement('p', 'file-name', output.originalName);
  name.title = output.originalName;
  info.append(name, createElement('p', 'result-note', output.message));
  item.append(state, info);
  if (output.url) {
    const button = createElement('button', 'download-button', '下载 PDF ↓');
    button.type = 'button';
    button.setAttribute('aria-label', `下载 ${output.filename}`);
    button.onclick = () => download(output);
    item.append(button);
  }
  $('result-list').append(item);
  $('results').hidden = false;
}

let pdfJsPromise;
async function getPdfJs() {
  pdfJsPromise ||= import('pdfjs-dist/build/pdf.mjs').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    return pdfjs;
  });
  return pdfJsPromise;
}

async function drawFooter(bytes, canvas, generation) {
  const pdfjs = await getPdfJs();
  if (generation !== previewGeneration) return;
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    enableXfa: false,
    stopAtErrors: true,
  });
  let pdf;
  try {
    pdf = await task.promise;
    const page = await pdf.getPage(1);
    const scale = 1.5;
    const viewport = page.getViewport({ scale });
    const temporary = document.createElement('canvas');
    temporary.width = Math.ceil(viewport.width);
    temporary.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: temporary.getContext('2d'), viewport }).promise;
    if (generation !== previewGeneration) return;
    const width = Math.min(temporary.width, Math.ceil(230 * scale));
    const height = Math.min(temporary.height, Math.ceil(65 * scale));
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(temporary, temporary.width - width, temporary.height - height, width, height, 0, 0, width, height);
    temporary.width = temporary.height = 0;
  } finally {
    await task.destroy();
  }
}

async function preview(file, bytes) {
  const generation = ++previewGeneration;
  $('demo-preview').hidden = true;
  $('real-preview').hidden = false;
  $('preview-status').textContent = '正在生成本地预览…';
  try {
    const before = await file.arrayBuffer();
    await Promise.all([
      drawFooter(before, $('before-canvas'), generation),
      drawFooter(bytes, $('after-canvas'), generation),
    ]);
    if (generation === previewGeneration) $('preview-status').textContent = '预览仅在本机生成 · 请检查下载后的完整文件';
  } catch (error) {
    console.warn('Local PDF preview failed:', error?.message || 'Unknown rendering error');
    if (generation === previewGeneration) {
      $('demo-preview').hidden = false;
      $('real-preview').hidden = true;
      setStatus('PDF 已处理完成，预览暂不可用。可以下载后查看。');
    }
  }
}

processButton.onclick = async () => {
  if (busy || selected.length === 0) return;
  busy = true;
  resetOutputs();
  renderQueue();
  const files = [...selected];
  let previewWork;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    setStatus(`正在本地处理 ${index + 1} / ${files.length}…`);
    let output;
    try {
      const buffer = await file.arrayBuffer();
      const result = await processPdf(buffer);
      if (result.status === 'cleaned' && result.bytes) {
        const blob = new Blob([result.bytes], { type: 'application/pdf' });
        output = {
          status: 'cleaned',
          originalName: file.name,
          filename: file.name.replace(/\.pdf$/i, '') + '_去水印.pdf',
          url: URL.createObjectURL(blob),
          message: `已去除 ${result.removedWatermarks} 处水印 · ${result.changedPages} / ${result.pageCount} 页已处理`,
        };
        if (!previewWork) previewWork = preview(file, result.bytes);
      } else {
        output = { status: 'skipped', originalName: file.name, message: result.reason || '未找到支持的页脚水印，原文件未修改。' };
      }
    } catch (error) {
      output = { status: 'error', originalName: file.name, message: error?.message || '无法处理此文件，请检查文件是否完整。' };
    }
    outputs.push(output);
    renderResult(output);
  }
  busy = false;
  renderQueue();
  const cleaned = outputs.filter((output) => output.status === 'cleaned').length;
  const skipped = outputs.filter((output) => output.status === 'skipped').length;
  const failed = outputs.length - cleaned - skipped;
  $('download-all').hidden = cleaned < 2;
  setStatus(`完成：${cleaned} 个文件已处理${skipped ? `，${skipped} 个已跳过` : ''}${failed ? `，${failed} 个未能处理` : ''}。`);
  if (previewWork) await previewWork;
};

function chooseFiles() {
  if (!busy) input.click();
}
dropZone.onclick = chooseFiles;
dropZone.onkeydown = (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    chooseFiles();
  }
};
input.onchange = () => addFiles([...input.files]);
for (const event of ['dragenter', 'dragover']) {
  dropZone.addEventListener(event, (e) => {
    e.preventDefault();
    if (!busy) dropZone.classList.add('dragover');
  });
}
for (const event of ['dragleave', 'drop']) dropZone.addEventListener(event, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); });
dropZone.addEventListener('drop', (event) => addFiles([...event.dataTransfer.files]));
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());
clearButton.onclick = () => {
  if (busy) return;
  selected = [];
  resetOutputs();
  renderQueue();
  setStatus('');
};
$('download-all').onclick = async () => {
  for (const output of outputs) {
    if (output.url) {
      download(output);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
};
window.addEventListener('beforeunload', () => {
  for (const output of outputs) if (output.url) URL.revokeObjectURL(output.url);
  worker?.terminate();
});
if (!window.isSecureContext || !globalThis.crypto?.subtle || !globalThis.Worker) {
  setStatus('请通过 HTTPS 在现代浏览器中打开此工具。', true);
  processButton.disabled = true;
  input.disabled = true;
  dropZone.setAttribute('aria-disabled', 'true');
  busy = true;
}
