// CLI used by Python to compare both planners over exactly the same portable inputs.
import {readFile} from 'node:fs/promises';
import {buildMergePlan} from '../frontend/src/data/mergePlan.js';
const fixtures=JSON.parse(await readFile(new URL('./manual-merge-fixtures.json',import.meta.url),'utf8'));
fixtures.push(...JSON.parse(await readFile(new URL('./legacy-schedule-merge-fixtures.json',import.meta.url),'utf8')));
const plans=[];
for (const f of fixtures) plans.push(await buildMergePlan(f.local,f.incoming,f.mode||'merge',f.choices));
process.stdout.write(JSON.stringify(plans));
