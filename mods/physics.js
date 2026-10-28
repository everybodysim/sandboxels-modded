/* ============================================================================
   SUBLEVEL PHYSICS v4  -  Sandboxels 1.13.x

   * EVERY solid in the Solids tab falls when unsupported (copper, iron, glass,
     bricks ... even ones the game never tags with a state). The whole connected
     chunk unhooks into a free rotating rigid body. "Physics wall" lives in the
     Solids tab; the ordinary "wall" moved to the Anchored tab.
   * A body's cells are REAL pixels of their element in the grid (their
     footprint, drawn invisibly - the body is drawn rotated on top). So the game
     itself does the rest: acid dissolves them, fire burns wood, heat melts
     metal, electricity conducts, explosions/tools/radiation all just work.
     Whatever a footprint turns into is synced back into the body.
   * Per-solid physics numbers: density, bounce, friction, toughness
     (ice slippery, steel tough, glass brittle, rubber bouncy ...).
   * Archimedes buoyancy incl. hollow hulls (cups/boats), with a pool check so
     carried water can't give infinite lift, and clamped lift so ultra-light
     things (straw) don't catapult out of water.
   * Heavy bodies sink through sand/gravel slowly, light ones rest on top.
   * Place solids touching a body (big brushes too): they join it, body is held
     still while you build. Erase to cut / split.
   * Tools: physkick, physicsspin, physicsflip, physicsfreeze, physicsunfreeze,
            physicssnap, physicsalignedsnap
   ========================================================================== */
(function () {

var G = 0.09, MAXV = 3.0, MAXW = 0.22, HOLD = 12;
var BODIES = {}, FALL = {}, PC = {};
var baseId = Math.floor(Math.random()*1e8) * 100, idc = 1;
var NOJOIN = false, dirtyA = [], dirtyS = new Set();
var D4 = [[1,0],[-1,0],[0,1],[0,-1]];
var COV_T = 0.35, COV_B = 0.55, COV_SOFT = 0.55;     // coverage needed before an overlap counts

function chance(p){ return Math.random() < p; }
function pick(a){ return a[Math.floor(Math.random()*a.length)]; }
function sign(v){ return v > 0 ? 1 : v < 0 ? -1 : 0; }
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

/* ------------------------------------- per-element physics characteristics */
function hash(s){ var h = 2166136261; for (var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function physOf(id){
  var P = PC[id]; if (P) return P;
  var e = elements[id] || {}, h = hash(id);
  var r1 = (h & 255)/255, r2 = ((h >>> 8) & 255)/255, r3 = ((h >>> 16) & 255)/255;
  var dens = Math.max(30, Math.min(9000, e.density || 1500));
  var hard = e.hardness !== undefined ? e.hardness : 0.3 + 0.6*r1;
  var bounce = 0.03 + 0.27*r2, fric = 0.25 + 0.55*r3;
  if (/rubber|slime|jelly|gummy|tire|ball|bounc/.test(id)){ bounce = 0.7 + 0.25*r2; fric = 0.85; hard = Math.max(hard, 0.7); }
  else if (/ice|rime/.test(id)){ bounce = 0.08; fric = 0.1; hard = Math.min(hard, 0.3); }
  else if (/glass|porcelain|crystal|ceramic|pyrite|ruby|sapphire|quartz/.test(id)){ bounce = 0.05 + 0.15*r2; hard = Math.min(hard, 0.25); fric = 0.3 + 0.2*r3; }
  else if (/steel|titan|tungsten|adamant|iron/.test(id)){ bounce = 0.02 + 0.05*r2; fric = 0.3 + 0.15*r3; hard = Math.max(hard, 0.93); }
  else if (/copper|gold|silver|lead|zinc|tin|nickel|alumin|brass|bronze|platin|metal|cobalt|chrom/.test(id)){ bounce = 0.02 + 0.08*r2; fric = 0.28 + 0.2*r3; hard = Math.max(hard, 0.75); }
  else if (/wood|plank|bamboo|board|paper|cork|foam|sponge|bone|straw/.test(id)){ bounce = 0.1 + 0.12*r2; fric = 0.55 + 0.15*r3; hard = Math.min(Math.max(hard, 0.3), 0.5); }
  hard = Math.max(0.05, Math.min(0.98, hard));
  var br = e.breakInto; if (Array.isArray(br)) br = br[0];
  var debris = (br && elements[br]) ? br : (elements.gravel ? "gravel" : null);
  P = PC[id] = { dens: dens, bounce: bounce, fric: fric, hard: hard, g: 1, debris: debris };
  return P;
}

/* ------------------------------------------------------------ transforms */
function toWorld(b,lx,ly){
  var u = lx - b.com.x, v = ly - b.com.y, c = Math.cos(b.a), s = Math.sin(b.a);
  return { x: b.x + u*c - v*s, y: b.y + u*s + v*c };
}
function toLocal(b,wx,wy){
  var dx = wx - b.x, dy = wy - b.y, c = Math.cos(b.a), s = Math.sin(b.a);
  return { x: dx*c + dy*s + b.com.x, y: -dx*s + dy*c + b.com.y };
}

/* ---------------------------------------------------------- body building */
function calc(b, keepWorld){
  var m = 0, cx = 0, cy = 0, bo = 0, fr = 0, hd = 0, n = b.cells.size;
  if (!n){ b.m = 0; return; }
  b.cells.forEach(function(c){
    var P = physOf(c.e); m += P.dens; cx += P.dens*c.x; cy += P.dens*c.y; bo += P.bounce; fr += P.fric; hd += P.hard;
  });
  var ncx = cx/m, ncy = cy/m;
  if (keepWorld){
    var ow = toWorld(b, ncx, ncy), rx = ow.x - b.x, ry = ow.y - b.y;
    b.vx += -b.w*ry; b.vy += b.w*rx; b.x = ow.x; b.y = ow.y;
  }
  b.com.x = ncx; b.com.y = ncy;
  var I = 0, rad = 0;
  b.cells.forEach(function(c){
    var P = physOf(c.e), dx = c.x - ncx, dy = c.y - ncy;
    I += P.dens*(dx*dx + dy*dy + 1/6); rad = Math.max(rad, Math.sqrt(dx*dx + dy*dy) + 0.75);
  });
  b.m = m; b.I = Math.max(I, 1e-3); b.bounce = bo/n; b.fric = fr/n; b.hard = hd/n; b.g = 1; b.rad = rad;
}
function makeBody(cells, ang, vx, vy, w, gf){
  var b = { id: baseId + (idc++), cells: cells, x: 0, y: 0, a: ang || 0, vx: vx || 0, vy: vy || 0,
    w: w || 0, gf: gf || 1, com: { x:0, y:0 }, proxies: new Map(), dirty: false, sleep: 0, sleepT: 0,
    rest: 0, sinkLeft: 4, wet: 0, debris: [], dead: false, stuck: false, touch: false, plow: 0, hold: 0, frozen: false, needSync: false };
  calc(b); BODIES[b.id] = b; return b;
}
function raster(b, x, y, a){
  var c = Math.cos(a), s = Math.sin(a), r = b.rad, cm = b.com;
  var gx0 = Math.floor(x - r), gx1 = Math.ceil(x + r), gy0 = Math.floor(y - r), gy1 = Math.ceil(y + r);
  var out = { gx: [], gy: [], ck: [] };
  for (var gx = gx0; gx <= gx1; gx++) for (var gy = gy0; gy <= gy1; gy++){
    var dx = gx - x, dy = gy - y;
    var k = K(Math.round(dx*c + dy*s + cm.x), Math.round(-dx*s + dy*c + cm.y));
    if (b.cells.has(k)){ out.gx.push(gx); out.gy.push(gy); out.ck.push(k); }
  }
  return out;
}

/* ----------------------------------------------------- grid obstacle test */
/* 0 free, 1 terrain, 2 other body, 3 soft (plowed aside by heavy bodies), 4 graze (ignored) */
function blocker(b, gx, gy, speed, cov){
  if (outOfBounds(gx,gy)) return 1;
  var p = pixelMap[gx][gy];
  if (!p || p.sub === b.id) return 0;
  if (p.sub !== undefined) return BODIES[p.sub] ? 2 : 1;
  var e = elements[p.element];
  if (!e) return 1;
  if (e.state === "liquid" || e.state === "gas") return (cov !== undefined && cov < COV_SOFT) ? 4 : 0;
  if (e.movable === true && e.category !== "tools"){          // sand, gravel, plants, critters...
    var ratio = (b.m / b.cells.size) / Math.max(1, e.density || 1000);
    if ((ratio > 1.5 || (ratio > 1.0 && speed > 2.0)) && b.sinkLeft > 0) return (cov !== undefined && cov < COV_SOFT) ? 4 : 3;   // sinks at most ~4 pixels
    return 1;                                                 // lighter bodies rest ON the powder
  }
  return 1;
}
/* grid cell counts if its unit square overlaps a body cell; cov = covered fraction (5 subsamples) */
function rasterC(b, x, y, a){
  var c = Math.cos(a), s = Math.sin(a), r = b.rad + 0.5, cm = b.com;
  var gx0 = Math.floor(x - r), gx1 = Math.ceil(x + r), gy0 = Math.floor(y - r), gy1 = Math.ceil(y + r);
  var out = { gx: [], gy: [], cov: [] };
  var offs = [[0,0],[0.26,0.26],[-0.26,0.26],[0.26,-0.26],[-0.26,-0.26]];
  for (var gx = gx0; gx <= gx1; gx++) for (var gy = gy0; gy <= gy1; gy++){
    var ins = 0;
    for (var i = 0; i < 5; i++){
      var dx = gx - x + offs[i][0], dy = gy - y + offs[i][1];
      if (b.cells.has(K(Math.round(dx*c + dy*s + cm.x), Math.round(-dx*s + dy*c + cm.y)))) ins++;
    }
    if (ins > 0){ out.gx.push(gx); out.gy.push(gy); out.cov.push(ins/5); }
  }
  return out;
}
function contacts(b, x, y, a, speed){
  var R = rasterC(b, x, y, a), n = 0, sx = 0, sy = 0, hits = [], other = null, plow = 0;
  for (var i = 0; i < R.gx.length; i++){
    var t = blocker(b, R.gx[i], R.gy[i], speed, R.cov[i]);
    if (t === 0 || t === 4) continue;
    if (t === 3){ plow++; continue; }
    if (t === 1 && R.cov[i] < COV_T) continue;                 // tolerate a sliver of overlap (no jitter)
    if (t === 2 && R.cov[i] < COV_B) continue;
    n++; sx += R.gx[i]; sy += R.gy[i];
    if (hits.length < 12) hits.push([R.gx[i], R.gy[i]]);
    if (t === 2 && !other){ var p = pixelMap[R.gx[i]][R.gy[i]]; other = BODIES[p.sub] || null; }
  }
  return { n:n, cx: n ? sx/n : x, cy: n ? sy/n : y, hits:hits, other:other, plow:plow };
}
function normalAt(b, c, speed){
  var gx0 = Math.round(c.cx), gy0 = Math.round(c.cy), sx = 0, sy = 0;
  for (var dx = -2; dx <= 2; dx++) for (var dy = -2; dy <= 2; dy++){
    var t = blocker(b, gx0+dx, gy0+dy, speed, 1);
    if (t === 1 || t === 2){ sx += gx0 + dx - c.cx; sy += gy0 + dy - c.cy; }
  }
  var nx = -sx, ny = -sy, len = Math.sqrt(nx*nx + ny*ny);
  var tx = b.x - c.cx, ty = b.y - c.cy;
  if (len < 1e-3){ nx = tx; ny = ty; len = Math.sqrt(nx*nx + ny*ny); }
  if (len < 1e-3){ nx = 0; ny = -1; len = 1; }
  nx /= len; ny /= len;
  if (nx*tx + ny*ty < -0.2){ nx = -nx; ny = -ny; }
  if (Math.abs(nx) < 0.38){ nx = 0; ny = sign(ny) || -1; }          // axis-snap: stray pixels can't push sideways forever
  else if (Math.abs(ny) < 0.38){ ny = 0; nx = sign(nx); }
  else { len = Math.sqrt(nx*nx + ny*ny); nx /= len; ny /= len; }
  return { x:nx, y:ny };
}

/* -------------------------------------------------------------- impulses */
function impulse(b, c, n){
  var rx = c.cx - b.x, ry = c.cy - b.y;
  var vcx = b.vx - b.w*ry, vcy = b.vy + b.w*rx;
  var o = c.other, invm2 = 0, invI2 = 0, orx = 0, ory = 0, ovx = 0, ovy = 0;
  if (o){
    orx = c.cx - o.x; ory = c.cy - o.y; ovx = o.vx - o.w*ory; ovy = o.vy + o.w*orx; invm2 = 1/o.m; invI2 = 1/o.I;
  }
  var vn = (vcx - ovx)*n.x + (vcy - ovy)*n.y;
  if (vn >= -0.01) return 0;
  var e = Math.abs(vn) < 0.6 ? 0 : (o ? Math.min(b.bounce, o.bounce) : b.bounce);   // resting contact: no bounce
  var rn = rx*n.y - ry*n.x, orn = orx*n.y - ory*n.x;
  var j = -(1+e)*vn/(1/b.m + rn*rn/b.I + invm2 + orn*orn*invI2);
  b.vx += j*n.x/b.m; b.vy += j*n.y/b.m; b.w += rn*j/b.I;
  if (o){ o.vx -= j*n.x*invm2; o.vy -= j*n.y*invm2; o.w -= orn*j*invI2; o.sleep = 0; }
  var tx = -n.y, ty = n.x;
  vcx = b.vx - b.w*ry; vcy = b.vy + b.w*rx;
  if (o){ ovx = o.vx - o.w*ory; ovy = o.vy + o.w*orx; }
  var vt = (vcx - ovx)*tx + (vcy - ovy)*ty;
  var rt = rx*ty - ry*tx, ort = orx*ty - ory*tx;
  var jt = -vt/(1/b.m + rt*rt/b.I + invm2 + ort*ort*invI2), mx = (o ? Math.sqrt(b.fric*o.fric) : b.fric)*1.6*j;
  if (jt > mx) jt = mx; else if (jt < -mx) jt = -mx;
  b.vx += jt*tx/b.m; b.vy += jt*ty/b.m; b.w += rt*jt/b.I;
  if (o){ o.vx -= jt*tx*invm2; o.vy -= jt*ty*invm2; o.w -= ort*jt*invI2; }
  return -vn;
}
function smash(p){
  var e = elements[p.element]; if (!e || !e.breakInto) return;
  var t = e.breakInto; if (Array.isArray(t)) t = pick(t);
  if (t && elements[t]) changePixel(p, t);
}
function removeCell(b, k, debris){
  var cell = b.cells.get(k); if (!cell) return;
  b.cells.delete(k); b.dirty = true; b.sleep = 0;
  if (debris && chance(0.55)){
    var w = toWorld(b, cell.x, cell.y), d = physOf(cell.e).debris;
    if (d) b.debris.push([Math.round(w.x), Math.round(w.y), d]);
  }
}
/* toughness: every material has an impact speed it can shrug off (steel ~2.5, glass ~0.6) */
function damage(b, c, s){
  var i, tH = 0.6, mf = Math.max(0.2, Math.min(3, (b.m/b.cells.size)/1500 * (0.4 + Math.min(1.2, b.cells.size/40))));
  if (s > 1.0){
    for (i = 0; i < c.hits.length && i < 6; i++){
      var p = pxAt(c.hits[i][0], c.hits[i][1]);
      if (!p || p.sub !== undefined) continue;
      var e = elements[p.element];
      var hard = (e && e.hardness !== undefined) ? e.hardness : 0.6; tH = hard;
      if (e && e.breakInto && hard < 0.95 && chance(Math.min(0.7, (s - 1.0)*0.25*mf*(1-hard)))) smash(p);
    }
  }
  var lc = toLocal(b, c.cx, c.cy);
  b.cells.forEach(function(cell, k){
    var dx = cell.x - lc.x, dy = cell.y - lc.y;
    if (dx*dx + dy*dy > 2.9) return;
    var thr = 0.4 + 2.6*physOf(cell.e).hard;
    if (s <= thr) return;
    if (chance(Math.min(0.8, (s - thr)*0.45) * (0.5 + 0.5*(1 - tH)))) removeCell(b, k, true);
  });
}

/* ------------------------------------------------------------ integration */
function moveSub(b, h){
  var nx = b.x + b.vx*h, ny = b.y + b.vy*h, na = b.a + b.w*h;
  var spd = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
  var c = contacts(b, nx, ny, na, spd);
  if (c.plow) b.plow += c.plow;
  if (c.n === 0){ b.x = nx; b.y = ny; b.a = na; return; }
  b.touch = true;
  var damaged = false, ok = false;
  for (var it = 0; it < 2 && c.n > 0; it++){
    var n = normalAt(b, c, spd), s = impulse(b, c, n);
    if (s > 0 && !damaged){ damaged = true; damage(b, c, s); if (!b.cells.size) return; }
    var moved = 0;
    while (c.n > 0 && moved < 8){ nx += n.x*0.08; ny += n.y*0.08; moved++; c = contacts(b, nx, ny, na, spd); }
    if (c.n === 0){ ok = true; break; }
  }
  if (ok){ b.x = nx; b.y = ny; b.a = na; b.w *= 0.995; }
  else {                                                   // clipped: push out of the overlap instead of freezing
    var n0 = contacts(b, b.x, b.y, b.a, spd);
    if (n0.n > 0){
      var nn = normalAt(b, n0, spd); b.x += nn.x*0.2; b.y += nn.y*0.2;
      var vn0 = b.vx*nn.x + b.vy*nn.y; if (vn0 < 0){ b.vx -= vn0*nn.x; b.vy -= vn0*nn.y; }
    } else b.stuck = true;
  }
}
function escape(b){
  for (var r = 1; r <= 5; r++) for (var d = 0; d < 8; d++){
    var ang = d*Math.PI/4, x = b.x + Math.cos(ang)*r*0.4, y = b.y + Math.sin(ang)*r*0.4;
    if (contacts(b, x, y, b.a, 0).n === 0){ b.x = x; b.y = y; b.vx *= 0.3; b.vy *= 0.3; b.w *= 0.3; return true; }
  }
  return false;
}
/* is the liquid at p0 part of a real pool (reaches the body's own rows), not a lump carried on top? */
function pooled(p0, minY){
  var seen = new Set([p0]), q = [p0], n = 0;
  while (q.length && n < 250){
    var c = q.pop(); n++;
    if (c.y >= minY) return true;
    for (var d = 0; d < 4; d++){
      var m = pxAt(c.x + D4[d][0], c.y + D4[d][1]);
      if (m && m.sub === undefined && !seen.has(m)){
        var e = elements[m.element];
        if (e && e.state === "liquid"){ seen.add(m); q.push(m); }
      }
    }
  }
  return false;
}
/* buoyancy: submerged solid cells + enclosed dry air inside hollow hulls (cups, boats) */
function fluidInfo(b, R){
  var rows = {}, cols = {}, i, gx, gy, k, p, own = new Set(), minY = 1e9;
  for (i = 0; i < R.gx.length; i++){
    gx = R.gx[i]; gy = R.gy[i]; own.add(GK(gx, gy)); if (gy < minY) minY = gy;
    var r = rows[gy]; if (!r) rows[gy] = [gx,gx]; else { if (gx < r[0]) r[0] = gx; if (gx > r[1]) r[1] = gx; }
    var c = cols[gx]; if (!c) cols[gx] = [gy,gy]; else { if (gy < c[0]) c[0] = gy; if (gy > c[1]) c[1] = gy; }
  }
  var rw = {}, cw = {}, rho = 0, rn = 0, poolOk = null;
  for (k in rows){ p = liq(rows[k][0]-1, +k) || liq(rows[k][1]+1, +k); if (p){ rw[k] = 1; rho += elements[p.element].density; rn++; } }
  for (k in cols){
    p = liq(+k, cols[k][0]-1);
    if (p){
      if (poolOk === null) poolOk = pooled(p, minY);
      if (poolOk){ cw[k] = 1; rho += elements[p.element].density; rn++; }
    }
  }
  var cnt = 0, sx = 0, sy = 0;
  for (i = 0; i < R.gx.length; i++) if (rw[R.gy[i]] || cw[R.gx[i]]){ cnt++; sx += R.gx[i]; sy += R.gy[i]; }
  for (k in rw){                                   // dry air pockets between the walls also displace water
    var row = rows[k];
    for (var x = row[0] + 1; x < row[1]; x++){
      if (own.has(GK(x, +k))) continue;
      var q = outOfBounds(x, +k) ? null : pixelMap[x][+k];
      if (!q || (q.sub === undefined && elements[q.element] && elements[q.element].state === "gas")){ cnt++; sx += x; sy += +k; }
    }
  }
  return { n:cnt, cx: cnt ? sx/cnt : b.x, cy: cnt ? sy/cnt : b.y, rho: rn ? rho/rn : 1000 };
}

/* ------------------------------------------------------------- proxies */
/* a footprint pixel is a REAL pixel of the cell's element (hidden at draw time) */
function relocate(o, gx, gy, want, rr){
  for (var r = 1; r <= 12; r++){
    var cand = [];
    for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++){
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      var x = gx + dx, y = gy + dy;
      if (outOfBounds(x,y) || pixelMap[x][y] !== undefined || want.has(GK(x,y))) continue;
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
      var t = pick(cand);
      pixelMap[o.x][o.y] = undefined; o.x = t[0]; o.y = t[1]; pixelMap[t[0]][t[1]] = o; return true;
    }
  }
  pixelMap[o.x][o.y] = undefined; o.del = true; mark(gx, gy);
  return false;
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
  pix.color = cell.c || pix.color;
  return pix;
}
function syncProxies(b){
  var R = raster(b, b.x, b.y, b.a), RC = rasterC(b, b.x, b.y, b.a);
  var want = new Map(), cov = {}, i, spd = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
  for (i = 0; i < RC.gx.length; i++) cov[GK(RC.gx[i], RC.gy[i])] = RC.cov[i];
  var rr = {};
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
    pixelMap[pix.x][pix.y] = undefined; mark(pix.x, pix.y);
    (spareBy[pix.element] = spareBy[pix.element] || []).push(pix);
  });
  want.forEach(function(idx, gk){
    var gx = R.gx[idx], gy = R.gy[idx], o = pixelMap[gx][gy];
    var cell = b.cells.get(R.ck[idx]); if (!cell) return;
    if (o){
      var bt = blocker(b, gx, gy, spd, cov[gk] !== undefined ? cov[gk] : 1);
      if (bt === 1 || bt === 2 || bt === 4) return;       // overlap tolerated / barely-covered soft pixel left alone
      relocate(o, gx, gy, want, rr);
    }
    var pix = mkProxy(b, cell, gx, gy, spareBy);
    if (!pix) return;
    pix.sub = b.id; pix.ck = R.ck[idx];
    b.proxies.set(gk, pix);
  });
  for (var el in spareBy) spareBy[el].forEach(function(pix){ pix.sub = undefined; pix.del = true; });
}
function releaseProxies(b){
  b.proxies.forEach(function(pix){
    if (!pix.del && pixelMap[pix.x] && pixelMap[pix.x][pix.y] === pix) pixelMap[pix.x][pix.y] = undefined;
    pix.sub = undefined; pix.del = true; mark(pix.x, pix.y);
  });
  b.proxies.clear();
}
function killBody(b){ releaseProxies(b); b.dead = true; delete BODIES[b.id]; }
/* the game works on the footprint pixels (acid, fire, heat...). Pull the results back into the body. */
function watchProxies(b){
  var sum = {}, cnt = {}, chg = {};
  b.proxies.forEach(function(pix, gk){
    if (pix.del && pix.sub === b.id){                                   // deleted by the game
      b.proxies.delete(gk); if (b.cells.delete(pix.ck)) b.dirty = true; return;
    }
    if (pix.sub !== b.id || !pixelMap[pix.x] || pixelMap[pix.x][pix.y] !== pix || GK(pix.x, pix.y) !== gk){
      b.proxies.delete(gk); b.needSync = true; return;
    }
    var cell = b.cells.get(pix.ck); if (!cell) return;
    if (pix.element !== cell.e){                                       // melted / burnt / dissolved / reacted
      var NE = pix.element;
      if (FALL[NE]){ cell.e = NE; cell.c = pix.color; b.dirty = true; }
      else { b.cells.delete(pix.ck); b.proxies.delete(gk); pix.sub = undefined; b.dirty = true; mark(pix.x, pix.y); return; }
    }
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
  if (comps.length === 1){ calc(b, true); b.sleep = 0; syncProxies(b); return; }
  var created = [];
  comps.forEach(function(keys){
    var cells = new Map();
    keys.forEach(function(k){ cells.set(k, b.cells.get(k)); });
    var nb = makeBody(cells, b.a, b.vx, b.vy, b.w, b.gf);
    var w = toWorld(b, nb.com.x, nb.com.y), rx = w.x - b.x, ry = w.y - b.y;
    nb.x = w.x; nb.y = w.y; nb.vx = b.vx - b.w*ry; nb.vy = b.vy + b.w*rx;
    nb.hold = b.hold; nb.frozen = b.frozen;
    created.push(nb);
  });
  killBody(b);
  var cx = 0, cy = 0; created.forEach(function(n){ cx += n.x; cy += n.y; });
  cx /= created.length; cy /= created.length;
  created.forEach(function(n){
    var dx = n.x - cx, dy = n.y - cy, l = Math.sqrt(dx*dx + dy*dy) || 1;
    if (pixelTicks >= n.hold){ n.vx += dx/l*0.08; n.vy += dy/l*0.08; }
    syncProxies(n);
  });
}

/* ------------------------------------------------------ the body stepper */
function stepBody(b){
  if (b.dead) return;
  if (b.dirty){ fixBody(b); if (b.dead) return; }
  if (b.needSync){ b.needSync = false; syncProxies(b); }
  if (b.frozen || pixelTicks < b.hold){ b.vx = 0; b.vy = 0; b.w = 0; return; }
  if (b.sleep){
    b.sleepT++; if (b.sleepT % 5 !== 0) return;
    var gs0 = (b.g*b.gf) >= 0 ? 1 : -1;
    if (contacts(b, b.x, b.y + 0.3*gs0, b.a, 0).n === 0) b.sleep = 0; else return;
  }
  if (b.stuck){ b.stuck = false; escape(b); }
  var R0 = raster(b, b.x, b.y, b.a);
  var ay = b.g*b.gf*G, tq = 0;
  var fl = fluidInfo(b, R0); b.wet = fl.n;
  if (fl.n > 0){
    var Fb = fl.rho*fl.n*G, frac = Math.min(1, fl.n/b.cells.size), avgD = b.m/b.cells.size;
    var up = Fb/b.m, capUp = G*1.8;
    if (up > capUp){ Fb *= capUp/up; }                           // ultra-light stuff (straw) can't catapult out of water
    ay -= Fb/b.m; tq -= (fl.cx - b.x)*Fb;
    var sp = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
    var dk = Math.min(0.7, frac*(0.14 + 0.16*sp + Math.min(0.3, 0.02*fl.rho/Math.max(30, avgD))));
    b.vx *= 1 - dk; b.vy *= 1 - dk; b.w *= 1 - Math.min(0.5, 0.28*frac);
  }
  b.vy += ay; b.w += tq/b.I; b.w *= 0.998;
  if (b.vx > MAXV) b.vx = MAXV; else if (b.vx < -MAXV) b.vx = -MAXV;
  if (b.vy > MAXV) b.vy = MAXV; else if (b.vy < -MAXV) b.vy = -MAXV;
  if (b.w > MAXW) b.w = MAXW; else if (b.w < -MAXW) b.w = -MAXW;

  var rr = Math.sqrt(b.vx*b.vx + b.vy*b.vy) + Math.abs(b.w)*b.rad;
  var n = Math.min(8, Math.max(1, Math.ceil(rr/0.45))), h = 1/n;
  b.touch = false; b.plow = 0; var y0 = b.y;
  for (var s = 0; s < n; s++){ moveSub(b, h); if (!b.cells.size){ b.dirty = true; break; } }
  if (b.plow > 0){ var d = Math.max(0.25, 1 - 0.1*b.plow/n); b.vx *= d; b.vy *= d; b.w *= d; }   // heavy bodies sink through powder slowly
  if (!b.cells.size){ killBody(b); return; }
  if (b.plow > 0){ b.sinkLeft -= Math.abs(b.y - y0); b.lt3 = pixelTicks; }
  else if (pixelTicks - (b.lt3 || -99) > 20 && !b.touch) b.sinkLeft = 4;
  var spd = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
  if (b.touch && b.wet === 0){                     // ground contact: friction decides how long it slides
    var damp = 1 - 0.09*Math.max(0.07, b.fric);
    b.vx *= damp; b.w *= damp;
    if (spd < 0.35 && b.fric > 0.12){ b.vx *= 0.8; b.vy *= 0.5; }
    if (Math.abs(b.vx) < 0.03 && b.fric > 0.12) b.vx = 0;
    if (Math.abs(b.w) < 0.005) b.w = 0;
    spd = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
  }
  if (b.touch) b.lt2 = pixelTicks;
  syncProxies(b);
  if (b.debris.length){
    b.debris.forEach(function(dd){ if (isEmpty(dd[0], dd[1]) && elements[dd[2]]) createPixel(dd[2], dd[0], dd[1]); });
    b.debris.length = 0;
  }
  carry(b);
  if (pixelTicks - (b.lt2 || -99) < 8 && b.wet === 0 && spd < 0.12 && Math.abs(b.w) < 0.015 && !b.dirty) b.rest++; else b.rest = 0;
  if (false){ b.sleep = 1; b.sleepT = 0; b.vx = 0; b.vy = 0; b.w = 0; b.rest = 0; }
}
function carry(b){                                    // loose solids on top + water inside hulls ride along
  if (Math.abs(b.vx) + Math.abs(b.vy) + Math.abs(b.w)*b.rad < 0.03) return;
  b.proxies.forEach(function(pix){
    var p = pxAt(pix.x, pix.y - 1);
    if (!p || p.sub !== undefined || p.del) return;
    var e = elements[p.element];
    if (!e || e.state === "liquid" || e.state === "gas" || e.movable !== true) return;
    p.rq = (p.rq || 0) + (b.vx - b.w*(pix.y - b.y));
    if (Math.abs(p.rq) >= 1){
      var dir = sign(p.rq);
      if (isEmpty(p.x + dir, p.y)) movePixel(p, p.x + dir, p.y);
      p.rq -= dir;
    }
  });
  if (Math.abs(b.vx) < 0.03) return;
  var rows = {};
  b.proxies.forEach(function(pix){
    var r = rows[pix.y]; if (!r) rows[pix.y] = [pix.x, pix.x];
    else { if (pix.x < r[0]) r[0] = pix.x; if (pix.x > r[1]) r[1] = pix.x; }
  });
  b.proxies.forEach(function(pix){
    var r = rows[pix.y]; if (!r || r[1] - r[0] < 2) return;
    for (var x = r[0] + 1; x < r[1]; x++){
      if (b.proxies.has(GK(x, pix.y))) continue;
      var q = pxAt(x, pix.y); if (!q || q.sub !== undefined || q.del) continue;
      var e = elements[q.element]; if (!e || e.state !== "liquid") continue;
      q.cqx = (q.cqx || 0) + b.vx;
      if (Math.abs(q.cqx) >= 1){
        var dir = sign(q.cqx);
        if (isEmpty(q.x + dir, q.y)) movePixel(q, q.x + dir, q.y);
        q.cqx -= dir;
      }
    }
  });
}

/* ------------------------------------------- falling: support detection */
function isFaller(p){ return p && !p.del && p.sub === undefined && FALL[p.element] === true; }
function bodyFromPixels(list){
  var ax = list[0].x, ay = list[0].y, cells = new Map();
  list.forEach(function(q){ cells.set(K(q.x - ax, q.y - ay), { x: q.x - ax, y: q.y - ay, e: q.element, c: q.color, t: q.temp !== undefined ? q.temp : 20 }); });
  list.forEach(function(q){ if (pixelMap[q.x][q.y] === q) pixelMap[q.x][q.y] = undefined; q.del = true; });
  var b = makeBody(cells, 0, 0, 0, 0, 1);
  b.x = ax + b.com.x; b.y = ay + b.com.y;
  syncProxies(b);
  return b;
}
function checkSupport(p, checked){
  var comp = [p], seen = new Set([p]), q = [p], supported = false, host = null;
  while (q.length && !supported){
    var c = q.pop();
    for (var d = 0; d < 4; d++){
      var nx = c.x + D4[d][0], ny = c.y + D4[d][1];
      if (outOfBounds(nx, ny)){ supported = true; break; }
      var n = pixelMap[nx][ny];
      if (!n || n.del) continue;
      if (n.sub !== undefined){ if (!host && BODIES[n.sub]) host = BODIES[n.sub]; continue; }
      if (FALL[n.element] === true){ if (!seen.has(n)){ seen.add(n); comp.push(n); q.push(n); } continue; }
      var e = elements[n.element];
      if (e && (e.state === "liquid" || e.state === "gas")) continue;
      supported = true; break;
    }
    if (comp.length > 2500) supported = true;
  }
  comp.forEach(function(x){ checked.add(x); });
  if (host){                    // anything that touches an existing body becomes part of it
    comp.forEach(function(px){ if (!px.del && px.sub === undefined) joinPixel(host, px, true); });
    calc(host, true); syncProxies(host);
    return;
  }
  if (!supported) bodyFromPixels(comp);
}
function processSupport(){
  var checked = new Set(), n = 0, i;
  while (n < 120 && dirtyA.length){                 // newest first: busy sims never starve fresh placements
    var gk = dirtyA.pop(); dirtyS.delete(gk); n++;
    var x = Math.floor(gk/4096), y = gk % 4096;
    for (var dx = -3; dx <= 3; dx++) for (var dy = -3; dy <= 3; dy++){
      var p = pxAt(x + dx, y + dy);
      if (p && !checked.has(p) && isFaller(p)) checkSupport(p, checked);
    }
  }
  if (typeof currentPixels !== "undefined" && currentPixels.length){      // slow background sweep
    for (i = 0; i < 12; i++){
      var r = currentPixels[Math.floor(Math.random()*currentPixels.length)];
      if (r && !checked.has(r) && isFaller(r) && pixelMap[r.x] && pixelMap[r.x][r.y] === r) checkSupport(r, checked);
    }
  }
}

/* -------------------------------------------- joining / erasing / snapping */
function joinPixel(b, p, defer){
  var l = toLocal(b, p.x, p.y), lx = Math.round(l.x), ly = Math.round(l.y);
  if (b.cells.has(K(lx, ly))){ pixelMap[p.x][p.y] = undefined; p.del = true; return true; }   // lands on an owned cell: swallow
  b.cells.set(K(lx, ly), { x: lx, y: ly, e: p.element, c: p.color, t: p.temp !== undefined ? p.temp : 20 });
  pixelMap[p.x][p.y] = undefined; p.del = true;
  b.sleep = 0; b.vx = 0; b.vy = 0; b.w = 0; b.hold = pixelTicks + HOLD;   // hold still while building
  if (!defer){ calc(b, true); syncProxies(b); }
  return true;
}
function onPlaceFaller(p){
  if (NOJOIN || p.sub !== undefined) return;
  p.pa = pixelTicks;
  var b = null, x, y;
  for (x = -1; x <= 1 && !b; x++) for (y = -1; y <= 1 && !b; y++){
    if (!x && !y) continue;
    var n = pxAt(p.x + x, p.y + y);
    if (n && n.sub !== undefined && BODIES[n.sub]) b = BODIES[n.sub];
  }
  if (!b) return;
  var px0 = p.x, py0 = p.y;
  if (!joinPixel(b, p)) return;
  var queue = [[px0, py0]];                      // pull in the rest of this brush stroke that touches it
  while (queue.length){
    var pos = queue.pop();
    for (var d = 0; d < 4; d++){
      var m = pxAt(pos[0] + D4[d][0], pos[1] + D4[d][1]);
      if (m && isFaller(m) && m.pa === pixelTicks){
        var mx = m.x, my = m.y;
        if (joinPixel(b, m)) queue.push([mx, my]);
      }
    }
  }
}
function onDeleteProxy(p){
  if (p.sub === undefined) return;
  var b = BODIES[p.sub]; if (!b) return;
  var gk = GK(p.x, p.y);
  if (b.proxies.get(gk) === p){ b.proxies.delete(gk); b.cells.delete(p.ck); b.dirty = true; b.sleep = 0; }
}
function snapBody(b, aligned){
  if (aligned){
    var q = Math.PI/2; b.a = Math.round(b.a/q)*q;
    var first = b.cells.values().next().value, w = toWorld(b, first.x, first.y);
    b.x += Math.round(w.x) - w.x; b.y += Math.round(w.y) - w.y;
  }
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

/* ------------------------------------------------ elements: fallers + tab */
/* "wall" is an anchored thing: move it, and add a falling "physics wall" to Solids */
if (elements.wall){
  var W0 = elements.wall;
  elements.physics_wall = Object.assign({}, W0, { category: "solids", desc: "A wall that obeys physics: falls when unsupported." });
  if (Array.isArray(W0.color)) elements.physics_wall.color = W0.color.slice();
  if (Array.isArray(W0.behavior)) elements.physics_wall.behavior = W0.behavior.slice();
  W0.category = "anchored";
}
function canFall(id, e){
  /* ANY immovable material gets physics: solid (or state-less = solid), no tick, no self-moving behaviour */
  if (!e || e.tool || e.hidden || id === "wall" || /^anchored_/.test(id)) return false;
  if (e.category === "tools" || e.category === "energy") return false;
  if (e.state !== undefined && e.state !== "solid") return false;
  if (e.tick || !Array.isArray(e.behavior)) return false;
  if (/M[12]/.test(JSON.stringify(e.behavior))) return false;
  return true;
}
Object.keys(elements).forEach(function(id){ if (canFall(id, elements[id])) FALL[id] = true; });
Object.keys(FALL).forEach(function(id){
  var e = elements[id];
  if (id !== "physics_wall"){
    var a = Object.assign({}, e);
    if (Array.isArray(a.color)) a.color = a.color.slice();
    if (Array.isArray(a.behavior)) a.behavior = a.behavior.slice();
    if (a.reactions) a.reactions = JSON.parse(JSON.stringify(a.reactions));
    a.category = "anchored"; a.anchored = true; delete a.onPlace; delete a.onDelete; delete a.hidden;
    a.desc = "Anchored " + id.replace(/_/g, " ") + ": identical, but never falls.";
    elements["anchored_" + id] = a;
  }
  var prevP = e.onPlace, prevD = e.onDelete, prevR = e.renderer;
  e.onPlace = function(p){ if (prevP) prevP(p); onPlaceFaller(p); };
  e.onDelete = function(p){ if (prevD) prevD(p); onDeleteProxy(p); };
  if (prevR){                                                                  // footprints are invisible
    var wr = function(p, ctx){ if (p.sub !== undefined) return; return prevR(p, ctx); };
    wr.__bord = (typeof renderPresets !== "undefined" && prevR === renderPresets.BORDER);
    e.renderer = wr;
  }
});
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
if (typeof runAfterLoad === "function") runAfterLoad(hideFootprints); else hideFootprints();

/* ---------------------------------------------------------------- tools */
function bodyOf(p){ return (p.sub !== undefined) ? (BODIES[p.sub] || null) : null; }
elements.physkick = { color: "#ffd24d", category: "tools", canPlace: false,
  desc: "Hits a physics body at that spot: shoves it and spins it.",
  tool: function(p){
    var b = bodyOf(p); if (!b || b.kt === pixelTicks) return; b.kt = pixelTicks;
    var dvx = (Math.random()*2 - 1)*0.9, dvy = -1.5*sign(b.gf), rx = p.x - b.x, ry = p.y - b.y;
    b.vx += dvx; b.vy += dvy; b.w += b.m*(rx*dvy - ry*dvx)/b.I; b.sleep = 0;
  } };
elements.physicsspin = { color: "#7bdcff", category: "tools", canPlace: false,
  desc: "Gives a physics body a burst of spin.",
  tool: function(p){
    var b = bodyOf(p); if (!b || (b.st !== undefined && pixelTicks - b.st < 10)) return;
    b.st = pixelTicks; b.w += (chance(0.5) ? 1 : -1)*0.08; b.sleep = 0;
  } };
elements.physicsfreeze = { color: "#7bdcff", category: "tools", canPlace: false,
  desc: "Freezes a physics body in place (still rotated, still off-grid).",
  tool: function(p){ var b = bodyOf(p); if (b){ b.frozen = true; b.vx = 0; b.vy = 0; b.w = 0; b.sleep = 0; } } };
elements.physicsunfreeze = { color: "#ff9d7b", category: "tools", canPlace: false,
  desc: "Unfreezes a frozen physics body so it moves again.",
  tool: function(p){ var b = bodyOf(p); if (b){ b.frozen = false; b.sleep = 0; } } };
elements.physicsflip = { color: "#c792ff", category: "tools", canPlace: false,
  desc: "Flips the gravity direction of a physics body.",
  tool: function(p){
    var b = bodyOf(p); if (!b || (b.ft !== undefined && pixelTicks - b.ft < 15)) return;
    b.ft = pixelTicks; b.gf = -b.gf; b.sleep = 0;
  } };
elements.physicssnap = { color: "#ffb347", category: "tools", canPlace: false,
  desc: "Snaps a physics body onto the grid as anchored blocks, exactly as its rotated shape rasterises.",
  tool: function(p){ var b = bodyOf(p); if (b && !b.dead) snapBody(b, false); } };
elements.physicsalignedsnap = { color: "#6be08a", category: "tools", canPlace: false,
  desc: "Rotates a physics body to the grid perfectly, then snaps it as anchored blocks without deforming it.",
  tool: function(p){ var b = bodyOf(p); if (b && !b.dead) snapBody(b, true); } };

/* --------------------------------------------------- change notifications */
function wrap(name, make){
  var o = globalThis[name];
  if (typeof o === "function" && !o.__sl){ var w = make(o); w.__sl = true; globalThis[name] = w; }
}
function quiet(p){ var e = p && elements[p.element]; return !p || p.sub !== undefined || (e && (e.state === "liquid" || e.state === "gas")); }
wrap("createPixel", function(o){ return function(el, x, y){ o(el, x, y); if (!NOJOIN) mark(x, y); }; });
wrap("deletePixel", function(o){ return function(x, y){
  var p = pixelMap[x] && pixelMap[x][y], q = quiet(p); o(x, y); if (!q) mark(x, y); }; });
wrap("changePixel", function(o){ return function(pixel){
  var q = quiet(pixel); o.apply(this, arguments); if (!q || !quiet(pixel)) mark(pixel.x, pixel.y); }; });
wrap("movePixel", function(o){ return function(pixel, x, y){
  var q = quiet(pixel), ox = pixel.x, oy = pixel.y; o.apply(this, arguments); if (!q){ mark(ox, oy); mark(x, y); } }; });
wrap("swapPixels", function(o){ return function(a, b){
  var q = quiet(a) && quiet(b), ax = a.x, ay = a.y, bx = b.x, by = b.y; o(a, b); if (!q){ mark(ax, ay); mark(bx, by); } }; });
/* explosions: physics bodies are shoved from twice as far as the blast radius, and lose cells inside it */
wrap("explodeAt", function(o){ return function(x, y, radius, fire){
  o.apply(this, arguments);
  var R2 = radius*2, keys = Object.keys(BODIES);
  for (var i = 0; i < keys.length; i++){
    var b = BODIES[keys[i]]; if (!b || b.dead) continue;
    var dx = b.x - x, dy = b.y - y, dist = Math.sqrt(dx*dx + dy*dy) || 1;
    if (dist > R2 + b.rad) continue;
    var f = Math.max(0, 1 - dist/(R2 + b.rad));
    var accel = R2 * 0.2 * Math.sqrt(f) * Math.min(4, 1500/(b.m/b.cells.size));
    b.vx += dx/dist*accel; b.vy += dy/dist*accel - accel*0.3;
    b.w += (Math.random() - 0.5) * 0.1 * f;
    b.sleep = 0; b.frozen = false;
    b.cells.forEach(function(cell, k){
      var w = toWorld(b, cell.x, cell.y);
      var dd = Math.sqrt((w.x-x)*(w.x-x) + (w.y-y)*(w.y-y));
      if (dd < radius && chance(0.55*(1 - dd/radius))) removeCell(b, k, true);
    });
  }
}; });

/* --------------------------------------------------------------- hooks */
runEveryTick(function(){
  processSupport();
  var list = Object.keys(BODIES), i;
  for (i = 0; i < list.length; i++){ var b0 = BODIES[list[i]]; if (b0 && !b0.dead) watchProxies(b0); }
  var cap = Math.min(list.length, 100);
  for (i = 0; i < cap; i++){ var b = BODIES[list[i]]; if (b) stepBody(b); }
});
runPerPixel(function(p){
  if (p.sub === undefined) return;
  var b = BODIES[p.sub];                       // stray footprint (after load, or moved by a tool): becomes an ordinary pixel
  if (!b || b.proxies.get(GK(p.x, p.y)) !== p) p.sub = undefined;
});
runAfterReset(function(){ BODIES = {}; dirtyA.length = 0; dirtyS.clear(); });
renderPostPixel(function(ctx){
  var ps = pixelSize, keys = Object.keys(BODIES);
  var bord = (typeof renderPresets !== "undefined") ? renderPresets.BORDER : null;
  for (var i = 0; i < keys.length; i++){
    var b = BODIES[keys[i]]; if (!b) continue;
    ctx.save(); ctx.globalAlpha = 1;
    ctx.translate((b.x + 0.5)*ps, (b.y + 0.5)*ps); ctx.rotate(b.a);
    var cm = b.com, size = ps + 0.7;
    b.cells.forEach(function(c){
      var X = (c.x - cm.x - 0.5)*ps - 0.35, Y = (c.y - cm.y - 0.5)*ps - 0.35;
      ctx.fillStyle = c.c || "#999999"; ctx.fillRect(X, Y, size, size);
      if (c.chg){ ctx.fillStyle = "rgba(255,255,0,0.55)"; ctx.fillRect(X, Y, size, size); }     // powered (native electricity)
      if (bord){
        var el = elements[c.e];
        if (el && el.renderer && el.renderer.__bord){
          var edge = false;
          for (var d = 0; d < 4; d++) if (!b.cells.has(K(c.x + D4[d][0], c.y + D4[d][1]))){ edge = true; break; }
          if (edge){ ctx.fillStyle = "rgba(255,255,255,0.25)"; ctx.fillRect(X, Y, size, size); }
        }
      }
    });
    if (b.frozen){ ctx.strokeStyle = "rgba(123,220,255,0.9)"; ctx.lineWidth = 1; ctx.strokeRect(-ps*b.rad, -ps*b.rad, ps*2*b.rad, ps*2*b.rad); }
    ctx.restore();
  }
});

if (typeof globalThis !== "undefined" && globalThis.__SUBLEVEL_TEST__){
  globalThis.__SUBLEVEL_TEST__ = { BODIES: function(){ return BODIES; }, FALL: FALL, physOf: physOf, processSupport: processSupport,
    stepBody: stepBody, K: K, snapBody: snapBody, bodyFromPixels: bodyFromPixels, syncProxies: syncProxies };
}
if (typeof logMessage === "function") logMessage("Sublevel Physics v4 loaded: every Solids-tab solid falls when unsupported; footprints are real pixels so acid/fire/heat/electricity work natively.");
})();
