/* script.js - Full client-side music app prototype
   - Uses IndexedDB for binaries (audio, images)
   - Uses localStorage for JSON metadata
   - Robust defensive code, modular rendering, persistent player
*/

/* ---------------------------
   IndexedDB helper (blobs store)
   --------------------------- */
const DB_NAME = 'music_client_db_v1';
const DB_STORE = 'assets';
let idbPromise = null;

function openDB() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return idbPromise;
}

async function idbPut(id, blob) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);
    store.put({ id, blob });
    tx.oncomplete = () => res(true);
    tx.onerror = (e) => rej(e);
  });
}

async function idbGet(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const store = tx.objectStore(DB_STORE);
    const req = store.get(id);
    req.onsuccess = () => res(req.result ? req.result.blob : null);
    req.onerror = (e) => rej(e);
  });
}

async function idbDelete(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);
    store.delete(id);
    tx.oncomplete = () => res(true);
    tx.onerror = (e) => rej(e);
  });
}

/* ---------------------------
   localStorage metadata helpers
   --------------------------- */
const META_KEY = 'music_app_meta_v1';

function loadMeta() {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return defaultMeta();
    const parsed = JSON.parse(raw);
    // Basic validation & migrations
    if (!parsed.users) parsed.users = [];
    if (!parsed.songs) parsed.songs = [];
    if (!parsed.playlists) parsed.playlists = [];
    if (!parsed.albums) parsed.albums = [];
    if (!parsed.likes) parsed.likes = {};
    if (!parsed.followers) parsed.followers = {};
    return parsed;
  } catch (e) {
    console.warn('meta load error', e);
    const m = defaultMeta();
    saveMeta(m);
    return m;
  }
}

function saveMeta(meta) {
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

function defaultMeta() {
  return {
    users: [],
    songs: [],
    albums: [],
    playlists: [],
    likes: {}, // songId -> array of usernames
    followers: {}, // username -> array of follower usernames
    recentlyPlayed: [], // songId list
    nextIds: {song:1, album:1, playlist:1, user:1}
  };
}

/* ---------------------------
   Utilities
   --------------------------- */
function $(sel, root=document) { return root.querySelector(sel); }
function $all(sel, root=document) { return Array.from(root.querySelectorAll(sel)); }
function uid(prefix='id') { return prefix + '_' + Math.random().toString(36).slice(2,9); }
function toast(msg, time=2000) {
  const t = $('#toast'); if (!t) return;
  t.textContent = msg; t.classList.remove('hidden');
  setTimeout(()=> t.classList.add('hidden'), time);
}

/* ---------------------------
   App state & player
   --------------------------- */
const state = {
  meta: loadMeta(),
  currentUser: null,
  route: 'home',
  routeParam: null,
  player: {
    queue: [],
    index: 0,
    playing: false,
    audioEl: null,
    currentSongId: null,
    seekUpdating: false
  }
};

/* ---------------------------
   Bootstrap: ensure superAdmin
   --------------------------- */
function ensureSuperAdmin() {
  const m = state.meta;
  const exists = m.users.find(u => u.username === 'RankRates');
  if (!exists) {
    const id = m.nextIds.user++;
    const su = {
      id, username: 'RankRates', password: 'Rank1250',
      displayName: 'RankRates', bio: 'Super admin', verified: true, superAdmin: true,
      imageAssetId: null,
      createdAt: Date.now()
    };
    m.users.push(su);
    saveMeta(m);
    toast('SuperAdmin created: RankRates');
  }
}

/* ---------------------------
   Sample content generation (generate small WAV + art) 
   - This runs only if no songs exist
   --------------------------- */
async function createSampleAssetsIfEmpty() {
  const m = state.meta;
  if (m.songs.length > 0) return;
  // Ensure at least one user besides admin
  if (!m.users.find(u=>u.username==='alice')) {
    const id = m.nextIds.user++;
    m.users.push({id, username:'alice', password:'alice', displayName:'Alice', bio:'Demo user', verified:true, superAdmin:false, imageAssetId:null, createdAt:Date.now()});
  }

  // generate a short beep WAV blob
  function genWav(seconds=2, freq=440) {
    const sr = 44100, nch=1, frames = sr*seconds;
    const buffer = new ArrayBuffer(44 + frames*2);
    const view = new DataView(buffer);
    function writeString(view, offset, str) {
      for (let i=0;i<str.length;i++) view.setUint8(offset+i,str.charCodeAt(i));
    }
    writeString(view,0,'RIFF'); view.setUint32(4,36 + frames*2, true);
    writeString(view,8,'WAVE'); writeString(view,12,'fmt ');
    view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,nch,true); view.setUint32(24,sr,true);
    view.setUint32(28,sr*nch*2,true); view.setUint16(32,nch*2,true); view.setUint16(34,16,true);
    writeString(view,36,'data'); view.setUint32(40,frames*2,true);
    let offset=44;
    for (let i=0;i<frames;i++){
      const t = i/sr;
      const s = Math.sin(2*Math.PI*freq*t) * Math.exp(-3*t); // decaying sine
      const val = Math.max(-1,Math.min(1,s));
      view.setInt16(offset, val * 0x7fff, true);
      offset += 2;
    }
    return new Blob([view], {type:'audio/wav'});
  }

  function genArt(text='Demo') {
    const c = document.createElement('canvas'); c.width = 1200; c.height = 1200;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#111'; ctx.fillRect(0,0,c.width,c.height);
    ctx.fillStyle = '#1db954'; ctx.fillRect(60,60,c.width-120,c.height-120);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 220px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, c.width/2, c.height/2);
    return new Promise(res => c.toBlob(res, 'image/jpeg', 0.9));
  }

  const audioBlob = genWav(3, 440);
  const artBlob = await genArt('Demo');

  const songId = `song_${m.nextIds.song++}`;
  const albumId = `album_${m.nextIds.album++}`;
  const uploader = m.users[0].username;

  // store in indexedDB
  await idbPut(`audio:${songId}`, audioBlob);
  await idbPut(`image:album:${albumId}`, artBlob);
  await idbPut(`image:user:${m.users[0].id}`, artBlob);

  m.albums.push({id: albumId, title: 'Demo Album', artist: uploader, year: (new Date()).getFullYear(), coverAssetId:`image:album:${albumId}`, tracks: [songId]});
  m.songs.push({
    id: songId, title: 'Demo Track', artist: uploader, albumId, duration: 3, assetId:`audio:${songId}`,
    coverAssetId:`image:album:${albumId}`, genre:'Electronic', language:'English', explicit:false, uploadedBy:uploader
  });

  saveMeta(m);
  toast('Sample song created');
}

/* ---------------------------
   Auth, users, follow/unfollow
   --------------------------- */
function registerUser(username, password, displayName) {
  const m = state.meta;
  if (m.users.find(u=>u.username===username)) return {ok:false, msg:'Username exists'};
  const id = m.nextIds.user++;
  const user = { id, username, password, displayName: displayName||username, bio:'', verified:false, superAdmin:false, imageAssetId:null, createdAt:Date.now() };
  m.users.push(user);
  saveMeta(m);
  return {ok:true, user};
}

function loginUser(username, password) {
  const m = state.meta;
  const user = m.users.find(u=>u.username===username && u.password===password);
  if (!user) return {ok:false, msg:'Invalid credentials'};
  state.currentUser = user;
  renderAuthArea();
  toast(`Signed in as ${user.displayName}`);
  return {ok:true,user};
}

function logoutUser() {
  state.currentUser = null;
  renderAuthArea();
  toast('Logged out');
}

function followUser(targetUsername) {
  if (!state.currentUser) { toast('Login first'); return; }
  const m = state.meta;
  if (!m.followers[targetUsername]) m.followers[targetUsername] = [];
  const arr = m.followers[targetUsername];
  if (!arr.includes(state.currentUser.username)) arr.push(state.currentUser.username);
  saveMeta(m);
}

function unfollowUser(targetUsername) {
  if (!state.currentUser) { toast('Login first'); return; }
  const m = state.meta;
  const arr = m.followers[targetUsername] || [];
  const idx = arr.indexOf(state.currentUser.username);
  if (idx>=0) arr.splice(idx,1);
  m.followers[targetUsername]=arr;
  saveMeta(m);
}

/* ---------------------------
   Player engine
   --------------------------- */
function initPlayer() {
  const audio = $('#audio');
  if (!audio) return;
  state.player.audioEl = audio;

  audio.addEventListener('timeupdate', ()=>{
    try {
      const s = state.player;
      if (!s.currentSongId) return;
      const ct = audio.currentTime || 0;
      const dur = audio.duration || 0;
      const p = document.getElementById('seek');
      if (p && !s.seekUpdating) p.value = dur ? (ct/dur*100) : 0;
      const cur = $('#currentTime'); const durEl = $('#duration');
      if (cur) cur.textContent = formatTime(ct);
      if (durEl) durEl.textContent = formatTime(dur);
      // fs seek sync
      const fsSeek = $('#fsSeek'); if (fsSeek && !s.seekUpdating) fsSeek.value = dur ? (ct/dur*100) : 0;
    } catch(e) { console.error(e); }
  });

  audio.addEventListener('ended', ()=> {
    playNext();
  });

  // controls
  $('#playPauseBtn')?.addEventListener('click', togglePlay);
  $('#prevBtn')?.addEventListener('click', playPrev);
  $('#nextBtn')?.addEventListener('click', playNext);
  $('#seek')?.addEventListener('input', (e)=> {
    state.player.seekUpdating = true;
    const v = Number(e.target.value);
    const audio = state.player.audioEl;
    if (audio.duration) audio.currentTime = audio.duration * v / 100;
    setTimeout(()=> state.player.seekUpdating = false, 300);
  });
  $('#volume')?.addEventListener('input', (e)=> { audio.volume = Number(e.target.value); });

  // fullscreen controls
  $('#expandBtn')?.addEventListener('click', ()=> $('#fullscreenModal').classList.remove('hidden'));
  $('#fsClose')?.addEventListener('click', ()=> $('#fullscreenModal').classList.add('hidden'));
  $('#fsPlay')?.addEventListener('click', togglePlay);
  $('#fsPrev')?.addEventListener('click', playPrev);
  $('#fsNext')?.addEventListener('click', playNext);
  $('#fsSeek')?.addEventListener('input', (e)=> {
    const v = Number(e.target.value);
    if (audio.duration) audio.currentTime = audio.duration * v / 100;
  });

  // queue open
  $('#queueBtn')?.addEventListener('click', ()=> {
    // open a simple queue panel
    openQueuePanel();
  });

  // like
  $('#likeBtn')?.addEventListener('click', ()=> {
    const sid = state.player.currentSongId;
    if (!sid || !state.currentUser) { toast('Login to like'); return; }
    const m = state.meta;
    m.likes[sid] = m.likes[sid] || [];
    const arr = m.likes[sid];
    const u = state.currentUser.username;
    if (arr.includes(u)) {
      arr.splice(arr.indexOf(u),1);
      $('#likeBtn').textContent = '♡';
    } else { arr.push(u); $('#likeBtn').textContent = '♥'; }
    saveMeta(m);
  });
}

function playSong(songId, contextQueue = null) {
  // contextQueue: array of songIds (for queue playback)
  const audio = state.player.audioEl;
  const song = state.meta.songs.find(s=>s.id===songId);
  if (!song) { toast('Song missing'); return; }
  (async ()=>{
    try {
      const blob = await idbGet(song.assetId);
      if (!blob) { toast('Audio blob missing'); return; }
      const url = URL.createObjectURL(blob);
      audio.src = url;
      await audio.play();
      state.player.playing = true;
      state.player.currentSongId = songId;
      if (contextQueue && Array.isArray(contextQueue)) state.player.queue = contextQueue;
      state.player.index = state.player.queue.indexOf(songId) >= 0 ? state.player.queue.indexOf(songId) : 0;
      updatePlayerUI(song);
      // mark recently played
      const rp = state.meta.recentlyPlayed || [];
      rp.unshift(songId); while (rp.length>50) rp.pop();
      state.meta.recentlyPlayed = Array.from(new Set(rp));
      saveMeta(state.meta);
    } catch (e) {
      console.error(e); toast('Playback error');
    }
  })();
}

function updatePlayerUI(song) {
  const coverEl = $('#playerCover'); const title = $('#playerTitle'); const artist = $('#playerArtist');
  const fsCover = $('#fsCover'); const fsTitle = $('#fsTitle'); const fsArtist = $('#fsArtist'); const fsAlbum = $('#fsAlbum');
  const fsExplicit = $('#fsExplicit'); const fsLang = $('#fsLanguage'); const fsGenre = $('#fsGenre');
  if (coverEl) {
    if (song.coverAssetId) idbGet(song.coverAssetId).then(b=>{ if (b) coverEl.src = URL.createObjectURL(b); else coverEl.src = ''; });
  }
  if (title) title.textContent = song.title;
  if (artist) artist.textContent = song.artist;
  if (fsCover) idbGet(song.coverAssetId).then(b=>{ if (b) fsCover.src = URL.createObjectURL(b); else fsCover.src='';});
  if (fsTitle) fsTitle.textContent = song.title;
  if (fsArtist) fsArtist.textContent = song.artist;
  if (fsAlbum) fsAlbum.textContent = state.meta.albums.find(a=>a.id===song.albumId)?.title || '';
  if (fsExplicit) { if (song.explicit) fsExplicit.classList.remove('hidden'); else fsExplicit.classList.add('hidden'); }
  if (fsLang) { fsLang.textContent = song.language || ''; fsLang.classList.toggle('hidden', !song.language); }
  if (fsGenre) { fsGenre.textContent = song.genre || ''; fsGenre.classList.toggle('hidden', !song.genre); }
  $('#playPauseBtn').textContent = '⏸';
  $('#fsPlay').textContent = '⏸';
}

function togglePlay() {
  const a = state.player.audioEl; if (!a) return;
  if (a.paused) { a.play(); state.player.playing = true; $('#playPauseBtn').textContent='⏸'; $('#fsPlay').textContent='⏸'; }
  else { a.pause(); state.player.playing = false; $('#playPauseBtn').textContent='▶'; $('#fsPlay').textContent='▶'; }
}

function playNext() {
  const q = state.player.queue;
  let idx = state.player.index;
  if (q.length === 0) return;
  idx = (idx + 1) % q.length;
  state.player.index = idx;
  playSong(q[idx], q);
}

function playPrev() {
  const q = state.player.queue;
  let idx = state.player.index;
  if (q.length === 0) return;
  idx = (idx - 1 + q.length) % q.length;
  state.player.index = idx;
  playSong(q[idx], q);
}

/* ---------------------------
   Queue panel simple UI
   --------------------------- */
function openQueuePanel() {
  const q = state.player.queue || [];
  const root = document.createElement('div');
  root.style.position='fixed'; root.style.right='12px'; root.style.bottom='120px'; root.style.background='#111';
  root.style.padding='12px'; root.style.borderRadius='8px'; root.style.maxHeight='300px'; root.style.overflow='auto'; root.style.zIndex=999;
  root.innerHTML = `<b>Queue</b><div></div><button id="closeQueue">Close</button>`;
  const listEl = root.querySelector('div');
  q.forEach((sid, i)=> {
    const s = state.meta.songs.find(x=>x.id===sid);
    const el = document.createElement('div');
    el.textContent = `${i+1}. ${s ? s.title : sid}`;
    el.style.padding='6px';
    el.addEventListener('click', ()=> { state.player.index=i; playSong(sid,q); document.body.removeChild(root); });
    listEl.appendChild(el);
  });
  root.querySelector('#closeQueue').addEventListener('click', ()=> document.body.removeChild(root));
  document.body.appendChild(root);
}

/* ---------------------------
   Format time
   --------------------------- */
function formatTime(sec) {
  if (!isFinite(sec) || sec<=0) return '0:00';
  const s = Math.floor(sec%60); const m = Math.floor(sec/60);
  return `${m}:${s.toString().padStart(2,'0')}`;
}

/* ---------------------------
   Upload music UI
   --------------------------- */
function openUploadModal() {
  const modal = $('#uploadModal');
  if (!modal) return;
  // populate artist select
  const sel = $('#metaArtist'); if (sel) {
    sel.innerHTML = '';
    state.meta.users.forEach(u=> {
      const opt = document.createElement('option'); opt.value = u.username; opt.textContent = u.displayName || u.username;
      sel.appendChild(opt);
    });
  }
  modal.classList.remove('hidden');

  const form = $('#uploadForm');
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const audioFile = $('#audioFile')?.files[0];
    const coverFile = $('#coverFile')?.files[0];
    if (!audioFile || !coverFile) { toast('Select files'); return; }
    // check cover size
    const img = await fileToImage(coverFile);
    if (img.width < 1000 || img.height < 1000) { toast('Cover too small (min 1000x1000)'); return; }
    const title = $('#metaTitle').value.trim();
    const artist = $('#metaArtist').value;
    const albumName = $('#metaAlbum').value.trim() || 'Single';
    const genre = $('#metaGenre').value;
    const lang = $('#metaLang').value;
    const explicit = $('#metaExplicit').checked;

    // create ids
    const songId = `song_${state.meta.nextIds.song++}`;
    const albumId = `album_${state.meta.nextIds.album++}`;

    // store blobs
    await idbPut(`audio:${songId}`, await fileToBlob(audioFile));
    await idbPut(`image:album:${albumId}`, await imageToBlob(img));
    // update meta
    state.meta.albums.push({id: albumId, title: albumName, artist, year: (new Date()).getFullYear(), coverAssetId:`image:album:${albumId}`, tracks: [songId]});
    state.meta.songs.push({
      id: songId, title, artist, albumId, duration: Math.round( (audioFile.size/100000) || 120 ), assetId:`audio:${songId}`,
      coverAssetId:`image:album:${albumId}`, genre, language:lang, explicit, uploadedBy: artist
    });
    saveMeta(state.meta);
    toast('Upload completed');
    modal.classList.add('hidden');
    renderPlaylists(); renderHome();
  };
}

function fileToBlob(file) {
  return new Promise((res)=> {
    const r = new FileReader();
    r.onload = ()=> {
      const arr = new Uint8Array(r.result);
      res(new Blob([arr], {type: file.type}));
    };
    r.readAsArrayBuffer(file);
  });
}

function fileToImage(file) {
  return new Promise((res,rej)=> {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = ()=> { URL.revokeObjectURL(url); res(img); };
    img.onerror = (e)=> rej(e);
    img.src = url;
  });
}

function imageToBlob(img) {
  return new Promise((res)=> {
    const c = document.createElement('canvas'); c.width=1200; c.height=1200;
    const ctx = c.getContext('2d'); ctx.drawImage(img,0,0,c.width,c.height);
    c.toBlob((b)=>res(b||new Blob()), 'image/jpeg', 0.9);
  });
}

/* ---------------------------
   Playlist system
   --------------------------- */
function createPlaylist(name, ownerUsername, isPrivate=false) {
  const id = `playlist_${state.meta.nextIds.playlist++}`;
  const pl = { id, name, owner: ownerUsername, tracks: [], coverAssetId: null, private: !!isPrivate, sharedWith: [], createdAt: Date.now() };
  state.meta.playlists.push(pl);
  saveMeta(state.meta);
  return pl;
}

/* ---------------------------
   Rendering functions (modular)
   --------------------------- */
function render() {
  // attach global nav
  $all('.nav-btn').forEach(btn=>{
    if (btn.dataset._nav) return;
    btn.dataset._nav = '1';
    btn.addEventListener('click', ()=> {
      const route = btn.getAttribute('data-route');
      navigate(route);
    });
  });
  // search input
  $('#globalSearchInput')?.addEventListener('input', (e)=> {
    navigate('search', e.target.value);
  });

  renderAuthArea();
  renderUserMini();
  renderMainRoute();
}

function navigate(route, param=null) {
  state.route = route;
  state.routeParam = param;
  renderMainRoute();
}

function renderMainRoute() {
  const area = $('#contentArea'); if (!area) return;
  try {
    if (state.route === 'home') renderHome();
    else if (state.route === 'search') renderSearchPage(state.routeParam || '');
    else if (state.route === 'library') renderLibrary();
    else if (state.route === 'playlists') renderPlaylists();
    else if (state.route === 'liked') renderLiked();
    else if (state.route === 'upload') openUploadModal();
    else renderHome();
  } catch (e) { console.error(e); area.innerHTML = '<p>Error rendering</p>'; }
  $('#breadcrumbs').textContent = state.route.charAt(0).toUpperCase() + state.route.slice(1);
}

/* Home */
function renderHome() {
  const area = $('#contentArea'); if (!area) return;
  area.innerHTML = '';
  const section = document.createElement('div');
  section.innerHTML = `<h2>Recently Played</h2>`;
  const recentDiv = document.createElement('div'); recentDiv.className='grid';
  const rp = state.meta.recentlyPlayed || [];
  rp.slice(0,8).forEach(sid=>{
    const s = state.meta.songs.find(x=>x.id===sid);
    if (!s) return;
    const card = createSongCard(s);
    recentDiv.appendChild(card);
  });
  section.appendChild(recentDiv);

  // daily mixes - generate from songs
  const mixes = document.createElement('div'); mixes.innerHTML = `<h2>Daily Mixes</h2>`;
  const mixGrid = document.createElement('div'); mixGrid.className='grid';
  for (let i=0;i<4;i++){
    const card = document.createElement('div'); card.className='card';
    const img = document.createElement('img'); img.alt='mix';
    const someSong = state.meta.songs[i % state.meta.songs.length];
    if (someSong) idbGet(someSong.coverAssetId).then(b=>{ if (b) img.src = URL.createObjectURL(b); });
    const t = document.createElement('div'); t.textContent = `Daily Mix ${i+1}`;
    card.appendChild(img); card.appendChild(t);
    card.addEventListener('click', ()=> {
      const q = state.meta.songs.map(s=>s.id);
      if (q.length) playSong(q[i%q.length], q);
    });
    mixGrid.appendChild(card);
  }
  mixes.appendChild(mixGrid);

  // recommended songs
  const rec = document.createElement('div'); rec.innerHTML = `<h2>Recommended</h2>`;
  const recGrid = document.createElement('div'); recGrid.className='grid';
  state.meta.songs.slice(0,8).forEach(s=>{
    const c = createSongCard(s);
    recGrid.appendChild(c);
  });
  rec.appendChild(recGrid);

  area.appendChild(section); area.appendChild(mixes); area.appendChild(rec);
}

/* Search */
function renderSearchPage(query='') {
  const area = $('#contentArea'); if (!area) return;
  area.innerHTML = `<h2>Search</h2>`;
  const input = document.createElement('input'); input.placeholder='Search...'; input.value = query || '';
  input.style.width='100%'; input.style.marginBottom='12px';
  input.addEventListener('input', ()=> renderSearchResults(input.value));
  area.appendChild(input);
  const results = document.createElement('div'); results.id='searchResults'; area.appendChild(results);
  renderSearchResults(query);
}
function renderSearchResults(q) {
  const root = $('#searchResults'); if (!root) return;
  const qq = (q||'').toLowerCase();
  root.innerHTML = '';
  const songs = state.meta.songs.filter(s=> s.title.toLowerCase().includes(qq) || s.artist.toLowerCase().includes(qq) || (s.genre||'').toLowerCase().includes(qq));
  if (songs.length === 0) { root.innerHTML = '<p>No results</p>'; return; }
  const grid = document.createElement('div'); grid.className='grid';
  songs.forEach(s=> grid.appendChild(createSongCard(s)));
  root.appendChild(grid);
}

/* Library */
function renderLibrary() {
  const area = $('#contentArea'); if (!area) return;
  area.innerHTML = '<h2>Your Library</h2>';
  const grid = document.createElement('div'); grid.className='grid';
  state.meta.albums.forEach(a=>{
    const card = document.createElement('div'); card.className='card';
    const img = document.createElement('img'); img.alt='album';
    idbGet(a.coverAssetId).then(b=>{ if (b) img.src = URL.createObjectURL(b); });
    const t = document.createElement('div'); t.textContent = a.title;
    card.appendChild(img); card.appendChild(t);
    card.addEventListener('click', ()=> renderAlbum(a.id));
    grid.appendChild(card);
  });
  area.appendChild(grid);
}

/* Playlists view */
function renderPlaylists() {
  const area = $('#contentArea'); if (!area) return;
  area.innerHTML = '<h2>Playlists</h2>';
  const newBtn = document.createElement('button'); newBtn.textContent='New Playlist';
  newBtn.addEventListener('click', ()=> {
    if (!state.currentUser) { toast('Login to create'); return; }
    const name = prompt('Playlist name'); if (!name) return;
    const pl = createPlaylist(name, state.currentUser.username, false);
    renderPlaylist(pl.id);
  });
  area.appendChild(newBtn);
  const list = document.createElement('div');
  state.meta.playlists.forEach(p=>{
    const el = document.createElement('div'); el.className='card';
    el.textContent = `${p.name} — ${p.owner}`;
    el.addEventListener('click', ()=> renderPlaylist(p.id));
    list.appendChild(el);
  });
  area.appendChild(list);
}

/* Render a single playlist page */
function renderPlaylist(id) {
  const pl = state.meta.playlists.find(x=>x.id===id);
  const area = $('#contentArea'); if (!area) return;
  if (!pl) { area.innerHTML = '<p>Playlist not found</p>'; return; }
  area.innerHTML = `<h2>${pl.name}</h2>`;
  const controls = document.createElement('div');
  const playAll = document.createElement('button'); playAll.textContent='Play All';
  playAll.addEventListener('click', ()=> {
    playSong(pl.tracks[0], pl.tracks);
  });
  controls.appendChild(playAll);
  area.appendChild(controls);

  const table = document.createElement('div');
  pl.tracks.forEach((sid, idx)=>{
    const s = state.meta.songs.find(x=>x.id===sid);
    const row = document.createElement('div'); row.style.display='flex'; row.style.gap='12px'; row.style.padding='8px';
    row.innerHTML = `<div>${idx+1}</div><div style="flex:1">${s? s.title:'Missing'}</div><div>${s? s.artist:''}</div>`;
    row.addEventListener('dblclick', ()=> { playSong(sid, pl.tracks); });
    table.appendChild(row);
  });
  area.appendChild(table);
}

/* Liked songs */
function renderLiked() {
  const area = $('#contentArea'); if (!area) return;
  if (!state.currentUser) { area.innerHTML = '<p>Login to see liked songs</p>'; return; }
  const liked = Object.entries(state.meta.likes).filter(([sid,users])=> users.includes(state.currentUser.username)).map(([sid])=> state.meta.songs.find(s=>s.id===sid)).filter(Boolean);
  area.innerHTML = '<h2>Liked Songs</h2>';
  const g = document.createElement('div'); g.className='grid';
  liked.forEach(s=> g.appendChild(createSongCard(s)));
  area.appendChild(g);
}

/* Artist page */
function renderArtist(username) {
  const area = $('#contentArea'); if (!area) return;
  const user = state.meta.users.find(u=>u.username===username);
  if (!user) { area.innerHTML = '<p>Artist not found</p>'; return; }
  area.innerHTML = `<h2>${user.displayName || user.username} ${user.verified ? '✔' : ''}</h2>`;
  const followBtn = document.createElement('button');
  const followers = state.meta.followers[username] || [];
  followBtn.textContent = (state.currentUser && followers.includes(state.currentUser.username)) ? 'Unfollow' : 'Follow';
  followBtn.addEventListener('click', ()=> {
    if (!state.currentUser) { toast('Sign in'); return; }
    if (followers.includes(state.currentUser.username)) { unfollowUser(username); followBtn.textContent='Follow'; }
    else { followUser(username); followBtn.textContent='Unfollow'; }
  });
  area.appendChild(followBtn);

  const top = state.meta.songs.filter(s=>s.artist===username).slice(0,8);
  const g = document.createElement('div'); g.className='grid';
  top.forEach(s=> g.appendChild(createSongCard(s)));
  area.appendChild(document.createElement('h3')).textContent = 'Top tracks';
  area.appendChild(g);
}

/* Album page */
function renderAlbum(id) {
  const a = state.meta.albums.find(x=>x.id===id);
  const area = $('#contentArea'); if (!area) return;
  if (!a) { area.innerHTML = '<p>Album missing</p>'; return; }
  area.innerHTML = `<h2>${a.title}</h2>`;
  const img = document.createElement('img'); img.style.width='240px'; img.style.height='240px';
  idbGet(a.coverAssetId).then(b=>{ if (b) img.src = URL.createObjectURL(b); });
  area.appendChild(img);
  const t = document.createElement('div'); t.textContent = `By ${a.artist} — ${a.year}`; area.appendChild(t);
  const list = document.createElement('div');
  a.tracks.forEach(sid=>{
    const s = state.meta.songs.find(x=>x.id===sid);
    const row = document.createElement('div'); row.style.display='flex'; row.style.gap='12px';
    row.innerHTML = `<div style="flex:1">${s? s.title : sid}</div><div><button>Play</button></div>`;
    row.querySelector('button').addEventListener('click', ()=> playSong(sid, a.tracks));
    list.appendChild(row);
  });
  area.appendChild(list);
}

/* Profile */
function renderProfile(username) {
  const user = state.meta.users.find(u=>u.username===username);
  const area = $('#contentArea'); if (!area) return;
  if (!user) { area.innerHTML = '<p>Profile not found</p>'; return; }
  area.innerHTML = `<h2>${user.displayName}</h2>`;
  const img = document.createElement('img'); img.style.width='160px'; img.style.height='160px';
  if (user.imageAssetId) idbGet(user.imageAssetId).then(b=>{ if (b) img.src = URL.createObjectURL(b); });
  area.appendChild(img);
  area.appendChild(document.createElement('p')).textContent = user.bio || '';
  const editBtn = document.createElement('button'); editBtn.textContent = 'Edit profile';
  editBtn.addEventListener('click', ()=> openProfileEditor(user));
  area.appendChild(editBtn);
}

/* ---------------------------
   Small UI helpers
   --------------------------- */
function createSongCard(s) {
  const card = document.createElement('div'); card.className='card';
  const img = document.createElement('img'); img.alt='cover';
  if (s.coverAssetId) idbGet(s.coverAssetId).then(b=>{ if (b) img.src = URL.createObjectURL(b); });
  const t = document.createElement('div'); t.textContent = s.title;
  const a = document.createElement('small'); a.textContent = s.artist;
  card.appendChild(img); card.appendChild(t); card.appendChild(a);
  card.addEventListener('dblclick', ()=> {
    // build a queue of all songs and start this one
    const q = state.meta.songs.map(x=>x.id);
    playSong(s.id, q);
  });
  return card;
}

function renderAuthArea() {
  const area = $('#authArea'); if (!area) return;
  area.innerHTML = '';
  if (!state.currentUser) {
    const loginBtn = document.createElement('button'); loginBtn.textContent='Sign in';
    const signupBtn = document.createElement('button'); signupBtn.textContent='Sign up';
    loginBtn.addEventListener('click', ()=> openLoginModal());
    signupBtn.addEventListener('click', ()=> openSignupModal());
    area.appendChild(loginBtn); area.appendChild(signupBtn);
  } else {
    const el = document.createElement('div'); el.textContent = state.currentUser.displayName || state.currentUser.username;
    const logout = document.createElement('button'); logout.textContent='Logout';
    logout.addEventListener('click', ()=> { logoutUser(); renderMainRoute(); });
    el.style.display='inline-block'; el.style.marginRight='8px';
    area.appendChild(el); area.appendChild(logout);
  }
}

function renderUserMini() {
  const el = $('#userMini'); if (!el) return;
  if (!state.currentUser) el.textContent = 'Not signed in';
  else el.textContent = state.currentUser.displayName || state.currentUser.username;
}

/* ---------------------------
   Auth modals
   --------------------------- */
function openLoginModal() {
  const modal = document.createElement('div'); modal.className='modal';
  modal.innerHTML = `<div class="modal-inner"><h3>Sign in</h3>
    <label>Username: <input id="loginUser" /></label>
    <label>Password: <input id="loginPass" type="password" /></label>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
      <button id="loginCancel">Cancel</button><button id="loginSubmit">Sign in</button>
    </div></div>`;
  document.body.appendChild(modal);
  modal.querySelector('#loginCancel').addEventListener('click', ()=> document.body.removeChild(modal));
  modal.querySelector('#loginSubmit').addEventListener('click', ()=> {
    const user = modal.querySelector('#loginUser').value;
    const pass = modal.querySelector('#loginPass').value;
    const res = loginUser(user, pass);
    if (res.ok) { document.body.removeChild(modal); renderUserMini(); renderMainRoute(); }
    else alert(res.msg);
  });
}

function openSignupModal() {
  const modal = document.createElement('div'); modal.className='modal';
  modal.innerHTML = `<div class="modal-inner"><h3>Sign up</h3>
    <label>Username: <input id="suUser" /></label>
    <label>Password: <input id="suPass" type="password" /></label>
    <label>Display name: <input id="suName" /></label>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
      <button id="suCancel">Cancel</button><button id="suSubmit">Sign up</button>
    </div></div>`;
  document.body.appendChild(modal);
  modal.querySelector('#suCancel').addEventListener('click', ()=> document.body.removeChild(modal));
  modal.querySelector('#suSubmit').addEventListener('click', ()=> {
    const user = modal.querySelector('#suUser').value;
    const pass = modal.querySelector('#suPass').value;
    const name = modal.querySelector('#suName').value;
    const res = registerUser(user, pass, name);
    if (res.ok) { toast('Registered'); document.body.removeChild(modal); }
    else alert(res.msg);
  });
}

/* ---------------------------
   Profile editor
   --------------------------- */
function openProfileEditor(user) {
  const modal = document.createElement('div'); modal.className='modal';
  modal.innerHTML = `<div class="modal-inner"><h3>Edit profile</h3>
    <label>Display name: <input id="edName" value="${escapeHtml(user.displayName||'')}" /></label>
    <label>Bio: <textarea id="edBio">${escapeHtml(user.bio||'')}</textarea></label>
    <label>Profile image: <input id="edImage" type="file" accept="image/*" /></label>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
      <button id="edCancel">Cancel</button><button id="edSave">Save</button>
    </div></div>`;
  document.body.appendChild(modal);
  modal.querySelector('#edCancel').addEventListener('click', ()=> document.body.removeChild(modal));
  modal.querySelector('#edSave').addEventListener('click', async ()=> {
    user.displayName = modal.querySelector('#edName').value;
    user.bio = modal.querySelector('#edBio').value;
    const file = modal.querySelector('#edImage').files[0];
    if (file) {
      const img = await fileToImage(file);
      const blob = await imageToBlob(img);
      const aid = `image:user:${user.id}`;
      await idbPut(aid, blob);
      user.imageAssetId = aid;
    }
    saveMeta(state.meta);
    document.body.removeChild(modal);
    renderUserMini(); renderProfile(user.username);
  });
}

/* ---------------------------
   Small helpers
   --------------------------- */
function escapeHtml(s) { return (s||'').replace(/[&<>"']/g, (m)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

/* ---------------------------
   Init app
   --------------------------- */
(async function bootstrap(){
  try {
    state.meta = loadMeta();
    ensureSuperAdmin();
    await createSampleAssetsIfEmpty();
    initPlayer();
    // wire upload modal open
    $('#uploadClose')?.addEventListener('click', ()=> $('#uploadModal').classList.add('hidden'));
    $('#uploadModal')?.addEventListener('click', (e)=> { if (e.target === $('#uploadModal')) $('#uploadModal').classList.add('hidden'); });
    $('#uploadModal') && $('#uploadModal').classList.add('hidden');
    $('#uploadBtn')?.addEventListener('click', openUploadModal);
    // open upload from nav
    $all('.nav-btn').forEach(b=> { if (b.dataset.route==='upload') b.addEventListener('click', openUploadModal); });

    // attach upload modal controls
    $('#uploadForm')?.addEventListener('submit', (e)=> e.preventDefault());

    render();
  } catch(e) {
    console.error('Bootstrap failed', e);
  }
})();
