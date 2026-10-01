(function(root){
  'use strict';

  const SCHEMA_VERSION=4;
  const APP_NAME='Finance OS';
  const pad=n=>String(n).padStart(2,'0');
  const uid=(p='id')=>`${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;
  const live=x=>x&&!x.deletedAt;

  function toCents(v){
    if(Number.isInteger(v)) return v;
    let s=String(v??'').trim().replace(/R\$/gi,'').replace(/\s/g,'');
    if(!s) return 0;
    if(s.includes(',')&&s.includes('.')) s=s.replace(/\./g,'').replace(',','.');
    else if(s.includes(',')) s=s.replace(',','.');
    const n=Number(s);
    return Number.isFinite(n)?Math.round(n*100):0;
  }

  function money(c){return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format((Number(c)||0)/100)}
  function ym(d){return String(d||'').slice(0,7)}
  function ymd(d=new Date()){return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`}
  function addMonths(s,n){
    const [y,m,d]=s.split('-').map(Number),x=new Date(y,m-1+n,1),last=new Date(x.getFullYear(),x.getMonth()+1,0).getDate();
    return `${x.getFullYear()}-${pad(x.getMonth()+1)}-${pad(Math.min(d,last))}`;
  }
  function monthEnd(k){const [y,m]=k.split('-').map(Number);return `${y}-${pad(m)}-${pad(new Date(y,m,0).getDate())}`}

  function installmentSchedule(p){
    if(!live(p)) return [];
    const count=Math.max(1,Number(p.count)||1);
    const next=Math.max(1,Math.min(count,Number(p.nextNumber)||1));
    const perMode=p.amountMode==='per_installment';
    const total=Number(p.totalCents)||0;
    const per=Number(p.installmentCents)||0;
    const base=perMode?per:Math.floor(total/count);
    const rows=[];
    for(let i=next;i<=count;i++){
      const amount=perMode?per:(i===count?total-(base*(count-1)):base);
      rows.push({
        id:`${p.id}_${i}`,purchaseId:p.id,installmentNumber:i,description:p.description,
        categoryId:p.categoryId,subcategory:p.subcategory||'',cardId:p.cardId||'',
        date:addMonths(p.startDate,i-next),amountCents:amount,type:'expense',status:'planned',number:i,count
      });
    }
    return rows;
  }

  function firstWeekdayOfMonth(k,weekday){
    const [y,m]=k.split('-').map(Number),d=new Date(y,m-1,1),delta=(weekday-d.getDay()+7)%7;
    return `${k}-${pad(1+delta)}`;
  }

  function recurringOccurrence(r,k){
    if(!live(r)||r.active===false||!r.startDate||k<ym(r.startDate)||(r.endDate&&k>ym(r.endDate))) return null;
    const ov=r.monthOverrides?.[k]||{};
    let date;
    if(ov.date) date=ov.date;
    else if(r.recurrenceRule==='first_monday') date=firstWeekdayOfMonth(k,1);
    else {
      const day=Math.min(Number(r.day)||1,Number(monthEnd(k).slice(8)));
      date=`${k}-${pad(day)}`;
    }
    // Boundaries are date-precise, not merely month-precise.
    if(date<r.startDate) return null;
    if(r.endDate&&date>r.endDate) return null;
    const amount=Number.isFinite(Number(ov.amountCents))?Number(ov.amountCents):Number(r.amountCents)||0;
    return {
      id:`rec_${r.id}_${k}`,recurringId:r.id,description:r.description,categoryId:r.categoryId,
      subcategory:r.subcategory||'',variable:!!r.variable,date,amountCents:amount,type:r.type||'expense',
      status:'planned',needsValue:!!r.variable&&amount<=0
    };
  }

  function monthProjection(data,k,today=ymd()){
    const tx=(data.transactions||[]).filter(live).filter(t=>ym(t.date)===k);
    const rec=(data.recurring||[]).map(r=>recurringOccurrence(r,k)).filter(Boolean);
    const ins=(data.installments||[]).filter(live).flatMap(installmentSchedule).filter(x=>ym(x.date)===k);
    const paidRecurring=new Set(tx.filter(t=>t.recurringId).map(t=>t.recurringId));
    const paidInstallments=new Set(tx.filter(t=>t.purchaseId&&t.installmentNumber).map(t=>`${t.purchaseId}:${t.installmentNumber}`));
    const planned=[
      ...rec.filter(x=>!paidRecurring.has(x.recurringId)),
      ...ins.filter(x=>!paidInstallments.has(`${x.purchaseId}:${x.installmentNumber}`))
    ];
    const sum=(rows,type)=>rows.filter(x=>x.type===type).reduce((s,x)=>s+(Number(x.amountCents)||0),0);
    const incomeActual=sum(tx,'income'),expenseActual=sum(tx,'expense');
    const investmentActual=tx.filter(x=>x.type==='investment'&&x.status!=='planned').reduce((s,x)=>s+(Number(x.amountCents)||0),0);
    const incomePlanned=sum(planned,'income'),expensePlanned=sum(planned,'expense');
    const investmentPlanned=sum(planned,'investment')+tx.filter(x=>x.type==='investment'&&x.status==='planned').reduce((s,x)=>s+(Number(x.amountCents)||0),0);
    return {
      incomeActual,expenseActual,investmentActual,incomePlanned,expensePlanned,investmentPlanned,
      totalIncome:incomeActual+incomePlanned,totalExpense:expenseActual+expensePlanned,totalInvestment:investmentActual+investmentPlanned,
      free:incomeActual+incomePlanned-expenseActual-expensePlanned-investmentActual-investmentPlanned,
      remainingCommitments:planned.filter(x=>['expense','investment'].includes(x.type)&&(k>ym(today)||x.date>=today)).reduce((s,x)=>s+(Number(x.amountCents)||0),0),
      transactions:tx,planned
    };
  }

  function categoryBreakdown(data,k){
    const p=monthProjection(data,k),map=new Map();
    for(const x of [...p.transactions,...p.planned].filter(x=>x.type==='expense'&&!x.historyOnly)){
      const key=x.categoryId||'outros';map.set(key,(map.get(key)||0)+(Number(x.amountCents)||0));
    }
    return [...map].map(([categoryId,amountCents])=>({categoryId,amountCents})).sort((a,b)=>b.amountCents-a.amountCents);
  }

  function remainingInstallments(p,asOf=ymd()){
    const s=installmentSchedule(p).filter(x=>x.date>=ym(asOf)+'-01');
    return {count:s.length,totalCents:s.reduce((a,b)=>a+(Number(b.amountCents)||0),0),endDate:s.at(-1)?.date||''};
  }

  function cardTermsForCycle(card,k){
    const history=Array.isArray(card?.termsHistory)?card.termsHistory:[];
    const eligible=history.filter(x=>x&&x.effectiveCycle&&x.effectiveCycle<=k).sort((a,b)=>a.effectiveCycle.localeCompare(b.effectiveCycle));
    const t=eligible.at(-1);
    return {
      closingDay:Number(t?.closingDay??card?.closingDay)||31,
      dueDay:Number(t?.dueDay??card?.dueDay)||1
    };
  }

  function cardCycleDate(purchaseDate,card){
    if(!card) return purchaseDate;
    const terms=cardTermsForCycle(card,ym(purchaseDate));
    const d=Number(purchaseDate.slice(8));
    return d>terms.closingDay?addMonths(purchaseDate,1):purchaseDate;
  }

  function cardCloseDateForCycle(k,card){
    const terms=cardTermsForCycle(card,k),day=Math.min(terms.closingDay,Number(monthEnd(k).slice(8)));
    return `${k}-${pad(day)}`;
  }

  function cardCloseDateForDueDate(dueDate,card){
    const dueK=ym(dueDate),close=Math.max(1,Math.min(31,Number(card?.closingDay)||31)),due=Math.max(1,Math.min(31,Number(card?.dueDay)||1));
    const closeMonth=due<=close?addMonths(dueK+'-01',-1).slice(0,7):dueK;
    const day=Math.min(close,Number(monthEnd(closeMonth).slice(8)));
    return `${closeMonth}-${pad(day)}`;
  }

  function cardDueDateForCycle(k,card){
    const [y,m]=k.split('-').map(Number);
    const terms=cardTermsForCycle(card,k),close=terms.closingDay,due=terms.dueDay;
    const base=`${y}-${pad(m)}-01`;
    const target=due<=close?addMonths(base,1):base;
    const tk=ym(target),day=Math.min(due,Number(monthEnd(tk).slice(8)));
    return `${tk}-${pad(day)}`;
  }

  function invoiceIsClosed(card,cycle,today=ymd(),dueDate=''){
    if(invoiceIsPaid(card,cycle)) return true;
    const marker=card?.invoiceClosed?.[cycle];
    // v1.8.1: only explicit manual-close records override the calendar.
    // Legacy boolean flags were created by old "adjust invoice" flows and can be stale
    // after the card closing day is corrected, so they are intentionally ignored here.
    if(marker&&typeof marker==='object'&&marker.manual===true) return true;
    // For the displayed invoice, the current card settings are authoritative. This makes
    // changing "fecha dia" synchronize the open/closed badge immediately, even when an
    // older cycle key still carries the amount/override for the same due month.
    const closeDate=dueDate?cardCloseDateForDueDate(dueDate,card):cardCloseDateForCycle(cycle,card);
    return today>=closeDate;
  }

  function cardStatement(data,card,k){
    const tx=(data.transactions||[]).filter(live).filter(t=>t.type==='expense'&&t.cardId===card.id&&!t.historyOnly&&ym(cardCycleDate(t.date,card))===k);
    const ins=(data.installments||[]).filter(live).flatMap(installmentSchedule).filter(x=>x.cardId===card.id&&ym(cardCycleDate(x.date,card))===k);
    const overriddenInstallments=new Set(tx.filter(t=>t.purchaseId&&t.installmentNumber).map(t=>`${t.purchaseId}:${t.installmentNumber}`));
    const planned=ins.filter(x=>!overriddenInstallments.has(`${x.purchaseId}:${x.installmentNumber}`));
    const calculatedCents=[...tx,...planned].reduce((s,x)=>s+(Number(x.amountCents)||0),0);
    const override=card.invoiceOverrides&&Number.isFinite(Number(card.invoiceOverrides[k]))?Number(card.invoiceOverrides[k]):null;
    const totalCents=override===null?calculatedCents:override;
    return {
      transactions:tx,planned,calculatedCents,totalCents,adjustmentCents:totalCents-calculatedCents,
      overridden:override!==null,dueDate:cardDueDateForCycle(k,card)
    };
  }

  function cardCycleKeys(data,card){
    const keys=new Set([
      ...Object.keys(card.invoiceOverrides||{}),...Object.keys(card.invoiceClosed||{}),
      ...Object.keys(card.invoicePaid||{}),...Object.keys(card.invoicePayments||{})
    ]);
    for(const t of (data.transactions||[]).filter(live).filter(x=>x.type==='expense'&&x.cardId===card.id&&!x.historyOnly)) keys.add(ym(cardCycleDate(t.date,card)));
    for(const x of (data.installments||[]).filter(live).flatMap(installmentSchedule).filter(x=>x.cardId===card.id)) keys.add(ym(cardCycleDate(x.date,card)));
    return [...keys].filter(Boolean).sort();
  }

  function invoiceIsPaid(card,cycle){return !!(card?.invoicePayments?.[cycle]||card?.invoicePaid?.[cycle])}
  function invoicePaidAmount(card,cycle,fallback=0){
    const rec=card?.invoicePayments?.[cycle];
    return rec&&Number.isFinite(Number(rec.amountCents))?Number(rec.amountCents):(invoiceIsPaid(card,cycle)?Number(fallback)||0:0);
  }

  function cardOutstandingCents(data,card){
    let total=0;
    for(const cycle of cardCycleKeys(data,card)){
      if(invoiceIsPaid(card,cycle)) continue;
      total+=Math.max(0,Number(cardStatement(data,card,cycle).totalCents)||0);
    }
    return total;
  }

  async function sha256Hex(text){
    const bytes=new TextEncoder().encode(text),digest=await crypto.subtle.digest('SHA-256',bytes);
    return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');
  }

  async function createBackupEnvelope(data,exportedAt){
    const p={app:APP_NAME,backupVersion:3,schemaVersion:SCHEMA_VERSION,exportedAt:exportedAt||new Date().toISOString(),data};
    return {...p,checksum:await sha256Hex(JSON.stringify(p))};
  }

  async function validateBackupEnvelope(input){
    const errors=[];
    if(!input||input.app!==APP_NAME) errors.push('Arquivo não pertence ao Finance OS');
    if(![1,2,3].includes(input?.backupVersion)) errors.push('Versão de backup não suportada');
    const d=input?.data;
    const required=['transactions','recurring','installments','cards'];
    if(!d||required.some(k=>!Array.isArray(d[k]))) errors.push('Estrutura de dados incompleta');
    if(input?.backupVersion===3&&!Array.isArray(d?.meta)) errors.push('Metadados do backup estão ausentes');
    if(!errors.length){
      for(const key of required){
        const ids=new Set();
        for(const row of d[key]){
          if(!row||typeof row!=='object'){errors.push(`Registro inválido em ${key}`);break;}
          if(row.id){if(ids.has(row.id)){errors.push(`IDs duplicados em ${key}`);break;}ids.add(row.id);}
        }
      }
    }
    if(!errors.length&&input.checksum){
      const p={app:input.app,backupVersion:input.backupVersion,schemaVersion:input.schemaVersion,exportedAt:input.exportedAt,data:input.data};
      if(await sha256Hex(JSON.stringify(p))!==input.checksum) errors.push('Checksum inválido');
    }
    const normalized=d?{...d,meta:Array.isArray(d.meta)?d.meta:[]}:null;
    return {ok:!errors.length,errors,data:normalized};
  }

  const api={
    SCHEMA_VERSION,APP_NAME,uid,toCents,money,ym,ymd,addMonths,monthEnd,
    installmentSchedule,recurringOccurrence,monthProjection,categoryBreakdown,remainingInstallments,firstWeekdayOfMonth,
    cardTermsForCycle,cardCycleDate,cardCloseDateForCycle,cardCloseDateForDueDate,cardDueDateForCycle,cardStatement,cardCycleKeys,invoiceIsPaid,invoiceIsClosed,invoicePaidAmount,cardOutstandingCents,
    createBackupEnvelope,validateBackupEnvelope
  };
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
  root.FinanceCore=api;
})(typeof globalThis!=='undefined'?globalThis:this);
