// Play tickets are opaque capabilities issued after owner-token authentication.
// Never accept a nickname, client flag, account id or decoded client JSON as proof.
export class AccountAccess {
  constructor({endpoint='https://amazing-fenglisu-72d040.netlify.app/api/arena-account',fetcher=fetch,now=Date.now}={}) {
    const url=new URL(endpoint);
    if(url.protocol!=='https:'&&!(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&url.protocol==='http:'))throw new Error('Unsafe account verification endpoint');
    this.endpoint=url.href;this.fetcher=fetcher;this.now=now;this.sessions=new WeakMap();
  }
  current(socket){const s=this.sessions.get(socket);return s&&s.allowed&&s.expiresAt>this.now()?s:null;}
  forget(socket){this.sessions.delete(socket);}
  async verify(socket,ticket,{refresh=false}={}) {
    if(!/^[a-zA-Z0-9_-]{40,256}$/.test(String(ticket||'')))return {allowed:false,code:'ACCOUNT_AUTH_REQUIRED'};
    const previous=this.sessions.get(socket);
    if(previous?.pending){
      // A scheduled recheck and the browser's renewal can arrive together.
      // Coalesce the same ticket; serialize a new ticket behind the old check
      // so its longer expiry is not silently lost.
      if(previous.checkingTicket===ticket)return previous.promise;
      if((previous.waiters||0)>=2)return {allowed:false,code:'ACCOUNT_CHECK_PENDING'};
      previous.waiters=(previous.waiters||0)+1;
      const result=await previous.promise;
      if(!result.allowed)return result;
      if(this.sessions.get(socket)?.epoch!==previous.epoch)return {allowed:false,code:'ACCOUNT_CHECK_SUPERSEDED'};
      return this.verify(socket,ticket,{refresh:true});
    }
    const pending={...previous,epoch:previous?.epoch||{},pending:true,checkingTicket:ticket,waiters:0};this.sessions.set(socket,pending);
    pending.promise=this.performVerification(socket,ticket,pending,previous,refresh);
    return pending.promise;
  }
  async performVerification(socket,ticket,pending,previous,refresh) {
    try {
      const response=await this.fetcher(this.endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'verifyTicket',ticket}),signal:AbortSignal.timeout(6000),redirect:'error'});
      const data=await response.json();
      if(this.sessions.get(socket)!==pending)return {allowed:false,code:'ACCOUNT_CHECK_SUPERSEDED'};
      if(!response.ok||data.allowed!==true){this.sessions.delete(socket);return {allowed:false,code:data.code==='ACCOUNT_BANNED'?'ACCOUNT_BANNED':response.status===401?'ACCOUNT_AUTH_REQUIRED':'ACCOUNT_SERVICE_UNAVAILABLE',...(data.code==='ACCOUNT_BANNED'?{ban:data.ban}:{} )};}
      if(!/^[a-zA-Z0-9_-]{8,80}$/.test(String(data.playerId||''))||!Number.isFinite(data.expiresAt)||data.expiresAt<=this.now()||data.expiresAt>this.now()+360000)throw new Error('Invalid account verification response');
      if(previous?.playerId&&previous.playerId!==data.playerId){this.sessions.delete(socket);return {allowed:false,code:'ACCOUNT_SUBJECT_MISMATCH'};}
      const session={allowed:true,playerId:data.playerId,nickname:String(data.nickname||'Gladiator').replace(/[<>\u0000-\u001f]/g,'').slice(0,24),expiresAt:data.expiresAt,ticket,checkedAt:this.now(),pending:false,epoch:pending.epoch};
      this.sessions.set(socket,session);return session;
    } catch {
      if(this.sessions.get(socket)===pending)this.sessions.delete(socket);
      return {allowed:false,code:'ACCOUNT_SERVICE_UNAVAILABLE'};
    }
  }
  needsCheck(socket){const s=this.sessions.get(socket);return !!s&&!s.pending&&this.now()-s.checkedAt>=30000;}
  async recheck(socket){const s=this.sessions.get(socket);if(!s)return {allowed:false,code:'ACCOUNT_AUTH_REQUIRED'};return this.verify(socket,s.ticket,{refresh:true});}
}
