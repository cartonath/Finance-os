'use strict';

const APP_META=Object.freeze({version:'1.9.1',build:'2026-10-06.02',channel:'Stable'});
const C=FinanceCore;
const DB='finance-os-db';
const DB_VERSION=5;
const STORES=['transactions','recurring','installments','cards','meta'];
const PIN_KEY='finance-os-pin-v1';
const LEGACY_LIVE_BALANCE_KEY='finance-os-live-balance-v1';
const LEGACY_LIVE_EPOCH_KEY='finance-os-live-epoch-v1';
const META_LIVE_BALANCE='liveBalance';
const META_MIGRATION='migration-v1.8.0';
const META_VAULTS='vaults-v1';
const META_BALANCE_LOG='balance-reconciliations-v1';
const META_BACKUP_STATUS='backup-status-v1';
const META_MONTH_CLOSE_PREFIX='month-close:';

const incomeSources=[
  ['salario','💼 Salário'],['particular','🧠 Atendimento particular'],['tiktok','🎵 TikTok Shop'],
  ['extra','✨ Renda extra'],['venda','🏷️ Venda'],['reembolso','↩️ Reembolso'],
  ['rendimentos','📈 Rendimentos'],['presente','🎁 Presente'],['outros','💵 Outros']
];

let db;
let state={transactions:[],recurring:[],installments:[],cards:[],meta:[]};
let currentMonth=C.ym(C.ymd());
let movementFilter='all',movementSearch='',movementCard='all';

const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
const nowIso=()=>new Date().toISOString();
const esc=v=>String(v??'').replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));

function showToast(text){
  const el=$('#toast');
  if(!el)return;
  el.textContent=text;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t=setTimeout(()=>el.classList.add('hidden'),2500);
}

function reqPromise(req){return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
function txDone(tx){return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Transação cancelada'))})}

function openDB(){
  return new Promise((resolve,reject)=>{
    const r=indexedDB.open(DB,DB_VERSION);
    r.onupgradeneeded=()=>{
      for(const s of STORES){if(!r.result.objectStoreNames.contains(s))r.result.createObjectStore(s,{keyPath:s==='meta'?'key':'id'})}
    };
    r.onsuccess=()=>resolve(r.result);
    r.onerror=()=>reject(r.error);
  });
}

async function getAll(store){return reqPromise(db.transaction(store).objectStore(store).getAll())}
async function putOne(store,obj){
  const tx=db.transaction(store,'readwrite');
  tx.objectStore(store).put(obj);
  await txDone(tx);
  return obj;
}

async function putMany(store,rows){
  const tx=db.transaction(store,'readwrite'),os=tx.objectStore(store);
  for(const row of rows)os.put(row);
  await txDone(tx);
}

async function atomicOps(ops){
  const names=[...new Set(ops.map(x=>x.store))];
  const tx=db.transaction(names,'readwrite');
  for(const op of ops){
    const os=tx.objectStore(op.store);
    if(op.type==='delete')os.delete(op.key);else os.put(op.value);
  }
  await txDone(tx);
}

function metaByKey(key){return state.meta.find(x=>x.key===key)||null}
function liveBalanceRecord(){const x=metaByKey(META_LIVE_BALANCE);return x&&Number.isFinite(Number(x.amountCents))?x:null}
function getAvailableBalance(){return liveBalanceRecord()?.amountCents??null}
function getAvailableEpoch(){return liveBalanceRecord()?.epoch||''}
function vaultRecord(){const x=metaByKey(META_VAULTS);return x&&Array.isArray(x.items)?x:{key:META_VAULTS,items:[]}}
function vaultItems(){return vaultRecord().items.filter(x=>x&&!x.archivedAt)}
function reservedTotal(){return vaultItems().reduce((s,x)=>s+Math.max(0,Number(x.savedCents)||0),0)}
function balanceLogRecord(){const x=metaByKey(META_BALANCE_LOG);return x&&Array.isArray(x.entries)?x:{key:META_BALANCE_LOG,entries:[]}}
function backupStatusRecord(){return metaByKey(META_BACKUP_STATUS)||{key:META_BACKUP_STATUS}}
function monthCloseKey(k){return META_MONTH_CLOSE_PREFIX+k}
function monthCloseRecord(k){const x=metaByKey(monthCloseKey(k));return x&&x.month===k?x:null}
function isMonthClosed(k){return !!monthCloseRecord(k)}
function assertMonthOpen(k,action='alterar este mês'){
  if(!isMonthClosed(k))return true;
  alert(`Este mês foi fechado. Reabra ${fmtMonth(k)} em Análises antes de ${action}.`);
  return false;
}
function addDaysIso(dateStr,days){const [y,m,d]=dateStr.split('-').map(Number),x=new Date(y,m-1,d+days);return C.ymd(x)}
function daysBetweenIso(a,b){const [ay,am,ad]=a.split('-').map(Number),[by,bm,bd]=b.split('-').map(Number);return Math.round((new Date(by,bm-1,bd)-new Date(ay,am-1,ad))/86400000)}

async function atomicPutWithBalance(store,obj,delta=0,expectedEpoch=''){
  const tx=db.transaction([store,'meta'],'readwrite');
  tx.objectStore(store).put(obj);
  if(delta){
    const rec=liveBalanceRecord();
    if(rec&&(!expectedEpoch||rec.epoch===expectedEpoch)){
      tx.objectStore('meta').put({...rec,amountCents:Number(rec.amountCents)+Number(delta),updatedAt:nowIso()});
    }
  }
  await txDone(tx);
}

async function atomicRestore(data){
  const tx=db.transaction(STORES,'readwrite');
  try{
    for(const s of STORES)tx.objectStore(s).clear();
    for(const s of ['transactions','recurring','installments','cards','meta']){
      for(const row of data[s]||[])tx.objectStore(s).put(row);
    }
    await txDone(tx);
  }catch(err){try{tx.abort()}catch{}throw err}
}

function normalizeLoadedState(){
  state.transactions=(state.transactions||[]).filter(Boolean).map(x=>({
    ...x,amountCents:Number(x.amountCents)||0,description:x.description||'',date:x.date||C.ymd(),type:x.type||'expense'
  }));
  state.recurring=(state.recurring||[]).filter(Boolean).map(x=>({
    ...x,amountCents:Number(x.amountCents)||0,description:x.description||'Conta',startDate:x.startDate||C.ymd(),
    day:Number(x.day)||Number((x.startDate||C.ymd()).slice(8))||1,
    monthOverrides:(x.monthOverrides&&typeof x.monthOverrides==='object')?x.monthOverrides:{},active:x.active!==false
  }));
  state.installments=(state.installments||[]).filter(Boolean).map(x=>{
    const count=Math.max(1,Number(x.count)||1),total=Number(x.totalCents)||0,per=Number(x.installmentCents)||Math.floor(total/count);
    return {...x,count,nextNumber:Math.max(1,Math.min(count,Number(x.nextNumber)||1)),amountMode:x.amountMode||'total',installmentCents:per,totalCents:total||per*count,description:x.description||'Parcelamento',startDate:x.startDate||C.ymd()};
  });
  state.cards=(state.cards||[]).filter(Boolean).map(x=>({
    ...x,name:x.name||'Cartão',limitCents:Number(x.limitCents)||0,closingDay:Number(x.closingDay)||31,dueDay:Number(x.dueDay)||1,
    invoiceOverrides:(x.invoiceOverrides&&typeof x.invoiceOverrides==='object')?x.invoiceOverrides:{},
    invoiceClosed:(x.invoiceClosed&&typeof x.invoiceClosed==='object')?x.invoiceClosed:{},
    invoicePaid:(x.invoicePaid&&typeof x.invoicePaid==='object')?x.invoicePaid:{},
    invoicePayments:(x.invoicePayments&&typeof x.invoicePayments==='object')?x.invoicePayments:{},
    termsHistory:Array.isArray(x.termsHistory)?x.termsHistory:[],archivedAt:x.archivedAt||''
  }));
  state.meta=(state.meta||[]).filter(Boolean);
}

async function loadState(){
  const [transactions,recurring,installments,cards,meta]=await Promise.all(STORES.map(getAll));
  state={transactions,recurring,installments,cards,meta};
  normalizeLoadedState();
}

async function refresh(){
  await loadState();
  renderActive();
  refreshCardSelects();
}

function activeCards(){return state.cards.filter(x=>!x.archivedAt&&!x.deletedAt)}
function allCards(){return state.cards.filter(x=>!x.deletedAt)}
function txAppliedEpoch(tx){return tx?.balanceAppliedEpoch||tx?.availableAppliedEpoch||''}

function cashEffect(tx){
  if(!tx||tx.deletedAt)return 0;
  const amount=Number(tx.amountCents)||0;
  if(tx.type==='income')return amount;
  if(tx.type==='expense'||tx.type==='investment'){
    if(tx.cardId||tx.paymentMethod==='Crédito')return 0;
    return -amount;
  }
  return 0;
}

function shouldApplyNewTransaction(tx){
  const balance=liveBalanceRecord(),effect=cashEffect(tx);
  if(!balance||!effect)return false;
  const epochDay=String(balance.epoch||'').slice(0,10);
  const created=tx.createdAt||nowIso();
  return (!epochDay||tx.date>=epochDay)&&(!balance.epoch||created>=balance.epoch);
}

async function migrateLegacyBalance(){
  if(liveBalanceRecord()||metaByKey(META_MIGRATION)?.restoredWithoutBalance)return false;
  let amount=null,epoch=localStorage.getItem(LEGACY_LIVE_EPOCH_KEY)||'';
  const live=localStorage.getItem(LEGACY_LIVE_BALANCE_KEY);
  if(live!==null&&Number.isFinite(Number(live)))amount=Number(live);
  if(amount===null){
    const today=C.ym(C.ymd()),found=[];
    for(let i=0;i<localStorage.length;i++){
      const key=localStorage.key(i)||'',m=key.match(/^finance-os-available-(\d{4}-\d{2})$/);
      if(!m)continue;
      const value=Number(localStorage.getItem(key));
      if(Number.isFinite(value))found.push({month:m[1],value,key});
    }
    found.sort((a,b)=>b.month.localeCompare(a.month));
    const chosen=found.find(x=>x.month<=today)||found[0];
    if(chosen){amount=chosen.value;epoch=localStorage.getItem(`finance-os-available-epoch-${chosen.month}`)||epoch}
  }
  if(amount===null)return false;
  await putOne('meta',{key:META_LIVE_BALANCE,amountCents:amount,epoch:epoch||nowIso(),updatedAt:nowIso(),migratedFrom:'localStorage'});
  return true;
}

async function migrateCardsV180(){
  let changed=false;
  const rows=[];
  for(const original of state.cards){
    let card={...original},dirty=false;

    if(card.deletedAt&&!card.archivedAt){card.archivedAt=card.deletedAt;card.deletedAt='';dirty=true}

    if(!Array.isArray(card.termsHistory)||!card.termsHistory.length){
      card.termsHistory=[{effectiveCycle:'0000-00',closingDay:Number(card.closingDay)||31,dueDay:Number(card.dueDay)||1}];dirty=true;
    }

    if(!card.invoiceOverrideCycleFixV176){
      const overrides={...(card.invoiceOverrides||{})},closed={...(card.invoiceClosed||{})};
      let moved=false;
      if(Number(card.dueDay)<=Number(card.closingDay)){
        for(const [k,value] of Object.entries({...overrides})){
          if(closed[k])continue;
          const target=C.addMonths(k+'-01',-1).slice(0,7);
          if(overrides[target]===undefined){overrides[target]=value;delete overrides[k];moved=true}
        }
      }
      card={...card,invoiceOverrides:overrides,invoiceOverrideCycleFixV176:true};
      if(moved||!original.invoiceOverrideCycleFixV176)dirty=true;
    }

    const payments={...(card.invoicePayments||{})};
    for(const [cycle,paid] of Object.entries(card.invoicePaid||{})){
      if(!paid||payments[cycle])continue;
      const st=C.cardStatement(state,card,cycle),legacy=card.invoiceAvailableApplied?.[cycle];
      payments[cycle]={
        amountCents:Number(legacy?.amountCents)||Number(st.totalCents)||0,
        paidAt:card.updatedAt||card.createdAt||nowIso(),dueDate:st.dueDate,
        balanceEpoch:legacy?.epoch||'',migrated:true
      };
      dirty=true;
    }
    card.invoicePayments=payments;

    if(dirty){rows.push({...card,updatedAt:card.updatedAt||nowIso()});changed=true}
  }
  if(rows.length)await putMany('cards',rows);
  return changed;
}

async function migrateV180(){
  let changed=false;
  if(await migrateLegacyBalance())changed=true;
  if(changed)await loadState();
  if(await migrateCardsV180())changed=true;
  await putOne('meta',{key:META_MIGRATION,version:'1.8.0',completedAt:nowIso()});
  return changed;
}

function bytesHex(buf){return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('')}
async function pinHash(pin,salt){const data=new TextEncoder().encode(salt+':'+pin);return bytesHex(await crypto.subtle.digest('SHA-256',data))}
function pinConfig(){try{return JSON.parse(localStorage.getItem(PIN_KEY)||'null')}catch{return null}}
async function setPin(){
  const a=prompt('Crie um PIN de 4 a 8 números:');if(a===null)return;
  if(!/^\d{4,8}$/.test(a))return alert('Use de 4 a 8 números.');
  const b=prompt('Repita o PIN:');if(a!==b)return alert('Os PINs não conferem.');
  const salt=crypto.getRandomValues(new Uint32Array(4)).join('-');
  localStorage.setItem(PIN_KEY,JSON.stringify({salt,hash:await pinHash(a,salt),createdAt:nowIso()}));
  updatePinStatus();showToast('PIN ativado neste aparelho.');
}
async function removePin(){
  const cfg=pinConfig();if(!cfg)return showToast('Nenhum PIN configurado.');
  const p=prompt('Digite o PIN atual para remover:');if(p===null)return;
  if(await pinHash(p,cfg.salt)!==cfg.hash)return alert('PIN incorreto.');
  localStorage.removeItem(PIN_KEY);updatePinStatus();showToast('PIN removido.');
}
function updatePinStatus(){
  const on=!!pinConfig();
  if($('#pinStatus'))$('#pinStatus').textContent=on?'PIN ativo neste aparelho.':'PIN desativado.';
  if($('#removePinBtn'))$('#removePinBtn').disabled=!on;
  if($('#lockNowBtn'))$('#lockNowBtn').disabled=!on;
}
function lockApp(){if(!pinConfig())return;$('#lockScreen').classList.remove('hidden');$('#unlockPin').value='';$('#unlockError').textContent='';setTimeout(()=>$('#unlockPin').focus(),50)}
async function unlockApp(){
  const cfg=pinConfig();if(!cfg){$('#lockScreen').classList.add('hidden');return}
  const pin=$('#unlockPin').value;
  if(await pinHash(pin,cfg.salt)===cfg.hash){$('#lockScreen').classList.add('hidden');$('#unlockPin').value='';$('#unlockError').textContent=''}
  else{$('#unlockError').textContent='PIN incorreto.';$('#unlockPin').select()}
}
let hiddenAt=0;
document.addEventListener('visibilitychange',()=>{if(document.hidden)hiddenAt=Date.now();else if(pinConfig()&&hiddenAt&&Date.now()-hiddenAt>120000)lockApp()});
window.addEventListener('error',e=>{console.error(e.error||e.message);showToast('Algo deu errado. Seus dados não foram apagados.')});
window.addEventListener('unhandledrejection',e=>{console.error(e.reason);showToast('Não foi possível concluir essa ação.')});

function syncAppMeta(){
  if($('#appVersion'))$('#appVersion').textContent='v'+APP_META.version;
  if($('#appBuild'))$('#appBuild').textContent=APP_META.build;
  if($('#appChannel'))$('#appChannel').textContent=APP_META.channel;
  if($('#versionFooter'))$('#versionFooter').textContent=`Finance OS • v${APP_META.version}`;
}
function formatMoneyInput(el){const digits=String(el.value||'').replace(/\D/g,'');if(!digits){el.value='';return}el.value=(Number(digits)/100).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}
function bindMoneyInputs(){$$('.money-input').forEach(el=>{el.addEventListener('input',()=>formatMoneyInput(el));el.addEventListener('focus',()=>setTimeout(()=>el.select(),0))})}
function fmtMonth(k){const [y,m]=k.split('-').map(Number);return new Intl.DateTimeFormat('pt-BR',{month:'long',year:'numeric'}).format(new Date(y,m-1,1))}
function sourceName(id){return incomeSources.find(x=>x[0]===id)?.[1]||'Outros'}
function fillSelect(el,items){if(!el)return;el.innerHTML=items.map(([v,l])=>`<option value="${esc(v)}">${esc(l)}</option>`).join('')}
function open(id){const el=document.getElementById(id);if(el&&!el.open)el.showModal()}
function close(id){const el=document.getElementById(id);if(el?.open)el.close()}

function refreshCardSelects(){
  const html='<option value="">Escolha o cartão</option>'+activeCards().map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  if($('#txCard'))$('#txCard').innerHTML=html;
}
function fillInvoiceCards(){
  const html='<option value="">Escolha o cartão</option>'+activeCards().map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  if($('#invoiceCard'))$('#invoiceCard').innerHTML=html;
}

function cardCyclesForDueMonth(card,k=currentMonth){
  const candidates=[C.addMonths(k+'-01',-2).slice(0,7),C.addMonths(k+'-01',-1).slice(0,7),k,C.addMonths(k+'-01',1).slice(0,7)];
  return [...new Set(candidates)].map(cycle=>({cycle,st:C.cardStatement(state,card,cycle)})).filter(x=>C.ym(x.st.dueDate)===k);
}
function invoiceCycleForDueMonth(card,k=currentMonth){
  const rows=cardCyclesForDueMonth(card,k);
  return (rows.find(x=>C.invoiceIsPaid(card,x.cycle)||x.st.overridden||x.st.totalCents>0)||rows[0]||{cycle:k}).cycle;
}
function invoicePayment(card,cycle){return card.invoicePayments?.[cycle]||null}
function invoiceDisplayAmount(card,cycle,st){return C.invoiceIsPaid(card,cycle)?C.invoicePaidAmount(card,cycle,st.totalCents):st.totalCents}

function monthSimpleSummary(k=currentMonth){
  const closed=monthCloseRecord(k),todayMonth=C.ym(C.ymd());
  if(closed&&k<todayMonth&&closed.summary){
    return {...closed.summary,p:C.monthProjection(state,k),mode:'past',closed:true,snapshot:closed,available:null,balance:null,reserved:0};
  }
  const p=C.monthProjection(state,k);
  const invoices=allCards().flatMap(card=>cardCyclesForDueMonth(card,k)
    .filter(x=>x.st.totalCents>0||C.invoiceIsPaid(card,x.cycle)||x.st.overridden)
    .map(x=>({card,cycle:x.cycle,statement:x.st})));
  const cardDue=invoices.filter(x=>!C.invoiceIsPaid(x.card,x.cycle)).reduce((s,x)=>s+(Number(x.statement.totalCents)||0),0);
  const cardPaid=invoices.filter(x=>C.invoiceIsPaid(x.card,x.cycle)).reduce((s,x)=>s+C.invoicePaidAmount(x.card,x.cycle,x.statement.totalCents),0);
  const received=p.transactions.filter(x=>x.type==='income').reduce((s,x)=>s+(Number(x.amountCents)||0),0);
  const paidCash=p.transactions.filter(x=>x.type==='expense'&&!x.cardId).reduce((s,x)=>s+(Number(x.amountCents)||0),0);
  const paid=paidCash+p.investmentActual+cardPaid;
  const dueCash=p.planned.filter(x=>x.type==='expense'&&!x.cardId).reduce((s,x)=>s+(Number(x.amountCents)||0),0);
  const due=dueCash+p.investmentPlanned+cardDue;
  const mode=k===todayMonth?'current':k>todayMonth?'future':'past';
  const available=mode==='current'?getAvailableBalance():null;
  const reserved=mode==='current'?reservedTotal():0;
  const balance=mode==='current'&&available!==null?available-due-reserved:null;
  return {p,invoices,cardDue,cardPaid,received,paid,due,dueCash,available,balance,reserved,mode,closed:false};
}

function renderHome(){
  let m;
  try{m=monthSimpleSummary()}catch(e){console.error('Resumo do mês falhou',e);m={received:0,paid:0,due:0,available:null,balance:null,reserved:0,mode:'current'}}
  $('#monthLabel').textContent=fmtMonth(currentMonth);
  const current=m.mode==='current',future=m.mode==='future';
  $('#balanceHero').disabled=!current;
  $('#availableMetricBtn').disabled=!current;
  $('#balanceHero').classList.toggle('static',!current);
  $('#availableMetricBtn').classList.toggle('static',!current);

  if(current){
    $('#heroKicker').textContent='AGORA';
    if(m.available===null){
      $('#balanceLabel').textContent='Saldo disponível hoje';$('#freeMoney').textContent='R$ —';$('#freeMoney').classList.remove('negative');
      $('#freeHint').textContent='Toque para informar quanto dinheiro você realmente tem hoje. O app não vai adivinhar.';
      $('#incomeMetric').textContent='Definir';$('#availableMetricLabel').textContent='💵 Saldo hoje';$('#availableMetricHelp').textContent='toque para reconciliar';
    }else{
      $('#balanceLabel').textContent=m.balance>=0?'Livre de verdade':'Falta para cobrir tudo';
      $('#freeMoney').textContent=C.money(Math.abs(m.balance));$('#freeMoney').classList.toggle('negative',m.balance<0);
      $('#freeHint').textContent=`${C.money(m.available)} em mãos • ${C.money(m.due)} a pagar • ${C.money(m.reserved)} reservado.`;
      $('#incomeMetric').textContent=C.money(m.available);$('#availableMetricLabel').textContent='💵 Saldo hoje';$('#availableMetricHelp').textContent='toque para reconciliar';
    }
  }else if(future){
    $('#heroKicker').textContent='PRÓXIMO PERÍODO';$('#balanceLabel').textContent='Previsto para pagar';$('#freeMoney').textContent=C.money(m.due);$('#freeMoney').classList.remove('negative');
    $('#freeHint').textContent=`Compromissos previstos para ${fmtMonth(currentMonth)}. Seu saldo de hoje não é projetado para o futuro.`;
    $('#availableMetricLabel').textContent='💰 Entradas registradas';$('#incomeMetric').textContent=C.money(m.received);$('#availableMetricHelp').textContent='não é previsão';
  }else{
    $('#heroKicker').textContent=m.closed?'MÊS FECHADO':'HISTÓRICO';$('#balanceLabel').textContent='Pago no mês';$('#freeMoney').textContent=C.money(m.paid);$('#freeMoney').classList.remove('negative');
    $('#freeHint').textContent=m.closed?`Resumo congelado em ${new Date(m.snapshot.closedAt).toLocaleDateString('pt-BR')}. Reabra em Análises para alterar.`:`O que ficou registrado como quitado em ${fmtMonth(currentMonth)}.`;
    $('#availableMetricLabel').textContent='💰 Entradas registradas';$('#incomeMetric').textContent=C.money(m.received);$('#availableMetricHelp').textContent=m.closed?'resumo congelado':'histórico';
  }
  $('#committedMetric').textContent=C.money(m.due);
  $('#expenseMetric').textContent=C.money(m.paid);
  if($('#reservedMetric'))$('#reservedMetric').textContent=C.money(reservedTotal());
  renderHomeCards();
  renderUpcoming();
}

function currentCardView(card){
  const cycle=invoiceCycleForDueMonth(card,currentMonth),st=C.cardStatement(state,card,cycle);
  const nextMonth=C.addMonths(currentMonth+'-01',1).slice(0,7),nextCycle=invoiceCycleForDueMonth(card,nextMonth),next=C.cardStatement(state,card,nextCycle);
  return {cycle,st,nextCycle,next};
}

function renderHomeCards(){
  const el=$('#homeCards');if(!el)return;
  const cards=activeCards();
  if(!cards.length){el.innerHTML='<button type="button" class="cards-empty-compact" id="emptyAddCard"><span>Nenhum cartão cadastrado</span><b>+ adicionar</b></button>';$('#emptyAddCard').onclick=()=>openNewCard();return}
  el.innerHTML=cards.map(card=>{
    const v=currentCardView(card),paid=C.invoiceIsPaid(card,v.cycle),closed=C.invoiceIsClosed(card,v.cycle,C.ymd(),v.st.dueDate),amount=invoiceDisplayAmount(card,v.cycle,v.st);
    const outstanding=C.cardOutstandingCents(state,card),available=Math.max(0,(Number(card.limitCents)||0)-outstanding);
    const badge=paid?['PAGA','paid']:closed?['FECHADA','closed']:['ABERTA',''];
    const closeDate=C.cardCloseDateForDueDate(v.st.dueDate,card),closeLabel=new Date(closeDate+'T12:00:00').toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'}),dueLabel=new Date(v.st.dueDate+'T12:00:00').toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});
    return `<button type="button" class="home-card-row" data-home-card="${esc(card.id)}">
      <span class="home-card-main"><b>${esc(card.name)}</b><span class="card-badge ${badge[1]}">${badge[0]}</span><small>fecha ${closeLabel} • vence ${dueLabel} • limite livre ${C.money(available)}</small></span>
      <span class="home-card-side"><strong>${C.money(amount)}</strong><small>Próx. ${C.money(v.next.totalCents)}</small></span>
    </button>`;
  }).join('');
  $$('[data-home-card]').forEach(row=>row.onclick=()=>openCardActions(row.dataset.homeCard));
}

function itemStatus(x,today=C.ymd()){
  if(x.paid)return {label:'✓ Pago',cls:'status-paid',cardCls:'month-paid'};
  if(x.needsValue||x.amountCents<=0)return {label:'A definir',cls:'status-define',cardCls:'month-define'};
  if(x.date<today)return {label:'Atrasado',cls:'status-late',cardCls:'month-late'};
  return {label:'A pagar',cls:'status-open',cardCls:'month-open'};
}

function buildLedgerRows(k=currentMonth){
  const p=C.monthProjection(state,k),actual=p.transactions.filter(x=>['expense','investment'].includes(x.type)&&!x.cardId&&(x.recurringId||x.purchaseId)).map(x=>({...x,kind:'actual',paid:true,number:x.installmentNumber||x.number||0,count:x.count||state.installments.find(i=>i.id===x.purchaseId)?.count||0}));
  const planned=p.planned.filter(x=>['expense','investment'].includes(x.type)&&!x.cardId).map(x=>({...x,kind:'planned',paid:false}));
  const invoices=allCards().flatMap(card=>cardCyclesForDueMonth(card,k).filter(x=>x.st.totalCents>0||C.invoiceIsPaid(card,x.cycle)||x.st.overridden).map(x=>({
    kind:'card',cardId:card.id,cycle:x.cycle,date:x.st.dueDate,description:card.name,
    amountCents:invoiceDisplayAmount(card,x.cycle,x.st),paid:C.invoiceIsPaid(card,x.cycle),detail:card.archivedAt?'Fatura • cartão arquivado':'Fatura',type:'expense'
  })));
  return [...actual,...planned,...invoices].sort((a,b)=>a.date.localeCompare(b.date)||String(a.description||'').localeCompare(String(b.description||''),'pt-BR'));
}

function renderUpcoming(){
  const today=C.ymd(),closed=monthCloseRecord(currentMonth);
  $('#homeAccountsTitle').textContent=`Contas de ${fmtMonth(currentMonth)}`;
  if(closed&&currentMonth<C.ym(today)&&Array.isArray(closed.rows)){
    const rows=closed.rows;
    if(!rows.length){$('#upcomingList').innerHTML=`<div class="month-empty"><b>Mês fechado sem compromissos</b><small>Fechado em ${new Date(closed.closedAt).toLocaleDateString('pt-BR')}.</small></div>`;return}
    $('#upcomingList').innerHTML=rows.map(x=>`<div class="ledger-row ${esc(x.cardCls||'')} closed-ledger-row">
      <span class="ledger-main"><b>${esc(x.description||'Sem descrição')}${x.number&&x.count?` <em>${x.number}/${x.count}</em>`:''}</b><small>${esc(x.dateLabel||'')}${x.detail?` · ${esc(x.detail)}`:''}</small></span>
      <span class="ledger-side"><strong>${C.money(x.amountCents)}</strong><small class="${esc(x.statusCls||'')}">${esc(x.statusLabel||'')}</small></span>
    </div>`).join('');return;
  }
  const rows=buildLedgerRows(currentMonth);
  if(!rows.length){$('#upcomingList').innerHTML=`<div class="month-empty"><b>Nada para pagar em ${esc(fmtMonth(currentMonth))}</b><small>Compras avulsas ficam no Histórico; aqui entram contas, parcelas e faturas.</small></div>`;return}
  $('#upcomingList').innerHTML=rows.map(x=>{
    const st=itemStatus(x,today),num=x.number||x.installmentNumber||0,count=x.count||0,needsValue=!!(x.needsValue||x.amountCents<=0);
    return `<button type="button" class="ledger-row quick-item ${st.cardCls}" data-quick-kind="${esc(x.kind)}" data-card-id="${esc(x.cardId||'')}" data-cycle="${esc(x.cycle||'')}" data-recurring-id="${esc(x.recurringId||'')}" data-purchase-id="${esc(x.purchaseId||'')}" data-tx-id="${esc(x.kind==='actual'?x.id:'')}" data-planned-id="${esc(x.kind==='planned'?x.id:'')}" data-needs-value="${needsValue?'1':'0'}">
      <span class="ledger-main"><b>${esc(x.description||'Sem descrição')}${num&&count?` <em>${num}/${count}</em>`:''}</b><small>${new Date(x.date+'T12:00:00').toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})}${x.detail?` · ${esc(x.detail)}`:''}</small></span>
      <span class="ledger-side"><strong>${C.money(x.amountCents)}</strong><small class="${st.cls}">${st.label}</small></span>
    </button>`;
  }).join('');
  $$('.quick-item').forEach(el=>el.onclick=()=>quickForUpcoming(el));
}

function openQuickActions(title,actions){
  $('#quickActionsTitle').textContent=title;
  $('#quickActionsBody').innerHTML=actions.map((a,i)=>`<button type="button" data-qa="${i}"><span>${a.icon||'•'}</span><b>${esc(a.label)}</b>${a.help?`<small>${esc(a.help)}</small>`:''}</button>`).join('');
  $$('[data-qa]').forEach(b=>b.onclick=()=>{const a=actions[Number(b.dataset.qa)];close('quickActionsDialog');a.run()});
  open('quickActionsDialog');
}

function quickForUpcoming(el){
  const kind=el.dataset.quickKind;
  if(kind==='card'){
    const card=state.cards.find(x=>x.id===el.dataset.cardId),cycle=el.dataset.cycle;if(!card)return;
    const paid=C.invoiceIsPaid(card,cycle),actions=[];
    if(paid)actions.push({icon:'↩',label:'Desmarcar pagamento',help:'A fatura volta a ficar aberta e o saldo é devolvido quando aplicável.',run:()=>unpayInvoice(card.id,cycle)});
    else actions.push({icon:'✓',label:'Marcar fatura como paga',run:()=>payInvoice(card.id,cycle)});
    if(!paid)actions.push({icon:'🧾',label:'Ajustar valor da fatura',run:()=>adjustInvoice(card.id,cycle)});
    if(!card.archivedAt)actions.push({icon:'✎',label:'Editar cartão',run:()=>editCard(card.id)});
    openQuickActions(card.name,actions);return;
  }
  const txId=el.dataset.txId,recId=el.dataset.recurringId,purchaseId=el.dataset.purchaseId,plannedId=el.dataset.plannedId,needsValue=el.dataset.needsValue==='1';
  if(txId){
    const tx=state.transactions.find(x=>x.id===txId&&!x.deletedAt);if(!tx)return;
    const actions=[{icon:'↩',label:'Desmarcar pagamento',help:'A conta volta para A pagar/Atrasado.',run:()=>undoPaidTransaction(tx.id)},{icon:'✎',label:'Editar lançamento',run:()=>editTx(tx.id)}];
    if(tx.recurringId)actions.push({icon:'↻',label:'Editar conta recorrente',run:()=>editRecurring(tx.recurringId)});
    if(tx.purchaseId)actions.push({icon:'▤',label:'Editar dívida / parcelamento',run:()=>editInstallment(tx.purchaseId)});
    openQuickActions(tx.description||'Pagamento',actions);return;
  }
  if(recId){
    const r=state.recurring.find(x=>x.id===recId&&!x.deletedAt);if(!r)return;
    const actions=[];
    if(plannedId&&!needsValue)actions.push({icon:'✓',label:r.type==='investment'?'Marcar como guardado':'Marcar como pago',run:()=>payPlanned(plannedId)});
    actions.push({icon:'✎',label:needsValue?'Definir valor deste mês':'Editar este mês',run:()=>editRecurringOccurrence(recId,currentMonth)});
    actions.push({icon:'↻',label:r.type==='investment'?'Editar investimento':'Editar regra da conta',run:()=>r.type==='investment'?editInvestment(recId):editRecurring(recId)});
    actions.push({icon:'×',label:'Arquivar compromisso',run:()=>deleteManaged('recurring',recId)});
    openQuickActions(r.description,actions);return;
  }
  if(purchaseId){
    const x=state.installments.find(i=>i.id===purchaseId&&!i.deletedAt);if(!x)return;
    const actions=[];if(plannedId)actions.push({icon:'✓',label:'Marcar parcela como paga',run:()=>payPlanned(plannedId)});
    actions.push({icon:'✎',label:'Editar dívida / parcelamento',run:()=>editInstallment(purchaseId)},{icon:'×',label:'Arquivar dívida / parcelamento',run:()=>deleteManaged('installments',purchaseId)});
    openQuickActions(x.description,actions);
  }
}

function movementMethod(x){if(x.type==='income')return'income';if(x.cardId)return'Crédito';return x.paymentMethod||'Outro'}
function movementCardName(id){return state.cards.find(c=>c.id===id)?.name||'Cartão'}
function refreshMovementCardFilter(){
  const el=$('#movementCardFilter');if(!el)return;
  const used=new Set(C.monthProjection(state,currentMonth).transactions.map(x=>x.cardId).filter(Boolean));
  const cards=state.cards.filter(x=>used.has(x.id)||!x.archivedAt);
  const current=movementCard;
  el.innerHTML='<option value="all">Todos os cartões</option>'+cards.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  if(cards.some(c=>c.id===current))el.value=current;else{movementCard='all';el.value='all'}
  el.classList.toggle('hidden',movementFilter!=='Crédito'||!cards.length);
}
function historyRows(){
  const q=movementSearch.trim().toLocaleLowerCase('pt-BR');
  return C.monthProjection(state,currentMonth).transactions.filter(x=>{
    const method=movementMethod(x);
    if(movementFilter==='income'&&x.type!=='income')return false;
    if(movementFilter!=='all'&&movementFilter!=='income'&&method!==movementFilter)return false;
    if(movementCard!=='all'&&x.cardId!==movementCard)return false;
    if(q){const hay=[x.description,x.paymentMethod,x.cardId?movementCardName(x.cardId):'',x.incomeSource?sourceName(x.incomeSource):''].join(' ').toLocaleLowerCase('pt-BR');if(!hay.includes(q))return false}
    return true;
  }).sort((a,b)=>b.date.localeCompare(a.date)||String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
}
function movementDetail(x){
  if(x.type==='income')return`Entrada · ${sourceName(x.incomeSource||'outros')}`;
  if(x.type==='investment')return'Reserva / investimento';
  const method=movementMethod(x),card=x.cardId?` · ${movementCardName(x.cardId)}`:'',count=x.count||state.installments.find(i=>i.id===x.purchaseId)?.count||0;
  if(x.creditPurchaseSummary)return`${method}${card}${count?` · compra em ${count}x`:''}`;
  const inst=x.installmentNumber?` · parcela ${x.installmentNumber}${count?'/'+count:''}`:'';
  return`${method}${card}${inst}`;
}
function renderMovements(){
  $('#movementMonth').textContent=fmtMonth(currentMonth);refreshMovementCardFilter();
  const rows=historyRows(),spent=rows.filter(x=>x.type==='expense').reduce((s,x)=>s+(Number(x.amountCents)||0),0),income=rows.filter(x=>x.type==='income').reduce((s,x)=>s+(Number(x.amountCents)||0),0);
  $('#movementSummary').innerHTML=movementFilter==='income'?`<span>Entradas mostradas</span><strong>${C.money(income)}</strong><small>${rows.length} lançamento${rows.length===1?'':'s'}</small>`:`<span>Gastos mostrados</span><strong>${C.money(spent)}</strong><small>${rows.length} lançamento${rows.length===1?'':'s'}</small>`;
  $('#movementList').innerHTML=rows.length?rows.map(x=>`<div class="history-row"><div class="history-row-main"><b>${esc(x.description||'Sem descrição')}</b><small>${new Date(x.date+'T12:00:00').toLocaleDateString('pt-BR')} · ${esc(movementDetail(x))}</small></div><div class="move-side"><strong class="amount ${x.type==='income'?'income':x.type==='investment'?'investment-amount':'expense'}">${x.type==='income'?'+':x.type==='investment'?'🌱':'−'} ${C.money(x.amountCents)}</strong><div><button class="mini" data-edit="${esc(x.id)}">Editar</button><button class="mini danger" data-del="${esc(x.id)}">Excluir</button></div></div></div>`).join(''):`<div class="empty-state"><b>Nenhum lançamento encontrado</b><small>Tente outro filtro ou busca. Contas ainda não pagas ficam na tela Início.</small></div>`;
  $$('[data-edit]').forEach(b=>b.onclick=()=>editTx(b.dataset.edit));$$('[data-del]').forEach(b=>b.onclick=()=>deleteTx(b.dataset.del));
}

function projection90Data(){
  const today=C.ymd(),end=addDaysIso(today,90),months=[];
  let k=C.ym(today);
  while(k<=C.ym(end)){months.push(k);k=C.ym(C.addMonths(k+'-01',1))}
  const rows=[];
  for(const month of months){
    for(const x of buildLedgerRows(month)){
      if(x.paid||Number(x.amountCents)<=0)continue;
      const effectiveDate=x.date<today?today:x.date;
      if(effectiveDate<=end)rows.push({...x,effectiveDate});
    }
  }
  rows.sort((a,b)=>a.effectiveDate.localeCompare(b.effectiveDate)||String(a.description||'').localeCompare(String(b.description||''),'pt-BR'));
  const totalWithin=days=>rows.filter(x=>daysBetweenIso(today,x.effectiveDate)<=days).reduce((s,x)=>s+(Number(x.amountCents)||0),0);
  return {rows,p30:totalWithin(30),p60:totalWithin(60),p90:totalWithin(90)};
}

function renderProjection(){
  const d=projection90Data();
  $('#projection30').textContent=C.money(d.p30);$('#projection60').textContent=C.money(d.p60);$('#projection90').textContent=C.money(d.p90);
  const rows=d.rows.slice(0,8);
  $('#projectionList').innerHTML=rows.length?rows.map(x=>`<div class="timeline-row"><span><b>${esc(new Date(x.effectiveDate+'T12:00:00').toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'}))}</b><small>${esc(x.description||'Compromisso')}</small></span><strong>${C.money(x.amountCents)}</strong></div>`).join(''):`<div class="empty-state"><b>Nada pendente nos próximos 90 dias</b><small>Quando houver conta, parcela ou fatura, ela aparece aqui.</small></div>`;
}

function renderVaultSummary(){
  const items=vaultItems(),el=$('#vaultSummaryList');if(!el)return;
  if(!items.length){el.innerHTML='<button type="button" class="analysis-action" id="emptyVaultAction"><span><b>Nenhum cofre ainda</b><small>Separe dinheiro sem tirá-lo do saldo bancário</small></span><strong>＋</strong></button>';$('#emptyVaultAction').onclick=openVaults;return}
  el.innerHTML=items.map(v=>{const target=Math.max(0,Number(v.targetCents)||0),saved=Math.max(0,Number(v.savedCents)||0),pct=target?Math.min(100,Math.round(saved/target*100)):100;return `<button type="button" class="vault-card" data-vault-open="${esc(v.id)}"><span><b>🔒 ${esc(v.name)}</b><small>${target?`${C.money(saved)} de ${C.money(target)}`:`${C.money(saved)} reservado`}</small></span><span class="vault-progress"><i style="width:${pct}%"></i></span></button>`}).join('');
  $$('[data-vault-open]').forEach(b=>b.onclick=openVaults);
}

function renderMonthCloseStatus(){
  const el=$('#monthCloseStatus'),btn=$('#monthCloseBtn');if(!el||!btn)return;
  const todayMonth=C.ym(C.ymd()),rec=monthCloseRecord(currentMonth);
  if(currentMonth>=todayMonth){
    el.textContent=currentMonth===todayMonth?'O mês atual ainda está em andamento. O fechamento fica disponível quando virar o mês.':'Mês futuro não pode ser fechado.';
    btn.disabled=true;btn.textContent='Fechamento indisponível';btn.onclick=null;return;
  }
  btn.disabled=false;
  if(rec){
    el.textContent=`${fmtMonth(currentMonth)} foi fechado em ${new Date(rec.closedAt).toLocaleString('pt-BR')}. O resumo e a lista de compromissos estão congelados.`;
    btn.textContent='Reabrir mês';btn.onclick=()=>reopenMonth(currentMonth);
  }else{
    const m=monthSimpleSummary(currentMonth);
    el.textContent=`Ao fechar, o Finance OS congela o resumo e os compromissos de ${fmtMonth(currentMonth)}. Pendências abertas também ficam registradas.`;
    btn.textContent=`Fechar ${fmtMonth(currentMonth)}`;btn.onclick=()=>closeMonth(currentMonth,m);
  }
}

async function closeMonth(k,summary=monthSimpleSummary(k)){
  if(k>=C.ym(C.ymd()))return alert('Só é possível fechar um mês que já terminou.');
  if(monthCloseRecord(k))return;
  if(!confirm(`Fechar ${fmtMonth(k)}? Depois disso, alterações nesse mês ficam bloqueadas até você reabrir.`))return;
  const rows=buildLedgerRows(k).map(x=>{const st=itemStatus(x,C.monthEnd(k));return {description:x.description||'',amountCents:Number(x.amountCents)||0,date:x.date||'',dateLabel:x.date?new Date(x.date+'T12:00:00').toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'}):'',paid:!!x.paid,detail:x.detail||'',number:x.number||x.installmentNumber||0,count:x.count||0,statusLabel:st.label,statusCls:st.cls,cardCls:st.cardCls}});
  const record={key:monthCloseKey(k),month:k,closedAt:nowIso(),summary:{received:summary.received,paid:summary.paid,due:summary.due,cardDue:summary.cardDue,cardPaid:summary.cardPaid},rows};
  await putOne('meta',record);await refresh();renderAnalysis();showToast(`${fmtMonth(k)} fechado.`);
}

async function reopenMonth(k){
  if(!monthCloseRecord(k))return;
  if(!confirm(`Reabrir ${fmtMonth(k)}? O mês volta a aceitar alterações.`))return;
  await atomicOps([{store:'meta',type:'delete',key:monthCloseKey(k)}]);await refresh();renderAnalysis();showToast(`${fmtMonth(k)} reaberto.`);
}

function renderAnalysis(){
  if($('#analysisMonth'))$('#analysisMonth').textContent=fmtMonth(currentMonth);const m=monthSimpleSummary(),p=C.monthProjection(state,currentMonth);
  if(m.mode==='current')$('#analysisText').textContent=m.available===null?`Você já pagou ${C.money(m.paid)} e ainda falta pagar ${C.money(m.due)}. Defina seu saldo de hoje para saber quanto fica livre depois das contas e dos cofres.`:`Você tem ${C.money(m.available)} disponíveis hoje, ${C.money(m.reserved)} reservados em cofres e ${C.money(m.due)} ainda a pagar. ${m.balance>=0?'Livre de verdade: '+C.money(m.balance)+'.':'Para cobrir tudo, faltam '+C.money(Math.abs(m.balance))+'.'}`;
  else if(m.mode==='future')$('#analysisText').textContent=`Para ${fmtMonth(currentMonth)}, há ${C.money(m.due)} previstos para pagar. O Finance OS não projeta seu saldo atual para meses futuros.`;
  else $('#analysisText').textContent=`Em ${fmtMonth(currentMonth)}, ficaram registrados ${C.money(m.paid)} como pagos e ${C.money(m.received)} em entradas.${m.closed?' Este mês está fechado e o resumo está congelado.':''}`;
  const tx=p.transactions.filter(x=>x.type==='income'),rec=p.planned.filter(x=>x.type==='income'),map=new Map();
  for(const x of [...tx,...rec]){const k=x.incomeSource||'outros';map.set(k,(map.get(k)||0)+(Number(x.amountCents)||0))}
  $('#incomeSources').innerHTML=map.size?[...map.entries()].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<div class="history-row"><b>${esc(sourceName(k))}</b><strong class="amount income">${C.money(v)}</strong></div>`).join(''):`<div class="empty-state"><b>Nenhuma entrada cadastrada</b><small>Quando você registrar o que recebeu, aparece aqui.</small></div>`;
  renderProjection();renderVaultSummary();renderMonthCloseStatus();
}

function renderActive(){
  const id=$('.view.active')?.id||'view-home';
  if(id==='view-home')renderHome();
  else if(id==='view-movements')renderMovements();
  else if(id==='view-analysis')renderAnalysis();
  else if(id==='view-settings'){syncAppMeta();renderBackupStatus();}
}
function navigate(v){
  if(v==='home')currentMonth=C.ym(C.ymd());
  $$('.view').forEach(x=>x.classList.toggle('active',x.id===`view-${v}`));
  $$('.nav').forEach(x=>x.classList.toggle('active',x.dataset.view===v));
  renderActive();
}

function updateBalanceComparison(){
  const el=$('#balanceComparison');if(!el)return;
  const tracked=getAvailableBalance(),typed=C.toCents($('#balanceAmount')?.value||'');
  if(tracked===null){el.textContent=typed>0?`Primeira referência: ${C.money(typed)}.`:'Informe o saldo real para iniciar o acompanhamento.';el.className='reconcile-preview';return}
  const diff=typed-tracked;
  if(!$('#balanceAmount')?.value){el.textContent=`Finance OS calcula ${C.money(tracked)} neste momento.`;el.className='reconcile-preview';return}
  el.textContent=diff===0?'Bate certinho com o saldo calculado.':`${diff>0?'Há':'Faltam'} ${C.money(Math.abs(diff))} ${diff>0?'a mais':'em relação ao cálculo'} do app.`;
  el.className='reconcile-preview '+(diff===0?'ok':Math.abs(diff)<=500?'':'warn');
}


function renderVaultDialog(){
  const el=$('#vaultList');if(!el)return;
  const items=vaultItems();
  el.innerHTML=items.length?items.map(v=>{const saved=Math.max(0,Number(v.savedCents)||0),target=Math.max(0,Number(v.targetCents)||0),pct=target?Math.min(100,Math.round(saved/target*100)):100;return `<div class="vault-manage-row"><div><b>🔒 ${esc(v.name)}</b><small>${target?`${C.money(saved)} de ${C.money(target)}`:`${C.money(saved)} reservado`}</small><span class="vault-progress"><i style="width:${pct}%"></i></span></div><div class="vault-manage-actions"><button type="button" class="mini" data-vault-edit="${esc(v.id)}">Editar</button><button type="button" class="mini danger" data-vault-del="${esc(v.id)}">Excluir</button></div></div>`}).join(''):'<div class="empty-state"><b>Nenhum cofre criado</b><small>Crie uma meta para separar dinheiro sem mexer no saldo bancário.</small></div>';
  $$('[data-vault-edit]').forEach(b=>b.onclick=()=>editVault(b.dataset.vaultEdit));
  $$('[data-vault-del]').forEach(b=>b.onclick=()=>deleteVault(b.dataset.vaultDel));
}

function openVaults(){
  $('#vaultForm').reset();$('#vaultEditId').value='';renderVaultDialog();open('vaultDialog');setTimeout(()=>$('#vaultName').focus(),80);
}

function editVault(id){
  const v=vaultItems().find(x=>x.id===id);if(!v)return;
  $('#vaultEditId').value=v.id;$('#vaultName').value=v.name;$('#vaultTarget').value=v.targetCents?(Number(v.targetCents)/100).toFixed(2).replace('.',','):'';$('#vaultSaved').value=(Number(v.savedCents||0)/100).toFixed(2).replace('.',',');setTimeout(()=>$('#vaultName').focus(),50);
}

async function saveVault(e){
  e.preventDefault();const name=$('#vaultName').value.trim(),saved=C.toCents($('#vaultSaved').value),target=C.toCents($('#vaultTarget').value),id=$('#vaultEditId').value||C.uid('vault');
  if(!name||saved<0||target<0)return alert('Confira nome e valores do cofre.');
  const rec=vaultRecord(),items=[...(rec.items||[])],i=items.findIndex(x=>x.id===id),obj={...(i>=0?items[i]:{}),id,name,savedCents:saved,targetCents:target,createdAt:i>=0?items[i].createdAt:nowIso(),updatedAt:nowIso()};
  if(i>=0)items[i]=obj;else items.push(obj);
  await putOne('meta',{key:META_VAULTS,items,updatedAt:nowIso()});$('#vaultForm').reset();$('#vaultEditId').value='';await refresh();renderVaultDialog();renderVaultSummary();showToast(i>=0?'Cofre atualizado.':'Cofre criado.');
}

async function deleteVault(id){
  const v=vaultItems().find(x=>x.id===id);if(!v||!confirm(`Excluir o cofre "${v.name}"? Isso não apaga dinheiro; só deixa de reservá-lo no Finance OS.`))return;
  const rec=vaultRecord(),items=(rec.items||[]).filter(x=>x.id!==id);await putOne('meta',{key:META_VAULTS,items,updatedAt:nowIso()});await refresh();renderVaultDialog();renderVaultSummary();showToast('Cofre removido.');
}

function syncSimulatorFields(){
  const credit=$('#simType').value==='credit';$('#simCreditFields').classList.toggle('hidden',!credit);
  if(credit){
    const cards=activeCards();$('#simCard').innerHTML=cards.length?cards.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join(''):'<option value="">Nenhum cartão</option>';
  }
}

function openSimulator(){
  $('#simulatorForm').reset();$('#simInstallments').value=1;$('#simType').value='cash';$('#simResult').innerHTML='';syncSimulatorFields();open('simulatorDialog');setTimeout(()=>$('#simAmount').focus(),80);
}

function runSimulator(e){
  e.preventDefault();const type=$('#simType').value,amount=C.toCents($('#simAmount').value);if(amount<=0)return alert('Informe um valor válido.');
  const m=monthSimpleSummary(C.ym(C.ymd())),free=m.available===null?null:m.available-m.due-reservedTotal(),result=$('#simResult');
  if(type==='cash'||type==='income'){
    const delta=type==='income'?amount:-amount,next=free===null?null:free+delta;
    result.innerHTML=`<b>${type==='income'?'Entrada simulada':'Gasto simulado'}: ${type==='income'?'+':'−'}${C.money(amount)}</b><p>${next===null?'Defina seu saldo hoje para ver o valor livre final.':`Livre depois das contas e cofres: <strong class="${next<0?'negative-text':''}">${C.money(next)}</strong>.`}</p>`;
    return;
  }
  const card=state.cards.find(x=>x.id===$('#simCard').value&&!x.archivedAt&&!x.deletedAt),count=Math.max(1,Math.min(120,Number($('#simInstallments').value)||1));if(!card)return alert('Escolha um cartão.');
  const base=Math.floor(amount/count),last=amount-base*(count-1),cycle=C.ym(C.cardCycleDate(C.ymd(),card)),due=C.cardDueDateForCycle(cycle,card),outstanding=C.cardOutstandingCents(state,card),availableLimit=Math.max(0,(Number(card.limitCents)||0)-outstanding),afterLimit=availableLimit-amount;
  result.innerHTML=`<b>${esc(card.name)} • ${count}x</b><p>Parcela aproximada: <strong>${C.money(base)}</strong>${last!==base?` (última ${C.money(last)})`:''}. Primeira fatura prevista: <strong>${new Date(due+'T12:00:00').toLocaleDateString('pt-BR')}</strong>.</p><p>Limite livre iria de ${C.money(availableLimit)} para <strong class="${afterLimit<0?'negative-text':''}">${C.money(afterLimit)}</strong>${afterLimit<0?` • excede em ${C.money(Math.abs(afterLimit))}`:''}.</p>`;
}

function openBalanceDialog(){
  if(currentMonth!==C.ym(C.ymd()))return;
  const cur=getAvailableBalance(),info=$('#balanceCurrentInfo');
  if(info)info.innerHTML=cur===null?'<b>Ainda sem referência</b><small>Defina o saldo real uma vez; depois entradas e saídas atualizam automaticamente.</small>':`<b>Calculado agora: ${C.money(cur)}</b><small>Se o banco mostrar outro valor, informe abaixo para reconciliar.</small>`;
  $('#balanceAmount').value=cur===null?'':(cur/100).toFixed(2).replace('.',',');updateBalanceComparison();open('balanceDialog');setTimeout(()=>$('#balanceAmount').focus(),80);
}
async function saveBalance(e){
  e.preventDefault();
  const cents=C.toCents($('#balanceAmount').value);if(cents<0)return alert('Informe um valor válido.');
  const prior=liveBalanceRecord(),expected=prior?Number(prior.amountCents):null,diff=expected===null?0:cents-expected,at=nowIso();
  const live={key:META_LIVE_BALANCE,amountCents:cents,epoch:at,updatedAt:at,reconciledAt:at};
  const log=balanceLogRecord(),entries=[...(log.entries||[]),{at,expectedCents:expected,actualCents:cents,differenceCents:diff}].slice(-60);
  await atomicOps([{store:'meta',value:live},{store:'meta',value:{key:META_BALANCE_LOG,entries,updatedAt:at}}]);
  close('balanceDialog');await refresh();
  showToast(expected===null?'Saldo de hoje definido.':diff===0?'Saldo reconciliado • tudo bateu.':`Saldo reconciliado • ajuste ${diff>0?'+':''}${C.money(diff)}.`);
}

function resetTxForm(type){
  $('#txForm').reset();$('#txEditId').value='';$('#txType').value=type;$('#txTitle').textContent=type==='income'?'Nova entrada':'Novo gasto';
  $('#incomeSourceWrap').classList.toggle('hidden',type!=='income');$('#txDate').value=C.ymd();refreshCardSelects();syncPaymentUI('Pix');
}
function syncPaymentUI(value){
  const wanted=value||$('#txPayment')?.value||'Pix';$('#txPayment').value=wanted;
  $$('[data-payment]').forEach(b=>b.classList.toggle('active',b.dataset.payment===wanted));
  const credit=wanted==='Crédito';$('#txCardWrap').classList.toggle('hidden',!credit);$('#txInstallmentWrap').classList.toggle('hidden',!credit);
  if(!credit){$('#txCard').value='';$('#txInstallmentCheck').checked=false;$('#txInstallmentFields').classList.add('hidden')}
  if(!$('#txInstallmentStart').value)$('#txInstallmentStart').value=C.ymd();
}

async function saveTx(e){
  e.preventDefault();
  const type=$('#txType').value,amount=C.toCents($('#txAmount').value),desc=$('#txDescription').value.trim(),date=$('#txDate').value,payment=$('#txPayment').value,cardId=$('#txCard').value;
  if(amount<=0||!desc||!date)return alert('Confira valor, descrição e data.');
  const existingId=$('#txEditId').value,existingTx=existingId?state.transactions.find(x=>x.id===existingId&&!x.deletedAt):null;
  if(existingTx&&!assertMonthOpen(C.ym(existingTx.date),'editar lançamentos'))return;if(!assertMonthOpen(C.ym(date),'salvar lançamentos'))return;
  if(type==='expense'&&payment==='Crédito'&&!cardId)return alert('Escolha qual cartão foi usado.');

  if(type==='expense'&&$('#txInstallmentCheck').checked){
    const count=Number($('#txInstallmentCount').value),start=$('#txInstallmentStart').value||date;if(count<2)return alert('Informe o número de parcelas.');
    const purchaseId=C.uid('inst'),createdAt=nowIso();
    const installment={id:purchaseId,description:desc,totalCents:amount,installmentCents:Math.floor(amount/count),count,nextNumber:1,startDate:start,categoryId:'outros',subcategory:'',cardId,createdAt,amountMode:'total'};
    const history={id:C.uid('tx'),type:'expense',amountCents:amount,description:desc,categoryId:'outros',subcategory:'',date,paymentMethod:'Crédito',status:'paid',cardId,purchaseId,installmentNumber:0,creditPurchaseSummary:true,historyOnly:true,createdAt,balanceAppliedEpoch:''};
    await atomicOps([{store:'installments',value:installment},{store:'transactions',value:history}]);
    close('txDialog');e.target.reset();await refresh();showToast(`Compra em ${count}x salva no Histórico e na fatura.`);return;
  }

  const editId=$('#txEditId').value,prior=editId?state.transactions.find(x=>x.id===editId):null,balance=liveBalanceRecord();
  let delta=0;
  if(prior&&balance&&txAppliedEpoch(prior)===balance.epoch)delta-=cashEffect(prior);
  const tx={...(prior||{}),id:editId||C.uid('tx'),type,amountCents:amount,description:desc,categoryId:'outros',subcategory:'',incomeSource:type==='income'?$('#txIncomeSource').value:'',date,paymentMethod:payment,cardId,status:'paid',createdAt:prior?.createdAt||nowIso(),updatedAt:editId?nowIso():'',balanceAppliedEpoch:'',availableAppliedEpoch:''};
  const applyNew=balance&&((prior&&txAppliedEpoch(prior)===balance.epoch)||(!prior&&shouldApplyNewTransaction(tx))||(!txAppliedEpoch(prior)&&shouldApplyNewTransaction(tx)));
  if(applyNew){delta+=cashEffect(tx);if(cashEffect(tx))tx.balanceAppliedEpoch=balance.epoch}
  await atomicPutWithBalance('transactions',tx,delta,balance?.epoch||'');
  $('#txEditId').value='';close('txDialog');e.target.reset();await refresh();
  showToast(type==='income'?(tx.balanceAppliedEpoch?'Entrada salva • saldo atualizado':'Entrada salva.'):(tx.balanceAppliedEpoch?'Gasto salvo • saldo atualizado':'Gasto salvo.'));
}

function editTx(id){
  const x=state.transactions.find(t=>t.id===id&&!t.deletedAt);if(!x)return;if(!assertMonthOpen(C.ym(x.date),'editar lançamentos'))return;
  if(x.creditPurchaseSummary&&x.purchaseId)return editInstallment(x.purchaseId);
  $('#txEditId').value=x.id;$('#txType').value=x.type;$('#txTitle').textContent=x.type==='income'?'Editar entrada':'Editar gasto';$('#txAmount').value=(x.amountCents/100).toFixed(2).replace('.',',');$('#txDescription').value=x.description;$('#txIncomeSource').value=x.incomeSource||'outros';$('#incomeSourceWrap').classList.toggle('hidden',x.type!=='income');$('#txDate').value=x.date;$('#txPayment').value=x.paymentMethod||'Pix';refreshCardSelects();$('#txCard').value=x.cardId||'';syncPaymentUI($('#txPayment').value);if(x.cardId)$('#txCardWrap').classList.remove('hidden');open('txDialog');
}

async function deleteTx(id){
  const x=state.transactions.find(t=>t.id===id&&!t.deletedAt);if(!x)return;if(!assertMonthOpen(C.ym(x.date),'excluir lançamentos'))return;
  if(x.creditPurchaseSummary&&x.purchaseId){
    if(!confirm(`Excluir a compra parcelada ${x.description} e as parcelas futuras?`))return;
    const inst=state.installments.find(i=>i.id===x.purchaseId&&!i.deletedAt),ops=[{store:'transactions',value:{...x,deletedAt:nowIso(),updatedAt:nowIso()}}];
    if(inst)ops.push({store:'installments',value:{...inst,deletedAt:nowIso(),updatedAt:nowIso()}});
    await atomicOps(ops);await refresh();showToast('Compra parcelada excluída.');return;
  }
  if(!confirm(`Excluir ${x.description}?`))return;
  const balance=liveBalanceRecord(),delta=balance&&txAppliedEpoch(x)===balance.epoch?-cashEffect(x):0;
  await atomicPutWithBalance('transactions',{...x,deletedAt:nowIso(),balanceAppliedEpoch:'',availableAppliedEpoch:''},delta,balance?.epoch||'');
  await refresh();showToast('Movimentação excluída.');
}

function movementRows(){const p=C.monthProjection(state,currentMonth);return [...p.transactions.map(x=>({...x,planned:false})),...p.planned.map(x=>({...x,planned:true}))].sort((a,b)=>b.date.localeCompare(a.date))}
async function payPlanned(id){
  const x=movementRows().find(t=>t.id===id&&t.planned);if(!x)return;if(!assertMonthOpen(C.ym(x.date),'marcar pagamentos'))return;
  let amount=x.amountCents;if(x.variable){const v=prompt(`Valor real de ${x.description}:`,amount?(amount/100).toFixed(2).replace('.',','):'0,00');if(v===null)return;amount=C.toCents(v);if(amount<=0)return alert('Informe um valor válido.')}
  const balance=liveBalanceRecord(),tx={id:C.uid('tx'),type:x.type,amountCents:amount,description:x.description,categoryId:x.categoryId||'outros',subcategory:x.subcategory||'',date:x.date,paymentMethod:'Outro',status:'paid',recurringId:x.recurringId||'',purchaseId:x.purchaseId||'',installmentNumber:x.installmentNumber||x.number||0,cardId:x.cardId||'',createdAt:nowIso(),balanceAppliedEpoch:''};
  const effect=cashEffect(tx),delta=balance?effect:0;if(balance&&effect)tx.balanceAppliedEpoch=balance.epoch;
  await atomicPutWithBalance('transactions',tx,delta,balance?.epoch||'');await refresh();showToast(x.type==='investment'?'Valor marcado como guardado.':'Pagamento confirmado.');
}

async function undoPaidTransaction(id){
  const tx=state.transactions.find(x=>x.id===id&&!x.deletedAt);if(!tx)return;if(!assertMonthOpen(C.ym(tx.date),'desmarcar pagamentos'))return;
  if(!(tx.recurringId||tx.purchaseId))return alert('Este lançamento não veio de uma conta planejada. Edite ou exclua pelo Histórico.');
  if(!confirm(`Desmarcar o pagamento de ${tx.description}?`))return;
  const balance=liveBalanceRecord(),delta=balance&&txAppliedEpoch(tx)===balance.epoch?-cashEffect(tx):0;
  await atomicPutWithBalance('transactions',{...tx,deletedAt:nowIso(),paymentUndoneAt:nowIso(),balanceAppliedEpoch:'',availableAppliedEpoch:''},delta,balance?.epoch||'');
  await refresh();showToast('Pagamento desmarcado.');
}

async function payInvoice(cardId,cycle){
  const card=state.cards.find(x=>x.id===cardId&&!x.deletedAt);if(!card)return;
  if(C.invoiceIsPaid(card,cycle))return;
  const st=C.cardStatement(state,card,cycle);if(!assertMonthOpen(C.ym(st.dueDate),'pagar faturas'))return;const amount=Number(st.totalCents)||0,balance=liveBalanceRecord();
  const paid={...(card.invoicePaid||{}),[cycle]:true},payments={...(card.invoicePayments||{}),[cycle]:{amountCents:amount,paidAt:nowIso(),dueDate:st.dueDate,balanceEpoch:balance?.epoch||''}};
  const updated={...card,invoicePaid:paid,invoicePayments:payments,updatedAt:nowIso()};
  await atomicPutWithBalance('cards',updated,balance?-amount:0,balance?.epoch||'');await refresh();showToast(`Fatura ${card.name} marcada como paga.`);
}
async function unpayInvoice(cardId,cycle){
  const card=state.cards.find(x=>x.id===cardId&&!x.deletedAt);if(!card)return;
  const payment=invoicePayment(card,cycle),st=C.cardStatement(state,card,cycle);if(!assertMonthOpen(C.ym(st.dueDate),'desmarcar faturas'))return;const amount=Number(payment?.amountCents)||Number(st.totalCents)||0;
  if(!C.invoiceIsPaid(card,cycle))return;
  if(!confirm(`Desmarcar o pagamento da fatura ${card.name}?`))return;
  const paid={...(card.invoicePaid||{})},payments={...(card.invoicePayments||{})};delete paid[cycle];delete payments[cycle];
  const balance=liveBalanceRecord(),delta=balance&&payment?.balanceEpoch===balance.epoch?amount:0;
  await atomicPutWithBalance('cards',{...card,invoicePaid:paid,invoicePayments:payments,updatedAt:nowIso()},delta,balance?.epoch||'');await refresh();showToast(`Pagamento da fatura ${card.name} desmarcado.`);
}

function cycleForDueDate(card,dueDate){
  const k=C.ym(dueDate),candidates=[C.addMonths(k+'-01',-2).slice(0,7),C.addMonths(k+'-01',-1).slice(0,7),k,C.addMonths(k+'-01',1).slice(0,7)];
  return [...new Set(candidates)].find(c=>C.cardDueDateForCycle(c,card)===dueDate)||invoiceCycleForDueMonth(card,k);
}
async function saveClosedInvoice(e){
  e.preventDefault();const card=state.cards.find(x=>x.id===$('#invoiceCard').value&&!x.archivedAt&&!x.deletedAt);if(!card)return alert('Escolha um cartão.');
  const amount=C.toCents($('#invoiceAmount').value),due=$('#invoiceDueDate').value;if(amount<0||!due)return alert('Confira valor e vencimento.');if(!assertMonthOpen(C.ym(due),'alterar faturas'))return;
  const cycle=cycleForDueDate(card,due);if(C.invoiceIsPaid(card,cycle))return alert('Essa fatura já está paga. Desmarque o pagamento antes de alterar o valor.');
  await putOne('cards',{...card,invoiceOverrides:{...(card.invoiceOverrides||{}),[cycle]:amount},invoiceClosed:{...(card.invoiceClosed||{}),[cycle]:{manual:true,closedAt:nowIso()}},updatedAt:nowIso()});
  close('invoiceDialog');e.target.reset();await refresh();showToast(`Fatura ${card.name} salva no vencimento correto.`);
}
async function adjustInvoice(id,forcedCycle=''){
  const card=state.cards.find(x=>x.id===id&&!x.deletedAt);if(!card)return;
  const cycle=forcedCycle||invoiceCycleForDueMonth(card,currentMonth);if(C.invoiceIsPaid(card,cycle))return alert('Essa fatura já está paga. Desmarque o pagamento antes de ajustar o valor.');
  const st=C.cardStatement(state,card,cycle);if(!assertMonthOpen(C.ym(st.dueDate),'ajustar faturas'))return;const label=fmtMonth(C.ym(st.dueDate));
  const v=prompt(`Valor real da fatura ${card.name} que vence em ${label} (${new Date(st.dueDate+'T12:00:00').toLocaleDateString('pt-BR')}).\n\nCalculado pelas compras: ${C.money(st.calculatedCents)}\n\nDigite o valor real ou deixe vazio para voltar ao automático:`,st.overridden?(st.totalCents/100).toFixed(2).replace('.',','):'');
  if(v===null)return;
  const overrides={...(card.invoiceOverrides||{})};
  if(!String(v).trim())delete overrides[cycle];
  else{const cents=C.toCents(v);if(cents<0)return alert('Informe um valor válido.');overrides[cycle]=cents}
  await putOne('cards',{...card,invoiceOverrides:overrides,updatedAt:nowIso()});await refresh();showToast(`Fatura ${card.name} de ${label} atualizada.`);
}

function openCardActions(id){
  const card=state.cards.find(x=>x.id===id&&!x.deletedAt);if(!card)return;
  const v=currentCardView(card),paid=C.invoiceIsPaid(card,v.cycle),actions=[];
  if(paid)actions.push({icon:'↩',label:'Desmarcar pagamento da fatura',run:()=>unpayInvoice(card.id,v.cycle)});
  else{actions.push({icon:'✓',label:'Marcar fatura como paga',run:()=>payInvoice(card.id,v.cycle)});actions.push({icon:'🧾',label:'Ajustar fatura',run:()=>adjustInvoice(card.id,v.cycle)})}
  if(!card.archivedAt)actions.push({icon:'✎',label:'Editar cartão',run:()=>editCard(card.id)});
  openQuickActions(card.name,actions);
}

function openNewCard(){
  $('#cardEditId').value='';$('#cardDialogTitle').textContent='Cadastrar cartão';$('#cardForm').reset();open('cardDialog');
}
async function saveCard(e){
  e.preventDefault();const editId=$('#cardEditId').value,prior=editId?state.cards.find(x=>x.id===editId):null;
  const name=$('#cardName').value.trim(),limitCents=C.toCents($('#cardLimit').value),closingDay=Number($('#cardClosing').value),dueDay=Number($('#cardDue').value);
  if(!name||limitCents<=0||closingDay<1||closingDay>31||dueDay<1||dueDay>31)return alert('Confira nome, limite, fechamento e vencimento.');
  let termsHistory=Array.isArray(prior?.termsHistory)?[...prior.termsHistory]:[{effectiveCycle:'0000-00',closingDay,dueDay}];
  if(prior&&(closingDay!==Number(prior.closingDay)||dueDay!==Number(prior.dueDay))){
    const effectiveCycle=C.ym(C.ymd());termsHistory=termsHistory.filter(x=>x.effectiveCycle!==effectiveCycle);termsHistory.push({effectiveCycle,closingDay,dueDay});termsHistory.sort((a,b)=>a.effectiveCycle.localeCompare(b.effectiveCycle));
  }
  const obj={...(prior||{}),id:editId||C.uid('card'),name,limitCents,closingDay,dueDay,termsHistory,createdAt:prior?.createdAt||nowIso(),updatedAt:editId?nowIso():'',archivedAt:prior?.archivedAt||''};
  await putOne('cards',obj);$('#cardEditId').value='';e.target.reset();close('cardDialog');await refresh();showToast(editId?'Cartão atualizado sem reescrever ciclos antigos.':'Cartão cadastrado.');
}
function editCard(id){
  const x=state.cards.find(t=>t.id===id&&!t.deletedAt);if(!x||x.archivedAt)return;
  close('listDialog');$('#cardEditId').value=x.id;$('#cardDialogTitle').textContent='Editar cartão';$('#cardName').value=x.name;$('#cardLimit').value=(x.limitCents/100).toFixed(2).replace('.',',');$('#cardClosing').value=x.closingDay;$('#cardDue').value=x.dueDay;open('cardDialog');
}
async function archiveCard(id){
  const x=state.cards.find(t=>t.id===id&&!t.deletedAt);if(!x||!confirm(`Arquivar o cartão "${x.name}"? Faturas e histórico continuarão visíveis nos meses correspondentes.`))return;
  await putOne('cards',{...x,archivedAt:nowIso(),updatedAt:nowIso()});await refresh();close('listDialog');showCards();showToast('Cartão arquivado. Histórico preservado.');
}
async function reactivateCard(id){const x=state.cards.find(t=>t.id===id&&!t.deletedAt);if(!x)return;await putOne('cards',{...x,archivedAt:'',updatedAt:nowIso()});await refresh();close('listDialog');showCards();showToast('Cartão reativado.')}
function showCards(){
  const rows=allCards();$('#listTitle').textContent='Cartões';
  $('#listContent').innerHTML=rows.length?rows.map(x=>{
    const cycle=invoiceCycleForDueMonth(x,C.ym(C.ymd())),st=C.cardStatement(state,x,cycle),outstanding=C.cardOutstandingCents(state,x),available=Math.max(0,x.limitCents-outstanding);
    return `<div class="history-row"><div class="history-row-main"><b>${esc(x.name)} ${x.archivedAt?'<span class="card-badge archived">ARQUIVADO</span>':''}</b><small>Fecha ${x.closingDay} · vence ${x.dueDay} · comprometido ${C.money(outstanding)} · livre ${C.money(available)}</small></div><div class="move-side"><strong>${C.money(invoiceDisplayAmount(x,cycle,st))}</strong><div>${x.archivedAt?`<button class="mini" data-react-card="${esc(x.id)}">Reativar</button>`:`<button class="mini" data-invoice-card="${esc(x.id)}" data-invoice-cycle="${esc(cycle)}">Fatura</button><button class="mini" data-edit-card="${esc(x.id)}">Editar</button><button class="mini danger" data-archive-card="${esc(x.id)}">Arquivar</button>`}</div></div></div>`;
  }).join(''):'<div class="empty-state"><b>Nenhum cartão cadastrado</b><small>Use “Cadastrar cartão” para adicionar o primeiro.</small></div>';
  $$('[data-invoice-card]').forEach(b=>b.onclick=()=>adjustInvoice(b.dataset.invoiceCard,b.dataset.invoiceCycle));$$('[data-edit-card]').forEach(b=>b.onclick=()=>editCard(b.dataset.editCard));$$('[data-archive-card]').forEach(b=>b.onclick=()=>archiveCard(b.dataset.archiveCard));$$('[data-react-card]').forEach(b=>b.onclick=()=>reactivateCard(b.dataset.reactCard));open('listDialog');
}

async function editRecurringOccurrence(id,k){
  if(!assertMonthOpen(k,'editar este mês'))return;const r=state.recurring.find(x=>x.id===id&&!x.deletedAt);if(!r)return;const occ=C.recurringOccurrence(r,k);if(!occ)return;
  const val=prompt(`Valor de ${r.description} neste mês:`,occ.amountCents?(occ.amountCents/100).toFixed(2).replace('.',','):'0,00');if(val===null)return;
  const amount=C.toCents(val),date=prompt('Data deste mês (AAAA-MM-DD):',occ.date);if(date===null)return;if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return alert('Data inválida. Use AAAA-MM-DD.');
  await putOne('recurring',{...r,monthOverrides:{...(r.monthOverrides||{}),[k]:{amountCents:amount,date}},updatedAt:nowIso()});await refresh();showToast('Este mês foi atualizado.');
}

async function saveRecurring(e){
  e.preventDefault();const editId=$('#recEditId').value,prior=editId?state.recurring.find(x=>x.id===editId&&!x.deletedAt):null;
  if(prior&&prior.type==='investment')return alert('Esse item é um investimento. Edite pela área Reservas e investimentos.');
  const description=$('#recDescription').value.trim(),startDate=$('#recStart').value,endDate=$('#recEnd').value;if(!description||!startDate)return alert('Confira descrição e data inicial.');if(endDate&&endDate<startDate)return alert('A data final não pode vir antes do início.');
  await putOne('recurring',{...(prior||{}),id:editId||C.uid('rec'),type:'expense',description,amountCents:C.toCents($('#recAmount').value),categoryId:'outros',subcategory:'',variable:$('#recVariable').checked,day:Number(startDate.slice(8)),startDate,endDate,recurrenceRule:$('#recRule').value||'same_day',monthOverrides:prior?.monthOverrides||{},active:true,frequency:'monthly',createdAt:prior?.createdAt||nowIso(),updatedAt:editId?nowIso():''});
  $('#recEditId').value='';close('recDialog');e.target.reset();await refresh();showToast(editId?'Conta recorrente atualizada.':'Conta recorrente salva.');
}
function editRecurring(id){
  const x=state.recurring.find(t=>t.id===id&&!t.deletedAt&&t.type!=='investment');if(!x)return;
  close('listDialog');$('#recEditId').value=x.id;$('#recDialogTitle').textContent='Editar conta recorrente';$('#recDescription').value=x.description;$('#recAmount').value=(x.amountCents/100).toFixed(2).replace('.',',');$('#recVariable').checked=!!x.variable;$('#recStart').value=x.startDate;$('#recEnd').value=x.endDate||'';$('#recRule').value=x.recurrenceRule||'same_day';open('recDialog');
}

async function saveInvestment(e){
  e.preventDefault();const editId=$('#investmentEditId').value,prior=editId?state.recurring.find(x=>x.id===editId&&!x.deletedAt&&x.type==='investment'):null,desc=$('#investmentDescription').value.trim(),amount=C.toCents($('#investmentAmount').value),date=$('#investmentDate').value,rec=$('#investmentRecurring').checked;
  if(!desc||amount<=0||!date)return alert('Confira objetivo, valor e data.');
  await putOne('recurring',{...(prior||{}),id:editId||C.uid('rec'),type:'investment',description:desc,amountCents:amount,categoryId:'investimento',subcategory:'',variable:false,day:Number(date.slice(8)),startDate:date,endDate:rec?'':date,active:true,frequency:'monthly',recurrenceRule:'same_day',monthOverrides:prior?.monthOverrides||{},createdAt:prior?.createdAt||nowIso(),updatedAt:editId?nowIso():''});
  $('#investmentEditId').value='';close('investmentDialog');e.target.reset();await refresh();showToast(editId?'Investimento atualizado.':'Compromisso de guardar dinheiro criado.');
}
function editInvestment(id){
  const x=state.recurring.find(t=>t.id===id&&!t.deletedAt&&t.type==='investment');if(!x)return;close('listDialog');$('#investmentEditId').value=x.id;$('#investmentDescription').value=x.description;$('#investmentAmount').value=(x.amountCents/100).toFixed(2).replace('.',',');$('#investmentDate').value=x.startDate;$('#investmentRecurring').checked=!(x.endDate&&x.endDate===x.startDate);open('investmentDialog');
}
function showInvestments(){
  const rows=state.recurring.filter(x=>!x.deletedAt&&x.type==='investment');$('#listTitle').textContent='Reservas e investimentos';
  $('#listContent').innerHTML=rows.length?rows.map(x=>`<div class="history-row"><div class="history-row-main"><b>${esc(x.description)}</b><small>${C.money(x.amountCents)} · ${x.endDate&&x.endDate===x.startDate?'uma vez':'todo mês'} · dia ${x.day}</small></div><div class="move-side"><button class="mini" data-edit-invest="${esc(x.id)}">Editar</button><button class="mini danger" data-del-invest="${esc(x.id)}">Arquivar</button></div></div>`).join(''):'<div class="empty-state"><b>Nenhuma reserva cadastrada</b><small>Use + → Guardar / investir.</small></div>';
  $$('[data-edit-invest]').forEach(b=>b.onclick=()=>editInvestment(b.dataset.editInvest));$$('[data-del-invest]').forEach(b=>b.onclick=()=>deleteManaged('recurring',b.dataset.delInvest));open('listDialog');
}

function syncInstallmentMode(){
  const parcelled=$('#instIsParcelled').checked,totalMode=$('#instForm').dataset.amountMode==='total';
  $('#instParcelFields').classList.toggle('hidden',!parcelled);const label=$('#instAmountLabel'),input=$('#instTotal');
  label.childNodes[0].nodeValue=parcelled?(totalMode?'Valor total da compra':'Valor de cada parcela'):'Valor a pagar';label.appendChild(input);
  $('#instSaveBtn').textContent=parcelled?(totalMode?'Salvar compra parcelada':'Salvar parcelamento'):'Salvar conta';updateInstPreview();
}
function updateInstPreview(){
  const raw=C.toCents($('#instTotal').value),parcelled=$('#instIsParcelled').checked,totalMode=$('#instForm').dataset.amountMode==='total';if(!raw){$('#instPreview').textContent='';return}
  if(!parcelled){$('#instPreview').textContent=`Pagamento único de ${C.money(raw)}.`;return}
  const count=Number($('#instCount').value)||0,next=Number($('#instNextNumber').value)||1;
  if(!(count>1&&next>=1&&next<=count)){ $('#instPreview').textContent='Confira a quantidade de parcelas.';return }
  const per=totalMode?Math.floor(raw/count):raw,total=totalMode?raw:raw*count;
  $('#instPreview').textContent=`${count}x de aproximadamente ${C.money(per)} · total ${C.money(total)} · faltam ${count-next+1} parcela${count-next+1===1?'':'s'}.`;
}
async function saveInstallment(e){
  e.preventDefault();const editId=$('#instEditId').value,prior=editId?state.installments.find(x=>x.id===editId&&!x.deletedAt):null,raw=C.toCents($('#instTotal').value),parcelled=$('#instIsParcelled').checked,count=parcelled?Number($('#instCount').value):1,next=parcelled?(Number($('#instNextNumber').value)||1):1,totalMode=$('#instForm').dataset.amountMode==='total';
  if(raw<=0||count<1||(parcelled&&count<2)||next<1||next>count)return alert(parcelled?'Confira valor, quantidade e parcela atual.':'Confira o valor e o vencimento.');
  const per=parcelled&&totalMode?Math.floor(raw/count):raw,total=parcelled?(totalMode?raw:raw*count):raw;
  const id=editId||C.uid('inst'),description=$('#instDescription').value.trim(),startDate=$('#instStart').value;if(!description||!startDate)return alert('Confira descrição e vencimento.');
  const updatedInstallment={...(prior||{}),id,description,amountMode:parcelled&&totalMode?'total':'per_installment',installmentCents:per,totalCents:total,count,nextNumber:next,startDate,categoryId:'outros',subcategory:'',cardId:prior?.cardId||'',createdAt:prior?.createdAt||nowIso(),updatedAt:editId?nowIso():''};
  const purchaseSummary=state.transactions.find(t=>!t.deletedAt&&t.creditPurchaseSummary&&t.purchaseId===id);
  if(purchaseSummary){
    const updatedSummary={...purchaseSummary,description,amountCents:total,cardId:updatedInstallment.cardId,updatedAt:nowIso()};
    await atomicOps([{store:'installments',value:updatedInstallment},{store:'transactions',value:updatedSummary}]);
  }else await putOne('installments',updatedInstallment);
  let inferredPrevious=false;
  if(!editId&&parcelled&&next>1){
    const previousDate=C.addMonths(startDate,-1),previousNumber=next-1,todayMonth=C.ym(C.ymd()),nextMonth=C.ym(startDate),already=state.transactions.some(t=>!t.deletedAt&&t.purchaseId===id&&Number(t.installmentNumber)===previousNumber);
    if(nextMonth>todayMonth&&C.ym(previousDate)===todayMonth&&!already){await putOne('transactions',{id:C.uid('tx'),type:'expense',amountCents:per,description,categoryId:'outros',subcategory:'',date:previousDate,paymentMethod:'Outro',status:'paid',recurringId:'',purchaseId:id,installmentNumber:previousNumber,cardId:'',createdAt:nowIso(),balanceAppliedEpoch:''});inferredPrevious=true}
  }
  $('#instEditId').value='';close('instDialog');e.target.reset();await refresh();showToast(editId?(parcelled?'Parcelamento atualizado.':'Conta atualizada.'):(inferredPrevious?`Parcela ${next-1}/${count} registrada como já paga.`:parcelled?'Dívida parcelada criada.':'Conta a pagar criada.'));
}
function editInstallment(id){
  const x=state.installments.find(t=>t.id===id&&!t.deletedAt);if(!x)return;close('listDialog');$('#instEditId').value=x.id;const parcelled=Number(x.count)>1,totalMode=!!x.cardId&&x.amountMode==='total';
  $('#instForm').dataset.amountMode=totalMode?'total':'per';$('#instDialogTitle').textContent=totalMode?'Editar compra parcelada':parcelled?'Editar parcelamento':'Editar conta / dívida';
  const shown=totalMode?x.totalCents:(x.amountMode==='per_installment'?x.installmentCents:Math.floor((x.totalCents||0)/(x.count||1)));$('#instTotal').value=(shown/100).toFixed(2).replace('.',',');$('#instIsParcelled').checked=parcelled;$('#instCount').value=parcelled?x.count:2;$('#instNextNumber').value=parcelled?(x.nextNumber||1):1;$('#instStart').value=x.startDate;$('#instDescription').value=x.description;syncInstallmentMode();open('instDialog');
}

function showList(kind){
  const recurring=kind==='recurring';$('#listTitle').textContent=recurring?'Contas recorrentes':'Parcelamentos e dívidas';
  const rows=(recurring?state.recurring.filter(x=>x.type!=='investment'):state.installments).filter(x=>!x.deletedAt);
  $('#listContent').innerHTML=rows.length?rows.map(x=>recurring?`<div class="history-row"><div class="history-row-main"><b>${esc(x.description)}</b><small>${C.money(x.amountCents)} · ${x.variable?'valor variável · ':''}${x.recurrenceRule==='first_monday'?'1ª segunda-feira':'dia '+x.day}${x.endDate?' · até '+new Date(x.endDate+'T12:00:00').toLocaleDateString('pt-BR'):''}</small></div><div class="move-side"><button class="mini" data-edit-rec="${esc(x.id)}">Editar</button><button class="mini danger" data-del-rec="${esc(x.id)}">Arquivar</button></div></div>`:(()=>{const r=C.remainingInstallments(x);return`<div class="history-row"><div class="history-row-main"><b>${esc(x.description)}</b><small>${x.count}x · próxima ${x.nextNumber}/${x.count} · termina ${r.endDate?new Date(r.endDate+'T12:00:00').toLocaleDateString('pt-BR'):'—'}</small></div><div class="move-side"><strong>${C.money(x.installmentCents||Math.floor(x.totalCents/x.count))}</strong><div><button class="mini" data-edit-inst="${esc(x.id)}">Editar</button><button class="mini danger" data-del-inst="${esc(x.id)}">Arquivar</button></div></div></div>`})()).join(''):'<div class="empty-state"><b>Nenhum cadastro ainda</b></div>';
  $$('[data-edit-rec]').forEach(b=>b.onclick=()=>editRecurring(b.dataset.editRec));$$('[data-del-rec]').forEach(b=>b.onclick=()=>deleteManaged('recurring',b.dataset.delRec));$$('[data-edit-inst]').forEach(b=>b.onclick=()=>editInstallment(b.dataset.editInst));$$('[data-del-inst]').forEach(b=>b.onclick=()=>deleteManaged('installments',b.dataset.delInst));open('listDialog');
}
async function deleteManaged(store,id){
  if(store==='cards')return archiveCard(id);
  const rows=state[store]||[],x=rows.find(t=>t.id===id&&!t.deletedAt);if(!x||!confirm(`Arquivar "${x.description||x.name}"? O histórico já pago será preservado.`))return;
  if(store==='installments'){
    const summary=state.transactions.find(t=>!t.deletedAt&&t.creditPurchaseSummary&&t.purchaseId===id);
    const ops=[{store,value:{...x,deletedAt:nowIso(),active:false,updatedAt:nowIso()}}];
    if(summary)ops.push({store:'transactions',value:{...summary,deletedAt:nowIso(),updatedAt:nowIso()}});
    await atomicOps(ops);
  }else await putOne(store,{...x,deletedAt:nowIso(),active:false,updatedAt:nowIso()});
  await refresh();close('listDialog');store==='recurring'?(x.type==='investment'?showInvestments():showList('recurring')):showList('installments');showToast('Item arquivado.');
}


function renderBackupStatus(){
  const el=$('#backupStatus');if(!el)return;const rec=backupStatusRecord(),last=rec.lastExportAt;
  if(!last){el.className='backup-status warn';el.textContent='Nenhum backup registrado neste aparelho.';return}
  const days=Math.max(0,Math.floor((Date.now()-new Date(last).getTime())/86400000)),label=new Date(last).toLocaleString('pt-BR');
  el.className='backup-status '+(days>30?'danger':days>14?'warn':'ok');
  el.textContent=days===0?`Último backup: hoje • ${label}`:`Último backup: há ${days} dia${days===1?'':'s'} • ${label}`;
}

async function exportBackup(){
  const env=await C.createBackupEnvelope(state),blob=new Blob([JSON.stringify(env,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`finance-os-backup-${C.ymd()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  const prior=backupStatusRecord();await putOne('meta',{...prior,key:META_BACKUP_STATUS,lastExportAt:nowIso(),updatedAt:nowIso()});await loadState();renderBackupStatus();
}
async function importBackup(file){
  try{
    const parsed=JSON.parse(await file.text()),v=await C.validateBackupEnvelope(parsed);if(!v.ok)throw new Error(v.errors.join('\n'));
    if(!confirm('Restaurar este backup vai substituir os dados atuais deste aparelho. A operação é atômica: ou restaura tudo, ou não altera nada. Continuar?'))return;
    await atomicRestore(v.data);await loadState();
    if(!(v.data.meta||[]).some(x=>x.key===META_LIVE_BALANCE)){
      await putOne('meta',{key:META_MIGRATION,version:'1.8.0',completedAt:nowIso(),restoredWithoutBalance:true});
      await loadState();await migrateCardsV180();
    }else await migrateV180();
    const prior=backupStatusRecord();await putOne('meta',{...prior,key:META_BACKUP_STATUS,lastRestoreAt:nowIso(),updatedAt:nowIso()});
    await refresh();renderBackupStatus();showToast('Backup restaurado por completo.');
  }catch(e){console.error(e);alert('Não foi possível restaurar o backup. Nenhuma restauração parcial foi mantida.\n\n'+e.message)}
}

function runIntegrityAudit(){
  const issues=[];
  const checkIds=(name,rows)=>{const set=new Set();for(const x of rows){if(!x?.id){issues.push(`${name}: registro sem ID`);continue}if(set.has(x.id))issues.push(`${name}: ID duplicado ${x.id}`);set.add(x.id)}};
  checkIds('Movimentações',state.transactions);checkIds('Recorrências',state.recurring);checkIds('Parcelamentos',state.installments);checkIds('Cartões',state.cards);
  const recIds=new Set(state.recurring.map(x=>x.id)),instIds=new Set(state.installments.map(x=>x.id)),cardIds=new Set(state.cards.map(x=>x.id));
  for(const t of state.transactions.filter(x=>!x.deletedAt)){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(t.date||''))issues.push(`Movimentação "${t.description}": data inválida`);
    if(!Number.isFinite(Number(t.amountCents))||Number(t.amountCents)<0)issues.push(`Movimentação "${t.description}": valor inválido`);
    if(t.recurringId&&!recIds.has(t.recurringId))issues.push(`Movimentação "${t.description}": recorrência não encontrada`);
    if(t.purchaseId&&!instIds.has(t.purchaseId))issues.push(`Movimentação "${t.description}": parcelamento não encontrado`);
    if(t.cardId&&!cardIds.has(t.cardId))issues.push(`Movimentação "${t.description}": cartão não encontrado`);
  }
  for(const r of state.recurring.filter(x=>!x.deletedAt)){if(r.endDate&&r.endDate<r.startDate)issues.push(`Recorrência "${r.description}": termina antes de começar`)}
  for(const p of state.installments.filter(x=>!x.deletedAt)){if(p.count<1||p.nextNumber<1||p.nextNumber>p.count||p.installmentCents<0)issues.push(`Parcelamento "${p.description}": sequência inválida`)}
  for(const c of state.cards.filter(x=>!x.deletedAt)){
    if(c.limitCents<=0||c.closingDay<1||c.closingDay>31||c.dueDay<1||c.dueDay>31)issues.push(`Cartão "${c.name}": configuração inválida`);
    for(const cycle of Object.keys(c.invoicePaid||{})){
      if(!c.invoicePaid[cycle])continue;
      const payment=c.invoicePayments?.[cycle];
      if(!payment)issues.push(`Cartão "${c.name}": pagamento ${cycle} sem valor congelado`);
      else{
        const current=C.cardStatement(state,c,cycle).totalCents;
        if(Number(payment.amountCents)!==Number(current))issues.push(`Cartão "${c.name}": fatura paga ${cycle} mudou depois do pagamento (pago ${C.money(payment.amountCents)}, cálculo atual ${C.money(current)})`);
      }
    }
  }
  const vaults=vaultItems(),vaultIds=new Set();
  for(const v of vaults){if(!v.id||vaultIds.has(v.id))issues.push('Cofres: ID ausente ou duplicado');vaultIds.add(v.id);if(!v.name||Number(v.savedCents)<0||Number(v.targetCents)<0)issues.push(`Cofre "${v.name||'sem nome'}": valores inválidos`)}
  for(const m of state.meta.filter(x=>String(x.key||'').startsWith(META_MONTH_CLOSE_PREFIX))){
    if(!/^\d{4}-\d{2}$/.test(m.month||'')||!m.summary||!Array.isArray(m.rows))issues.push(`Fechamento ${m.month||m.key}: snapshot inválido`);
  }
  const bal=liveBalanceRecord();if(bal&&!Number.isFinite(Number(bal.amountCents)))issues.push('Saldo disponível inválido');
  const el=$('#auditStatus');el.classList.remove('ok','warn');
  if(issues.length){el.classList.add('warn');el.textContent=`${issues.length} ponto${issues.length===1?'':'s'} para revisar: ${issues.slice(0,3).join(' • ')}${issues.length>3?' • …':''}`}
  else{el.classList.add('ok');el.textContent='Tudo certo: vínculos, IDs, valores e pagamentos passaram na verificação.'}
  return issues;
}

function bind(){
  fillSelect($('#txIncomeSource'),incomeSources);bindMoneyInputs();syncAppMeta();
  $$('[data-view]').forEach(b=>b.onclick=()=>navigate(b.dataset.view));$$('[data-close]').forEach(b=>b.onclick=()=>close(b.dataset.close));
  $('#settingsBtn').onclick=()=>navigate('settings');$('#fab').onclick=()=>open('addDialog');
  $('#balanceHero').onclick=openBalanceDialog;$('#availableMetricBtn').onclick=openBalanceDialog;$('#balanceForm').onsubmit=saveBalance;$('#balanceAmount').addEventListener('input',updateBalanceComparison);if($('#reservedMetricBtn'))$('#reservedMetricBtn').onclick=openVaults;
  $('#newExpense').onclick=()=>{close('addDialog');resetTxForm('expense');open('txDialog');setTimeout(()=>$('#txAmount').focus(),80)};
  $('#newIncome').onclick=()=>{close('addDialog');resetTxForm('income');open('txDialog');setTimeout(()=>$('#txAmount').focus(),80)};
  $('#txForm').onsubmit=saveTx;$$('[data-payment]').forEach(b=>b.onclick=()=>syncPaymentUI(b.dataset.payment));
  $('#txInstallmentCheck').onchange=()=>$('#txInstallmentFields').classList.toggle('hidden',!$('#txInstallmentCheck').checked);

  $('#newInstallment').onclick=()=>{close('addDialog');$('#instForm').reset();$('#instForm').dataset.amountMode='per';$('#instEditId').value='';$('#instDialogTitle').textContent='Conta / dívida';$('#instStart').value=C.ymd();$('#instCount').value=2;$('#instNextNumber').value=1;$('#instIsParcelled').checked=false;syncInstallmentMode();open('instDialog');setTimeout(()=>$('#instTotal').focus(),80)};
  $('#instForm').onsubmit=saveInstallment;$('#instTotal').oninput=updateInstPreview;$('#instCount').oninput=updateInstPreview;$('#instNextNumber').oninput=updateInstPreview;$('#instIsParcelled').onchange=syncInstallmentMode;

  $('#newRecurring').onclick=()=>{close('addDialog');$('#recEditId').value='';$('#recDialogTitle').textContent='Conta recorrente';$('#recForm').reset();$('#recStart').value=C.ymd();open('recDialog')};$('#recForm').onsubmit=saveRecurring;
  $('#newInvestment').onclick=()=>{close('addDialog');$('#investmentForm').reset();$('#investmentEditId').value='';$('#investmentDate').value=C.ymd();open('investmentDialog');setTimeout(()=>$('#investmentAmount').focus(),80)};$('#investmentForm').onsubmit=saveInvestment;
  $('#newCardInvoice').onclick=()=>{close('addDialog');fillInvoiceCards();$('#invoiceDueDate').value=C.ymd();open('invoiceDialog')};$('#invoiceForm').onsubmit=saveClosedInvoice;
  $('#homeAddCard').onclick=openNewCard;$('#newCardBtn').onclick=openNewCard;$('#cardForm').onsubmit=saveCard;

  $('#homePrevMonth').onclick=()=>{currentMonth=C.ym(C.addMonths(currentMonth+'-01',-1));renderHome()};$('#homeNextMonth').onclick=()=>{currentMonth=C.ym(C.addMonths(currentMonth+'-01',1));renderHome()};$('#homeCurrentMonth').onclick=()=>{currentMonth=C.ym(C.ymd());renderHome()};if($('#analysisPrevMonth'))$('#analysisPrevMonth').onclick=()=>{currentMonth=C.ym(C.addMonths(currentMonth+'-01',-1));renderAnalysis()};if($('#analysisNextMonth'))$('#analysisNextMonth').onclick=()=>{currentMonth=C.ym(C.addMonths(currentMonth+'-01',1));renderAnalysis()};
  $('#prevMonth').onclick=()=>{currentMonth=C.ym(C.addMonths(currentMonth+'-01',-1));renderMovements()};$('#nextMonth').onclick=()=>{currentMonth=C.ym(C.addMonths(currentMonth+'-01',1));renderMovements()};
  $('#movementSearch').oninput=e=>{movementSearch=e.target.value;renderMovements()};$$('[data-movement-filter]').forEach(b=>b.onclick=()=>{movementFilter=b.dataset.movementFilter;movementCard='all';$$('[data-movement-filter]').forEach(x=>x.classList.toggle('active',x===b));renderMovements()});$('#movementCardFilter').onchange=e=>{movementCard=e.target.value;renderMovements()};

  $('#manageRecurringBtn').onclick=()=>showList('recurring');$('#manageInstallmentsBtn').onclick=()=>showList('installments');$('#manageInvestmentsBtn').onclick=showInvestments;if($('#manageVaultsBtn'))$('#manageVaultsBtn').onclick=openVaults;$('#manageCardsBtn').onclick=showCards;
  $('#setPinBtn').onclick=setPin;$('#removePinBtn').onclick=removePin;$('#lockNowBtn').onclick=lockApp;$('#unlockBtn').onclick=unlockApp;$('#unlockPin').onkeydown=e=>{if(e.key==='Enter')unlockApp()};
  $('#exportBtn').onclick=exportBackup;$('#importBtn').onclick=()=>$('#importFile').click();$('#importFile').onchange=e=>e.target.files[0]&&importBackup(e.target.files[0]);$('#runAuditBtn').onclick=runIntegrityAudit;
  if($('#openVaultsBtn'))$('#openVaultsBtn').onclick=openVaults;if($('#vaultForm'))$('#vaultForm').onsubmit=saveVault;
  if($('#openSimulatorBtn'))$('#openSimulatorBtn').onclick=openSimulator;if($('#simType'))$('#simType').onchange=syncSimulatorFields;if($('#simulatorForm'))$('#simulatorForm').onsubmit=runSimulator;
}

(async()=>{
  db=await openDB();
  await loadState();
  await migrateV180();
  await loadState();
  bind();updatePinStatus();refreshCardSelects();renderHome();renderBackupStatus();
  document.body.dataset.appReady='1';if(pinConfig())lockApp();
  if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js?v=1.9.1',{updateViaCache:'none'}).catch(console.warn);
})().catch(e=>{console.error('BOOT_FATAL',e);document.body.dataset.appReady='0';alert('O Finance OS não conseguiu iniciar. Seus dados locais permanecem no aparelho. Atualize para a correção mais recente.')});
