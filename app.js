'use strict';
// The website receives only ENCRYPTED records from a public GitHub repository.
// This exact URL is for the new repo zerg211/nutrition-journal.
const RAW_JOURNAL = 'https://raw.githubusercontent.com/zerg211/nutrition-journal/main/journal.json';
const $ = (id) => document.getElementById(id);
const fmt = (v, maxFractionDigits = 0) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: maxFractionDigits }).format(v);
const enc = new TextDecoder();
const state = { journal: null, privateKey: null, keyId: null, entries: [], busy: false };
function fromBase64Url(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('Некорректные зашифрованные данные.');
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
function isoInZone(date = new Date(), zone = 'Europe/Moscow') {
  const parts = new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const o = Object.fromEntries(parts.map(p=>[p.type,p.value]));
  return `${o.year}-${o.month}-${o.day}`;
}
function addDays(iso, n) {
  const t = new Date(iso+'T12:00:00Z');
  if (!Number.isFinite(t.getTime())) throw new Error('Ошибка формата даты в журнале');
  t.setUTCDate(t.getUTCDate()+n);
  return t.toISOString().slice(0,10);
}
function dayDiff(a,b) { return Math.round((Date.parse(a+'T12:00:00Z')-Date.parse(b+'T12:00:00Z'))/86400000); }
function dateLabel(iso) { return new Intl.DateTimeFormat('ru-RU',{weekday:'long',day:'numeric',month:'long',timeZone:'UTC'}).format(new Date(iso+'T12:00:00Z')); }
function shortDate(iso) { return new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',timeZone:'UTC'}).format(new Date(iso+'T12:00:00Z')); }
function setStatus(message, isError = false) { $('status').textContent = message; $('status').style.color = isError ? '#b34141' : ''; }
function showUnlock(message) {
  $('unlock').hidden = false; $('dashboard').hidden = true; $('forget-key').hidden = true;
  if (message) $('key-status').textContent = message;
}
function showDashboard() { $('unlock').hidden = true; $('dashboard').hidden = false; $('forget-key').hidden = false; }
function openVault() {
  return new Promise((resolve,reject)=>{
    const request = indexedDB.open('food-journal-vault-v1',1);
    request.onupgradeneeded=()=>{ if(!request.result.objectStoreNames.contains('keys')) request.result.createObjectStore('keys'); };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
async function vaultRead() {
  try {
    const db = await openVault();
    const result = await new Promise((resolve,reject)=>{
      const t=db.transaction('keys','readonly'); const r=t.objectStore('keys').get('main');
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
    }); db.close(); return result;
  } catch(e) { console.warn('Local key vault unavailable',e); return null; }
}
async function vaultWrite(obj) {
  try {
    const db = await openVault();
    await new Promise((resolve,reject)=>{const t=db.transaction('keys','readwrite'); t.objectStore('keys').put(obj,'main');t.oncomplete=resolve;t.onerror=()=>reject(t.error);}); db.close(); return true;
  } catch(e) { console.warn('Could not remember key on device',e);return false; }
}
async function vaultClear() {
  const db = await openVault();
  await new Promise((resolve,reject)=>{const t=db.transaction('keys','readwrite');t.objectStore('keys').delete('main');t.oncomplete=resolve;t.onerror=()=>reject(t.error);}); db.close();
}
async function decryptRecord(record, key) {
  if (!record || record.v!==1 || record.kid!==state.journal.keyId) throw new Error('Неизвестная версия или ключ записи.');
  const aesBytes = await crypto.subtle.decrypt({name:'RSA-OAEP'},key,fromBase64Url(record.ek));
  const aes = await crypto.subtle.importKey('raw',aesBytes,{name:'AES-GCM'},false,['decrypt']);
  const plain = await crypto.subtle.decrypt({name:'AES-GCM',iv:fromBase64Url(record.iv)},aes,fromBase64Url(record.ct));
  const payload=JSON.parse(enc.decode(plain));
  if (!['profile','meal','weight'].includes(payload.type)) throw new Error('Неизвестный тип записи.');
  return payload;
}
async function loadEntries() {
  if (!state.privateKey || !state.journal) return;
  try {
    // No partial display: avoid understating consumption when even one record fails to decrypt.
    const records = await Promise.all(state.journal.entries.map(x=>decryptRecord(x,state.privateKey)));
    const profile = records.filter(x=>x.type==='profile').at(-1);
    if (!profile || !profile.daily || !profile.anchorDate) throw new Error('Не найдены настройки журнала.');
    state.entries=records;
    render(profile,records);
    showDashboard();
    setStatus('Записи синхронизированы · данные защищены');
  } catch(e) {
    $('dashboard').hidden=true;
    showUnlock('Ошибка расшифровки. Возможно, файл ключа не соответствует журналу.');
    setStatus('Не удалось прочитать все записи: '+e.message,true);
  }
}
async function tryFetch(url) {
  const sep=url.includes('?')?'&':'?';
  const response=await fetch(`${url}${sep}nocache=${Date.now()}`,{cache:'no-store',redirect:'error'});
  if(!response.ok) throw new Error(`HTTP ${response.status}`);
  const obj=await response.json();
  if(obj?.format!=='nj-sealed-v1'||!Array.isArray(obj.entries)||typeof obj.keyId!=='string') throw new Error('Неверный формат журнала.');
  if (obj.entries.length>5000) throw new Error('Слишком много записей.');
  return obj;
}
async function refresh() {
  if(state.busy) return; state.busy=true; $('refresh-btn').classList.add('busy');
  try {
    // Prefer the newest valid response: raw GitHub often updates before Pages finishes publishing.
    const results=await Promise.allSettled([tryFetch('./journal.json'),tryFetch(RAW_JOURNAL)]);
    const available=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
    if (!available.length) throw new Error('Не удалось загрузить журнал. Проверь интернет и публикацию GitHub Pages.');
    available.sort((a,b)=>Date.parse(b.updatedAt||'')-Date.parse(a.updatedAt||''));
    state.journal=available[0];
    $('last-sync').textContent='Проверено '+new Intl.DateTimeFormat('ru-RU',{hour:'2-digit',minute:'2-digit'}).format(new Date());
    if(state.privateKey && state.keyId!==state.journal.keyId) {
      state.privateKey=null;state.keyId=null;showUnlock('Для этого журнала требуется другой ключ.');
    }
    if(!state.privateKey) {
      const existing=await vaultRead();
      if(existing?.keyId===state.journal.keyId && existing.cryptoKey){state.privateKey=existing.cryptoKey;state.keyId=existing.keyId;}
    }
    if(state.privateKey) await loadEntries(); else { showUnlock();setStatus('Подключи личный ключ для просмотра записей'); }
  } catch(e){setStatus(e.message,true); if(!state.privateKey) showUnlock();}
  finally{state.busy=false;$('refresh-btn').classList.remove('busy');}
}
function sumMeals(meals) { return meals.reduce((a,m)=>{for(const x of ['kcal','p','f','c'])a[x]+=Number(m[x]||0);return a;},{kcal:0,p:0,f:0,c:0}); }
function paintCard(prefix,target,eaten) {
  const remaining={};for(const x of ['kcal','p','f','c'])remaining[x]=target[x]-eaten[x];
  $(prefix+'-left').textContent=fmt(Math.max(0,Math.round(remaining.kcal)));
  $(prefix+'-caption').textContent=remaining.kcal>=0?(prefix==='day'?'Осталось на сегодня':'Осталось на неделю'):'Превышено на '+fmt(Math.round(-remaining.kcal))+' ккал';
  $(prefix+'-caption').classList.toggle('over',remaining.kcal<0);
  $(prefix+'-eaten').textContent='Съедено: '+fmt(Math.round(eaten.kcal));
  $(prefix+'-total').textContent='План: '+fmt(target.kcal);
  let progress=target.kcal>0?Math.min(100,Math.max(0,eaten.kcal/target.kcal*100)):0;
  $(prefix+'-progress').setAttribute('aria-valuenow',String(Math.round(progress)));
  $(prefix+'-fill').style.width=progress+'%';
  for(const x of ['p','f','c']){
    $(prefix+'-'+x).textContent=fmt(Math.max(0,Math.round(remaining[x]*10)/10),1)+' г';
    const used=target[x]>0?Math.min(100,Math.max(0,eaten[x]/target[x]*100)):0;
    $(prefix+'-'+x+'-fill').style.width=used+'%';
    $(prefix+'-'+x).title=remaining[x]<0?'Превышено на '+fmt(-remaining[x],1)+' г':'Съедено '+fmt(eaten[x],1)+' г';
  }
}
function render(profile,records) {
  const zone=profile.timezone||'Europe/Moscow';
  const today=isoInZone(new Date(),zone);
  const start=profile.anchorDate;
  const weeksPassed=Math.max(0,Math.floor(dayDiff(today,start)/7));
  const weekStart=addDays(start,weeksPassed*7), weekEnd=addDays(weekStart,6);
  const meals=records.filter(x=>x.type==='meal'&&typeof x.date==='string');
  const todayMeals=meals.filter(x=>x.date===today);
  const weekMeals=meals.filter(x=>x.date>=weekStart&&x.date<=weekEnd);
  const d=profile.daily;
  const daily={kcal:d.kcal,p:d.p,f:d.f,c:d.c};
  const weekly=Object.fromEntries(Object.entries(daily).map(([k,v])=>[k,v*7]));
  $('current-date').textContent=dateLabel(today);
  $('week-range').textContent=shortDate(weekStart)+' — '+shortDate(weekEnd);
  paintCard('day',daily,sumMeals(todayMeals));
  paintCard('week',weekly,sumMeals(weekMeals));
  paintMeals(meals,today,zone);
  paintWeight(profile,records);
}
function paintMeals(meals,today,zone) {
  const recent=meals.filter(m=>dayDiff(today,m.date)>=0&&dayDiff(today,m.date)<35)
    .sort((a,b)=>`${b.date} ${b.time||''}`.localeCompare(`${a.date} ${a.time||''}`));
  $('meal-count').textContent=String(recent.length);
  const root=$('meal-list');root.replaceChildren();
  if(!recent.length){const e=document.createElement('div');e.className='empty-state';e.textContent='Пока нет записей о еде. Пришли фото или описание еды в ChatGPT — я добавлю запись в этот журнал.';root.append(e);return;}
  const groups=new Map(); for(const m of recent){if(!groups.has(m.date))groups.set(m.date,[]);groups.get(m.date).push(m);}
  for(const [date,items] of groups){
    const group=document.createElement('section');group.className='day-group';
    const h=document.createElement('div');h.className='day-label';
    const a=document.createElement('span');a.textContent=dateLabel(date);
    const b=document.createElement('span');b.textContent=fmt(sumMeals(items).kcal)+' ккал';h.append(a,b);group.append(h);
    for(const item of items){
      const row=document.createElement('div');row.className='meal-row';
      const left=document.createElement('div');
      const title=document.createElement('div');title.className='meal-title';title.textContent=String(item.name||'Приём пищи');
      const meta=document.createElement('div');meta.className='meal-meta';
      const bits=[]; if(item.time)bits.push(item.time);if(item.amount)bits.push(item.amount);
      bits.push(`Б ${fmt(Number(item.p||0),1)} · Ж ${fmt(Number(item.f||0),1)} · У ${fmt(Number(item.c||0),1)}`);
      if(item.estimated)bits.push('оценка');meta.textContent=bits.join('  ·  ');
      left.append(title,meta);
      const c=document.createElement('div');c.className='meal-cals';c.textContent=fmt(Number(item.kcal||0))+' ';
      const small=document.createElement('small');small.textContent='ккал';c.append(small);
      row.append(left,c);group.append(row);
    }root.append(group);
  }
}
function paintWeight(profile,records){
  const history=records.filter(x=>x.type==='weight' && typeof x.date==='string' && Number.isFinite(Number(x.kg))).sort((a,b)=>a.date.localeCompare(b.date));
  const latest=history.at(-1);
  const weight=latest?Number(latest.kg):Number(profile.startWeight);
  $('current-weight').textContent=Number.isFinite(weight)?fmt(weight,1):'—';
  $('weight-goal').textContent=fmt(Number(profile.goalMin||85))+'–'+fmt(Number(profile.goalMax||89))+' кг';
  $('weight-history').textContent=latest?'Последнее измерение: '+shortDate(latest.date):'Исходный вес на '+shortDate(profile.anchorDate)+': '+fmt(Number(profile.startWeight),1)+' кг. Новые измерения добавим через чат.';
}
async function importKey(e) {
  const file=e.target.files?.[0];if(!file)return;
  try {
    if(file.size>15000)throw new Error('Слишком большой файл.');
    const parsed=JSON.parse(await file.text());
    if(parsed.kind!=='nutrition-journal-private-key-v1'||parsed.keyId!==state.journal?.keyId||!parsed.privateJwk)throw new Error('Выбран не тот ключ для этого журнала.');
    const cryptoKey=await crypto.subtle.importKey('jwk',parsed.privateJwk,{name:'RSA-OAEP',hash:'SHA-256'},false,['decrypt']);
    state.privateKey=cryptoKey;state.keyId=parsed.keyId;
    const remembered=await vaultWrite({keyId:parsed.keyId,cryptoKey});
    await loadEntries();
    if(!remembered) setStatus('Журнал открыт. Браузер не смог сохранить ключ — при следующем входе импортируй его снова.');
  } catch(err) { $('key-status').textContent='Ошибка: '+err.message;setStatus('Не удалось подключить ключ',true); }
  finally{e.target.value='';}
}
async function forgetKey(){
  if(!confirm('Стереть ключ с этого устройства? Записи останутся зашифрованными на GitHub.'))return;
  try{await vaultClear();}catch(e){console.warn('Clear failed',e);}
  state.privateKey=null;state.keyId=null;state.entries=[];showUnlock('Локальный ключ удалён. Можешь импортировать сохранённый файл снова.');setStatus('Журнал закрыт');
}
$('refresh-btn').addEventListener('click',refresh);
$('key-input').addEventListener('change',importKey);
$('forget-key').addEventListener('click',forgetKey);
refresh();
setInterval(()=>{if(!document.hidden)refresh();},45000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
