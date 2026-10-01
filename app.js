const $ = id => document.getElementById(id);
let ci, db, busy = false;
let io = Promise.resolve();
let saving = Promise.resolve();
// The emulator protocol does not support overlapping requests for the same file.
function disk(task) {
  const result = io.then(task);
  io = result.catch(() => {});
  return result;
}
const canvas = $('display'), ctx = canvas.getContext('2d');
const held = new Set();
const base = new URL('./', import.meta.url);
async function asset(path) {
  const response = await fetch(new URL(path, base));
  if (!response.ok) throw new Error(`Could not load ${path}: HTTP ${response.status}`);
  return response;
}
const config = '[dosbox]\nmachine=vgaonly\nmemsize=16\n[cpu]\ncore=normal\ncycles=fixed 6000\n[mixer]\nnosound=true\n[autoexec]\n@echo off\nmount c .\nc:\nSPOCK.EXE\n';
const dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open('spock-original-v1', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('state');
  req.onsuccess = () => { db = req.result; resolve(); };
  req.onerror = () => reject(req.error);
});
// Avoid an unhandled rejection before Start is pressed.
dbReady.catch(() => {});
async function stored() {
  await dbReady;
  return new Promise((resolve, reject) => {
    const req = db.transaction('state').objectStore('state').get('files');
    req.onsuccess = () => resolve(req.result || []); req.onerror = () => reject(req.error);
  });
}
async function fileNames() {
  const tree = await ci.fsTree();
  function walk(node, prefix = '') {
    return (node.nodes || []).flatMap(child => {
      const name = prefix + child.name;
      return child.nodes ? walk(child, name + '/') : /\.(CIR|CFG|RES|NET|BMP)$/i.test(name) ? [name] : [];
    });
  }
  return walk(tree).sort();
}
function persist() {
  const result = saving.then(saveFiles);
  saving = result.catch(() => {});
  return result;
}
async function saveFiles() {
  if (!ci) return;
  busy = true;
  try {
    await dbReady;
    const files = await disk(async () => {
      const files=[];
      for(const path of await fileNames()) files.push({path,contents:await ci.fsReadFile(path)});
      return files;
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite');
      tx.objectStore('state').put(files, 'files');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    $('storage').textContent = `DOS files saved to this browser at ${new Date().toLocaleTimeString()}.`;
  } catch (e) { $('storage').textContent = `Browser save failed: ${e.message}. Download your files instead.`; }
  finally { busy = false; }
}
async function refresh() {
  const rows = await Promise.all((await disk(fileNames)).map(async name => {
    const row = document.createElement('div'); row.className = 'file';
    const label = document.createElement('span'); label.textContent = name;
    const button = document.createElement('button'); button.textContent = 'Download'; button.setAttribute('aria-label', `Download ${name}`);
    button.onclick = async () => {
      try {
        const url = URL.createObjectURL(new Blob([await disk(() => ci.fsReadFile(name))], {type:'application/octet-stream'}));
        const a = document.createElement('a'); a.href = url; a.download = name.split('/').pop(); a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (e) { $('notice').textContent = e.message; }
    };
    row.append(label, button); return row;
  }));
  $('files').replaceChildren(...rows);
}
$('start').onclick = async () => {
  $('start').disabled = true; $('status').textContent = 'Starting DOS…';
  try {
    if (!navigator.locks) throw new Error('Use a current desktop browser over HTTPS or on localhost.');
    // A second tab must not silently overwrite the first tab’s saved work.
    await navigator.locks.request('spock-original-session', {ifAvailable:true}, async lock => {
      if (!lock) throw new Error('Spock is already running in another tab. Close that tab first.');
      const names = await (await asset('runtime.json')).json();
      const init = [config, ...await Promise.all(names.map(async path => ({path, contents: new Uint8Array(await (await asset(`runtime/${path}`)).arrayBuffer())})))];
      try { init.push(...await stored()); } catch (e) { $('storage').textContent = `Storage unavailable: ${e.message}. Use downloads.`; }
      emulators.pathPrefix = new URL('emulator/', base).href;
      ci = await emulators.dosboxWorker(init);
      ci.events().onFrameSize((w,h) => { canvas.width=w; canvas.height=h; });
      ci.events().onFrame((rgb,rgba) => {
        if (rgba) ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba),canvas.width,canvas.height),0,0);
        else if (rgb) {
          const im = ctx.createImageData(canvas.width,canvas.height);
          for(let i=0,j=0;i<rgb.length;i+=3,j+=4) { im.data[j]=rgb[i]; im.data[j+1]=rgb[i+1]; im.data[j+2]=rgb[i+2]; im.data[j+3]=255; }
          ctx.putImageData(im,0,0);
        }
      });
      // Capture the initial frame too, in case it preceded listener registration.
      try {
        const initial = await ci.screenshot(); canvas.width=initial.width; canvas.height=initial.height; ctx.putImageData(initial,0,0);
      } catch { /* The worker may not have emitted its first frame yet. */ }
      for(const id of ['enter','fullscreen','import','refresh','save']) $(id).disabled=false;
      $('status').textContent = 'Running · press Enter'; $('start').textContent = 'Running'; canvas.focus();
      await refresh(); setInterval(() => { if(!busy) void persist(); },5000);
      await new Promise(() => {});
    });
  } catch (e) { $('status').textContent = e.message; $('start').disabled=false; }
};
$('enter').onclick = () => { ci.simulateKeyPress(257); $('status').textContent='Running'; canvas.focus(); };
$('fullscreen').onclick = () => canvas.parentElement.requestFullscreen().catch(e => { $('notice').textContent=e.message; });
$('save').onclick = async () => {
  $('save').disabled=true; $('save').textContent='Saving…';
  try { await persist(); await refresh(); }
  catch(e) { $('notice').textContent=e.message; }
  finally { $('save').disabled=false; $('save').textContent='Save to browser'; }
};
$('refresh').onclick = () => refresh().catch(e => { $('notice').textContent=e.message; });
$('import').onchange = async e => {
  try {
    const files = [...e.target.files];
    const existing = new Set(await disk(fileNames));
    for(const file of files) {
      const name=file.name.toUpperCase();
      if(!/^[A-Z0-9_-]{1,8}\.(CIR|CFG)$/.test(name)) throw new Error(`${file.name}: use a DOS name of 1–8 letters, digits, _ or -, ending in .CIR or .CFG.`);
      if(file.size>1024*1024) throw new Error(`${name}: maximum file size is 1 MiB.`);
    }
    const overwrite=files.filter(f=>existing.has(f.name.toUpperCase()));
    if(overwrite.length && !confirm(`Replace ${overwrite.map(f=>f.name).join(', ')} in the DOS drive?`)) return;
    await disk(async () => {
      for(const file of files) await ci.fsWriteFile(file.name.toUpperCase(),new Uint8Array(await file.arrayBuffer()));
    });
    await persist(); await refresh(); $('notice').textContent='Imported. Now use Ler Circuito inside Spock to load the circuit.';
  } catch(e) { $('notice').textContent=e.message; }
  finally { e.target.value=''; }
};
function motion(e) { const r=canvas.getBoundingClientRect(); ci.sendMouseMotion(Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))); }
canvas.onpointermove = e => { if(ci) motion(e); };
canvas.onpointerdown = e => { if(!ci)return; e.preventDefault();canvas.focus();canvas.setPointerCapture(e.pointerId);motion(e);ci.sendMouseButton(e.button,true); };
canvas.onpointerup = e => { if(ci){motion(e);ci.sendMouseButton(e.button,false);} };
canvas.oncontextmenu = e => e.preventDefault();
const special={Enter:257,Escape:256,Backspace:259,Delete:261,Insert:260,ArrowRight:262,ArrowLeft:263,ArrowDown:264,ArrowUp:265,PageUp:266,PageDown:267,Home:268,End:269,ShiftLeft:340,ShiftRight:344,ControlLeft:341,ControlRight:345,AltLeft:342,AltRight:346,Space:32,Minus:45,Equal:61,BracketLeft:91,BracketRight:93,Backslash:92,Semicolon:59,Quote:39,Comma:44,Period:46,Slash:47,Backquote:96};
function key(e){if(special[e.code]!==undefined)return special[e.code];if(/^Key[A-Z]$/.test(e.code))return e.code.charCodeAt(3);if(/^Digit[0-9]$/.test(e.code))return e.code.charCodeAt(5);if(/^F([1-9]|1[0-2])$/.test(e.code))return 289+Number(e.code.slice(1));}
canvas.onkeydown = e => { const k=key(e);if(ci&&k!==undefined){e.preventDefault();if(!held.has(k)){held.add(k);ci.sendKeyEvent(k,true);}} };
canvas.onkeyup = e => {const k=key(e);if(ci&&k!==undefined){e.preventDefault();held.delete(k);ci.sendKeyEvent(k,false);} };
function release(){if(!ci)return;for(const k of held)ci.sendKeyEvent(k,false);held.clear();for(let b=0;b<3;b++)ci.sendMouseButton(b,false);}
canvas.onblur=release;window.addEventListener('blur',release);
canvas.onpointercancel=release;
