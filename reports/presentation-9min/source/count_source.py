import subprocess,json,csv,re
from pathlib import Path
from pygments import lex
from pygments.lexers import get_lexer_for_filename
from pygments.token import Comment
root=Path.cwd(); out=root/'.workbench-cache/report-dynamic/output'
head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(); baseline='95acbb7'
def selected(p):
 return (p.startswith(('apps/workbench/src/','apps/workbench/src-tauri/src/','crates/','packages/agent-runtime/src/','packages/arranger/src/','packages/classroom/src/','packages/classroom/java/','packages/showcase/src/','packages/showcase/demo/','packages/showcase/public/')) and Path(p).suffix in ['.rs','.java','.ts','.tsx','.mts','.css','.js','.html'] and not any(s in p.split('/') for s in ['generated','test','tests','fixtures','vendor','third-party','gen']) and not p.endswith(('build.rs','.test.ts','.test.mts','_tests.rs')) and '/src/bin/' not in p and p != 'packages/showcase/public/demo.js')
def count(ref):
 files=[p for p in subprocess.check_output(['git','ls-tree','-r','--name-only',ref],text=True).splitlines() if selected(p)]; result=[]
 data=subprocess.check_output(['git','cat-file','--batch'],input=''.join(f'{ref}:{p}\n' for p in files).encode());offset=0
 for p in files:
  e=data.index(b'\n',offset);size=int(data[offset:e].split()[-1]);offset=e+1
  src=data[offset:offset+size].decode('utf-8',errors='replace');offset+=size+1
  # Rust test-only suffix modules are excluded from production totals.
  src=re.sub(r'(?ms)^#\[cfg\(test\)\]\s*(?:pub\s+)?mod\s+tests\s*\{.*\Z','',src)
  try:
   stripped=''.join(v if not t in Comment else ''.join('\n' if c=='\n' else ' ' for c in v) for t,v in lex(src,get_lexer_for_filename(p)))
  except Exception: stripped=src
  loc=sum(bool(line.strip()) for line in stripped.splitlines())
  group=('前端界面' if p.startswith('apps/workbench/src/') else '桌面壳' if p.startswith('apps/workbench/src-tauri') else 'AI运行时' if p.startswith('packages/agent-runtime') else '自动布局' if p.startswith('packages/arranger') else '课堂服务' if p.startswith('packages/classroom') else '官网与演示' if p.startswith('packages/showcase') else '文档内核' if p.startswith('crates/circuit-document') else '原生兼容与仿真' if p.startswith('crates/logisim-runtime') else 'Rust宿主')
  result.append(dict(path=p,module=group,language=Path(p).suffix,code=loc,physical=len(src.splitlines())))
 return result
rows=count(head);base=count(baseline)
logic=sum(r['code'] for r in rows if r['language'] not in ['.css','.html']); css=sum(r['code'] for r in rows if r['language']=='.css')
modules={}
for r in rows:
 if r['language'] not in ['.css','.html']:modules[r['module']]=modules.get(r['module'],0)+r['code']
result=dict(commit=head,baseline=baseline,date='2026-11-02',definition='Git tracked production sources; Pygments comment removal, nonblank physical code lines; excludes scripts/tests/generated/config/vendor; excludes Rust test suffix modules. CSS reported separately. This measures repository source, not original authorship.',logic=logic,css=css,total=logic+css,files=len(rows),baselineLogic=sum(r['code'] for r in base if r['language'] not in ['.css','.html']),baselineCSS=sum(r['code'] for r in base if r['language']=='.css'),modules=modules)
result['markup']=sum(r['code'] for r in rows if r['language']=='.html')
result['total']=logic+css+result['markup']
(out/'代码量统计.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
with (out/'代码量明细.csv').open('w',encoding='utf-8-sig',newline='') as f:
 w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
print(json.dumps(result,ensure_ascii=False,indent=2))
