import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { BlobReader, BlobWriter, TextReader, TextWriter, ZipReader, ZipWriter, configure } from '@zip.js/zip.js';
import { activeBranch } from '../lib/pdf-branch.ts';

configure({ useWebWorkers: false });
// Run the actual background worker with Chrome and HTTP mocked, using the real
// parser, Markdown converter, ZIP writer and download handler.
const source = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '')
  .replace('export default defineBackground', 'defineBackground');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
});

async function exportProject(pages, titles, failedChat = null) {
  let listener;
  const downloads = [];
  const requests = [];
  const projectPath = '/backend-api/gizmos/g-p-abc123/conversations';
  const sidebarPath = '/backend-api/gizmos/snorlax/sidebar';
  const routes = new Map([
    [sidebarPath, { items: [{ gizmo: { id: 'g-p-other', display: { name: 'Other Project' } } }], cursor: 'metadata-next' }],
    [`${sidebarPath}?cursor=metadata-next`, { items: [{ gizmo: { id: 'g-p-abc123', display: { name: 'Project: Science. ' } } }], cursor: null }],
    ...pages.map((page, index) => [`${projectPath}?cursor=${index ? 'next%2Fpage%2B2' : '0'}`, page]),
  ]);
  vm.runInNewContext(outputText, {
    defineBackground: callback => callback(),
    activeBranch, BlobReader, BlobWriter, TextReader, ZipWriter,
    Blob, Uint8Array, btoa, console, setTimeout, clearTimeout,
    // Exercise the service worker's data-URL download path.
    URL: class extends URL { static createObjectURL = undefined; },
    chrome: {
      runtime: {
        onConnect: { addListener() {} },
        onMessage: { addListener(callback) { listener = callback; } },
      },
      tabs: { query(_query, callback) {
        callback([{ id: 1, url: 'https://chatgpt.com/g/g-p-abc123/c/not-enumerated-current-chat' }]);
      } },
      downloads: { download(options, callback) { downloads.push(options); callback(1); } },
    },
    fetch: async (url, options) => {
      const path = url.replace('https://chatgpt.com', '');
      requests.push(path);
      if (path === '/api/auth/session') return { ok: true, json: async () => ({ accessToken: 'mock-token' }) };
      assert.equal(options.headers.authorization, 'Bearer mock-token');
      if (routes.has(path)) return { ok: true, json: async () => routes.get(path) };
      const id = path.replace('/backend-api/conversation/', '');
      assert.ok(titles.has(id), `Unexpected request outside the enumerated project: ${path}`);
      if (id === failedChat) return { ok: false, status: 403 };
      return { ok: true, json: async () => ({
        conversation_id: id,
        title: titles.get(id),
        mapping: { message: { message: { author: { role: 'assistant' }, content: { parts: [`Full content of ${id}`] } } } },
      }) };
    },
  });
  const response = await new Promise(resolve => {
    assert.equal(listener({
      message: 'backUpCurrentProject', downloadType: 'markdown',
      secondsBetweenChatDownloads: 0,
      // Project Markdown must still produce .md files without MDX frontmatter.
      markdownExtension: '.mdx', mdxFrontmatter: 'unwanted frontmatter',
    }, {}, resolve), true);
  });
  return { downloads, requests, response };
}

async function readZip(download) {
  const blob = await (await fetch(download.url)).blob();
  assert.equal(blob.type, 'application/zip');
  const reader = new ZipReader(new BlobReader(blob));
  try {
    const entries = await reader.getEntries();
    return new Map(await Promise.all(entries.map(async entry => [entry.filename, await entry.getData(new TextWriter())])));
  } finally {
    await reader.close();
  }
}

test('Current Project exports every paginated chat in one named Markdown ZIP', async () => {
  const titles = new Map([
    ['chat-1', 'First Chat'], ['chat-2', 'First Chat'],
    ['chat-3', 'Notes: A/B?. '], ['chat-4', 'CON'], ['chat-5', 'first chat'],
  ]);
  const pages = [
    { items: [{ id: 'chat-1', title: 'Stale title' }, { id: 'chat-2' }], cursor: 'next/page+2' },
    { items: [{ id: 'chat-2' }, { id: 'chat-3' }, { id: 'chat-4' }, { id: 'chat-5' }], cursor: null },
  ];
  const result = await exportProject(pages, titles);
  assert.equal(result.response.error, undefined);
  assert.equal(result.downloads.length, 1);
  assert.equal(result.downloads[0].filename, 'Project_ Science.zip');
  const entries = await readZip(result.downloads[0]);
  assert.deepEqual([...entries.keys()], [
    'Project_ Science/First Chat.md', 'Project_ Science/First Chat (2).md',
    'Project_ Science/Notes_ A_B_.md', 'Project_ Science/_CON.md', 'Project_ Science/first chat (3).md',
  ]);
  [...entries.values()].forEach((markdown, index) => assert.equal(markdown, `ASSISTANT\n\nFull content of chat-${index + 1}\n\n---\n\n`));
  assert.equal(result.requests.filter(path => path.startsWith('/backend-api/conversation/')).length, 5);
  assert.ok(result.requests.includes('/backend-api/gizmos/g-p-abc123/conversations?cursor=next%2Fpage%2B2'));

  const single = await exportProject([{ items: [{ id: 'chat-1' }], cursor: null }], titles);
  assert.equal(single.response.error, undefined);
  assert.equal(single.downloads.length, 1);
  assert.equal(single.downloads[0].filename, 'Project_ Science.zip');
  assert.deepEqual([...(await readZip(single.downloads[0])).keys()], ['Project_ Science/First Chat.md']);

  const incomplete = await exportProject([{ items: [{ id: 'chat-1' }], has_more: true }], titles);
  assert.match(incomplete.response.error, /missing next cursor/);
  assert.equal(incomplete.downloads.length, 0);
  const failed = await exportProject(pages, titles, 'chat-3');
  assert.match(failed.response.error, /No incomplete ZIP was downloaded/);
  assert.equal(failed.downloads.length, 0);
});
