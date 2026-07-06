import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'spec', 'wpt');
const REPO = 'web-platform-tests/wpt';
const SHA = 'bbe4ce211741e3b36f58ccdcffd6a7c1926fde1b';
const TREE = process.argv[2] || 'webmessaging';
const enc = p => p.split('/').map(encodeURIComponent).join('/');
async function gh(path, accept='application/vnd.github+json'){
  const h={Accept:accept,'User-Agent':'csim-vendor'}; if(process.env.GITHUB_TOKEN)h.Authorization=`Bearer ${process.env.GITHUB_TOKEN}`;
  const r=await fetch(`https://api.github.com/repos/${REPO}/${path}`,{headers:h}); if(!r.ok)throw new Error(`API ${path}: ${r.status}`); return r;
}
async function listBlobs(tree){ const r=await gh(`git/trees/${SHA}:${tree}?recursive=1`); const j=await r.json(); if(j.truncated)throw new Error('truncated'); return j.tree.filter(e=>e.type==='blob').map(e=>`${tree}/${e.path}`); }
async function fetchRaw(path){ const u=`https://raw.githubusercontent.com/${REPO}/${SHA}/${enc(path)}`; const r=await fetch(u,{headers:{'User-Agent':'csim-vendor'}}); if(r.ok)return Buffer.from(await r.arrayBuffer()); const b=await gh(`contents/${enc(path)}?ref=${SHA}`,'application/vnd.github.raw'); return Buffer.from(await b.arrayBuffer()); }
const blobs = await listBlobs(TREE);
console.error(`${TREE}: ${blobs.length} blobs`);
let done=0;
async function run(items){ for(const p of items){ const buf=await fetchRaw(p); const dest=join(OUT,p); await mkdir(dirname(dest),{recursive:true}); await writeFile(dest,buf); if(++done%25===0||done===blobs.length)process.stderr.write(`\r  ${done}/${blobs.length}`); } }
const N=16, chunks=Array.from({length:N},()=>[]); blobs.forEach((b,i)=>chunks[i%N].push(b));
await Promise.all(chunks.map(run)); process.stderr.write('\n');
console.error('done');
