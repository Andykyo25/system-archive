import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const output=process.argv[2];if(!output) throw new Error('Specify private output directory');
await mkdir(output,{recursive:true});
for(const file of ['20261008075201_collection_priority','20261008075202_r2p_forward','20261008075203_holding_risk_monitor','20261008075204_optimization_jobs']){
  const sql=await readFile('supabase/migrations/'+file+'.sql','utf8');
  const version=file.slice(0,14),name=file.slice(15),tag='$optimization_source$';
  if(sql.includes(tag)) throw new Error('SQL quote tag collision');
  const wrapped="begin;\nset local statement_timeout='120s';\n"+sql+
    "\ninsert into supabase_migrations.schema_migrations(version,name,statements) values ('"+version+"','"+name+"',array["+tag+sql+tag+"]);\ncommit;\n"+
    "select version,name from supabase_migrations.schema_migrations where version='"+version+"';\n";
  await writeFile(join(output,file+'.sql'),wrapped);
  console.log(JSON.stringify({file,version,sha256:createHash('sha256').update(sql).digest('hex')}));
}
