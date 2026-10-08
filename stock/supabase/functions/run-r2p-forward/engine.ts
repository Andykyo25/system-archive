// Forward paper execution: no broker orders. Append-only signals; replay one
// completed market session at a time. Fixed policy is part of the version.
export const POLICY = Object.freeze({version:'R2p-forward-v1',capital:1_000_000,
  allocation:0.1,maxPositions:10,lot:1000,fee:0.001425,tax:0.003,slippage:0.001,tp:0.1,maxDays:20});
export interface Signal {date:string;symbol:string;stop:number;close:number;rank:number;factor:number}
export interface Bar {symbol:string;date:string;open:number;high:number;low:number;close:number;volume:number;factor:number}
export interface Position {signal:Signal;entryDate:string;entry:number;qty:number;cost:number;held:number;exitPending:boolean;mark:number}
export interface Trade {signalDate:string;symbol:string;entryDate:string|null;exitDate:string|null;entry:number|null;exit:number|null;qty:number;net:number|null;reason:string}
export interface ForwardState {version:string;lastDate:string|null;cash:number;positions:Position[];trades:Trade[];equity:number;peak:number;maxDrawdown:number;benchmarkStart:number|null;benchmark:number|null;benchmarkFactor?:number}
export function initialState():ForwardState {return {version:POLICY.version,lastDate:null,cash:POLICY.capital,positions:[],trades:[],equity:POLICY.capital,peak:POLICY.capital,maxDrawdown:0,benchmarkStart:null,benchmark:null};}
const valid=(b:Bar|undefined):b is Bar=>!!b && [b.open,b.high,b.low,b.close,b.factor].every(x=>Number.isFinite(x)&&x>0) && Number.isFinite(b.volume) && b.volume>=0 && b.low<=Math.min(b.open,b.close) && b.high>=Math.max(b.open,b.close);
export function forwardSession(previous:ForwardState,date:string,previousDate:string|null,signals:Signal[],bars:Bar[]):ForwardState {
  if(previous.version!==POLICY.version) throw new Error('strategy version mismatch');
  if(previous.lastDate && date<=previous.lastDate) throw new Error('session already committed');
  const state=structuredClone(previous),bySymbol=new Map(bars.map(b=>[b.symbol,b]));
  const benchmark=bySymbol.get('0050');
  if(!valid(benchmark)) throw new Error('benchmark session unavailable');
  if(state.benchmarkFactor!=null && Math.abs(state.benchmarkFactor-benchmark.factor)>1e-8) throw new Error('benchmark corporate action requires reconciliation');
  state.benchmarkFactor=benchmark.factor;
  for(const p of state.positions) if(!valid(bySymbol.get(p.signal.symbol))) throw new Error('held symbol missing OHLC; ledger paused');
  // Use factor ratios from the current immutable market snapshot. A factor
  // change is not handled by inventing a tradable price or a quantity change.
  // Freeze and pause affected positions until corporate action is reconciled.
  for(const p of state.positions){const b=bySymbol.get(p.signal.symbol)!;if(Math.abs(b.factor-p.signal.factor)>1e-8) throw new Error('corporate action requires reconciliation');}
  const kept:Position[]=[];
  for(const p of state.positions){
    const b=bySymbol.get(p.signal.symbol)!;
    const previousMark=p.mark;
    p.held++;p.mark=b.close;
    let exit:number|null=null,reason='';
    // Flat low bars at the daily lower limit: conservative deferred sale.
    const locked=b.open===b.high && b.high===b.low && b.close<=previousMark*0.905;
    if(p.exitPending){exit=b.open;reason='deferred_stop';}
    else if(b.open<=p.signal.stop){exit=b.open;reason='gap_stop';}
    else if(b.low<=p.signal.stop){exit=p.signal.stop;reason='stop';}
    else if(b.open>=p.entry*(1+POLICY.tp)){exit=b.open;reason='gap_take_profit';}
    else if(b.high>=p.entry*(1+POLICY.tp)){exit=p.entry*(1+POLICY.tp);reason='take_profit';}
    else if(p.held>=POLICY.maxDays){exit=b.close;reason='time_exit';}
    if(exit!=null && (b.volume===0 || locked)){p.exitPending=true;kept.push(p);continue;}
    if(exit==null){kept.push(p);continue;}
    const fill=exit*(1-POLICY.slippage),proceeds=fill*p.qty*(1-POLICY.fee-POLICY.tax);
    state.cash+=proceeds;
    state.trades.push({signalDate:p.signal.date,symbol:p.signal.symbol,entryDate:p.entryDate,exitDate:date,entry:p.entry,exit:fill,qty:p.qty,net:proceeds-p.cost,reason});
  }
  state.positions=kept;
  // Entry is T+1 CLOSE. Exit proceeds for that session are available at close;
  // stop/TP checks never use the entry day's high for a just-opened position.
  for(const s of signals.filter(s=>s.date===previousDate).sort((a,b)=>a.rank-b.rank || a.symbol.localeCompare(b.symbol))){
    const b=bySymbol.get(s.symbol);
    let reason:string|null=null;
    if(!valid(b)) throw new Error('entry symbol missing OHLC; ledger paused');
    if(!Number.isFinite(s.stop)||s.stop<=0||s.stop>=b.close) reason='invalid_stop';
    else if(b.factor!==s.factor) reason='corporate_action_entry';
    else if(b.low<=s.stop) reason='entry_day_stop';
    else if(b.volume===0 || (b.open===b.high && b.high===b.low)) reason='entry_locked_or_suspended';
    else if(state.positions.some(p=>p.signal.symbol===s.symbol)) reason='already_held';
    else if(state.positions.length>=POLICY.maxPositions) reason='position_limit';
    const fill=b.close*(1+POLICY.slippage);
    const qty=Math.floor(Math.min(POLICY.capital*POLICY.allocation,state.cash)/(fill*(1+POLICY.fee))/POLICY.lot)*POLICY.lot;
    if(qty<1 && !reason) reason='insufficient_cash_or_lot';
    if(reason){state.trades.push({signalDate:s.date,symbol:s.symbol,entryDate:null,exitDate:null,entry:null,exit:null,qty:0,net:null,reason});continue;}
    const cost=qty*fill*(1+POLICY.fee);
    state.cash-=cost;
    state.positions.push({signal:s,entryDate:date,entry:fill,qty,cost,held:1,exitPending:false,mark:b.close});
  }
  const benchmarkValue=benchmark.close*benchmark.factor;
  state.benchmarkStart??=benchmarkValue;state.benchmark=100*(benchmarkValue/state.benchmarkStart-1);
  state.equity=state.cash+state.positions.reduce((sum,p)=>sum+p.qty*p.mark,0);
  state.peak=Math.max(state.peak,state.equity);
  state.maxDrawdown=Math.min(state.maxDrawdown,100*(state.equity/state.peak-1));
  state.lastDate=date;
  if(state.cash< -0.01 || !Number.isFinite(state.equity)) throw new Error('invalid cash ledger');
  return state;
}
