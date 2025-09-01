// Banner
(function(){
  var bs = document.getElementById('bootStatus');
  if (bs) bs.textContent = 'HTML caricato — avvio JS…';
})();

// Debug helper
function debug(msg){
  try {
    var box = document.getElementById('debugBox');
    if (!box) return;
    var line = document.createElement('div');
    line.textContent = msg;
    box.appendChild(line);
    console.log('[ASTA]', msg);
  } catch(e){}
}

// === Firebase
var firebaseConfig = {
  apiKey: "AIzaSyBoMl0n8V1qk6hYB7HtPBmQy8JY1OxnGec",
  authDomain: "fanta-wagner.firebaseapp.com",
  databaseURL: "https://fanta-wagner-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "fanta-wagner",
  storageBucket: "fanta-wagner.firebasestorage.app",
  messagingSenderId: "97053268763",
  appId: "1:97053268763:web:95ec2acd4f41b65a9091be",
  measurementId: "G-Y0BB797KJG"
};
firebase.initializeApp(firebaseConfig);
debug('firebase init ok');
const db = firebase.database();

// ping
db.ref('__ping').set(Date.now()).then(()=>debug('rtdb write: ok')).catch(err=>debug('rtdb write ERROR: ' + (err && err.message || String(err))));

// Refs
const auctionsRef     = db.ref('auctions');
const assignmentsRef  = db.ref('assignments');
const participantsRef = db.ref('participants');
const settingsRef     = db.ref('settings');
const timerMinutesRef = db.ref('settings/timerMinutes');
const extendSecondsRef= db.ref('settings/extendSeconds');

const START_BUDGET = 500;

// Stato
var rows = [];
var headers = [];
var filterValue = '';
var participants = {};
var assignmentsCache = [];
var auctionsCache = {}; // key -> auction
var openPlayersSet = new Set();
var closedPlayersSet = new Set();
var expiredHandled = new Set(); // per evitare doppie chiusure

// Impostazioni locali (default)
var timerMinutes = 2;   // durata nuove aste
var extendSeconds = 15; // estensione sotto 60s

function el(id){ return document.getElementById(id); }
function toNumber(v){ var n = Number(String(v||'').replace(/[^0-9.-]/g,'')); return isNaN(n)?0:n; }
function norm(s){ return String(s||'').trim().toLowerCase(); }
function now(){ return Date.now(); }
function fmtMMSS(ms){
  if (ms < 0) ms = 0;
  var s = Math.floor(ms/1000);
  var m = Math.floor(s/60);
  var r = s % 60;
  return (m<10?'0':'')+m+':'+(r<10?'0':'')+r;
}

// === SETTINGS (sync UI <-> RTDB)
function bindSettingsUI(){
  var minInput = el('timerMinutes');
  var extInput = el('extendSeconds');

  timerMinutesRef.on('value', function(s){
    var v = Number(s.val());
    if (!isNaN(v) && v>0) { timerMinutes = v; if (minInput) minInput.value = v; }
  });
  extendSecondsRef.on('value', function(s){
    var v = Number(s.val());
    if (!isNaN(v) && v>=0) { extendSeconds = v; if (extInput) extInput.value = v; }
  });

  if (minInput) {
    minInput.addEventListener('change', function(){
      var v = Math.max(1, parseInt(minInput.value||timerMinutes, 10));
      timerMinutesRef.set(v);
    });
  }
  if (extInput) {
    extInput.addEventListener('change', function(){
      var v = Math.max(0, parseInt(extInput.value||extendSeconds, 10));
      extendSecondsRef.set(v);
    });
  }

  settingsRef.once('value').then(function(s){
    var val = s.val()||{};
    if (typeof val.timerMinutes === 'undefined') timerMinutesRef.set(timerMinutes);
    if (typeof val.extendSeconds === 'undefined') extendSecondsRef.set(extendSeconds);
  });
}

// === CSV loader
function loadCSV(){
  var pill = el('csvStatus');
  try {
    var text = (window.__csvTextCache = window.__csvTextCache || document.getElementById('csv')?.value || '');
    if (!text) {
      fetch('listone.csv?cacheBust=' + Date.now())
        .then(r=>r.text())
        .then(t=>{ window.__csvTextCache = t; el('csvStatus').textContent='Caricato'; parseCSV(t); renderTable(); })
        .catch(()=>{ el('csvStatus').textContent='Errore'; });
    } else {
      if (pill) pill.textContent='Caricato';
      parseCSV(text);
      renderTable();
    }
  } catch(e){
    if (pill) pill.textContent='Errore';
    debug('CSV load ERROR: ' + (e && e.message || String(e)));
  }
}
function parseCSV(text){
  rows = []; headers = [];
  var sep = ',';
  if (text.indexOf('\t')>-1 && text.indexOf(';')===-1 && text.indexOf(',')===-1) sep='\t';
  else if (text.indexOf(';')>-1 && text.indexOf(',')===-1) sep=';';
  var lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return;
  headers = lines[0].split(sep).map(function(h){ return h.trim(); });
  rows = lines.slice(1).map(function(line){
    var cols = line.split(sep);
    var obj = {}; headers.forEach(function(h,i){ obj[h] = (cols[i]||'').trim(); });
    return obj;
  });
}

// === Elenco giocatori (CSV)
function getField(obj, names){
  var map = {}; Object.keys(obj||{}).forEach(function(k){ map[norm(k)] = obj[k]; });
  for (var i=0;i<names.length;i++){ var k = norm(names[i]); if (k in map) return map[k]; }
  var vals = Object.values(obj||{}); return vals.length? vals[0]:'';
}
function isLockedPlayer(name){
  const n = norm(name);
  return openPlayersSet.has(n) || closedPlayersSet.has(n);
}

function renderTable(){
  var tbody = el('tbodyList'); if (!tbody) return; tbody.innerHTML='';
  var q = norm(filterValue);
  var filtered = rows.filter(function(r){ return norm(JSON.stringify(r)).includes(q); });
  if (!filtered.length){
    var tr0 = document.createElement('tr');
    tr0.innerHTML = '<td colspan="5" class="muted">Nessun giocatore trovato</td>';
    tbody.appendChild(tr0);
    return;
  }
  filtered.forEach(function(r, idx){
    var tr = document.createElement('tr');
    var nome = getField(r, ['Nome','Giocatore','Player']);
    var ruolo = getField(r, ['Ruolo','R','Role']);
    var squadra = getField(r, ['Squadra','Team','Club']);
    var quota = getField(r, ['Quotazione','quotazione','Quota','Prezzo']);
    var disabled = isLockedPlayer(nome);
    var label = disabled ? 'In asta' : 'Metti all’asta';
    var btn = disabled
      ? '<button class="btn sm" disabled>'+label+'</button>'
      : '<button class="btn primary sm" data-idx="'+idx+'">'+label+'</button>';
    tr.innerHTML =
      '<td>'+nome+'</td>'+
      '<td class="nowrap">'+ruolo+'</td>'+
      '<td>'+squadra+'</td>'+
      '<td class="nowrap">'+quota+'</td>'+
      '<td class="nowrap">'+btn+'</td>';
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('button[data-idx]').forEach(function(btn){
    btn.addEventListener('click', function(e){
      var i = Number(e.currentTarget.getAttribute('data-idx'));
      var r = rows[i];
      startAuctionFromRow(r);
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = 'In asta';
      e.currentTarget.classList.remove('primary');
    });
  });
}

// === Aste
function startAuctionFromRow(r){
  var player = getField(r, ['Nome','Giocatore','Player']);
  var role   = getField(r, ['Ruolo','R','Role']);
  var team   = getField(r, ['Squadra','Team','Club']);
  var quota  = getField(r, ['Quotazione','quotazione','Quota','Prezzo']);
  var startBid = toNumber(quota);
  if (isLockedPlayer(player)) return;

  // prendi il nome di chi apre
  var me = (document.getElementById('myName') && document.getElementById('myName').value.trim()) || 'Anonimo';

  var endAt = now() + Math.max(1, parseInt(timerMinutes,10)||1) * 60000;

  auctionsRef.push({
    player: player,
    role: role,
    team: team,
    bid: startBid,
    lastBidder: '',
    status: 'open',
    createdAt: now(),
    endAt: endAt,
    openedBy: me
  }, function(err){
    if (err) { debug('create auction ERROR: ' + err.message); }
  });
}

window.raiseBid = function(key, amount){
  var me = el('myName').value.trim() || 'Anonimo';
  var a = auctionsCache[key]; if (!a || a.status !== 'open') return;
  var next = toNumber(a.bid) + amount;

  var endAt = a.endAt || (a.createdAt ? a.createdAt + timerMinutes*60000 : now()+timerMinutes*60000);
  var remain = endAt - now();
  var patch = { bid: next, lastBidder: me };
  if (remain <= 60000 && extendSeconds > 0) {
    patch.endAt = endAt + (extendSeconds*1000);
  }
  db.ref('auctions/'+key).update(patch).catch(function(err){
    debug('raiseBid ERROR: ' + (err && err.message || String(err)));
  });
};

window.raiseManual = function(key){
  var me = el('myName').value.trim() || 'Anonimo';
  var inp = el('manualBid-'+key); if (!inp) return;
  var v = Math.max(0, parseInt(inp.value||0, 10));
  var a = auctionsCache[key];
  if (!a || a.status !== 'open') return;
  if (v <= Number(a.bid||0)) { alert('Offerta deve essere maggiore di quella attuale.'); return; }

  var endAt = a.endAt || (a.createdAt ? a.createdAt + timerMinutes*60000 : now()+timerMinutes*60000);
  var remain = endAt - now();
  var patch = { bid: v, lastBidder: me };
  if (remain <= 60000 && extendSeconds > 0) {
    patch.endAt = endAt + (extendSeconds*1000);
  }
  db.ref('auctions/'+key).update(patch).then(function(){
    inp.value = '';
  }).catch(function(err){
    debug('raiseManual ERROR: ' + (err && err.message || String(err)));
  });
};

// Auto-chiusura allo scadere
function handleExpiry(key, a){
  if (expiredHandled.has(key)) return;
  expiredHandled.add(key);
  if (a.lastBidder && toNumber(a.bid) > 0) {
    assignmentsRef.push({
      player: a.player, role: a.role, team: a.team,
      price: toNumber(a.bid), winner: a.lastBidder, at: now()
    }, function(err){
      if (err) { debug('auto-assign ERROR: ' + err.message); }
      db.ref('auctions/'+key).update({ status: 'closed' });
    });
  } else {
    db.ref('auctions/'+key).update({ status: 'closed' });
  }
}

// Reset (UI sbloccata)
window.resetOpenAuctions = function () {
  if (!confirm('Sicuro di voler cancellare TUTTE le aste APERTE?')) return;

  auctionsRef.once('value').then(function (s) {
    var val = s.val() || {};
    var updates = {};
    Object.keys(val).forEach(function (k) {
      if (val[k] && val[k].status === 'open') {
        updates['/auctions/' + k] = null;
        if (auctionsCache[k] && auctionsCache[k].status === 'open') delete auctionsCache[k];
      }
    });

    var doAfter = function () {
      openPlayersSet.clear();
      renderAuctions();
      renderTable();
      debug('Reset aste aperte: UI sbloccata');
    };

    if (Object.keys(updates).length) {
      db.ref().update(updates).then(doAfter).catch(doAfter);
    } else {
      doAfter();
    }
  });
};

window.resetEverything = function () {
  if (!confirm('⚠️ RESET TOTALE: cancella aste, assegnazioni e partecipanti. Confermi?')) return;

  var updates = { auctions: null, assignments: null, participants: null, tokens: null };

  db.ref().update(updates).then(function () {
    auctionsCache = {};
    assignmentsCache = [];
    participants = {};
    openPlayersSet.clear();
    closedPlayersSet.clear();
    expiredHandled.clear();

    var closed = document.getElementById('closedBox'); if (closed) closed.innerHTML = '';
    var list = document.getElementById('auctionsList'); if (list) list.innerHTML = '';
    var left = document.querySelector('#tbodyList'); if (left) left.innerHTML = '';
    var parts = document.querySelector('#participants'); if (parts) parts.innerHTML = '';

    alert('Reset completato.');
  }).catch(function (err) {
    alert('Reset fallito: ' + (err && err.message || String(err)));
  });
};

// Partecipanti (render + budgets)
function renderParticipants(items){
  var container = document.getElementById('participants');
  if (!container) return;
  var budgets = {};
  items.forEach(function(it){
    var key = norm(it.winner||'');
    if (!key) return;
    if (!budgets[key]) budgets[key] = { name:it.winner, spent:0, items:[] };
    budgets[key].spent += Number(it.price||0);
    budgets[key].items.push({ player:it.player, role:it.role, price:Number(it.price||0) });
  });

  container.innerHTML = '';
  var names = Object.keys(participants).map(function(uid){ return participants[uid]; });
