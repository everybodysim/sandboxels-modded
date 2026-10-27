/*
 * bestModManager.js  v2  -  a full remake of the Sandboxels mod manager.
 *
 * Does NOT modify the game's files. It only:
 *   1. intercepts the "Mods" button so it opens a new blank page instead of the Mods panel,
 *   2. builds a profile-based mod manager in that page (profiles, Browse tab, import/export),
 *   3. loads the active profile's mods itself, from the R74n GitHub repos via the jsDelivr CDN,
 *      registering each one under its normal "mods/<file>.js" name so the ~85 official mods that
 *      check enabledMods / dependOn() by that name keep working.
 *
 * Install once: open the normal Mods panel, paste this file's full URL, press Enter, reload.
 * After that the Mods button opens this manager. Shift+click Mods to open the original panel.
 *
 * Data lives in localStorage (key "bmm_v1"). Use Export to back up across devices / data wipes.
 */
(function () {
  'use strict';
  if (window.__bmmGameSide) return;
  window.__bmmGameSide = true;

  var VERSION = '2.0.0';
  var SELF_RE = /bestModManager/i;
  var OFFICIAL_RE = /^https?:\/\/cdn\.jsdelivr\.net\/gh\/R74nCom\/[^\/@]+@[^\/]+\/mods\/[^\/]+$/i;

  /* ---------------------------------------------------------------------------
   * Stylesheet for the manager page. Mirrors the game's look: black background,
   * grey --theme borders, pixel fonts. Purple is only used to highlight things.
   * ------------------------------------------------------------------------- */
  var BMM_CSS = [
    ':root{--theme:rgb(127,127,127);--theme-dark:rgb(63,63,63);--theme-darker:rgb(25,25,25);--theme-darkest:rgb(0,0,0);--theme-darkest2:rgb(0,0,0);',
    '--hl:#a77bff;--hl-dark:#2b2050;--hl-line:#6f4fd1;--text:#fff;--dim:#a0a0a0;--danger:#6a2323;--ok:#5ee05e;--err:#ff6b6b;',
    '--font:"VT323",Arial,sans-serif;--px:"Press Start 2P","VT323",monospace}',
    '*{box-sizing:border-box}',
    '::selection{background:var(--hl-line)}',
    'html,body{margin:0;background:var(--theme-darkest2);color:var(--text);font-family:var(--font);font-size:21px}',
    'button,input,textarea{font:inherit;color:inherit}',
    'h2{margin:0;font-size:1.5em;font-weight:normal;text-decoration:underline}',
    '#head{position:sticky;top:0;z-index:20}',
    '.top{display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--theme-darkest);border-bottom:2px solid var(--theme);flex-wrap:wrap}',
    '.brand{font-family:var(--px);font-size:12px;margin-right:14px;color:var(--text)}',
    '.grow{flex:1}',
    '.btn,.tab{background:var(--theme-darkest2);color:var(--text);border:2px solid var(--theme);border-radius:5px;padding:3px 13px;cursor:pointer;transition:transform .15s}',
    '.btn:hover,.tab:hover{filter:brightness(1.35)}',
    '.btn:active,.tab:active{transform:scale(.95)}',
    '.tab.on{background:var(--hl-dark);border-color:var(--hl);color:#fff}',
    '.btn.primary{background:rgb(85,85,85);border-color:rgb(160,160,160)}',
    '.btn.hl{background:var(--hl-dark);border-color:var(--hl)}',
    '.btn.danger{background:var(--danger);border-color:#a34a4a}',
    '.btn.big{padding:8px 22px;font-size:1.25em}',
    '.btn.sm{padding:0 9px;font-size:.9em}',
    '.btn:disabled{opacity:.45;cursor:not-allowed;filter:none;transform:none}',
    '.pulse{animation:pulse 1.2s infinite;border-color:var(--hl)}',
    '@keyframes pulse{50%{box-shadow:0 0 0 4px rgba(167,123,255,.4)}}',
    '.banner{display:flex;gap:10px;align-items:center;padding:8px 16px;background:var(--hl-dark);border-bottom:2px solid var(--hl)}',
    '.banner b{color:var(--hl)}',
    'main{max-width:980px;margin:0 auto;padding:18px 16px 80px}',
    '.pagehead{display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap}',
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px}',
    '.card{display:flex;gap:12px;align-items:center;background:var(--theme-darker);border:2px solid var(--theme-dark);border-radius:6px;padding:12px;cursor:pointer;position:relative}',
    '.card:hover{border-color:var(--theme)}',
    '.card.active{border-color:var(--hl)}',
    '.cardname{font-size:1.2em}',
    '.badge{background:var(--hl);color:#12082b;border-radius:3px;font-size:.7em;padding:0 6px;margin-left:6px;vertical-align:middle}',
    '.badge.dim{background:var(--theme-dark);color:#ddd}',
    '.card .badge{position:absolute;top:8px;right:8px;margin:0}',
    '.ico{flex:none;width:46px;height:46px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-family:var(--px);font-size:16px;color:#fff;border:2px solid rgba(255,255,255,.2)}',
    '.ico.lg{width:56px;height:56px;font-size:20px}',
    '.meta{color:var(--dim);font-size:.85em;margin-top:2px;word-break:break-all}',
    '.st{font-size:.85em;margin-top:2px}.st.ok{color:var(--ok)}.st.err{color:var(--err)}.st.wait{color:var(--dim)}',
    '.empty{text-align:center;color:var(--dim);padding:40px 10px;line-height:1.5}',
    '.hero{display:flex;gap:16px;align-items:center;background:var(--theme-darker);border:2px solid var(--theme-dark);border-radius:8px;padding:16px;flex-wrap:wrap}',
    '.hero.active{border-color:var(--hl)}',
    '.hero-main{flex:1;min-width:200px}',
    '.title{width:100%;background:transparent;border:2px solid transparent;border-radius:5px;font-size:1.7em;padding:0 6px;margin-left:-6px}',
    '.title:hover,.title:focus{border-color:var(--theme);background:var(--theme-darkest);outline:none}',
    '.hero-actions{display:flex;gap:10px;flex-wrap:wrap}',
    '.note{margin:12px 0 0;padding:8px 12px;background:var(--theme-darker);border-left:4px solid var(--hl);border-radius:4px;color:#ddd}',
    '.toolbar{display:flex;gap:8px;margin:16px 0 10px;flex-wrap:wrap}',
    '.inp{flex:1;min-width:180px;background:var(--theme-darkest);border:2px solid var(--theme);border-radius:5px;padding:4px 10px}',
    '.inp:focus{outline:none;border-color:var(--hl);box-shadow:0 0 0 2px rgba(167,123,255,.3)}',
    '.inp.paste{border-color:var(--hl-line);background:#120d26}',
    '.list{display:flex;flex-direction:column;gap:8px}',
    '.row{display:flex;gap:12px;align-items:center;background:var(--theme-darker);border:2px solid var(--theme-dark);border-radius:6px;padding:9px 12px}',
    '.row:hover{border-color:var(--theme)}',
    '.row.off{opacity:.5}',
    '.info{flex:1;min-width:0}',
    '.name{font-size:1.15em}',
    '.desc{margin-top:6px;padding:8px 10px;background:var(--theme-darkest);border-left:3px solid var(--hl);color:#cfcfcf;font-size:.85em;white-space:pre-wrap;word-break:break-word}',
    '.acts{display:flex;gap:6px;align-items:center;flex:none;flex-wrap:wrap;justify-content:flex-end}',
    '.sw{position:relative;width:44px;height:24px;display:inline-block;margin:0 4px}',
    '.sw input{opacity:0;width:0;height:0;position:absolute}',
    '.sw span{position:absolute;inset:0;background:var(--theme-dark);border:2px solid var(--theme);border-radius:24px;cursor:pointer;transition:.15s}',
    '.sw span:before{content:"";position:absolute;width:14px;height:14px;left:3px;top:3px;background:#ddd;border-radius:50%;transition:.15s}',
    '.sw input:checked+span{background:var(--hl-line);border-color:var(--hl)}',
    '.sw input:checked+span:before{transform:translateX(20px);background:#fff}',
    '.foot{color:var(--dim);font-size:.8em;margin-top:14px;text-align:center}',
    '#modal{display:none}#modal.on{display:block}',
    '.mback{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:40}',
    '.mbox{position:fixed;z-index:41;top:50%;left:50%;transform:translate(-50%,-50%);width:min(520px,92vw);max-height:86vh;overflow:auto;background:var(--theme-darker);border:3px solid var(--hl);border-radius:8px;padding:18px}',
    '.mbox h3{margin:0 0 10px;font-size:1.3em;font-weight:normal;text-decoration:underline}',
    '.mbox .btn{margin:4px 4px 4px 0}',
    '.mbox textarea{width:100%;min-height:100px;background:var(--theme-darkest);border:2px solid var(--theme);border-radius:5px;padding:8px;resize:vertical}',
    '.mbox textarea:focus{outline:none;border-color:var(--hl)}',
    '.pick{display:flex;width:100%;justify-content:space-between;align-items:center;text-align:left;margin:6px 0 !important}',
    '.mbox .inp{margin:4px 0}',
    '#toasts{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:60;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none}',
    '.toast{background:var(--theme-darkest);border:2px solid var(--hl);border-radius:6px;padding:6px 16px;max-width:90vw}',
    '.toast.err{border-color:var(--err)}'
  ].join('\n');

  /* ---------------------------------------------------------------------------
   * The manager app. This function is stringified and injected into the new page,
   * so it runs in that page's own context and keeps working even if the game
   * tab reloads. It must stay fully self-contained (no references to outer vars).
   * ------------------------------------------------------------------------- */
  function bmmApp(boot) {
    'use strict';
    window.__bmmReady = true;
    window.__bmmVersion = boot.version;

    var STORE = 'bmm_v1', REGKEY = 'bmm_registry_v1', ENABLED = 'enabledMods', LOADED = 'bmm_loaded', SELFKEY = 'bmm_self', STATUS = 'bmm_status';
    var SELF_RE = /bestModManager/i;
    var OFFICIAL_RE = /^https?:\/\/cdn\.jsdelivr\.net\/gh\/R74nCom\/[^\/@]+@[^\/]+\/mods\/[^\/]+$/i;
    var PAGE = 40;
    /* Mods are only ever listed from R74n's own repositories. */
    var SOURCES = [
      { repo: 'R74nCom/Sandboxels-Mods', path: 'mods', branch: 'main' },
      { repo: 'R74nCom/sandboxels', path: 'mods', branch: 'main' }
    ];
    var SIG = 'r74n-v2';

    /* ---------- helpers ---------- */
    var $ = function (s, r) { return (r || document).querySelector(s); };
    var esc = function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    };
    var uid = function () { return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4); };
    var fileOf = function (u) {
      var f = String(u).split(/[?#]/)[0].split('/').pop();
      try { return decodeURIComponent(f); } catch (e) { return f; }
    };
    var pretty = function (f) {
      return f.replace(/\.js$/i, '').replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/\b\w/g, function (c) { return c.toUpperCase(); }).trim() || f;
    };
    var hue = function (s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; };
    var fmtSize = function (b) { return !b ? '' : b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB'; };
    var okUrl = function (u) {
      return typeof u === 'string' && (/^https?:\/\/[^\s]+\.js(\?[^\s]*)?$/i.test(u) || /^[\w\-. \/]+\.js$/i.test(u));
    };
    var byName = function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0; };
    function readJSON(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
    function writeJSON(k, v, silent) {
      try { localStorage.setItem(k, JSON.stringify(v)); return true; }
      catch (e) { if (!silent) toast('Could not save (storage full or blocked).', 'err'); return false; }
    }
    /* The name the game (and other mods) see in enabledMods for a managed mod. */
    function entryOf(m) { return OFFICIAL_RE.test(m.url) ? 'mods/' + m.file : m.url; }

    /* ---------- data ---------- */
    function mkProfile(name) { return { id: uid(), name: name, createdAt: Date.now(), mods: [] }; }
    function modFromEntry(u) {
      var f = fileOf(u);
      return { id: uid(), name: pretty(f), file: f, url: u, source: /^https?:/i.test(u) ? 'imported' : 'local', ref: '', size: 0, enabled: true };
    }
    var db = readJSON(STORE, null);
    if (!db || !Array.isArray(db.profiles)) db = migrate();
    delete db.sources; /* v1 allowed custom sources; v2 is R74n-only */

    function migrate() {
      var d = { version: 2, activeProfileId: null, lastExport: 0, profiles: [] };
      var cur = readJSON(ENABLED, []);
      var others = (Array.isArray(cur) ? cur : []).filter(function (x) { return typeof x === 'string' && !SELF_RE.test(x); });
      if (others.length) {
        var p = mkProfile('Imported');
        p.mods = others.map(modFromEntry);
        d.profiles.push(p);
        d.activeProfileId = p.id;
      }
      writeJSON(STORE, d, true);
      return d;
    }
    var P = function (id) { return db.profiles.find(function (p) { return p.id === id; }); };
    var activeProfile = function () { return db.activeProfileId ? P(db.activeProfileId) : null; };
    function uniqueName(base, exceptId) {
      var name = base, n = 2;
      while (db.profiles.some(function (p) { return p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase(); })) name = base + ' (' + (n++) + ')';
      return name;
    }

    /* Everything any profile manages (both the native name and the raw url), so we can keep it
       out of the game's own enabledMods: the manager loads these itself. */
    function managedSet() {
      var s = {};
      db.profiles.forEach(function (p) { p.mods.forEach(function (m) { s[entryOf(m)] = 1; s[m.url] = 1; }); });
      return s;
    }
    function desiredEntries() {
      var p = activeProfile(), out = [];
      if (p) p.mods.forEach(function (m) { if (!m.enabled || SELF_RE.test(m.url)) return; var e = entryOf(m); if (out.indexOf(e) < 0) out.push(e); });
      return out;
    }
    /* The game's enabledMods only needs the manager itself (plus any mods we don't manage). */
    function applyEnabled() {
      var self = localStorage.getItem(SELFKEY) || boot.selfUrl || '';
      var cur = readJSON(ENABLED, []); if (!Array.isArray(cur)) cur = [];
      var man = managedSet(), list = [];
      if (self) list.push(self);
      else cur.forEach(function (x) { if (typeof x === 'string' && SELF_RE.test(x) && list.indexOf(x) < 0) list.push(x); });
      cur.forEach(function (x) { if (typeof x !== 'string' || SELF_RE.test(x) || man[x] || list.indexOf(x) >= 0) return; list.push(x); });
      try { localStorage.setItem(ENABLED, JSON.stringify(list)); }
      catch (e) { toast('Could not write the game\'s mod list.', 'err'); }
    }
    function save() { writeJSON(STORE, db); applyEnabled(); }
    function pending() {
      var b = readJSON(LOADED, null); if (!Array.isArray(b)) return false;
      return JSON.stringify(desiredEntries()) !== JSON.stringify(b);
    }
    function statusFor(m) {
      if (!m.enabled || db.activeProfileId == null || pending()) return null;
      var st = readJSON(STATUS, null);
      return st && st.items ? st.items[entryOf(m)] || null : null;
    }
    function installedIn(url) {
      return db.profiles.filter(function (p) { return p.mods.some(function (m) { return m.url === url; }); }).map(function (p) { return p.name; });
    }

    /* ---------- registry (R74n mods from GitHub via the jsDelivr CDN) ---------- */
    var registry = readJSON(REGKEY, null);
    if (registry && registry.sig !== SIG) registry = null;
    var regState = registry && registry.items && registry.items.length ? 'ready' : 'idle';
    var regError = '';
    function indexRegistry() {
      if (!registry || !registry.items) return;
      registry.items.forEach(function (it, i) { it.i = i; it.hay = (it.name + ' ' + it.file + ' ' + it.source).toLowerCase(); });
    }
    indexRegistry();

    async function listFiles(repo, ref, dir) {
      var enc = encodeURIComponent(ref);
      var tries = [
        async function () {
          var r = await fetch('https://data.jsdelivr.com/v1/packages/gh/' + repo + '@' + enc + '?structure=flat');
          if (!r.ok) throw new Error('jsDelivr ' + r.status);
          return ((await r.json()).files || []).map(function (f) { return { name: f.name, size: f.size }; });
        },
        async function () {
          var r = await fetch('https://data.jsdelivr.com/v1/package/gh/' + repo + '@' + enc + '/flat');
          if (!r.ok) throw new Error('jsDelivr ' + r.status);
          return ((await r.json()).files || []).map(function (f) { return { name: f.name, size: f.size }; });
        },
        async function () {
          var r = await fetch('https://api.github.com/repos/' + repo + '/contents/' + dir + '?ref=' + enc);
          if (!r.ok) throw new Error('GitHub ' + r.status);
          var j = await r.json(); if (!Array.isArray(j)) throw new Error('GitHub: unexpected reply');
          return j.filter(function (t) { return t.type === 'file'; }).map(function (t) { return { name: '/' + t.path, size: t.size }; });
        },
        async function () {
          var r = await fetch('https://api.github.com/repos/' + repo + '/git/trees/' + enc + '?recursive=1');
          if (!r.ok) throw new Error('GitHub ' + r.status);
          return ((await r.json()).tree || []).filter(function (t) { return t.type === 'blob'; }).map(function (t) { return { name: '/' + t.path, size: t.size }; });
        }
      ];
      var err;
      for (var i = 0; i < tries.length; i++) { try { return await tries[i](); } catch (e) { err = e; } }
      throw err;
    }
    async function fetchSource(src) {
      var branches = [src.branch || 'main', 'main', 'master'].filter(function (b, i, a) { return a.indexOf(b) === i; });
      var err;
      for (var bi = 0; bi < branches.length; bi++) {
        var br = branches[bi];
        try {
          var ref = br;
          try { /* pin to a commit so CDN caching can't serve stale files */
            var rr = await fetch('https://data.jsdelivr.com/v1/packages/gh/' + src.repo + '/resolved?specifier=' + encodeURIComponent(br));
            if (rr.ok) { var rj = await rr.json(); if (/^[0-9a-f]{40}$/i.test(rj.version || '')) ref = rj.version; }
          } catch (e) { /* fall back to branch name */ }
          var prefix = '/' + String(src.path).replace(/^\/+|\/+$/g, '') + '/';
          var files = (await listFiles(src.repo, ref, String(src.path).replace(/^\/+|\/+$/g, ''))).filter(function (f) {
            return f.name.indexOf(prefix) === 0 && f.name.indexOf('/', prefix.length) < 0 && /\.js$/i.test(f.name) && !/\.min\.js$/i.test(f.name) && !SELF_RE.test(f.name);
          });
          if (!files.length) throw new Error('no mods found in /' + src.path);
          return files.map(function (f) {
            var file = f.name.split('/').pop();
            return {
              name: pretty(file), file: file,
              url: 'https://cdn.jsdelivr.net/gh/' + src.repo + '@' + ref + f.name.split('/').map(encodeURIComponent).join('/'),
              source: src.repo, ref: ref === br ? br : ref.slice(0, 7), size: f.size || 0
            };
          });
        } catch (e) { err = e; }
      }
      throw err;
    }
    async function ensureRegistry(force) {
      if (!force && registry && registry.sig === SIG && Date.now() - registry.fetchedAt < 864e5 && registry.items.length) { regState = 'ready'; return; }
      if (regState === 'loading') return;
      regState = 'loading'; regError = ''; refresh();
      var results = await Promise.all(SOURCES.map(async function (s) {
        try { return { items: await fetchSource(s) }; } catch (e) { return { err: s.repo + ' (' + (e.message || e) + ')' }; }
      }));
      var seen = {}, items = [], errs = [];
      results.forEach(function (r) { /* source order = priority; same filename is listed once */
        if (r.err) { errs.push(r.err); return; }
        r.items.forEach(function (it) { var k = it.file.toLowerCase(); if (!seen[k]) { seen[k] = 1; items.push(it); } });
      });
      if (items.length) {
        items.sort(byName);
        registry = { sig: SIG, fetchedAt: Date.now(), items: items };
        writeJSON(REGKEY, registry, true);
        regState = 'ready';
        if (errs.length) toast('Some sources failed: ' + errs.join(', '), 'err');
      } else if (registry && registry.items && registry.items.length) {
        regState = 'ready'; toast('Could not refresh the list; showing saved copy.', 'err');
      } else { regState = 'error'; regError = errs.join('; ') || 'No mods found.'; }
      indexRegistry(); ui.shown = PAGE; refresh();
    }
    var texts = {};
    async function getText(url) {
      if (texts[url] !== undefined) return texts[url];
      var r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status);
      return (texts[url] = await r.text());
    }
    var descs = {};
    async function loadDesc(it) {
      if (descs[it.url] !== undefined) return;
      descs[it.url] = null; refresh();
      try {
        var t = await getText(it.url);
        var m = t.match(/^\s*(\/\*[\s\S]*?\*\/|(?:\/\/.*(?:\r?\n|$))+)/);
        var d = m ? m[1].replace(/^\/\*+|\*+\/$/g, '').replace(/^\s*\/\/ ?/gm, '').replace(/^\s*\* ?/gm, '').trim() : '';
        descs[it.url] = (d ? d.slice(0, 500) : 'No description in the file header.') + (m && d.length > 500 ? '…' : '');
      } catch (e) { descs[it.url] = 'Could not load details (' + (e.message || e) + ').'; }
      refresh();
    }

    /* Mods that force-load other mods (dependOn(..., true)) or insert a library into enabledMods
       need those mods installed too. Find them in the source so we can add them automatically. */
    function findDeps(text) {
      var out = {}, re = /dependOn\(/g, m;
      while ((m = re.exec(text))) {
        var i = re.lastIndex, depth = 1, args = [], cur = '', q = null;
        for (; i < text.length; i++) {
          var c = text[i];
          if (q) { cur += c; if (c === '\\') { cur += text[++i] || ''; } else if (c === q) q = null; continue; }
          if (c === '/' && text[i + 1] === '/') { var nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue; }
          if (c === '/' && text[i + 1] === '*') { var ce = text.indexOf('*/', i + 2); i = ce < 0 ? text.length : ce + 1; continue; }
          if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; }
          if (c === '(' || c === '[' || c === '{') { depth++; cur += c; continue; }
          if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) { args.push(cur); break; } cur += c; continue; }
          if (c === ',' && depth === 1) { args.push(cur); cur = ''; continue; }
          cur += c;
        }
        if (args.length >= 3) {
          var n = args[0].trim().match(/^["'`]([^"'`]+\.js)["'`]$/);
          if (n && args[2].trim() === 'true') out[n[1].replace(/^mods\//, '')] = 1;
        }
      }
      var lib = text.match(/libraryMod\s*=\s*["'`](?:mods\/)?([^"'`]+\.js)["'`]/);
      if (lib && /enabledMods\.splice\([\s\S]{0,80}?libraryMod/.test(text)) out[lib[1]] = 1;
      return Object.keys(out);
    }
    async function addDependencies(pid, item) {
      if (!OFFICIAL_RE.test(item.url) || !registry || !registry.items) return;
      try {
        var deps = findDeps(await getText(item.url)), added = [], missing = [], p = P(pid);
        if (!p) return;
        deps.forEach(function (d) {
          var low = d.toLowerCase();
          var hit = registry.items.find(function (it) { return it.file === d; }) || registry.items.find(function (it) { return it.file.toLowerCase() === low; });
          if (!hit) { missing.push(d); return; }
          if (p.mods.some(function (m) { return m.url === hit.url || m.file === hit.file; })) return;
          p.mods.splice(Math.max(0, p.mods.findIndex(function (m) { return m.url === item.url; })), 0,
            { id: uid(), name: hit.name, file: hit.file, url: hit.url, source: hit.source, ref: hit.ref, size: hit.size, enabled: true });
          added.push(hit.name);
        });
        if (added.length) { save(); toast(item.name + ' needs ' + added.join(', ') + ' — added too.'); refresh(); }
        if (missing.length) toast(item.name + ' also needs ' + missing.join(', ') + ' (not found).', 'err');
      } catch (e) { /* dependency check is best-effort */ }
    }

    /* ---------- UI state ---------- */
    var ui = { view: 'profiles', pid: null, target: null, query: '', shown: PAGE, open: {}, pfilter: '' };
    var modalCb = null, pendingItem = null, exportPayload = null;

    function toast(msg, kind) {
      var box = $('#toasts'); if (!box) return;
      var t = document.createElement('div'); t.className = 'toast' + (kind === 'err' ? ' err' : ''); t.textContent = msg;
      box.appendChild(t); setTimeout(function () { t.remove(); }, kind === 'err' ? 5000 : 3200);
    }
    function openModal(html, cb) {
      var m = $('#modal'); m.innerHTML = '<div class="mback" data-a="closeModal"></div><div class="mbox">' + html + '</div>';
      modalCb = cb || null; m.classList.add('on');
      var i = $('#modal [data-val]'); if (i) i.focus();
    }
    function closeModal() { var m = $('#modal'); m.classList.remove('on'); m.innerHTML = ''; modalCb = null; }
    function askName(title, initial, okLabel, cb) {
      openModal('<h3>' + esc(title) + '</h3><input class="inp" type="text" data-val maxlength="60" value="' + esc(initial) + '" style="width:100%">' +
        '<div style="margin-top:10px"><button class="btn primary" data-a="modalOk">' + esc(okLabel) + '</button><button class="btn" data-a="closeModal">Cancel</button></div>', cb);
      var i = $('#modal [data-val]'); if (i) i.select();
    }
    function confirmModal(text, okLabel, cb) {
      openModal('<h3>Are you sure?</h3><p>' + esc(text) + '</p><button class="btn danger" data-a="modalOk">' + esc(okLabel) + '</button><button class="btn" data-a="closeModal">Cancel</button>', cb);
    }

    /* ---------- rendering ---------- */
    function renderTop() {
      var pend = pending(), t = ui.target ? P(ui.target) : null;
      $('#head').innerHTML =
        '<div class="top"><div class="brand">MOD MANAGER</div>' +
        '<button class="tab ' + (ui.view === 'browse' ? '' : 'on') + '" data-a="tab" data-v="profiles">Profiles</button>' +
        '<button class="tab ' + (ui.view === 'browse' ? 'on' : '') + '" data-a="tab" data-v="browse">Browse Mods</button>' +
        '<div class="grow"></div>' +
        '<button class="btn ' + (pend ? 'hl pulse' : '') + '" data-a="reload">' + (pend ? 'Reload game to apply changes' : 'Reload game') + '</button></div>' +
        (t ? '<div class="banner">Installing into profile <b>' + esc(t.name) + '</b><div class="grow"></div><button class="btn sm primary" data-a="doneTarget">Done</button></div>' : '');
    }
    function icon(name, cls) { return '<div class="ico ' + (cls || '') + '" style="background:hsl(' + hue(name) + ' 22% 30%)">' + esc((name[0] || '?').toUpperCase()) + '</div>'; }

    function vProfiles() {
      var cards = db.profiles.map(function (p) {
        var on = db.activeProfileId === p.id, en = p.mods.filter(function (m) { return m.enabled; }).length;
        return '<div class="card ' + (on ? 'active' : '') + '" data-a="openProfile" data-id="' + p.id + '">' + icon(p.name, 'lg') +
          '<div><div class="cardname">' + esc(p.name) + '</div><div class="meta">' + p.mods.length + ' mod' + (p.mods.length === 1 ? '' : 's') + ' &middot; ' + en + ' enabled</div></div>' +
          (on ? '<span class="badge">ACTIVE</span>' : '') + '</div>';
      }).join('');
      var back = db.lastExport ? 'Last backup: ' + Math.floor((Date.now() - db.lastExport) / 864e5) + ' day(s) ago.' : 'You have not exported a backup yet.';
      return '<div class="pagehead"><h2>Profiles</h2><div class="grow"></div>' +
        '<button class="btn" data-a="importModal">Import</button><button class="btn" data-a="exportAll">Export all</button>' +
        '<button class="btn primary" data-a="newProfile">+ New profile</button></div>' +
        (cards ? '<div class="grid">' + cards + '</div>' :
          '<div class="empty">No profiles yet.<br>Create one, or open <b>Browse Mods</b> and install something &mdash; a profile is made for you.</div>') +
        '<div class="foot">Only one profile can be active at a time. ' + back + ' Export to keep profiles if you clear browser data.</div>';
    }

    function vProfile() {
      var p = P(ui.pid); if (!p) { ui.view = 'profiles'; return vProfiles(); }
      var on = db.activeProfileId === p.id, en = p.mods.filter(function (m) { return m.enabled; }).length;
      return '<div class="pagehead"><button class="btn" data-a="tab" data-v="profiles">&larr; Profiles</button></div>' +
        '<section class="hero ' + (on ? 'active' : '') + '">' + icon(p.name, 'lg') +
        '<div class="hero-main"><input class="title" data-c="rename" value="' + esc(p.name) + '" maxlength="60" title="Click to rename">' +
        '<div class="meta">' + p.mods.length + ' mod' + (p.mods.length === 1 ? '' : 's') + ' &middot; ' + en + ' enabled' + (on ? ' <span class="badge">ACTIVE</span>' : ' <span class="badge dim">DISABLED</span>') + '</div></div>' +
        '<div class="hero-actions"><button class="btn big ' + (on ? 'danger' : 'primary') + '" data-a="toggleProfile">' + (on ? 'Disable profile' : 'Enable profile') + '</button>' +
        '<button class="btn big" data-a="addContent">+ Add content</button></div></section>' +
        (on ? '' : '<div class="note">This profile is disabled, so none of its mods will load. Press <b>Enable profile</b> to use it (this turns off whichever profile is active).</div>') +
        '<div class="toolbar"><input class="inp" id="pfilter" data-i="pfilter" placeholder="Filter mods in this profile…" value="' + esc(ui.pfilter) + '">' +
        '<button class="btn" data-a="duplicate">Duplicate</button><button class="btn" data-a="exportOne">Export</button><button class="btn danger" data-a="deleteProfile">Delete</button></div>' +
        '<div class="list" id="plist"></div>';
    }
    function statusHtml(m) {
      var s = statusFor(m); if (!s) return '';
      if (s.state === 'loaded') return '<div class="st ok">&#10003; Loaded in game</div>';
      if (s.state === 'loading') return '<div class="st wait">Loading…</div>';
      return '<div class="st err" title="' + esc(s.msg || '') + '">&#10007; ' + (s.state === 'failed' ? 'Failed to download' : 'Error: ' + esc((s.msg || 'see console').slice(0, 90))) + '</div>';
    }
    function renderPList() {
      var box = $('#plist'), p = P(ui.pid); if (!box || !p) return;
      var q = ui.pfilter.trim().toLowerCase();
      var rows = p.mods.map(function (m, i) { return { m: m, i: i }; }).filter(function (x) { return !q || (x.m.name + ' ' + x.m.file).toLowerCase().indexOf(q) >= 0; });
      if (!p.mods.length) { box.innerHTML = '<div class="empty">This profile is empty.<br>Press <b>+ Add content</b> to pick mods to install here.</div>'; return; }
      if (!rows.length) { box.innerHTML = '<div class="empty">No mods match your filter.</div>'; return; }
      box.innerHTML = rows.map(function (x) {
        var m = x.m;
        return '<div class="row ' + (m.enabled ? '' : 'off') + '">' + icon(m.name) +
          '<div class="info"><div class="name">' + esc(m.name) + '</div><div class="meta">' + esc(entryOf(m)) + ' &middot; ' + esc(m.source) + (m.ref ? ' @ ' + esc(m.ref) : '') + (m.size ? ' &middot; ' + fmtSize(m.size) : '') + '</div>' + statusHtml(m) + '</div>' +
          '<div class="acts"><button class="btn sm" data-a="up" data-id="' + m.id + '" title="Load earlier">&#9650;</button><button class="btn sm" data-a="down" data-id="' + m.id + '" title="Load later">&#9660;</button>' +
          '<label class="sw" title="Enable / disable"><input type="checkbox" data-c="toggleMod" data-id="' + m.id + '" ' + (m.enabled ? 'checked' : '') + '><span></span></label>' +
          '<button class="btn sm danger" data-a="removeMod" data-id="' + m.id + '">Remove</button></div></div>';
      }).join('');
    }

    function vBrowse() {
      return '<div class="pagehead"><h2>Browse Mods</h2><div class="grow"></div><button class="btn" data-a="refreshReg">Refresh list</button></div>' +
        '<div class="toolbar"><input class="inp" id="q" data-i="query" placeholder="Search R74n mods…" value="' + esc(ui.query) + '" autocomplete="off"></div>' +
        '<div class="toolbar"><input class="inp paste" id="custom" placeholder="Paste a mod link (https://…/mod.js) to add it directly"><button class="btn hl" data-a="addCustom">Add link</button></div>' +
        '<div class="list" id="results"></div>';
    }
    function searchResults() {
      var items = registry && registry.items ? registry.items : [];
      var q = ui.query.trim().toLowerCase();
      if (!q) return items;
      var tk = q.split(/\s+/);
      return items.filter(function (it) { return tk.every(function (t) { return it.hay.indexOf(t) >= 0; }); })
        .sort(function (a, b) { var as = a.name.toLowerCase().indexOf(q) === 0 ? 0 : 1, bs = b.name.toLowerCase().indexOf(q) === 0 ? 0 : 1; return as - bs || byName(a, b); });
    }
    function renderResults() {
      var box = $('#results'); if (!box) return;
      var have = registry && registry.items && registry.items.length;
      if (regState === 'loading' && !have) { box.innerHTML = '<div class="empty">Loading the mod list from GitHub…</div>'; return; }
      if (!have) {
        box.innerHTML = '<div class="empty">' + (regState === 'error' ? 'Could not load the mod list.<br>' + esc(regError) + '<br><br><button class="btn primary" data-a="refreshReg">Retry</button>' : 'Loading…') + '</div>';
        return;
      }
      var all = searchResults(), slice = all.slice(0, ui.shown), tgt = ui.target ? P(ui.target) : null;
      if (!all.length) { box.innerHTML = '<div class="empty">No mods match &ldquo;' + esc(ui.query) + '&rdquo;.</div>'; return; }
      box.innerHTML = slice.map(function (it) {
        var where = installedIn(it.url), inT = tgt && tgt.mods.some(function (m) { return m.url === it.url; });
        var d = ui.open[it.url] ? '<div class="desc">' + (descs[it.url] ? esc(descs[it.url]) : 'Loading…') + '</div>' : '';
        return '<div class="row">' + icon(it.name) + '<div class="info"><div class="name">' + esc(it.name) +
          (where.length ? ' <span class="badge dim">IN: ' + esc(where.join(', ')) + '</span>' : '') + '</div>' +
          '<div class="meta">' + esc(it.file) + ' &middot; ' + esc(it.source) + (it.size ? ' &middot; ' + fmtSize(it.size) : '') + '</div>' + d + '</div>' +
          '<div class="acts"><button class="btn sm" data-a="details" data-i="' + it.i + '">' + (ui.open[it.url] ? 'Hide' : 'Details') + '</button>' +
          '<button class="btn primary" data-a="install" data-i="' + it.i + '" ' + (inT ? 'disabled' : '') + '>' + (inT ? 'Added' : 'Install') + '</button></div></div>';
      }).join('') + (all.length > slice.length ? '<button class="btn" data-a="more" style="margin:8px auto">Show more (' + (all.length - slice.length) + ' left)</button>' : '') +
        '<div class="foot">' + all.length + ' mod' + (all.length === 1 ? '' : 's') + ' from R74n&rsquo;s repositories &middot; mods run with full access to the game.</div>';
    }

    function renderMain() {
      var m = $('#view');
      m.innerHTML = ui.view === 'browse' ? vBrowse() : ui.view === 'profile' ? vProfile() : vProfiles();
      if (ui.view === 'browse') renderResults();
      if (ui.view === 'profile') renderPList();
    }
    function refresh() {
      var y = window.scrollY;
      renderTop();
      if (ui.view === 'browse') renderResults(); else renderMain();
      window.scrollTo(0, y);
    }
    function go(view, pid) {
      ui.view = view; if (pid !== undefined) ui.pid = pid;
      renderTop(); renderMain(); window.scrollTo(0, 0);
      if (view === 'browse') ensureRegistry(false);
    }

    /* ---------- install flow ---------- */
    function addMod(pid, item) {
      var p = P(pid); if (!p) return false;
      if (SELF_RE.test(item.url)) { toast('The manager itself is always enabled.'); return false; }
      if (p.mods.some(function (m) { return m.url === item.url; })) { toast(item.name + ' is already in ' + p.name + '.'); return false; }
      p.mods.push({ id: uid(), name: item.name, file: item.file, url: item.url, source: item.source || 'custom', ref: item.ref || '', size: item.size || 0, enabled: true });
      save();
      toast('Installed ' + item.name + ' into ' + p.name + (db.activeProfileId === p.id ? '' : ' (profile is disabled)'));
      refresh();
      addDependencies(pid, item);
      return true;
    }
    function startInstall(item) {
      if (ui.target && P(ui.target)) return addMod(ui.target, item);
      if (!db.profiles.length) {
        var d = mkProfile('Default'); db.profiles.push(d); if (!db.activeProfileId) db.activeProfileId = d.id;
        return addMod(d.id, item);
      }
      if (db.profiles.length === 1) return addMod(db.profiles[0].id, item);
      pendingItem = item;
      openModal('<h3>Install ' + esc(item.name) + ' into which profile?</h3>' +
        db.profiles.map(function (p) {
          return '<button class="btn pick" data-a="pickProfile" data-id="' + p.id + '"><span>' + esc(p.name) + '</span><span class="meta">' + p.mods.length + ' mods' + (db.activeProfileId === p.id ? ' &middot; ACTIVE' : '') + '</span></button>';
        }).join('') +
        '<div style="margin-top:12px" class="meta">Or create a new profile:</div><input class="inp" type="text" data-val id="newp" placeholder="Profile name" maxlength="60" style="width:100%">' +
        '<div style="margin-top:8px"><button class="btn primary" data-a="pickNew">Create &amp; install</button><button class="btn" data-a="closeModal">Cancel</button></div>');
    }

    /* ---------- import / export ---------- */
    function profilePayload(list) {
      return { bmm: 1, type: 'profiles', exportedAt: new Date().toISOString(), profiles: list.map(function (p) {
        return { name: p.name, mods: p.mods.map(function (m) { return { name: m.name, file: m.file, url: m.url, source: m.source, ref: m.ref, size: m.size, enabled: m.enabled }; }) };
      }) };
    }
    function exportModal(list, label) {
      exportPayload = profilePayload(list);
      var code = 'BMM1:' + btoa(unescape(encodeURIComponent(JSON.stringify(exportPayload))));
      openModal('<h3>Export ' + esc(label) + '</h3><p class="meta">Save the file somewhere safe &mdash; it lets you restore your profiles after clearing data or on another device.</p>' +
        '<button class="btn primary" data-a="dlExport">Download file</button><button class="btn hl" data-a="copyCode">Copy share code</button>' +
        '<textarea id="codebox" readonly>' + esc(code) + '</textarea><div style="margin-top:8px"><button class="btn" data-a="closeModal">Close</button></div>');
    }
    function parseImport(text) {
      text = String(text || '').trim(); if (!text) throw new Error('Nothing to import.');
      if (text.indexOf('BMM1:') === 0) text = decodeURIComponent(escape(atob(text.slice(5).replace(/\s+/g, ''))));
      var j = JSON.parse(text), profiles = [];
      if (Array.isArray(j)) j = { profiles: [{ name: 'Imported', mods: j }] };
      if (!j || !Array.isArray(j.profiles)) throw new Error('Not a Mod Manager export.');
      j.profiles.forEach(function (ip) {
        var p = mkProfile(uniqueName(String(ip.name || 'Imported').slice(0, 60)));
        db.profiles.push(p);
        (Array.isArray(ip.mods) ? ip.mods : []).forEach(function (im) {
          var url = typeof im === 'string' ? im : im && im.url;
          if (!okUrl(url) || SELF_RE.test(url) || p.mods.some(function (m) { return m.url === url; })) return;
          var f = fileOf(url);
          p.mods.push({ id: uid(), name: (im && im.name) || pretty(f), file: f, url: url, source: (im && im.source) || 'imported', ref: (im && im.ref) || '', size: (im && im.size) || 0, enabled: !(im && im.enabled === false) });
        });
        profiles.push(p);
      });
      return profiles;
    }
    function doImport(text) {
      var snapshot = db.profiles.slice();
      try {
        var got = parseImport(text);
        save(); closeModal(); toast('Imported ' + got.length + ' profile' + (got.length === 1 ? '' : 's') + '.'); go('profiles');
      } catch (e) { db.profiles = snapshot; toast('Import failed: ' + (e.message || e), 'err'); }
    }

    /* ---------- actions ---------- */
    var A = {
      tab: function (el) { go(el.dataset.v); },
      openProfile: function (el) { go('profile', el.dataset.id); },
      closeModal: closeModal,
      modalOk: function () { var i = $('#modal [data-val]'), v = i ? i.value : '', cb = modalCb; closeModal(); if (cb) cb(v); },
      reload: function () {
        try { if (!window.opener || window.opener.closed) throw 0; window.opener.location.reload(); toast('Reloading the game…'); }
        catch (e) { toast('Could not find the game tab. Reload it manually.', 'err'); }
      },
      newProfile: function () {
        askName('New profile', '', 'Create', function (v) {
          v = (v || '').trim(); if (!v) return;
          var p = mkProfile(uniqueName(v)); db.profiles.push(p); save(); go('profile', p.id);
        });
      },
      toggleProfile: function () {
        var p = P(ui.pid); if (!p) return;
        db.activeProfileId = db.activeProfileId === p.id ? null : p.id; save();
        toast(db.activeProfileId ? 'Enabled ' + p.name + ' (other profiles disabled)' : 'Disabled ' + p.name); refresh();
      },
      addContent: function () { ui.target = ui.pid; go('browse'); },
      doneTarget: function () { var pid = ui.target; ui.target = null; if (pid && P(pid)) go('profile', pid); else go('profiles'); },
      duplicate: function () {
        var p = P(ui.pid); if (!p) return;
        var c = mkProfile(uniqueName(p.name + ' (copy)'));
        c.mods = p.mods.map(function (m) { return Object.assign({}, m, { id: uid() }); });
        db.profiles.push(c); save(); toast('Duplicated.'); go('profile', c.id);
      },
      deleteProfile: function () {
        var p = P(ui.pid); if (!p) return;
        confirmModal('Delete the profile "' + p.name + '" and its ' + p.mods.length + ' mod entries? This cannot be undone (export first to keep a copy).', 'Delete profile', function () {
          db.profiles = db.profiles.filter(function (x) { return x.id !== p.id; });
          if (db.activeProfileId === p.id) db.activeProfileId = null;
          if (ui.target === p.id) ui.target = null;
          save(); toast('Deleted ' + p.name); go('profiles');
        });
      },
      removeMod: function (el) {
        var p = P(ui.pid); if (!p) return;
        p.mods = p.mods.filter(function (m) { return m.id !== el.dataset.id; }); save(); refresh();
      },
      up: function (el) { moveMod(el.dataset.id, -1); },
      down: function (el) { moveMod(el.dataset.id, 1); },
      install: function (el) { var it = registry.items[+el.dataset.i]; if (it) startInstall(it); },
      details: function (el) {
        var it = registry.items[+el.dataset.i]; if (!it) return;
        ui.open[it.url] = !ui.open[it.url];
        if (ui.open[it.url]) loadDesc(it);
        refresh();
      },
      more: function () { ui.shown += PAGE; refresh(); },
      refreshReg: function () { ensureRegistry(true); },
      pickProfile: function (el) { var it = pendingItem; closeModal(); if (it) addMod(el.dataset.id, it); pendingItem = null; },
      pickNew: function () {
        var v = ($('#newp') || {}).value; v = (v || '').trim(); if (!v) { toast('Enter a profile name.', 'err'); return; }
        var it = pendingItem, p = mkProfile(uniqueName(v)); db.profiles.push(p); pendingItem = null; closeModal(); if (it) addMod(p.id, it); else save();
      },
      addCustom: function () {
        var u = (($('#custom') || {}).value || '').trim();
        if (!okUrl(u)) { toast('Enter a link ending in .js.', 'err'); return; }
        if (SELF_RE.test(u)) { toast('That is this manager — it is always installed.', 'err'); return; }
        var f = fileOf(u); $('#custom').value = '';
        startInstall({ name: pretty(f), file: f, url: u, source: 'custom link', ref: '', size: 0 });
      },
      exportAll: function () { if (!db.profiles.length) return toast('No profiles to export.', 'err'); exportModal(db.profiles, 'all profiles'); },
      exportOne: function () { var p = P(ui.pid); if (p) exportModal([p], '"' + p.name + '"'); },
      dlExport: function () {
        var blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
        var a = document.createElement('a'), n = exportPayload.profiles.length === 1 ? exportPayload.profiles[0].name.replace(/[^\w\-]+/g, '_') : 'all-profiles';
        a.href = URL.createObjectURL(blob); a.download = 'bestModManager-' + n + '-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
        db.lastExport = Date.now(); writeJSON(STORE, db, true); toast('Exported.');
      },
      copyCode: function () {
        var box = $('#codebox'); box.select();
        var done = function () { db.lastExport = Date.now(); writeJSON(STORE, db, true); toast('Share code copied.'); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(box.value).then(done, function () { document.execCommand('copy'); done(); });
        else { document.execCommand('copy'); done(); }
      },
      importModal: function () {
        openModal('<h3>Import profiles</h3><p class="meta">Imported profiles are added as new profiles &mdash; nothing is overwritten. Only import files from people you trust: mods run with full access to the game.</p>' +
          '<input type="file" accept=".json,application/json" data-c="importFile"><div class="meta" style="margin:10px 0 4px">…or paste a share code / JSON:</div>' +
          '<textarea data-val placeholder="BMM1:…"></textarea><div style="margin-top:8px"><button class="btn primary" data-a="doImport">Import</button><button class="btn" data-a="closeModal">Cancel</button></div>');
      },
      doImport: function () { doImport(($('#modal [data-val]') || {}).value); }
    };
    function moveMod(id, d) {
      var p = P(ui.pid); if (!p) return;
      var i = p.mods.findIndex(function (m) { return m.id === id; }), j = i + d;
      if (i < 0 || j < 0 || j >= p.mods.length) return;
      var t = p.mods[i]; p.mods[i] = p.mods[j]; p.mods[j] = t; save(); refresh();
    }
    var C = {
      rename: function (el) {
        var p = P(ui.pid); if (!p) return; var v = el.value.trim();
        if (!v) { el.value = p.name; return; }
        if (v !== p.name) { p.name = uniqueName(v, p.id); save(); toast('Renamed.'); }
        refresh();
      },
      toggleMod: function (el) {
        var p = P(ui.pid); if (!p) return; var m = p.mods.find(function (x) { return x.id === el.dataset.id; });
        if (m) { m.enabled = el.checked; save(); refresh(); }
      },
      importFile: function (el) {
        var f = el.files && el.files[0]; if (!f) return;
        f.text().then(doImport, function () { toast('Could not read that file.', 'err'); });
      }
    };
    var I = {
      query: function (el) { ui.query = el.value; ui.shown = PAGE; renderResults(); },
      pfilter: function (el) { ui.pfilter = el.value; renderPList(); }
    };

    /* ---------- boot ---------- */
    var root = document.documentElement;
    if (boot.theme) Object.keys(boot.theme).forEach(function (k) { root.style.setProperty(k, boot.theme[k]); });
    document.title = 'Mod Manager - Sandboxels';
    document.body.innerHTML = '<div id="head"></div><main id="view"></main><div id="modal"></div><div id="toasts"></div>';

    document.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('[data-a]') : null;
      if (el && el.tagName !== 'INPUT' && A[el.dataset.a]) A[el.dataset.a](el, e);
    });
    document.addEventListener('change', function (e) { var el = e.target; if (el && el.dataset && C[el.dataset.c]) C[el.dataset.c](el, e); });
    document.addEventListener('input', function (e) { var el = e.target; if (el && el.dataset && I[el.dataset.i]) I[el.dataset.i](el, e); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && $('#modal.on')) closeModal();
      if (e.key === 'Enter' && e.target && e.target.matches && e.target.matches('#modal input[type=text]')) {
        var ok = $('#modal [data-a=modalOk],#modal [data-a=pickNew]'); if (ok) ok.click();
      }
      if (e.key === 'Enter' && e.target && e.target.id === 'custom') A.addCustom();
    });
    window.addEventListener('storage', function (e) {
      if (e.key === STORE) { db = readJSON(STORE, db); if (ui.view === 'profile' && !P(ui.pid)) ui.view = 'profiles'; renderTop(); renderMain(); }
      else if (e.key === ENABLED || e.key === LOADED) renderTop();
      else if (e.key === STATUS) { renderTop(); if (ui.view === 'profile') renderPList(); }
    });
    renderTop(); renderMain();
  }

  /* ---------------------------------------------------------------------------
   * Game side: load the active profile's mods the way the game itself would.
   * ------------------------------------------------------------------------- */
  var selfSrc = '';
  try { selfSrc = (document.currentScript && document.currentScript.src) || ''; } catch (e) { /* ignore */ }
  if (!selfSrc) {
    var ss = document.scripts;
    for (var si = 0; si < ss.length; si++) { if (ss[si].src && SELF_RE.test(ss[si].src)) { selfSrc = ss[si].src; break; } }
  }

  function readJSON(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function entryOf(m) { return OFFICIAL_RE.test(m.url) ? 'mods/' + m.file : m.url; }
  function lastSeg(e) { var p = String(e).split('/'); return p[p.length - 1]; }

  var nativeSetItem = null;
  function bootGameSide() {
    var db = readJSON('bmm_v1', null);
    var cur = readJSON('enabledMods', []); if (!Array.isArray(cur)) cur = [];

    /* the manager must always stay enabled */
    var selfEntry = '';
    for (var k = 0; k < cur.length; k++) { if (typeof cur[k] === 'string' && SELF_RE.test(cur[k])) { selfEntry = cur[k]; break; } }
    if (!selfEntry && selfSrc) { selfEntry = selfSrc; cur.unshift(selfEntry); try { localStorage.setItem('enabledMods', JSON.stringify(cur)); } catch (e) { /* ignore */ } }
    if (selfEntry) { try { localStorage.setItem('bmm_self', selfEntry); } catch (e) { /* ignore */ } }

    /* what the active profile wants loaded, and everything any profile manages */
    var managed = {}, plan = [], ap = null;
    if (db && Array.isArray(db.profiles)) {
      db.profiles.forEach(function (p) {
        if (p.id === db.activeProfileId) ap = p;
        (p.mods || []).forEach(function (m) { if (m && m.url) { managed[entryOf(m)] = 1; managed[m.url] = 1; } });
      });
    }
    if (ap) (ap.mods || []).forEach(function (m) {
      if (!m || !m.enabled || !m.url || SELF_RE.test(m.url)) return;
      var e = entryOf(m);
      if (plan.some(function (x) { return x.entry === e; })) return;
      plan.push({ entry: e, src: m.url });
    });

    var G = window;
    var haveGlobals = Array.isArray(G.enabledMods) && Array.isArray(G.enabledModNames) && Array.isArray(G.loadedMods) &&
      Array.isArray(G.queuedMods) && typeof G.checkDependents === 'function';

    /* A previous version put profile mods straight into enabledMods, so the game already loaded
       them by their CDN url. Clean that up and reload once so they load the right way. */
    var natives = haveGlobals ? G.enabledMods.slice() : cur.slice();
    var leaked = natives.some(function (n) { return typeof n === 'string' && !SELF_RE.test(n) && managed[n]; });
    if (leaked) {
      var cleaned = natives.filter(function (n) { return typeof n === 'string' && (SELF_RE.test(n) || !managed[n]); });
      var guard = false; try { guard = sessionStorage.getItem('bmm_fix'); } catch (e) { guard = true; }
      if (!guard) {
        try { sessionStorage.setItem('bmm_fix', '1'); localStorage.setItem('enabledMods', JSON.stringify(cleaned)); location.reload(); return; } catch (e) { /* carry on */ }
      }
    }

    /* keep our injected entries out of anything a mod persists to enabledMods */
    var injected = {};
    plan.forEach(function (it) { injected[it.entry] = 1; });
    nativeSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'enabledMods' && this === window.localStorage) {
        try {
          var arr = JSON.parse(value);
          if (Array.isArray(arr)) {
            arr = arr.filter(function (e) { return !(typeof e === 'string' && (injected[e] || (managed[e] && !SELF_RE.test(e)))); });
            if (selfEntry && arr.indexOf(selfEntry) < 0) arr.unshift(selfEntry);
            value = JSON.stringify(arr);
          }
        } catch (e) { /* leave as-is */ }
      }
      return nativeSetItem.call(this, key, value);
    };

    var status = { items: {} };
    var saveTimer = null;
    function setStatus(entry, state, msg) {
      status.items[entry] = { state: state, msg: msg || '' };
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { try { localStorage.setItem('bmm_status', JSON.stringify(status)); } catch (e) { /* ignore */ } }, 50);
    }
    try {
      localStorage.setItem('bmm_loaded', JSON.stringify(plan.map(function (it) { return it.entry; })));
      localStorage.setItem('bmm_status', JSON.stringify(status));
    } catch (e) { /* ignore */ }
    if (!plan.length) return;

    if (!haveGlobals) { /* unknown game version: plain script loading, no name registration */
      plan.forEach(function (it) { var s = document.createElement('script'); s.async = false; s.src = it.src; document.head.appendChild(s); });
      console.warn('[bestModManager] game loader globals not found; mods loaded without native names.');
      return;
    }

    /* Register every mod under the name the game and other mods look for. */
    var skip = {};
    plan.forEach(function (it) {
      if (natives.indexOf(it.entry) >= 0) { skip[it.entry] = true; return; }
      G.enabledMods.push(it.entry);
      var sn = lastSeg(it.entry); if (G.enabledModNames.indexOf(sn) < 0) G.enabledModNames.push(sn);
    });

    var byUrl = {};
    window.addEventListener('error', function (ev) {
      var f = ev && ev.filename, ent = f && byUrl[f];
      if (ent && status.items[ent] && status.items[ent].state === 'loaded') setStatus(ent, 'error', ev.message);
      else if (ent) setStatus(ent, 'error', ev.message);
    });

    /* Mods that force-load other mods (dependOn(name, cb, true)) queue them on queuedDependencies.
       The game only loads those from inside its own load handlers, so do it for the mods we load. */
    function resolveDep(name) {
      var reg = readJSON('bmm_registry_v1', null);
      if (reg && reg.items) for (var i = 0; i < reg.items.length; i++) if (reg.items[i].file === name) return reg.items[i].url;
      return 'mods/' + name;
    }
    function pump() {
      var q = G.queuedDependencies; if (!Array.isArray(q)) return;
      while (q.length) {
        var src = q.shift(), name = lastSeg(src);
        if (G.loadedMods.indexOf(name) >= 0 || G.queuedMods.indexOf(name) >= 0) continue;
        G.queuedMods.push(name);
        (function (n) {
          var s = document.createElement('script'), real = resolveDep(n);
          if (/^https:\/\/cdn\.jsdelivr\.net\//.test(real)) s.crossOrigin = 'anonymous';
          s.async = false; s.src = real;
          s.addEventListener('load', function () { try { G.checkDependents(n); } catch (e) { console.error(e); } G.loadedMods.push(n); pump(); });
          s.addEventListener('error', function () { console.log('Error in mod: ' + real); });
          document.head.appendChild(s);
        })(name);
      }
    }

    /* Load in profile order. async=false makes the browser run them in that order too. */
    plan.forEach(function (it) {
      if (skip[it.entry]) { setStatus(it.entry, 'loaded'); return; }
      var short = lastSeg(it.entry);
      var modName = /^https?:/i.test(it.entry) ? it.entry : short; /* the game's own naming rule */
      G.queuedMods.push(modName);
      setStatus(it.entry, 'loading');
      var s = document.createElement('script');
      if (/^https:\/\/cdn\.jsdelivr\.net\//.test(it.src)) s.crossOrigin = 'anonymous'; /* lets us see a mod's real error message */
      s.async = false;
      s.src = it.src;
      try { byUrl[new URL(it.src, location.href).href] = it.entry; } catch (e) { /* ignore */ }
      s.addEventListener('load', function () {
        if (!status.items[it.entry] || status.items[it.entry].state === 'loading') setStatus(it.entry, 'loaded');
        try { G.checkDependents(modName); } catch (e) { console.error('[bestModManager] error in dependOn callback for ' + it.entry, e); }
        G.loadedMods.push(modName);
        pump();
      });
      s.addEventListener('error', function () {
        setStatus(it.entry, 'failed', 'Could not download ' + it.src);
        console.log('Error in mod: ' + it.entry);
        console.log('Could not download ' + it.src);
        pump();
      });
      document.head.appendChild(s);
    });
  }
  try { bootGameSide(); } catch (e) { console.error('[bestModManager] startup error', e); }

  /* ---------------------------------------------------------------------------
   * Mods button hook + opening the manager page.
   * ------------------------------------------------------------------------- */
  function themeInfo() {
    var t = {};
    try {
      var cs = getComputedStyle(document.documentElement);
      ['--theme', '--theme-dark', '--theme-darker', '--theme-darkest', '--theme-darkest2'].forEach(function (k) {
        var v = cs.getPropertyValue(k).trim(); if (v) t[k] = v;
      });
    } catch (e) { /* ignore */ }
    return { theme: t };
  }
  function fontFaces() { /* copy the game's @font-face rules so the page uses the same pixel fonts */
    var out = [];
    try {
      for (var s = 0; s < document.styleSheets.length; s++) {
        var sh = document.styleSheets[s], rules;
        try { rules = sh.cssRules; } catch (e) { continue; }
        var base = sh.href || location.href;
        for (var r = 0; r < rules.length; r++) {
          if (rules[r].type === 5) {
            out.push(rules[r].cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, function (m, q, u) {
              if (/^(data:|https?:)/i.test(u)) return m;
              try { return 'url("' + new URL(u, base).href + '")'; } catch (e) { return m; }
            }));
          }
        }
      }
    } catch (e) { /* ignore */ }
    return out.join('\n');
  }

  function openManager() {
    var w = null;
    try { w = window.open('', 'bmm_manager_window'); } catch (e) { w = null; }
    if (!w) return false;
    try { if (w.__bmmReady && w.__bmmVersion === VERSION) { w.focus(); return true; } } catch (e) { /* ignore */ }
    var boot = themeInfo();
    boot.selfUrl = selfSrc;
    boot.version = VERSION;
    var js = '(' + bmmApp.toString() + ')(' + JSON.stringify(boot).replace(/</g, '\\u003c') + ');';
    js = js.replace(/<\/script/gi, '<\\/script');
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Mod Manager</title><style>' + fontFaces() + '\n' + BMM_CSS + '</style></head><body><script>' + js + '<\/script></body></html>';
    try { w.document.open(); w.document.write(html); w.document.close(); w.focus(); return true; }
    catch (e) { console.error('[bestModManager] could not build the page', e); return false; }
  }

  var origShow = window.showModManager;
  function fallback() {
    try { alert('Best Mod Manager: your browser blocked the new page. Allow pop-ups for this site and try again.'); } catch (e) { /* ignore */ }
    if (typeof origShow === 'function') origShow();
  }
  window.showModManager = function () { if (!openManager()) fallback(); };
  document.addEventListener('click', function (e) {
    if (e.shiftKey) return; /* Shift+click opens the original Mods panel */
    var t = e.target; if (!t || !t.closest) return;
    var hit = t.closest('#modsButton,[onclick*="showModManager"]');
    if (!hit) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!openManager()) fallback();
  }, true);

  window.bmm = { version: VERSION, open: openManager };
  console.log('[bestModManager] v' + VERSION + ' ready. Click Mods to open it (Shift+click for the original panel).');
})();
