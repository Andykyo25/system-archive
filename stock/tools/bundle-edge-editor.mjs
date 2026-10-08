// Mechanical flattening for the Dashboard single-file editor. Source and shared
// modules remain canonical; no retyped deployment copies. No environment reads.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
const output=process.argv[2];
if(!output) throw new Error('Specify a private output directory');
await mkdir(output,{recursive:true});
async function bundle(path,seen=new Set()){
  path=resolve(path);if(seen.has(path)) return '';seen.add(path);
  let source=await readFile(path,'utf8'),dependencies='';
  const locals=[...source.matchAll(/^import[^\n;]*from\s+["'](\.[^"']+)["'];/gm)];
  for(const m of locals){dependencies+=await bundle(resolve(dirname(path),m[1]),seen);source=source.replace(m[0],'');}
  return dependencies+'\n'+source.replace(/^export /gm,'');
}
for(const name of ['fetch-finmind-fundamentals','fetch-official-fundamentals','run-r2p-forward','check-holding-risks']){
  const source=await bundle('supabase/functions/'+name+'/index.ts');
  await writeFile(join(output,name+'.ts'),source);
  console.log(JSON.stringify({name,bytes:Buffer.byteLength(source),sha256:createHash('sha256').update(source).digest('hex')}));
}
