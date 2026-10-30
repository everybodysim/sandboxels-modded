/* ============================================================================
   SUBLEVEL PHYSICS v6  -  Sandboxels 1.13.x  -  powered by Planck.js (Box2D)
   LOAD THIS MOD LAST. Needs internet once per session (planck.js from a CDN).

   v6 (written against the real 1.13 source: mouse1Action / mouse2Action /
   drawCursor / lineCoords / erase tool)
   - Solids can no longer plow through powder. Powder surfaces are colliders;
     a heavy body may displace grains only until it has sunk ~5 px, then it
     rests. Light bodies rest on top. Displaced grains are flung with velocity.
   - Powder lying on a body rides along with it (cups carry sand, you can lift
     a pile, kicking never drops grains through the bottom).
   - Support check: only things connected (through solids/powders) to the world
     edge or an anchored block are "grounded". Powder/liquid islands, rings
     filled with sand etc. no longer hold solids up.
   - Placing/erasing on a physics body works IN THE BODY'S OWN GRID (no holes,
     no splitting). The brush cursor is drawn rotated, every frame.
   - Every non-self-moving material gets physics (tick-only solids such as
     "border", sturdy/support solids, plants, etc). Animated colours/alpha are
     copied from the footprint each tick.
   - New tool: physgrab (click a physics body and drag it around).
   - Lag: fewer support scans, no per-pixel re-sync, throttled terrain refresh.
   Tools: physgrab, physkick, physicsspin, physicsflip, physicsfreeze,
          physicsunfreeze, physicssnap, physicsalignedsnap
   ========================================================================== */
(function () {

var G = 0.09, HOLD = 12, SUB = 4, DT = 1/SUB, SINKMAX = 5;
var BODIES = {}, FC = {}, PC = {}, PL = null, world = null, terrain = null;
var tfix = new Map(), impacts = [], pushes = [], RIDERS = new Set(), GC = new Set(), GRAB = null;
var baseId = Math.floor(Math.random()*1e8) * 100, idc = 1;
var NOJOIN = false, ERASEGUARD = false, dirtyA = [], dirtyS = new Set(), hookedCount = 0;
var D4 = [[1,0],[-1,0],[0,1],[0,-1]];

function chance(p){ return Math.random() < p; }
function pick(a){ return a[Math.floor(Math.random()*a.length)]; }
function sign(v){ return v > 0 ? 1 : v < 0 ? -1 : 0; }
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function K(lx,ly){ return (lx+2048)*4096 + (ly+2048); }
function GK(x,y){ return x*4096 + y; }
function pxAt(x,y){
  if (outOfBounds(x,y)) return undefined;
  var c = pixelMap[x]; return c ? c[y] : undefined;
}
function liq(x,y){
  if (outOfBounds(x,y)) return null;
  var p = pixelMap[x][y]; if (!p || p.sub !== undefined) return null;
  var e = elements[p.element]; return (e && e.state === "liquid") ? p : null;
}
function mark(x,y){ var gk = GK(x,y); if (!dirtyS.has(gk)){ dirtyS.add(gk); dirtyA.push(gk); } }

/* ------------------------------------------------ which blocks get physics */
/* anything that does not actively move on its own */
function selfMoving(e){
  var bh = e.behavior, i, j, s;
  if (typeof bh === "function") return true;
  if (Array.isArray(bh)){
    if (bh.length === 3 && Array.isArray(bh[0])){
      for (i = 0; i < 3; i++) for (j = 0; j < bh[i].length; j++){
        s = bh[i][j]; if (typeof s !== "string") continue;
        if (/M2/.test(s)) return true;                            // powders
        if (/M1/.test(s) && !(i === 2 && j === 1)) return true;   // only a straight fall (sturdy/support solids) is ok
      }
    } else if (/M[12]/.test(JSON.stringify(bh))) return true;
  } else if (bh !== undefined) return true;
  if (typeof e.tick === "function" && /tryMove|movePixel|swapPixels|moveTo\(/.test(String(e.tick))) return true;
  return false;
}
function calcFall(id, e){
  if (!e || e.tool || e.hidden || e.anchored || e.slNoPhys || id === "wall" || /^anchored_/.test(id)) return false;
  if (e.category === "tools" || e.category === "energy") return false;
  if (e.state !== undefined && e.state !== "solid") return false;
  if (selfMoving(e)) return false;
  return true;
}
function fallEl(id){
  var c = FC[id]; if (c !== undefined) return c;
  return (FC[id] = calcFall(id, elements[id]));
}
function isAnchoredEl(p){
  var id = p.element; return id === "wall" || /^anchored_/.test(id) || !!(elements[id] && elements[id].anchored);
}
function isPowderPix(p){
  if (!p || p.del || p.sub !== undefined) return false;
  var e = elements[p.element]; if (!e || (e.state !== "solid" && e.state !== undefined)) return false;
  return e.movable === true && !e.anchored && !fallEl(p.element);
}

/* ------------------------------------- per-element physics characteristics */
function hash(s){ var h = 2166136261; for (var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function physOf(id){
  var P = PC[id]; if (P) return P;
  var e = elements[id] || {}, h = hash(id);
  var r1 = (h & 255)/255, r2 = ((h >>> 8) & 255)/255, r3 = ((h >>> 16) & 255)/255;
  var dens = Math.max(30, Math.min(20000, e.density || 1500));
  var hard = e.hardness !== undefined ? e.hardness : 0.3 + 0.6*r1;
  var bounce = 0.02 + 0.2*r2, fric = 0.3 + 0.5*r3;
  if (/rubber|slime|jelly|gummy|tire|ball|bounc/.test(id)){ bounce = 0.75 + 0.2*r2; fric = 0.9; hard = Math.max(hard, 0.7); }
  else if (/ice|rime/.test(id)){ bounce = 0.05; fric = 0.04; hard = Math.min(hard, 0.3); }
  else if (/glass|porcelain|crystal|ceramic|pyrite|ruby|sapphire|quartz/.test(id)){ bounce = 0.04 + 0.1*r2; hard = Math.min(hard, 0.25); fric = 0.35 + 0.2*r3; }
  else if (/steel|titan|tungsten|adamant|iron/.test(id)){ bounce = 0.02 + 0.04*r2; fric = 0.35 + 0.15*r3; hard = Math.max(hard, 0.93); }
  else if (/copper|gold|silver|lead|zinc|tin|nickel|alumin|brass|bronze|platin|metal|cobalt|chrom/.test(id)){ bounce = 0.02 + 0.06*r2; fric = 0.3 + 0.2*r3; hard = Math.max(hard, 0.75); }
  else if (/wood|plank|bamboo|board|paper|cork|foam|sponge|bone|straw/.test(id)){ bounce = 0.08 + 0.1*r2; fric = 0.55 + 0.15*r3; hard = Math.min(Math.max(hard, 0.3), 0.5); }
  else if (/stone|rock|brick|concrete|cement|marble|granite/.test(id)){ bounce = 0.03 + 0.06*r2; fric = 0.55 + 0.25*r3; hard = Math.max(hard, 0.65); }
  hard = clamp(hard, 0.05, 0.98);
  var br = e.breakInto; if (Array.isArray(br)) br = br[0];
  var debris = (br && elements[br]) ? br : (elements.gravel ? "gravel" : null);
  P = PC[id] = { dens: dens, bounce: bounce, fric: fric, hard: hard, debris: debris };
  return P;
}

/* ------------------------------------------------------------ transforms */
function toWorld(b,lx,ly){
  var c = Math.cos(b.a), s = Math.sin(b.a);
  return { x: b.x + lx*c - ly*s, y: b.y + lx*s + ly*c };
}
function toLocal(b,wx,wy){
  var dx = wx - b.x, dy = wy - b.y, c = Math.cos(b.a), s = Math.sin(b.a);
  return { x: dx*c + dy*s, y: -dx*s + dy*c };
}
function syncPose(b){
  if (b.pb){ var ps = b.pb.getPosition(); b.x = ps.x; b.y = ps.y; b.a = b.pb.getAngle(); }
}

/* ------------------------------------------------------------ planck world */
function loadPlanck(){
  if (typeof planck !== "undefined"){ PL = planck; return; }
  if (typeof document === "undefined" || loadPlanck.busy) return;
  loadPlanck.busy = true;
  var urls = ["https://cdn.jsdelivr.net/npm/planck@1.0.0/dist/planck.min.js", "https://unpkg.com/planck@1.0.0/dist/planck.min.js"], i = 0;
  (function next(){
    if (i >= urls.length){ if (typeof logMessage === "function") logMessage("Sublevel Physics: could not load planck.js (no internet?)"); return; }
    var s = document.createElement("script"); s.src = urls[i++];
    s.onload = function(){ if (typeof planck !== "undefined") PL = planck; else next(); };
    s.onerror = next; document.head.appendChild(s);
  })();
}
function playableBounds(){
  var my = Math.floor(height/2), mx = Math.floor(width/2), x0 = 0, x1 = width, y0 = 0, y1 = height;
  while (x0 < width && outOfBounds(x0, my)) x0++;
  while (x1 > 0 && outOfBounds(x1, my)) x1--;
  while (y0 < height && outOfBounds(mx, y0)) y0++;
  while (y1 > 0 && outOfBounds(mx, y1)) y1--;
  return { x0:x0, x1:x1, y0:y0, y1:y1 };
}
function initWorld(){
  if (world || !PL) return;
  world = new PL.World({ gravity: PL.Vec2(0, G), allowSleep: false });
  terrain = world.createBody({ type: "static" });
  var B = playableBounds(), my = (B.y0 + B.y1)/2, mx = (B.x0 + B.x1)/2, bd = { friction: 0.8, userData: { t: 1, kind: 1, border: 1 } };
  terrain.createFixture(PL.Box(50, 2000, PL.Vec2(B.x0 - 0.5 - 50, my)), bd);
  terrain.createFixture(PL.Box(50, 2000, PL.Vec2(B.x1 + 0.5 + 50, my)), bd);
  terrain.createFixture(PL.Box(2000, 50, PL.Vec2(mx, B.y0 - 0.5 - 50)), bd);
  terrain.createFixture(PL.Box(2000, 50, PL.Vec2(mx, B.y1 + 0.5 + 50)), bd);
  world.on("begin-contact", onBegin);
  world.on("post-solve", onPost);
}
function bodyVelAt(pb, pt){ var v = pb.getLinearVelocityFromWorldPoint(pt); return { x: v.x, y: v.y }; }
function onBegin(contact){
  var fa = contact.getFixtureA(), fb = contact.getFixtureB(), ua = fa.getUserData(), ub = fb.getUserData();
  if (!ua || !ub) return;
  var wm = contact.getWorldManifold(null); if (!wm || !wm.points || !wm.points.length) return;
  var n = wm.normal, pt = wm.points[0];
  var va = bodyVelAt(fa.getBody(), pt), vb = bodyVelAt(fb.getBody(), pt);
  var s = (va.x - vb.x)*n.x + (va.y - vb.y)*n.y;
  if (s < 0.3) return;
  impacts.push({ ua: ua, ub: ub, s: s, x: pt.x, y: pt.y });
}
function onPost(contact, impulse){
  var fa = contact.getFixtureA(), fb = contact.getFixtureB(), ua = fa.getUserData(), ub = fb.getUserData();
  if (!ua || !ub) return;
  var body = ua.b ? ua : (ub.b ? ub : null), soil = ua.kind === 2 ? ua : (ub.kind === 2 ? ub : null);
  if (!body || !soil) return;
  var ni = impulse && impulse.normals, imp = 0, i;
  if (ni) for (i = 0; i < ni.length; i++) imp += ni[i];
  var wm = contact.getWorldManifold(null); if (!wm || !wm.points || !wm.points.length) return;
  pushes.push({ f: imp/DT, x: wm.points[0].x, y: wm.points[0].y, run: soil, b: body.b });
}

/* ---------------------------------------------------------- body building */
function calc(b){
  var rad = 0;
  b.cells.forEach(function(c){ rad = Math.max(rad, Math.sqrt(c.x*c.x + c.y*c.y) + 0.75); });
  b.rad = rad;
}
function makeBody(cells, ang){
  var b = { id: baseId + (idc++), cells: cells, x: 0, y: 0, a: ang || 0, gf: 1, proxies: new Map(),
    dirty: false, needSync: false, dead: false, hold: 0, frozen: false, pb: null, sx: 1e9, sy: 1e9, sa: 1e9,
    pend: null, wet: 0, pbud: 0, pbT: -999 };
  calc(b); BODIES[b.id] = b; return b;
}
function raster(b, x, y, a){
  var c = Math.cos(a), s = Math.sin(a), r = b.rad;
  var gx0 = Math.floor(x - r), gx1 = Math.ceil(x + r), gy0 = Math.floor(y - r), gy1 = Math.ceil(y + r);
  var out = { gx: [], gy: [], ck: [] };
  for (var gx = gx0; gx <= gx1; gx++) for (var gy = gy0; gy <= gy1; gy++){
    var dx = gx - x, dy = gy - y;
    var k = K(Math.round(dx*c + dy*s), Math.round(-dx*s + dy*c));
    if (b.cells.has(k)){ out.gx.push(gx); out.gy.push(gy); out.ck.push(k); }
  }
  return out;
}
function rebuildFixtures(b){
  var pb = b.pb; if (!pb) return;
  var f = pb.getFixtureList(), old = [];
  while (f){ old.push(f); f = f.getNext(); }
  old.forEach(function(x){ pb.destroyFixture(x); });
  var rows = {};
  b.cells.forEach(function(c){ (rows[c.y] = rows[c.y] || []).push(c); });
  Object.keys(rows).forEach(function(y){
    var list = rows[y].sort(function(p, q){ return p.x - q.x; }), i = 0;
    while (i < list.length){
      var j = i;
      while (j + 1 < list.length && list[j+1].x === list[j].x + 1 && list[j+1].e === list[i].e) j++;
      var P = physOf(list[i].e), len = j - i + 1;
      pb.createFixture(PL.Box(len/2, 0.5, PL.Vec2(list[i].x + (len - 1)/2, +y)),
        { density: P.dens/1000, friction: P.fric, restitution: P.bounce, userData: { b: b } });
      i = j + 1;
    }
  });
  pb.resetMassData();
}
function ensurePB(b){
  if (b.pb || !world) return;
  b.pb = world.createBody({ type: (b.frozen || pixelTicks < b.hold) ? "static" : "dynamic",
    position: PL.Vec2(b.x, b.y), angle: b.a });
  b.pb.setGravityScale(b.gf);
  b.pb.setLinearDamping(0.002); b.pb.setAngularDamping(0.02);
  rebuildFixtures(b);
  if (b.pend){ b.pend(b.pb); b.pend = null; }
}

/* ------------------------------------------------------------- proxies */
function occState(o){                   // 0 = can be shoved aside (liquid, gas, powder), 1 = solid
  if (o.sub !== undefined) return 1;
  var e = elements[o.element]; if (!e) return 1;
  if (e.state === "liquid" || e.state === "gas") return 0;
  if (e.movable === true && !e.anchored && !fallEl(o.element)) return 0;
  return 1;
}
/* move pixel o (which sits in pixelMap) to a free cell nearby, preferring cells AWAY from (cx,cy) */
function relocate(o, gx, gy, want, rr, cx, cy){
  for (var r = 1; r <= 12; r++){
    var cand = [];
    for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++){
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      var x = gx + dx, y = gy + dy;
      if (outOfBounds(x,y) || pixelMap[x][y] !== undefined || (want && want.has(GK(x,y)))) continue;
      if (rr && rr[y] && x > rr[y][0] && x < rr[y][1]) continue;          // never into a hull's dry interior
      cand.push([x,y]);
    }
    if (cand.length){
      if (elements[o.element] && elements[o.element].state === "liquid"){
        var wetc = cand.filter(function(q){
          for (var d = 0; d < 4; d++){ var n = pxAt(q[0] + D4[d][0], q[1] + D4[d][1]);
            if (n && n.sub === undefined && elements[n.element] && elements[n.element].state === "liquid") return true; }
          return false; });
        if (wetc.length) cand = wetc;
      }
      var t;
      if (cx !== undefined){
        var best = -1e9, ox = gx - cx, oy = gy - cy, ol = Math.sqrt(ox*ox + oy*oy) || 1;
        for (var ci = 0; ci < cand.length; ci++){
          var q2 = cand[ci], qx = q2[0] - cx, qy = q2[1] - cy, ql = Math.sqrt(qx*qx + qy*qy) || 1;
          var sc = (qx*ox + qy*oy)/(ql*ol) + Math.random()*0.8;
          var up = pixelMap[q2[0]] && pixelMap[q2[0]][q2[1] - 1];
          if (up && up.sub !== undefined) sc -= 2;                      // not into the pocket under a body
          if (sc > best){ best = sc; t = q2; }
        }
      } else t = pick(cand);
      pixelMap[o.x][o.y] = undefined; o.x = t[0]; o.y = t[1]; pixelMap[t[0]][t[1]] = o; return true;
    }
  }
  pixelMap[o.x][o.y] = undefined; o.del = true; mark(gx, gy);
  return false;
}
function placeNear(p, gx, gy){
  for (var r = 0; r <= 8; r++){
    for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++){
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      var x = gx + dx, y = gy + dy;
      if (!outOfBounds(x,y) && pixelMap[x][y] === undefined){ p.x = x; p.y = y; pixelMap[x][y] = p; return true; }
    }
  }
  p.del = true; return false;
}
function mkProxy(b, cell, gx, gy, spareBy){
  var list = spareBy[cell.e], pix;
  if (list && list.length){ pix = list.pop(); pix.x = gx; pix.y = gy; pix.del = false; pixelMap[gx][gy] = pix; }
  else {
    var prev = NOJOIN; NOJOIN = true;
    createPixel(cell.e, gx, gy);
    NOJOIN = prev;
    pix = pixelMap[gx][gy]; if (!pix) return null;
    pix.temp = cell.t !== undefined ? cell.t : 20;
  }
  if (cell.c) pix.color = cell.c; else cell.c = pix.color;
  return pix;
}
/* powder sitting on top of a body rides with it */
function walkRiders(pix, cb){
  var p = pxAt(pix.x, pix.y - 1), k = 0;
  while (p && k < 40 && isPowderPix(p)){ cb(p, p.y - pix.y); p = pxAt(p.x, p.y - 1); k++; }
}
function collectRiders(b){
  var out = [], seen = new Set();
  b.proxies.forEach(function(pix){
    if (out.length > 2500) return;
    walkRiders(pix, function(p, oy){ if (!seen.has(p)){ seen.add(p); out.push({ p: p, ck: pix.ck, oy: oy }); } });
  });
  return out;
}
function syncProxies(b){
  var riders = (b.sx < 1e8) ? collectRiders(b) : [], i;
  for (i = 0; i < riders.length; i++){ var rp = riders[i].p; if (pixelMap[rp.x] && pixelMap[rp.x][rp.y] === rp) pixelMap[rp.x][rp.y] = undefined; }
  var R = raster(b, b.x, b.y, b.a), want = new Map(), rr = {};
  for (i = 0; i < R.gx.length; i++){
    want.set(GK(R.gx[i], R.gy[i]), i);
    var q = rr[R.gy[i]]; if (!q) rr[R.gy[i]] = [R.gx[i], R.gx[i]]; else { if (R.gx[i] < q[0]) q[0] = R.gx[i]; if (R.gx[i] > q[1]) q[1] = R.gx[i]; }
  }
  var spareBy = {};
  b.proxies.forEach(function(pix, gk){
    var valid = !pix.del && pix.sub === b.id && pixelMap[pix.x] && pixelMap[pix.x][pix.y] === pix && GK(pix.x, pix.y) === gk;
    if (!valid){ b.proxies.delete(gk); return; }
    if (want.has(gk)){
      var nk = R.ck[want.get(gk)], nc = b.cells.get(nk);
      if (nc && nc.e === pix.element){ pix.ck = nk; want.delete(gk); return; }
    }
    b.proxies.delete(gk);
    pixelMap[pix.x][pix.y] = undefined;
    (spareBy[pix.element] = spareBy[pix.element] || []).push(pix);
  });
  want.forEach(function(idx, gk){
    var gx = R.gx[idx], gy = R.gy[idx], o = pixelMap[gx][gy];
    var cell = b.cells.get(R.ck[idx]); if (!cell) return;
    if (o){
      if (occState(o) === 1) return;                        // overlap with a real solid: tolerated
      var gone = elements[o.element] && elements[o.element].state === "solid";
      var ox = o.x, oy = o.y;
      relocate(o, gx, gy, want, rr, b.x, b.y);
      if (gone && !o.del){ o.pvx = (o.x - ox)*0.4 + (Math.random()-0.5)*0.2; o.pvy = (o.y - oy)*0.4 - 0.1; }
    }
    var pix = mkProxy(b, cell, gx, gy, spareBy);
    if (!pix) return;
    pix.sub = b.id; pix.ck = R.ck[idx];
    b.proxies.set(gk, pix);
  });
  for (var el in spareBy) spareBy[el].forEach(function(pix){ pix.sub = undefined; pix.del = true; });
  if (riders.length){
    var byCk = new Map();
    b.proxies.forEach(function(pix){ byCk.set(pix.ck, pix); });
    riders.forEach(function(r){
      var p = r.p; if (p.del) return;
      var base = byCk.get(r.ck);
      placeNear(p, base ? base.x : p.x, base ? base.y + r.oy : p.y);
    });
  }
  b.sx = b.x; b.sy = b.y; b.sa = b.a;
}
function releaseProxies(b){
  b.proxies.forEach(function(pix){
    if (!pix.del && pixelMap[pix.x] && pixelMap[pix.x][pix.y] === pix) pixelMap[pix.x][pix.y] = undefined;
    pix.sub = undefined; pix.del = true;
  });
  b.proxies.clear();
}
function killBody(b){
  releaseProxies(b);
  if (b.pb && world){ world.destroyBody(b.pb); b.pb = null; }
  if (GRAB && GRAB.b === b) GRAB = null;
  b.dead = true; delete BODIES[b.id];
}
/* the game works on the footprint pixels (acid, fire, heat, animation...). Pull results back into the body. */
function watchProxies(b){
  var sum = {}, cnt = {}, chg = {};
  b.proxies.forEach(function(pix, gk){
    if (pix.del && pix.sub === b.id){
      b.proxies.delete(gk); if (b.cells.delete(pix.ck)) b.dirty = true; return;
    }
    if (pix.sub !== b.id || !pixelMap[pix.x] || pixelMap[pix.x][pix.y] !== pix || GK(pix.x, pix.y) !== gk){
      b.proxies.delete(gk); b.needSync = true; return;
    }
    var cell = b.cells.get(pix.ck); if (!cell) return;
    if (pix.element !== cell.e){
      var NE = pix.element;
      if (fallEl(NE)){ cell.e = NE; b.dirty = true; }
      else { b.cells.delete(pix.ck); b.proxies.delete(gk); pix.sub = undefined; b.dirty = true; mark(pix.x, pix.y); return; }
    }
    cell.c = pix.color; cell.al = pix.alpha;                    // animated colours / alpha (border, hue shifters...)
    sum[pix.ck] = (sum[pix.ck] || 0) + pix.temp; cnt[pix.ck] = (cnt[pix.ck] || 0) + 1; if (pix.charge) chg[pix.ck] = 1;
  });
  b.cells.forEach(function(cell, k){ if (cnt[k]) cell.t = sum[k]/cnt[k]; cell.chg = chg[k] ? 1 : 0; });
}

/* ---------------------------------------------------- dirty / splitting */
function components(b){
  var seen = new Set(), out = [];
  b.cells.forEach(function(cell, k){
    if (seen.has(k)) return;
    var comp = [], q = [cell]; seen.add(k);
    while (q.length){
      var c = q.pop(); comp.push(K(c.x, c.y));
      for (var d = 0; d < 4; d++){
        var nk = K(c.x + D4[d][0], c.y + D4[d][1]), nc = b.cells.get(nk);
        if (nc && !seen.has(nk)){ seen.add(nk); q.push(nc); }
      }
    }
    out.push(comp);
  });
  return out;
}
function fixBody(b){
  b.dirty = false;
  if (!b.cells.size){ killBody(b); return; }
  var comps = components(b);
  if (comps.length === 1){ calc(b); if (b.pb) rebuildFixtures(b); syncProxies(b); return; }
  var old = b.pb, lv = null, av = 0, wc = null;
  if (old){ lv = old.getLinearVelocity(); av = old.getAngularVelocity(); wc = old.getWorldCenter(); lv = { x: lv.x, y: lv.y }; wc = { x: wc.x, y: wc.y }; syncPose(b); }
  var created = [];
  comps.forEach(function(keys){
    var cells = new Map();
    keys.forEach(function(k){ cells.set(k, b.cells.get(k)); });
    var nb = makeBody(cells, b.a);
    nb.x = b.x; nb.y = b.y; nb.gf = b.gf; nb.frozen = b.frozen; nb.hold = b.hold;
    if (old) nb.pend = function(pb){
      var c = pb.getWorldCenter(), dx = c.x - wc.x, dy = c.y - wc.y;
      pb.setLinearVelocity(PL.Vec2(lv.x - av*dy, lv.y + av*dx)); pb.setAngularVelocity(av);
    };
    created.push(nb);
  });
  killBody(b);
  created.forEach(function(n){ ensurePB(n); syncProxies(n); });
}

/* ------------------------------------------------------ terrain colliders */
function refreshTerrain(){
  var rows = {}, seen = new Set(), ids = Object.keys(BODIES), i, x, y;
  RIDERS.clear();
  for (i = 0; i < ids.length; i++){
    var bb = BODIES[ids[i]]; if (!bb) continue;
    bb.proxies.forEach(function(pix){ walkRiders(pix, function(p){ RIDERS.add(p); }); });   // piles on a body are carried, not solid walls
  }
  for (i = 0; i < ids.length; i++){
    var b = BODIES[ids[i]]; if (!b.pb) continue;
    var v = b.pb.getLinearVelocity(), pad = 2 + Math.min(4, Math.abs(v.x) + Math.abs(v.y));
    var x0 = Math.floor(b.x - b.rad - pad), x1 = Math.ceil(b.x + b.rad + pad), y0 = Math.floor(b.y - b.rad - pad), y1 = Math.ceil(b.y + b.rad + pad);
    for (x = x0; x <= x1; x++) for (y = y0; y <= y1; y++){
      var gk = GK(x, y); if (seen.has(gk)) continue; seen.add(gk);
      var p = pxAt(x, y); if (!p || p.sub !== undefined || RIDERS.has(p)) continue;
      var e = elements[p.element]; if (!e || e.state === "liquid" || e.state === "gas") continue;
      var kind = (e.movable === true && !e.anchored && !fallEl(p.element)) ? 2 : 1;
      var surf = false;
      for (var d = 0; d < 4; d++){
        var n = pxAt(x + D4[d][0], y + D4[d][1]);
        if (!n || n.sub !== undefined){ surf = true; break; }
        var ne = elements[n.element];
        if (!ne || ne.state === "liquid" || ne.state === "gas" || (ne.movable === true && !ne.anchored && !fallEl(n.element))){ surf = true; break; }
      }
      if (!surf) continue;
      (rows[y] = rows[y] || []).push([x, kind]);
    }
  }
  var want = new Map();
  Object.keys(rows).forEach(function(yy){
    var l = rows[yy].sort(function(p, q){ return p[0] - q[0]; }), a = 0;
    while (a < l.length){
      var z = a;
      while (z + 1 < l.length && l[z+1][0] === l[z][0] + 1 && l[z+1][1] === l[a][1]) z++;
      want.set(yy + "|" + l[a][0] + "|" + l[z][0] + "|" + l[a][1], { y: +yy, x0: l[a][0], x1: l[z][0], kind: l[a][1] });
      a = z + 1;
    }
  });
  tfix.forEach(function(fx, key){ if (!want.has(key)){ terrain.destroyFixture(fx); tfix.delete(key); } });
  want.forEach(function(r, key){
    if (tfix.has(key)) return;
    var len = r.x1 - r.x0 + 1;
    tfix.set(key, terrain.createFixture(PL.Box(len/2, 0.5, PL.Vec2((r.x0 + r.x1)/2, r.y)),
      { friction: r.kind === 2 ? 0.5 : 0.8, restitution: 0, userData: { t: 1, kind: r.kind, y: r.y, x0: r.x0, x1: r.x1 } }));
  });
}

/* ------------------------------------------------ impacts / powder pushing */
function smash(p){
  var e = elements[p.element]; if (!e || !e.breakInto) return;
  var t = e.breakInto; if (Array.isArray(t)) t = pick(t);
  if (t && elements[t]) changePixel(p, t);
}
function removeCell(b, k, debris){
  var cell = b.cells.get(k); if (!cell) return;
  b.cells.delete(k); b.dirty = true;
  if (debris && chance(0.55)){
    var w = toWorld(b, cell.x, cell.y), d = physOf(cell.e).debris;
    if (d && isEmpty(Math.round(w.x), Math.round(w.y))) createPixel(d, Math.round(w.x), Math.round(w.y));
  }
}
function hurt(b, x, y, s, tH){
  if (!b || b.dead) return;
  var lc = toLocal(b, x, y);
  b.cells.forEach(function(cell, k){
    var dx = cell.x - lc.x, dy = cell.y - lc.y;
    if (dx*dx + dy*dy > 2.9) return;
    var thr = 0.4 + 2.6*physOf(cell.e).hard;
    if (s <= thr) return;
    if (chance(Math.min(0.8, (s - thr)*0.45) * (0.5 + 0.5*(1 - tH)))) removeCell(b, k, true);
  });
}
function processImpacts(){
  impacts.forEach(function(im){
    var A = im.ua.b, B = im.ub.b, tH = 0.6;
    if (!A && !B) return;
    if (!A || !B){
      var mine = A || B, kind = im.ua.t ? im.ua : im.ub;
      if (kind.kind === 1 && !kind.border && im.s > 1.0){
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++){
          var p = pxAt(Math.round(im.x) + dx, Math.round(im.y) + dy);
          if (!p || p.sub !== undefined) continue;
          var e = elements[p.element]; if (!e || !e.breakInto) continue;
          var hard = e.hardness !== undefined ? e.hardness : 0.6; tH = hard;
          var mass = mine.pb ? mine.pb.getMass() : 1;
          if (hard < 0.95 && chance(Math.min(0.7, (im.s - 1.0)*0.2*Math.min(3, mass/6)*(1 - hard)))) smash(p);
        }
      }
      hurt(mine, im.x, im.y, im.s, tH);
    } else { hurt(A, im.x, im.y, im.s, 0.6); hurt(B, im.x, im.y, im.s, 0.6); }
  });
  impacts.length = 0;
}
/* Heavy bodies may displace powder, but only ~SINKMAX pixels deep per contact episode. */
function processPushes(){
  var done = new Set(), count = 0;
  pushes.forEach(function(ps){
    var bb = ps.b; if (!bb || bb.dead || !bb.pb) return;
    var run = ps.run, gx = clamp(Math.round(ps.x), run.x0, run.x1), gy = run.y, gk = GK(gx, gy);
    var p = pxAt(gx, gy); if (!p || p.sub !== undefined) return;
    var e = elements[p.element]; if (!e) return;
    if (pixelTicks - bb.pbT > 25){                                   // new contact episode: fresh sinking budget
      var avgD = bb.pb.getMass()/Math.max(1, bb.cells.size)*1000;
      var hv = clamp((avgD/Math.max(300, e.density || 1500) - 0.55)/0.9, 0, 1);
      bb.pbud = hv*SINKMAX*clamp(bb.rad*1.6, 4, 28);
    }
    bb.pbT = pixelTicks;
    if (done.has(gk) || count > 80) return;
    var resist = (e.density || 1500)/1000*G*12;
    if (ps.f < resist || bb.pbud < 1) return;                         // light body, or budget spent: powder acts as solid ground
    done.add(gk); count++; bb.pbud -= 1;
    var dx = gx - bb.x, dy = gy - bb.y, l = Math.sqrt(dx*dx + dy*dy) || 1;
    if (relocate(p, p.x, p.y, null, null, bb.x, bb.y)){
      var sp = Math.min(1.6, 0.3 + ps.f/(resist*3));
      if (dy/l > 0.6){ p.pvx = (chance(0.5) ? -1 : 1)*(0.4 + Math.random()*0.6)*sp; p.pvy = -0.2; }   // from below: shoved sideways
      else { p.pvx = dx/l*sp + (Math.random() - 0.5)*0.3; p.pvy = dy/l*sp - 0.15; }
    }
  });
  pushes.length = 0;
}
function flyGrain(p){
  p.pvy = (p.pvy || 0) + G*0.7;
  p.pvx = (p.pvx || 0) * 0.96; p.pvy *= 0.98;
  p.qx = (p.qx || 0) + p.pvx; p.qy = (p.qy || 0) + p.pvy;
  var sx = Math.trunc(p.qx), sy = Math.trunc(p.qy), i;
  for (i = 0; i < Math.abs(sx); i++){
    var nx = p.x + sign(sx);
    if (!outOfBounds(nx, p.y)){
      var ob = pixelMap[nx][p.y];
      if (!ob){ movePixel(p, nx, p.y); p.qx -= sign(sx); }
      else { p.pvx *= ob.sub !== undefined ? -0.3 : -0.2; p.qx = 0; break; }
    } else { p.pvx = 0; p.qx = 0; break; }
  }
  for (i = 0; i < Math.abs(sy); i++){
    var ny = p.y + sign(sy);
    if (!outOfBounds(p.x, ny)){
      var ob2 = pixelMap[p.x][ny];
      if (!ob2){ movePixel(p, p.x, ny); p.qy -= sign(sy); }
      else { p.pvy *= -0.1; p.qy = 0; break; }
    } else { p.pvy = 0; p.qy = 0; break; }
  }
  if (Math.abs(p.pvx) + Math.abs(p.pvy) < 0.08){ delete p.pvx; delete p.pvy; delete p.qx; delete p.qy; }
}

/* ------------------------------------------------------------- buoyancy */
function surfaceNear(minX, maxX, minY, maxY){
  for (var off = 1; off <= 6; off++){
    for (var sd = -1; sd <= 1; sd += 2){
      var x = sd < 0 ? minX - off : maxX + off;
      for (var y = minY - 6; y <= maxY + 4; y++){
        var p = liq(x, y);
        if (p && liq(x, y + 1)) return { edge: y - 0.5, rho: elements[p.element].density };
        if (!outOfBounds(x, y) && pixelMap[x][y] && pixelMap[x][y].sub === undefined && !p){
          var e = elements[pixelMap[x][y].element]; if (e && e.state !== "gas") break;
        }
      }
    }
  }
  return null;
}
function fluidInfo(b, R){
  var rows = {}, i, gx, gy, k, own = new Set(), minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (i = 0; i < R.gx.length; i++){
    gx = R.gx[i]; gy = R.gy[i]; own.add(GK(gx, gy));
    if (gx < minX) minX = gx; if (gx > maxX) maxX = gx; if (gy < minY) minY = gy; if (gy > maxY) maxY = gy;
    var r = rows[gy]; if (!r) rows[gy] = [gx,gx]; else { if (gx < r[0]) r[0] = gx; if (gx > r[1]) r[1] = gx; }
  }
  var S = surfaceNear(minX, maxX, minY, maxY);
  if (!S || maxY + 0.5 <= S.edge) return { n:0, cx: b.x, cy: b.y, rho: 1000 };
  var cnt = 0, sx = 0, sy = 0;
  for (i = 0; i < R.gx.length; i++){
    var f = clamp(R.gy[i] + 0.5 - S.edge, 0, 1);
    if (f > 0){ cnt += f; sx += R.gx[i]*f; sy += R.gy[i]*f; }
  }
  for (k in rows){
    var f2 = clamp(+k + 0.5 - S.edge, 0, 1); if (f2 <= 0) continue;
    var row = rows[k];
    for (var x = row[0] + 1; x < row[1]; x++){
      if (own.has(GK(x, +k))) continue;
      var q = outOfBounds(x, +k) ? null : pixelMap[x][+k];
      if (!q || (q.sub === undefined && elements[q.element] && elements[q.element].state === "gas")){ cnt += f2; sx += x*f2; sy += (+k)*f2; }
    }
  }
  return { n:cnt, cx: cnt ? sx/cnt : b.x, cy: cnt ? sy/cnt : b.y, rho: S.rho };
}

/* ------------------------------------------------ falling: support detection */
function isFaller(p){ return p && !p.del && p.sub === undefined && fallEl(p.element); }
function bodyFromPixels(list){
  var ax = list[0].x, ay = list[0].y, cells = new Map();
  list.forEach(function(q){ cells.set(K(q.x - ax, q.y - ay), { x: q.x - ax, y: q.y - ay, e: q.element, c: q.color, t: q.temp !== undefined ? q.temp : 20 }); });
  list.forEach(function(q){ if (pixelMap[q.x][q.y] === q) pixelMap[q.x][q.y] = undefined; q.del = true; });
  var b = makeBody(cells, 0);
  b.x = ax; b.y = ay;
  ensurePB(b); syncProxies(b);
  return b;
}
var SDIR = [[0,-1],[-1,0],[1,0],[0,1]];             // down is explored first (it is popped last-pushed)
/* grounded = connected, through solids AND powders, to the world edge or an anchored block.
   liquids, gases and other physics bodies never hold anything up. */
function checkSupport(p, checked){
  var fall = [p], seen = new Set([p]), stack = [p], supported = false, host = null;
  while (stack.length && !supported){
    var c = stack.pop();
    for (var d = 0; d < 4; d++){
      var nx = c.x + SDIR[d][0], ny = c.y + SDIR[d][1];
      if (outOfBounds(nx, ny)){ supported = true; break; }
      var n = pixelMap[nx][ny];
      if (!n || n.del) continue;
      if (n.sub !== undefined){ if (!host && BODIES[n.sub]) host = BODIES[n.sub]; continue; }
      if (seen.has(n)) continue;
      if (GC.has(n)){ supported = true; break; }
      var e = elements[n.element];
      if (!e){ supported = true; break; }
      if (fallEl(n.element)){ seen.add(n); fall.push(n); stack.push(n); continue; }
      if (e.state === "liquid" || e.state === "gas") continue;
      if (isAnchoredEl(n)){ supported = true; break; }
      seen.add(n); stack.push(n);                                     // powder / other static stuff conducts support
    }
    if (seen.size > 4000) supported = true;
  }
  fall.forEach(function(x){ checked.add(x); });
  if (supported){ seen.forEach(function(x){ GC.add(x); }); return; }
  if (host){                                       // pixels the user JUST placed beside a body join it
    var joined = false;
    fall.forEach(function(px){
      if (!px.del && px.sub === undefined && px.pa !== undefined && pixelTicks - px.pa <= 2){ joinPixel(host, px); joined = true; }
    });
    if (joined) return;
  }
  var byPos = new Map(), done = new Set();                      // every faller group in the floating region becomes a body
  fall.forEach(function(q){ byPos.set(GK(q.x, q.y), q); });
  fall.forEach(function(q){
    if (done.has(q) || q.del) return;
    var grp = [], st = [q]; done.add(q);
    while (st.length){
      var cur = st.pop(); grp.push(cur);
      for (var d2 = 0; d2 < 4; d2++){
        var m = byPos.get(GK(cur.x + D4[d2][0], cur.y + D4[d2][1]));
        if (m && !done.has(m)){ done.add(m); st.push(m); }
      }
    }
    bodyFromPixels(grp);
  });
}
function processSupport(){
  GC = new Set();
  var checked = new Set(), n = 0, i;
  while (n < 60 && dirtyA.length){
    var gk = dirtyA.pop(); dirtyS.delete(gk); n++;
    var x = Math.floor(gk/4096), y = gk % 4096;
    for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++){
      var p = pxAt(x + dx, y + dy);
      if (p && !checked.has(p) && isFaller(p)) checkSupport(p, checked);
    }
  }
  if (typeof currentPixels !== "undefined" && currentPixels.length){
    for (i = 0; i < 8; i++){
      var r = currentPixels[Math.floor(Math.random()*currentPixels.length)];
      if (r && !checked.has(r) && isFaller(r) && pixelMap[r.x] && pixelMap[r.x][r.y] === r) checkSupport(r, checked);
    }
  }
}

/* -------------------------------------------- joining / erasing / snapping */
function joinPixel(b, p){
  var l = toLocal(b, p.x, p.y), lx = Math.round(l.x), ly = Math.round(l.y);
  if (!b.cells.has(K(lx, ly))) b.cells.set(K(lx, ly), { x: lx, y: ly, e: p.element, c: p.color, t: p.temp !== undefined ? p.temp : 20 });
  pixelMap[p.x][p.y] = undefined; p.del = true;
  b.dirty = true; b.hold = pixelTicks + HOLD;
  return true;
}
function onDeleteProxy(p){
  if (p.sub === undefined) return;
  var b = BODIES[p.sub]; if (!b) return;
  var gk = GK(p.x, p.y);
  if (b.proxies.get(gk) === p){ b.proxies.delete(gk); b.cells.delete(p.ck); b.dirty = true; b.hold = pixelTicks + HOLD; }
}
function snapBody(b, aligned){
  syncPose(b);
  if (aligned){ var q = Math.PI/2; b.a = Math.round(b.a/q)*q; b.x = Math.round(b.x); b.y = Math.round(b.y); }
  var R = raster(b, b.x, b.y, b.a), cells = b.cells;
  killBody(b);
  NOJOIN = true;
  for (var i = 0; i < R.gx.length; i++){
    var cell = cells.get(R.ck[i]);
    if (cell && isEmpty(R.gx[i], R.gy[i])){
      var id = elements["anchored_" + cell.e] ? "anchored_" + cell.e : cell.e;
      createPixel(id, R.gx[i], R.gy[i]);
      var p = pixelMap[R.gx[i]][R.gy[i]];
      if (p){ if (cell.c) p.color = cell.c; if (cell.t !== undefined) p.temp = cell.t; }
    }
  }
  NOJOIN = false;
}

/* ------------------------------------------------ elements: tabs + hooks */
if (elements.wall && !elements.physics_wall){
  var W0 = elements.wall;
  elements.physics_wall = Object.assign({}, W0, { category: "solids", desc: "A wall that obeys physics: falls when unsupported." });
  if (Array.isArray(W0.color)) elements.physics_wall.color = W0.color.slice();
  if (Array.isArray(W0.behavior)) elements.physics_wall.behavior = W0.behavior.slice();
  W0.category = "anchored";
}
function cloneReactions(r){
  var o = {};
  Object.keys(r).forEach(function(k){ o[k] = (r[k] && typeof r[k] === "object") ? Object.assign({}, r[k]) : r[k]; });
  return o;
}
function hookAll(){
  Object.keys(elements).forEach(function(id){
    var e = elements[id]; if (!e || e.__slh || !calcFall(id, e)) return;
    e.__slh = true;
    var prevP = e.onPlace, prevD = e.onDelete, prevR = e.renderer;
    if (id !== "physics_wall"){                         // anchored twin (copied BEFORE hooking so it keeps its own animation hooks)
      var a = Object.assign({}, e);
      if (Array.isArray(a.color)) a.color = a.color.slice();
      if (Array.isArray(a.behavior)) a.behavior = a.behavior.slice();
      if (a.reactions) a.reactions = cloneReactions(a.reactions);
      a.category = "anchored"; a.anchored = true; delete a.hidden; delete a.__slh;
      a.desc = "Anchored " + id.replace(/_/g, " ") + ": identical, but never falls.";
      if (!elements["anchored_" + id]) elements["anchored_" + id] = a;
    }
    e.onPlace = function(p){ if (prevP) prevP(p); if (!NOJOIN && p.sub === undefined){ p.pa = pixelTicks; mark(p.x, p.y); } };
    e.onDelete = function(p){ if (prevD) prevD(p); onDeleteProxy(p); };
    if (prevR){
      var wr = function(p, ctx){ if (p.sub !== undefined) return; return prevR(p, ctx); };
      wr.__bord = (typeof renderPresets !== "undefined" && prevR === renderPresets.BORDER);
      e.renderer = wr;
    }
  });
  hookedCount = Object.keys(elements).length;
}
hookAll();
function hideFootprints(){
  if (typeof viewInfo === "undefined") return;
  Object.keys(viewInfo).forEach(function(v){
    var vi = viewInfo[v];
    if (vi && typeof vi.pixel === "function" && !vi.pixel.__sl){
      var o = vi.pixel;
      vi.pixel = function(p, ctx){ if (p.sub !== undefined) return; return o(p, ctx); };
      vi.pixel.__sl = true;
    }
  });
}
if (typeof runAfterLoad === "function") runAfterLoad(function(){ hookAll(); hideFootprints(); }); else hideFootprints();

/* ---------------------------------------------------------------- tools */
function bodyOf(p){ return (p.sub !== undefined) ? (BODIES[p.sub] || null) : null; }
elements.physgrab = { color: "#4dffb8", category: "tools", canPlace: false,
  desc: "Click a physics body and drag: it follows the mouse like a spring.",
  tool: function(p){
    if (GRAB) return;
    var b = bodyOf(p); if (!b || !b.pb || b.frozen) return;
    syncPose(b);
    var l = toLocal(b, mousePos.x, mousePos.y);
    GRAB = { b: b, lx: l.x, ly: l.y };
    b.hold = 0;
  } };
elements.physkick = { color: "#ffd24d", category: "tools", canPlace: false,
  desc: "Hits a physics body at that spot: shoves it and spins it.",
  tool: function(p){
    var b = bodyOf(p); if (!b || !b.pb || b.kt === pixelTicks) return; b.kt = pixelTicks;
    var m = b.pb.getMass();
    b.pb.applyLinearImpulse(PL.Vec2((Math.random()*2 - 1)*0.9*m, -1.5*m*b.gf), PL.Vec2(p.x, p.y), true);
  } };
elements.physicsspin = { color: "#7bdcff", category: "tools", canPlace: false,
  desc: "Gives a physics body a burst of spin.",
  tool: function(p){
    var b = bodyOf(p); if (!b || !b.pb || (b.st !== undefined && pixelTicks - b.st < 10)) return;
    b.st = pixelTicks; b.pb.applyAngularImpulse((chance(0.5) ? 1 : -1)*0.08*b.pb.getInertia(), true);
  } };
elements.physicsfreeze = { color: "#7bdcff", category: "tools", canPlace: false,
  desc: "Freezes a physics body in place (still rotated, still off-grid).",
  tool: function(p){ var b = bodyOf(p); if (b) b.frozen = true; } };
elements.physicsunfreeze = { color: "#ff9d7b", category: "tools", canPlace: false,
  desc: "Unfreezes a frozen physics body so it moves again.",
  tool: function(p){ var b = bodyOf(p); if (b){ b.frozen = false; b.hold = 0; } } };
elements.physicsflip = { color: "#c792ff", category: "tools", canPlace: false,
  desc: "Flips the gravity direction of a physics body.",
  tool: function(p){
    var b = bodyOf(p); if (!b || (b.ft !== undefined && pixelTicks - b.ft < 15)) return;
    b.ft = pixelTicks; b.gf = -b.gf; if (b.pb){ b.pb.setGravityScale(b.gf); b.pb.setAwake(true); }
  } };
elements.physicssnap = { color: "#ffb347", category: "tools", canPlace: false,
  desc: "Snaps a physics body onto the grid as anchored blocks, exactly as its rotated shape rasterises.",
  tool: function(p){ var b = bodyOf(p); if (b && !b.dead) snapBody(b, false); } };
elements.physicsalignedsnap = { color: "#6be08a", category: "tools", canPlace: false,
  desc: "Rotates a physics body to the grid perfectly, then snaps it as anchored blocks without deforming it.",
  tool: function(p){ var b = bodyOf(p); if (b && !b.dead) snapBody(b, true); } };
if (elements.erase && typeof elements.erase.tool === "function" && !elements.erase.tool.__sl){
  var eraseOrig = elements.erase.tool;
  elements.erase.tool = function(p){ if (ERASEGUARD && p && p.sub !== undefined) return; return eraseOrig.apply(this, arguments); };
  elements.erase.tool.__sl = true;
}

/* --------------------------------------------------- change notifications */
function wrap(name, make){
  var o = globalThis[name];
  if (typeof o === "function" && !o.__sl){ var w = make(o); w.__sl = true; globalThis[name] = w; }
}
function quiet(p){ var e = p && elements[p.element]; return !p || p.sub !== undefined || (e && (e.state === "liquid" || e.state === "gas")); }
wrap("createPixel", function(o){ return function(el, x, y){
  o(el, x, y);
  if (!NOJOIN){ var p = pxAt(x, y); if (p && isFaller(p)) mark(x, y); } }; });
wrap("deletePixel", function(o){ return function(x, y){
  var p = pixelMap[x] && pixelMap[x][y];
  if (ERASEGUARD && p && p.sub !== undefined) return;
  var q = quiet(p); o(x, y); if (!q) mark(x, y); }; });
wrap("changePixel", function(o){ return function(pixel){
  var q = quiet(pixel); o.apply(this, arguments); if (!q || !quiet(pixel)) mark(pixel.x, pixel.y); }; });
wrap("movePixel", function(o){ return function(pixel, x, y){
  var q = quiet(pixel), ox = pixel.x, oy = pixel.y; o.apply(this, arguments); if (!q) mark(ox, oy); }; });
wrap("swapPixels", function(o){ return function(a, b){
  var q = quiet(a) && quiet(b), ax = a.x, ay = a.y, bx = b.x, by = b.y; o(a, b); if (!q){ mark(ax, ay); mark(bx, by); } }; });
wrap("explodeAt", function(o){ return function(x, y, radius, fire){
  o.apply(this, arguments);
  if (!world) return;
  var R2 = radius*2, keys = Object.keys(BODIES);
  for (var i = 0; i < keys.length; i++){
    var b = BODIES[keys[i]]; if (!b || b.dead || !b.pb) continue;
    var dx = b.x - x, dy = b.y - y, dist = Math.sqrt(dx*dx + dy*dy) || 1;
    if (dist > R2 + b.rad) continue;
    var f = Math.max(0, 1 - dist/(R2 + b.rad)), m = b.pb.getMass();
    var dv = R2 * 0.2 * Math.sqrt(f);
    b.frozen = false; b.hold = 0; if (b.pb.getType() !== "dynamic") b.pb.setType("dynamic");
    b.pb.applyLinearImpulse(PL.Vec2(dx/dist*dv*m, (dy/dist*dv - dv*0.3)*m), b.pb.getWorldCenter(), true);
    b.pb.applyAngularImpulse((Math.random() - 0.5)*0.15*f*b.pb.getInertia(), true);
    b.cells.forEach(function(cell, k){
      var w = toWorld(b, cell.x, cell.y);
      var dd = Math.sqrt((w.x-x)*(w.x-x) + (w.y-y)*(w.y-y));
      if (dd < radius && chance(0.55*(1 - dd/radius))) removeCell(b, k, true);
    });
  }
}; });

/* ------------------------------------- drawing / erasing in a body's own grid */
function line4(x0, y0, x1, y1){                    // 4-connected line: never leaves diagonal gaps that split a body
  var pts = [[x0, y0]], dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  var err = dx - dy, x = x0, y = y0, guard = 0;
  while (!(x === x1 && y === y1) && guard++ < 5000){
    var e2 = 2*err, mx = false, my = false;
    if (e2 > -dy){ err -= dy; x += sx; mx = true; }
    if (e2 < dx){ err += dx; y += sy; my = true; }
    if (mx && my) pts.push([x - sx, y]);
    pts.push([x, y]);
  }
  return pts;
}
function bodyNear(x, y, reach){
  for (var d = 0; d <= reach; d++){
    for (var dx = -d; dx <= d; dx++) for (var dy = -d; dy <= d; dy++){
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
      var p = pxAt(x + dx, y + dy);
      if (p && p.sub !== undefined && BODIES[p.sub]) return BODIES[p.sub];
    }
  }
  return null;
}
function strokeBodies(x1, y1, x2, y2, reach){
  var pts = line4(x2, y2, x1, y1), out = [], seen = {}, stride = Math.max(1, Math.floor(pts.length/150));
  for (var i = 0; i < pts.length; i += stride){
    var b = bodyNear(pts[i][0], pts[i][1], reach);
    if (b && !seen[b.id]){ seen[b.id] = 1; out.push(b); }
  }
  return out;
}
function brushSize(){ return (typeof mouseSize !== "undefined" && mouseSize) ? mouseSize : 1; }
function localBrush(b, x1, y1, x2, y2, size){
  var a = toLocal(b, x1, y1), z = toLocal(b, x2, y2);
  var pts = line4(Math.round(a.x), Math.round(a.y), Math.round(z.x), Math.round(z.y));
  var mo = size/2, mn = Math.trunc(mo), mx = mn - (mo % 1 ? 0 : 1), out = new Map();
  for (var i = 0; i < pts.length; i++)
    for (var lx = pts[i][0] - mn; lx <= pts[i][0] + mx; lx++) for (var ly = pts[i][1] - mn; ly <= pts[i][1] + mx; ly++)
      out.set(K(lx, ly), [lx, ly]);
  return out;
}
function placeLocal(b, set, el, replace){
  syncPose(b);
  var added = 0;
  set.forEach(function(lc){
    var lx = lc[0], ly = lc[1];
    if (Math.abs(lx) > 2000 || Math.abs(ly) > 2000) return;
    var k = K(lx, ly), ex = b.cells.get(k);
    if (ex){ if (replace && ex.e !== el){ ex.e = el; ex.c = undefined; ex.t = 20; added++; } return; }
    var w = toWorld(b, lx, ly), gx = Math.round(w.x), gy = Math.round(w.y);
    if (outOfBounds(gx, gy)) return;
    var o = pixelMap[gx][gy];
    if (o && ((o.sub !== undefined && o.sub !== b.id) || (o.sub === undefined && occState(o) === 1))) return;
    b.cells.set(k, { x: lx, y: ly, e: el, c: undefined, t: 20 }); added++;
  });
  if (!added) return;
  b.hold = pixelTicks + HOLD;
  if (b.pb && b.pb.getType() !== "static") b.pb.setType("static");
  fixBody(b);                                           // ONE rebuild per stroke event
}
function eraseLocal(b, set){
  syncPose(b);
  var any = false;
  set.forEach(function(lc){ var k = K(lc[0], lc[1]); if (b.cells.has(k)){ b.cells.delete(k); any = true; } });
  if (!any) return;
  b.hold = pixelTicks + HOLD;
  if (b.pb && b.pb.getType() !== "static") b.pb.setType("static");
  fixBody(b);
}
function strokeStart(e, mx, my, sp){
  if (mx === undefined && my === undefined && typeof getMousePos === "function"){
    lastPos = mousePos; mousePos = getMousePos(canvas, e); mx = mousePos.x; my = mousePos.y;
  }
  return { x: mx, y: my, s: sp || lastPos };
}
wrap("mouse1Action", function(o){ return function(e, mx, my, sp){
  if (!world) return o.apply(this, arguments);
  var st = strokeStart(e, mx, my, sp), el = currentElement, ed = elements[el], sz = brushSize();
  if (ed && !ed.tool && fallEl(el)){
    var bs = strokeBodies(st.s.x, st.s.y, st.x, st.y, Math.min(5, 1 + Math.floor(sz/2)));
    if (bs.length){
      var near = bodyNear(st.x, st.y, 5) || bs[0];
      placeLocal(near, localBrush(near, st.s.x, st.s.y, st.x, st.y, sz), el, typeof mode !== "undefined" && mode === "replace");
      return;
    }
  } else if (el === "erase"){
    var eb = strokeBodies(st.s.x, st.s.y, st.x, st.y, Math.floor(sz/2));
    if (eb.length){
      eb.forEach(function(b){ eraseLocal(b, localBrush(b, st.s.x, st.s.y, st.x, st.y, sz)); });
      ERASEGUARD = true;
      try { return o.call(this, e, st.x, st.y, st.s); } finally { ERASEGUARD = false; }
    }
  }
  return o.call(this, e, st.x, st.y, st.s);
}; });
wrap("mouse2Action", function(o){ return function(e, mx, my, sp){
  if (!world) return o.apply(this, arguments);
  var st = strokeStart(e, mx, my, sp), sz = brushSize();
  var eb = strokeBodies(st.s.x, st.s.y, st.x, st.y, Math.floor(sz/2));
  if (eb.length){
    eb.forEach(function(b){ eraseLocal(b, localBrush(b, st.s.x, st.s.y, st.x, st.y, sz)); });
    ERASEGUARD = true;
    try { return o.call(this, e, st.x, st.y, st.s); } finally { ERASEGUARD = false; }
  }
  return o.call(this, e, st.x, st.y, st.s);
}; });
/* the game calls drawCursor() every frame: replace its square with the body-grid square when over a body */
wrap("drawCursor", function(o){ return function(){
  var b = null;
  try {
    if (world && typeof mousePos !== "undefined" && !(typeof shaping !== "undefined" && shaping)){
      var el = currentElement, ed = elements[el], sz = brushSize();
      if (el === "erase") b = bodyNear(mousePos.x, mousePos.y, Math.floor(sz/2));
      else if (ed && !ed.tool && fallEl(el)) b = bodyNear(mousePos.x, mousePos.y, Math.min(5, 1 + Math.floor(sz/2)));
    }
  } catch (err) { b = null; }
  if (!b) return o.apply(this, arguments);
  var sa = mouseAlpha; mouseAlpha = 0;                       // let the game draw its extras (line preview, edit marks) but hide its square
  try { o.apply(this, arguments); } finally { mouseAlpha = sa; }
  var lctx = canvasLayers.gui.getContext("2d"), ps = pixelSize, sz2 = brushSize();
  var mo = sz2/2, mn = Math.trunc(mo), mx2 = mn - (mo % 1 ? 0 : 1);
  var l = toLocal(b, mousePos.x, mousePos.y), lx = Math.round(l.x), ly = Math.round(l.y);
  lctx.save();
  lctx.globalAlpha = mouseAlpha;
  lctx.lineWidth = 2;
  lctx.strokeStyle = mouseColor || (typeof settings !== "undefined" && settings.mouseColor) || "white";
  lctx.translate((b.x + 0.5)*ps, (b.y + 0.5)*ps); lctx.rotate(b.a);
  lctx.strokeRect((lx - mn - 0.5)*ps, (ly - mn - 0.5)*ps, (mn + mx2 + 1)*ps, (mn + mx2 + 1)*ps);
  lctx.restore();
}; });

/* --------------------------------------------------------------- hooks */
runEveryTick(function(){
  if (!PL) loadPlanck();
  if (PL && !world) initWorld();
  if (pixelTicks % 90 === 0 && Object.keys(elements).length !== hookedCount) hookAll();
  if (!world) return;
  processSupport();
  var ids = Object.keys(BODIES), i, b;
  for (i = 0; i < ids.length; i++){ b = BODIES[ids[i]]; if (b && !b.dead) watchProxies(b); }
  for (i = 0; i < ids.length; i++){ b = BODIES[ids[i]]; if (b && !b.dead && b.dirty) fixBody(b); }
  ids = Object.keys(BODIES);
  for (i = 0; i < ids.length; i++){ b = BODIES[ids[i]]; if (b && !b.dead){ ensurePB(b); if (b.needSync){ b.needSync = false; syncProxies(b); } } }

  if (GRAB && (!mouseIsDown || currentElement !== "physgrab" || GRAB.b.dead || !GRAB.b.pb)) GRAB = null;

  var forces = [], maxSp = 0;
  for (i = 0; i < ids.length; i++){
    b = BODIES[ids[i]]; if (!b || b.dead || !b.pb) continue;
    var stat = b.frozen || pixelTicks < b.hold, want = stat ? "static" : "dynamic";
    if (b.pb.getType() !== want){ b.pb.setType(want); if (!stat){ b.pb.setGravityScale(b.gf); b.pb.setAwake(true); } }
    if (stat) continue;
    var R = raster(b, b.x, b.y, b.a), fl = fluidInfo(b, R); b.wet = fl.n;
    var m = b.pb.getMass(), lin = 0.002, ang = 0.02, Fb = 0, v = b.pb.getLinearVelocity();
    var sp = Math.sqrt(v.x*v.x + v.y*v.y);
    maxSp = Math.max(maxSp, sp + Math.abs(b.pb.getAngularVelocity())*b.rad*0.5);
    if (fl.n > 0){
      Fb = fl.rho/1000 * fl.n * G;
      var capUp = G * 1.8 * m; if (Fb > capUp) Fb = capUp;
      var frac = Math.min(1, fl.n/b.cells.size), avgD = m / b.cells.size * 1000;
      lin = Math.min(0.7, frac*(0.14 + 0.16*sp + Math.min(0.3, 0.02*fl.rho/Math.max(30, avgD))));
      ang = Math.min(0.5, 0.28*frac);
    }
    if (GRAB && GRAB.b === b){ ang = Math.max(ang, 0.25); lin = Math.max(lin, 0.02); b.pb.setAwake(true); maxSp = 1; }
    b.pb.setLinearDamping(lin); b.pb.setAngularDamping(ang);
    forces.push({ b: b, F: Fb, x: fl.cx, y: fl.cy });
  }
  if (maxSp > 0.03 || pixelTicks % 5 === 0) refreshTerrain();
  for (var s = 0; s < SUB; s++){
    for (i = 0; i < forces.length; i++) if (forces[i].F > 0) forces[i].b.pb.applyForce(PL.Vec2(0, -forces[i].F), PL.Vec2(forces[i].x, forces[i].y), true);
    if (GRAB && GRAB.b.pb && GRAB.b.pb.getType() === "dynamic"){
      var gb = GRAB.b, pb = gb.pb, pt = pb.getWorldPoint(PL.Vec2(GRAB.lx, GRAB.ly)), gv = pb.getLinearVelocityFromWorldPoint(pt);
      var gm = pb.getMass(), ax = 0.05*(mousePos.x - pt.x) - 0.45*gv.x, ay = 0.05*(mousePos.y - pt.y) - 0.45*gv.y;
      var al = Math.sqrt(ax*ax + ay*ay); if (al > 1.2){ ax *= 1.2/al; ay *= 1.2/al; }
      pb.applyForce(PL.Vec2(gm*ax, gm*ay - gm*G*gb.gf*0.95), pt, true);
    }
    world.step(DT, 6, 2);
  }
  processImpacts(); processPushes();
  for (i = 0; i < ids.length; i++){
    b = BODIES[ids[i]]; if (!b || b.dead || !b.pb) continue;
    var ps = b.pb.getPosition(); b.x = ps.x; b.y = ps.y; b.a = b.pb.getAngle();
    if (Math.abs(b.x - b.sx) + Math.abs(b.y - b.sy) > 0.02 || Math.abs(b.a - b.sa) > 0.01) syncProxies(b);
  }
});
runPerPixel(function(p){
  if (p.sub !== undefined){
    var b = BODIES[p.sub];
    if (!b || b.proxies.get(GK(p.x, p.y)) !== p) p.sub = undefined;
  } else if (p.pvx !== undefined) flyGrain(p);
});
runAfterReset(function(){
  BODIES = {}; dirtyA.length = 0; dirtyS.clear(); impacts.length = 0; pushes.length = 0; tfix.clear(); RIDERS.clear(); GC = new Set(); GRAB = null;
  if (world){ world = null; terrain = null; }
});
renderPostPixel(function(ctx){
  var ps = pixelSize, keys = Object.keys(BODIES);
  var bord = (typeof renderPresets !== "undefined") ? renderPresets.BORDER : null;
  for (var i = 0; i < keys.length; i++){
    var b = BODIES[keys[i]]; if (!b) continue;
    ctx.save();
    ctx.translate((b.x + 0.5)*ps, (b.y + 0.5)*ps); ctx.rotate(b.a);
    var size = ps + 0.7;
    b.cells.forEach(function(c){
      var X = (c.x - 0.5)*ps - 0.35, Y = (c.y - 0.5)*ps - 0.35;
      ctx.globalAlpha = (c.al === undefined || c.al === null) ? 1 : clamp(c.al, 0, 1);
      ctx.fillStyle = c.c || "#999999"; ctx.fillRect(X, Y, size, size);
      ctx.globalAlpha = 1;
      if (c.chg){ ctx.fillStyle = "rgba(255,255,0,0.55)"; ctx.fillRect(X, Y, size, size); }
      var el = elements[c.e];
      if (bord && el && el.renderer && el.renderer.__bord){
        var edge = false;
        for (var d = 0; d < 4; d++) if (!b.cells.has(K(c.x + D4[d][0], c.y + D4[d][1]))){ edge = true; break; }
        if (edge){ ctx.fillStyle = "rgba(255,255,255,0.25)"; ctx.fillRect(X, Y, size, size); }
      }
    });
    if (b.frozen){ ctx.strokeStyle = "rgba(123,220,255,0.9)"; ctx.lineWidth = 1; ctx.strokeRect(-ps*b.rad, -ps*b.rad, ps*2*b.rad, ps*2*b.rad); }
    ctx.restore();
  }
  if (GRAB && GRAB.b && !GRAB.b.dead && GRAB.b.pb){
    var gp = GRAB.b.pb.getWorldPoint(PL.Vec2(GRAB.lx, GRAB.ly));
    ctx.save(); ctx.globalAlpha = 0.9; ctx.strokeStyle = "#4dffb8"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo((gp.x + 0.5)*ps, (gp.y + 0.5)*ps); ctx.lineTo((mousePos.x + 0.5)*ps, (mousePos.y + 0.5)*ps); ctx.stroke();
    ctx.restore();
  }
});

loadPlanck();
globalThis.__SUBLEVEL_BODIES__ = function(){ return BODIES; };
if (globalThis.__SUBLEVEL_TEST__){
  globalThis.__SUBLEVEL_TEST__ = { BODIES: function(){ return BODIES; }, fallEl: fallEl, snapBody: snapBody, physOf: physOf, checkSupport: checkSupport,
    processSupport: processSupport, placeLocal: placeLocal, localBrush: localBrush, eraseLocal: eraseLocal, world: function(){ return world; } };
}
if (typeof logMessage === "function") logMessage("Sublevel Physics v6 loaded (Planck.js). Load it LAST in the mod list. New tool: physgrab.");

})();
