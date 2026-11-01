import { test, expect } from 'vite-plus/test';
import { scorePath, comparePathScores } from './lookup-score';
test('pinned filename/path scorer contract and positions', () => {
  // Literal positions from pinned upstream behavior; this is the shared scorer corpus.
  for (const [path, query, positions] of [
    ['src/workbench.ts', 'wkb', [4,7,8]],
    ['src/NullPointerException.ts', 'NPE', [4,8,15]],
    ['src/foo-bar.ts', 'fb', [4,8]],
    ['src/fooBar.ts', 'fb', [4,7]],
    ['a/src/workbench.ts', 'src/wkb', [2,3,4,5,6,9,10]],
    ['src/workbench.ts', 'wkb ts', [4,7,8,14,15]],
    ['src/workbench.ts', '"work" ts', [4,5,6,7,14,15]],
    ['src/workbench.ts', 'WORK', [4,5,6,7]],
  ] as const) expect(scorePath(path,query)?.positions).toEqual(positions);
  expect(scorePath('workbench.ts','work')!.score).toBeGreaterThan(scorePath('workbench.ts','WORK')!.score);
  expect(scorePath('work.ts','work')!.score).toBeGreaterThan(scorePath('workbench.ts','work')!.score);
  expect(scorePath('foo-bar.ts','fb')!.score).toBeGreaterThan(scorePath('fzzb.ts','fb')!.score);
  expect(scorePath('src/workbench.ts', 'wkb')?.positions).toEqual([4, 7, 8]);
  expect(comparePathScores({path:'workbench.ts',...scorePath('workbench.ts','wkb')!}, {path:'deep/workbench.ts',...scorePath('deep/workbench.ts','wkb')!}, 'wkb')).toBeLessThan(0);
  expect(comparePathScores({path:'workbench.ts',score:131289,positions:[0,3,4]}, {path:'deep/workbench.ts',score:131289,positions:[5,8,9]}, 'wkb')).toBeLessThan(0);
  expect(scorePath('src/workbench.ts', 'wrok')).toBeUndefined();
  expect(scorePath('src/workbench.ts', 'src wkb')).toBeDefined();
  expect(scorePath('src/workbench.ts', 'src missing')).toBeUndefined();
  expect(scorePath('src/workbench.ts', '"wkb"')).toBeUndefined();
  expect(scorePath('src/workbench.ts', '"work"')).toBeDefined();
  expect(scorePath('src/workbench.ts', 'work')!.score).toBeGreaterThan(scorePath('work/other.ts', 'work')!.score);
});

import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, symlinkSync, renameSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Checkout } from './project';
test('native discovery honors only local ignore sources and fixed prunes', async () => {
 const base=realpathSync(mkdtempSync(join(tmpdir(),'lookup-'))), root=join(base,'repo');
 execFileSync('git',['init',root]);
 writeFileSync(join(base,'.ignore'),'parent.txt\n');
 const paths=['parent.txt','.hidden','dist/output.js','deep/workbench.ts','deep/skip.txt','deep/keep.txt','skip-root.txt','rg.txt','git.txt','exclude.txt','global.txt','deep/local.txt','deep/rg-local.txt','node_modules/no.txt','bower_components/no.txt','.svn/no.txt','.hg/no.txt','.jj/no.txt','.DS_Store','Thumbs.db','a.code-search/no.txt'];
 for(const path of paths){mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),'text');}
 writeFileSync(join(root,'.gitignore'),'git.txt\n');writeFileSync(join(root,'.ignore'),'skip-root.txt\n');writeFileSync(join(root,'.rgignore'),'rg.txt\n');
 writeFileSync(join(root,'deep/.gitignore'),'skip.txt\n');writeFileSync(join(root,'deep/.ignore'),'local.txt\n');writeFileSync(join(root,'deep/.rgignore'),'rg-local.txt\n');writeFileSync(join(root,'.git/info/exclude'),'exclude.txt\n');
 symlinkSync(base,join(root,'escape'));
 writeFileSync(join(base,'global-ignore'),'global.txt\n');writeFileSync(join(base,'gitconfig'),`[core]\n excludesFile = ${join(base,'global-ignore')}\n`);writeFileSync(join(base,'rgconfig'),'--invalid-option\n');
 const oldGlobal=process.env.GIT_CONFIG_GLOBAL, oldConfig=process.env.RIPGREP_CONFIG_PATH;process.env.GIT_CONFIG_GLOBAL=join(base,'gitconfig');process.env.RIPGREP_CONFIG_PATH=join(base,'rgconfig');
 const project=await Checkout.open(root);
 try { const result=await project.discover('txt',new AbortController().signal); expect(result.partial).toBe(false); expect(result.results.map(r=>r.path).sort()).toEqual(['deep/keep.txt','global.txt','parent.txt']);
 expect((await project.discover('hidden',new AbortController().signal)).results.map(r=>r.path)).toEqual(['.hidden']);
 expect((await project.discover('output',new AbortController().signal)).results.map(r=>r.path)).toEqual(['dist/output.js']);
 for (const query of ['', 'x'.repeat(257), 'a\0b']) await expect(project.discover(query,new AbortController().signal)).rejects.toThrow('Invalid lookup');
 for (const history of [Array.from({length:201},()=> 'a'), ['../escape'], Array.from({length:20},()=> 'x'.repeat(4000))]) await expect(project.discover('',new AbortController().signal,history)).rejects.toThrow('Invalid lookup history');
 const cancel=new AbortController();cancel.abort();await expect(project.discover('',cancel.signal,[])).rejects.toThrow('cancelled');await expect(project.discover('txt',cancel.signal)).rejects.toThrow('cancelled');
 const first=new AbortController(), second=new AbortController();
 const work=[project.discover('txt',first.signal),project.discover('txt',second.signal)];
 await expect(project.discover('txt',new AbortController().signal)).rejects.toThrow('busy');
 first.abort();second.abort();await Promise.allSettled(work);
 symlinkSync(join(base,'global-ignore'),join(root,'deep/.ignore-link'));
 renameSync(join(root,'deep/.ignore'),join(root,'deep/.ignore-old'));
 renameSync(join(root,'deep/.ignore-link'),join(root,'deep/.ignore'));
 const unsafe=await project.discover('txt',new AbortController().signal);
 expect(unsafe.partial).toBe(true);expect(unsafe.message).toMatch(/ignore.*unavailable/i);
 rmSync(join(root,'deep/.ignore'));renameSync(join(root,'deep/.ignore-old'),join(root,'deep/.ignore'));
 for(let i=0;i<101;i++) writeFileSync(join(root,`cap-${i}.txt`),'text');
 const capped=await project.discover('cap',new AbortController().signal);expect(capped.partial).toBe(true);expect(capped.results).toHaveLength(100);
 const nested=join(root,...Array.from({length:130},()=> 'nested'));mkdirSync(nested,{recursive:true});
 const depth=await project.discover('txt',new AbortController().signal);
 expect(depth.partial).toBe(true);expect(depth.message).toMatch(/ignore.*unavailable/i);
 } finally {if(oldGlobal===undefined) delete process.env.GIT_CONFIG_GLOBAL;else process.env.GIT_CONFIG_GLOBAL=oldGlobal;if(oldConfig===undefined) delete process.env.RIPGREP_CONFIG_PATH;else process.env.RIPGREP_CONFIG_PATH=oldConfig;project.close();rmSync(base,{recursive:true,force:true});}
});

test('recursive observation coalesces unloaded changes, bounds admission and releases on close', async () => {
 const base=realpathSync(mkdtempSync(join(tmpdir(),'lookup-observe-'))), root=join(base,'repo');
 execFileSync('git',['init',root]); mkdirSync(join(root,'deep'));
 const project=await Checkout.open(root);
 const releases: (()=>void)[]=[];
 let notifications=0;
 try {
   releases.push(project.observeFiles(()=>{notifications++;}));
   for(let i=0;i<20;i++) writeFileSync(join(root,'deep',`new-${i}.txt`),'text');
   await expect.poll(()=>notifications).toBeGreaterThan(0);
   expect(notifications).toBeLessThan(5);
   for(let i=1;i<16;i++) releases.push(project.observeFiles(()=>{}));
   expect(()=>project.observeFiles(()=>{})).toThrow('observation limit');
   releases.splice(0).forEach(release=>release());
   const before=notifications;
   writeFileSync(join(root,'deep/after-close.txt'),'text');
   await new Promise(done=>setTimeout(done,700));
   expect(notifications).toBe(before);
   releases.push(project.observeFiles(()=>{}));
   project.close();
   expect(()=>project.observeFiles(()=>{})).toThrow('closed');
 } finally { releases.forEach(release=>release());project.close();rmSync(base,{recursive:true,force:true}); }
});


test('linked checkout observes repository excludes and rejects replaced policy metadata', async () => {
 const base=realpathSync(mkdtempSync(join(tmpdir(),'lookup-policy-'))), root=join(base,'repo'), linked=join(base,'linked');
 execFileSync('git',['init',root]);
 execFileSync('git',['-C',root,'-c','user.name=Test','-c','user.email=test@example.com','commit','--allow-empty','-m','fixture']);
 execFileSync('git',['-C',root,'worktree','add',linked]);
 writeFileSync(join(linked,'policy.txt'),'text');
 const project=await Checkout.open(linked);
 let notifications=0, failure='';
 const release=project.observeFiles(error=>{notifications++;failure=error??'';});
 try {
   writeFileSync(join(root,'.git/info/exclude'),'policy.txt\n');
   await expect.poll(()=>notifications).toBeGreaterThan(0);
   expect((await project.discover('policy',new AbortController().signal)).results).toEqual([]);
   const changed=notifications;
   rmSync(join(root,'.git/info/exclude'));
   await expect.poll(()=>notifications).toBeGreaterThan(changed);
   expect((await project.discover('policy',new AbortController().signal)).results.map(row=>row.path)).toEqual(['policy.txt']);
   const before=notifications;
   renameSync(join(root,'.git/info'),join(root,'.git/info-old'));
   symlinkSync(join(root,'.git/info-old'),join(root,'.git/info'));
   await expect.poll(()=>failure).toMatch(/policy|symbolic|link/i);
   expect(notifications).toBeGreaterThan(before);
   expect(()=>project.observeFiles(()=>{})).toThrow(/policy|link/i);
   rmSync(join(root,'.git/info'));renameSync(join(root,'.git/info-old'),join(root,'.git/info'));
   const retry=project.observeFiles(()=>{});retry();
 } finally {release();project.close();rmSync(base,{recursive:true,force:true});}
});

// Missing bundled tools are a runtime fault, separate from scorer/ignore semantics.
test('missing bundled ripgrep discloses incomplete discovery and leaves exact reads available', async () => {
 const base=realpathSync(mkdtempSync(join(tmpdir(),'lookup-tool-'))), root=join(base,'repo');
 execFileSync('git',['init',root]);writeFileSync(join(root,'known.txt'),'retained file');
 const helper=join(base,'filesystem');copyFileSync('dist/host/filesystem',helper);
 const checkout=await Checkout.open(root,helper);
 try {
   const result=await checkout.discover('known',new AbortController().signal);
   expect(result.partial).toBe(true);expect(result.message).toMatch(/unavailable/i);
   expect(result.results).toEqual([]);
   expect((await checkout.read('known.txt')).text).toBe('retained file');
   copyFileSync('dist/host/ripgrep',join(base,'ripgrep'));
   expect((await checkout.discover('known',new AbortController().signal)).results.map(r=>r.path)).toEqual(['known.txt']);
 } finally {checkout.close();rmSync(base,{recursive:true,force:true});}
});
