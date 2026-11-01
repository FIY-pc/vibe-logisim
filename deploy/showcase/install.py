"""Install/update the isolated showcase; stdout carries first-login details to the private local operator file."""
from pathlib import Path
import argparse, hashlib, json, os, re, secrets, shutil, sqlite3, subprocess, tarfile, time, urllib.request

parser=argparse.ArgumentParser()
parser.add_argument('release')
parser.add_argument('sha256')
args=parser.parse_args()
assert re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}',args.release)
root=Path('/home/ubuntu/apps/vibe-logisim-site')
root.mkdir(mode=0o750,parents=True,exist_ok=True)
assert root.resolve()==root
incoming=root/'incoming'
source=incoming/'showcase-server.mjs'
assert hashlib.sha256(source.read_bytes()).hexdigest()==args.sha256
release=root/'releases'/args.release
if release.exists():
    assert hashlib.sha256((release/'showcase-server.mjs').read_bytes()).hexdigest()==args.sha256
else:
    release.mkdir(mode=0o750,parents=True)
    shutil.copy2(source,release/'showcase-server.mjs')
    with tarfile.open(incoming/'public.tar.gz','r:gz') as archive:
        for member in archive.getmembers():
            assert (release/member.name).resolve().is_relative_to(release.resolve())
            assert member.isfile() or member.isdir()
        archive.extractall(release)
downloads=root/'downloads'
downloads.mkdir(mode=0o750,exist_ok=True)
manifest=json.loads((release/'public/release.json').read_text())
for kind in ['installer','portable']:
    item=manifest[kind]
    assert re.fullmatch(r'[a-zA-Z0-9._-]+',item['name'])
    candidate=incoming/item['name']
    target=downloads/item['name']
    if not target.exists():
        assert hashlib.sha256(candidate.read_bytes()).hexdigest()==item['sha256']
        shutil.copy2(candidate,target)
    assert target.stat().st_size==item['bytes']
    assert hashlib.sha256(target.read_bytes()).hexdigest()==item['sha256']
(downloads/'SHA256SUMS.txt').write_text(''.join(f"{manifest[k]['sha256']}  {manifest[k]['name']}\n" for k in ['installer','portable']))
data=root/'data'
data.mkdir(mode=0o700,exist_ok=True)
stamp=time.strftime('%Y%m%d-%H%M%S',time.gmtime())
backup=root/'backups'/stamp
backup.mkdir(mode=0o700,parents=True)
if (data/'showcase.sqlite').exists():
    with sqlite3.connect(data/'showcase.sqlite') as live,sqlite3.connect(backup/'showcase.sqlite') as saved:live.backup(saved)
    os.chmod(backup/'showcase.sqlite',0o600)
environment=root/'showcase.env'
password=None
if not environment.exists():
    password=secrets.token_urlsafe(24)
    salt=secrets.token_hex(16)
    hashed=hashlib.scrypt(password.encode(),salt=salt.encode(),n=16384,r=8,p=1,dklen=64).hex()
    content='\n'.join(['NODE_ENV=production','SHOWCASE_PORT=8811','SHOWCASE_DATABASE='+str(data/'showcase.sqlite'),'SHOWCASE_PUBLIC='+str(root/'current/public'),'SHOWCASE_DOWNLOADS='+str(downloads),'SHOWCASE_ORIGIN=https://lovej.site','SHOWCASE_TRUST_PROXY=1','SHOWCASE_ADMIN_USERNAME=admin','SHOWCASE_ADMIN_PASSWORD_HASH='+salt+':'+hashed,'SHOWCASE_IP_SECRET='+secrets.token_hex(32),''])
    fd=os.open(environment,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:f.write(content)
else:
    shutil.copy2(environment,backup/'showcase.env')
    os.chmod(backup/'showcase.env',0o600)
current=root/'current'
assert not current.exists() or current.is_symlink()
previous=current.resolve() if current.is_symlink() else None
next_link=root/('current.next-'+stamp)
next_link.symlink_to(release)
os.replace(next_link,current)
def run(*command):subprocess.run(command,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
nginx=Path('/etc/nginx/sites-available/synctv')
original=nginx.read_text()
shutil.copy2(nginx,backup/'nginx-synctv.conf')
snippet=Path('/etc/nginx/snippets/vibe-showcase-location.conf')
old_snippet=snippet.read_text() if snippet.exists() else None
marker='    include /etc/nginx/snippets/vibe-classroom-location.conf;'
include='    include /etc/nginx/snippets/vibe-showcase-location.conf;'
try:
    if include not in original:
        assert original.count(marker)==1
        staged=incoming/'synctv.staged.conf'
        staged.write_text(original.replace(marker,marker+'\n'+include,1))
        run('sudo','-n','install','-m','644',str(staged),str(nginx))
    run('sudo','-n','install','-m','644',str(incoming/'nginx-location.conf'),str(snippet))
    run('sudo','-n','nginx','-t')
    run('sudo','-n','install','-m','644',str(incoming/'vibe-showcase.service'),'/etc/systemd/system/vibe-showcase.service')
    run('sudo','-n','systemctl','daemon-reload')
    run('sudo','-n','systemctl','enable','vibe-showcase')
    run('sudo','-n','systemctl','restart','vibe-showcase')
    for attempt in range(30):
        try:
            with urllib.request.urlopen('http://127.0.0.1:8811/api/health',timeout=2) as response:assert json.load(response)['ok']
            break
        except Exception:
            if attempt==29:raise
            time.sleep(.3)
    run('sudo','-n','systemctl','reload','nginx')
except Exception:
    run('sudo','-n','install','-m','644',str(backup/'nginx-synctv.conf'),str(nginx))
    if old_snippet is not None:
        (incoming/'previous-snippet.conf').write_text(old_snippet)
        run('sudo','-n','install','-m','644',str(incoming/'previous-snippet.conf'),str(snippet))
    if previous:
        next_link.symlink_to(previous);os.replace(next_link,current)
        run('sudo','-n','systemctl','restart','vibe-showcase')
    else:run('sudo','-n','systemctl','stop','vibe-showcase')
    run('sudo','-n','nginx','-t')
    raise
(root/'deployment.json').write_text(json.dumps({'release':args.release,'sha256':args.sha256,'deployedAt':stamp,'url':'https://lovej.site/vibe-logisim/'},indent=2)+'\n')
print(json.dumps({'ok':True,'url':'https://lovej.site/vibe-logisim/','adminUrl':'https://lovej.site/vibe-logisim/admin/','username':'admin','firstPassword':password,'backup':str(backup)}))
