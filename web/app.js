/* web/app.js
   Full client-side logic integrated with Flask backend endpoints:
   - audio + WebAudio visuals (waveform, bars, circle, particles)
   - playlist rendering + drag/drop + upload to Flask
   - delete / rename / reorder (server)
   - IndexedDB caching helpers
*/

(() => {
  // ---- Flask server API ----
  async function uploadSong(file) {
    const buf = await file.arrayBuffer();
    const res = await fetch("/upload", {
      method: "POST",
      headers: { "X-Filename": file.name },
      body: buf
    });
    return await res.json(); // {status, path, name}
  }

  async function savePlaylistToServer(songs) {
    await fetch("/save-playlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songs })
    });
  }

  async function loadPlaylistFromServer() {
    const res = await fetch("/playlist");
    if (!res.ok) return [];
    return await res.json();
  }

  async function deleteSongOnServer(id) {
    const res = await fetch("/playlist/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id })
    });
    return res.json();
  }

  async function renameSongOnServer(id, name) {
    const res = await fetch("/playlist/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name })
    });
    return res.json();
  }

  async function reorderOnServer(order) {
    const res = await fetch("/playlist/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order })
    });
    return res.json();
  }
  // ---- end Flask API ----

  // Elements
  const audio = document.getElementById("audio");
  const fileInput = document.getElementById("fileInput");
  const playBtn = document.getElementById("playBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const muteBtn = document.getElementById("muteBtn");
  const volumeEl = document.getElementById("volume");
  const seekSec = document.getElementById("seekSec");
  const seekBtn = document.getElementById("seekBtn");
  const loopToggle = document.getElementById("loopToggle");
  const songName = document.getElementById("songName");
  const durationEl = document.getElementById("duration");
  const currentEl = document.getElementById("current");
  const playlistEl = document.getElementById("playlist");
  const refreshBtn = document.getElementById("refreshList");
  const saveBtn = document.getElementById("saveList");
  const vizSelect = document.getElementById("vizSelect");
  const sensitivityEl = document.getElementById("sensitivity");

  const canvas = document.getElementById("visual");
  const ctx = canvas.getContext("2d");

  let audioCtx = null, sourceNode = null, analyser = null, dataArray = null, freqArray = null, rafId = null;
  let vizMode = vizSelect.value || 'wave';
  let sensitivity = parseFloat(sensitivityEl.value) || 1.0;

  // playlist model
  // item shape: { id, name, url, origin: 'local'|'remote', size, createdAt }
  let playlist = [];

  // IndexedDB helpers
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('darkwave-db', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveFileToIDB(id, blob) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put({ id, blob });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  async function getFileFromIDB(id) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('files','readonly');
      const req = tx.objectStore('files').get(id);
      req.onsuccess = () => res(req.result ? req.result.blob : null);
      req.onerror = () => rej(req.error);
    });
  }

  async function saveMeta(k, v) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('meta','readwrite');
      tx.objectStore('meta').put({ k, v });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function getMeta(k) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('meta','readonly');
      const req = tx.objectStore('meta').get(k);
      req.onsuccess = () => res(req.result ? req.result.v : null);
      req.onerror = () => rej(req.error);
    });
  }

  function timeFmt(t) {
    if (!isFinite(t) || isNaN(t)) return "0:00";
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function ensureAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (!sourceNode) {
      try { sourceNode = audioCtx.createMediaElementSource(audio); } catch(e){ console.warn(e); }
    }
    if (!analyser) {
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      dataArray = new Uint8Array(analyser.fftSize);
      freqArray = new Uint8Array(analyser.frequencyBinCount);
    }
    try { sourceNode.disconnect(); } catch(e){}
    sourceNode.connect(analyser);
    analyser.connect(audioCtx.destination);
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.max(300, Math.floor(w * dpr));
    canvas.height = Math.max(120, Math.floor(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw() {
    if (!analyser) return;
    analyser.getByteTimeDomainData(dataArray);
    analyser.getByteFrequencyData(freqArray);

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0,0,w,h);

    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.fillRect(0,0,w,h);
    ctx.lineJoin = 'round';

    const mode = vizMode;
    if (mode === 'wave') {
      ctx.lineWidth = 2;
      const grad = ctx.createLinearGradient(0,0,w,0);
      grad.addColorStop(0, "#20c9b8"); grad.addColorStop(1, "#28a6ff");
      ctx.strokeStyle = grad;
      ctx.beginPath();
      const slice = w / dataArray.length;
      let x = 0;
      for (let i=0;i<dataArray.length;i++){
        const v = dataArray[i] / 128.0;
        const y = (v * h) / 2;
        if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        x += slice;
      }
      ctx.stroke();

    } else if (mode === 'bars') {
      const bars = 64;
      const binSize = Math.floor(freqArray.length / bars);
      const barW = w / bars * 0.8; const gap = w / bars * 0.2;
      for (let i=0;i<bars;i++){
        let sum = 0;
        for (let j=0;j<binSize;j++) sum += freqArray[i*binSize + j] || 0;
        const avg = sum / Math.max(1, binSize);
        const scaled = Math.pow(avg/255, 1/sensitivity) * h;
        const x = i * (barW + gap);
        const g = ctx.createLinearGradient(x,0,x,h);
        g.addColorStop(0, "rgba(40,166,255,0.95)"); g.addColorStop(1, "rgba(32,201,184,0.9)");
        ctx.fillStyle = g;
        ctx.fillRect(x, h - scaled, barW, scaled);
      }

    } else if (mode === 'circle') {
      const cx = w/2, cy = h/2; const radius = Math.min(w,h) * 0.18; const bins = 120;
      const binSize = Math.floor(freqArray.length / bins);
      for (let i=0;i<bins;i++){
        let sum = 0;
        for (let j=0;j<binSize;j++) sum += freqArray[i*binSize + j] || 0;
        const avg = sum / Math.max(1, binSize);
        const angle = (i / bins) * Math.PI * 2;
        const len = Math.pow(avg/255, 1/sensitivity) * Math.min(w,h) * 0.35;
        const x1 = cx + Math.cos(angle) * radius;
        const y1 = cy + Math.sin(angle) * radius;
        const x2 = cx + Math.cos(angle) * (radius + len);
        const y2 = cy + Math.sin(angle) * (radius + len);
        ctx.strokeStyle = `rgba(32,201,184,${0.8 * (avg/255) + 0.05})`;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
      }

    } else if (mode === 'particles') {
      const lowBins = 8; let lowSum = 0; for (let i=0;i<lowBins;i++) lowSum += freqArray[i] || 0;
      const energy = (lowSum / (lowBins * 255)) * sensitivity;
      const maxR = Math.min(w,h)/3; const r = Math.min(maxR, energy * maxR * 1.8 + 10);
      const cx = w/2, cy = h/2;
      const grad = ctx.createRadialGradient(cx,cy,0,cx,cy,r);
      grad.addColorStop(0, "rgba(32,201,184,0.18)"); grad.addColorStop(1, "rgba(40,166,255,0)");
      ctx.fillStyle = grad; ctx.fillRect(0,0,w,h);
      const particleCount = Math.floor(20 + energy * 120);
      for (let i=0;i<particleCount;i++){
        const a = Math.random() * Math.PI*2; const rad = Math.random() * r;
        const x = cx + Math.cos(a) * rad; const y = cy + Math.sin(a) * rad;
        const size = Math.random() * (1 + energy * 4);
        ctx.beginPath(); ctx.fillStyle = `rgba(32,201,184,${0.05 + Math.random()*0.2})`; ctx.arc(x,y,size,0,Math.PI*2); ctx.fill();
      }
    }

    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = "rgba(32,201,184,0.01)";
    ctx.fillRect(0,0,w,h);
    ctx.globalCompositeOperation = 'source-over';

    rafId = requestAnimationFrame(draw);
  }

  function startVisuals() { if (!audioCtx) ensureAudioCtx(); if (!rafId) { resizeCanvas(); rafId = requestAnimationFrame(draw); } }
  function stopVisuals() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  // ==== UI: render playlist ====
  function renderPlaylist() {
    playlistEl.innerHTML = '';
    playlist.forEach(item => {
      const el = document.createElement('div');
      el.className = 'playlist-item item';
      el.draggable = true;
      el.dataset.id = String(item.id);
      el.innerHTML = `
        <div class="song-row-inner">
          <div class="song-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
          <div class="song-actions">
            <button class="btn small play-song" data-id="${item.id}">Play</button>
            <button class="btn small cache-song" data-id="${item.id}">Cache</button>
            <button class="btn small rename" data-id="${item.id}">✏️</button>
            <button class="btn small delete" data-id="${item.id}">🗑️</button>
            <span class="drag-handle">☰</span>
          </div>
        </div>
      `;
      playlistEl.appendChild(el);
    });
  }

  function escapeHtml(s) {
    return (s + "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ==== Play item (IDB cache first) ====
  async function playItem(item) {
    songName.textContent = item.name;
    try {
      const cached = await getFileFromIDB(item.id);
      if (cached) {
        const url = URL.createObjectURL(cached);
        audio.src = url;
        audio.dataset.id = item.id;
        await audio.play();
        startVisuals();
        return;
      }
    } catch (e) { console.warn('IDB check failed', e); }
    // remote: use stream route
    audio.src = "/stream/" + item.path;
    audio.dataset.id = item.id;
    await audio.play();
    startVisuals();
    // background cache
    if (item.origin === 'remote') {
      fetch("/stream/" + item.path).then(r => r.blob()).then(b => saveFileToIDB(item.id, b)).catch(e => console.warn('cache failed', e));
    }
  }

  // ==== Load playlist (server first, fallback to IDB meta) ====
  async function loadLocalPlaylist() {
    try {
      const serverList = await loadPlaylistFromServer();
      if (Array.isArray(serverList) && serverList.length) {
        playlist = serverList.map(s => ({
          id: String(s.id),
          name: s.name,
          path: s.path,
          origin: 'remote',
          createdAt: s.createdAt
        }));
        renderPlaylist();
        await saveMeta('playlist', playlist);
        return;
      }
    } catch(e) { console.warn('server playlist fetch failed', e); }

    const saved = await getMeta('playlist');
    if (saved && Array.isArray(saved)) {
      playlist = saved;
      renderPlaylist();
    }
  }

  async function saveLocalPlaylist() {
    await saveMeta('playlist', playlist);
  }

  // ==== Add file: upload to server, replace temp entry with server entry ====
  async function addFileLocal(file) {
    const tempId = `temp_${Date.now()}_${file.name}`;
    const tempItem = { id: tempId, name: file.name, path: URL.createObjectURL(file), origin: 'local', size: file.size, createdAt: new Date().toISOString() };
    playlist.unshift(tempItem);
    renderPlaylist();
    saveLocalPlaylist();

    try {
      const res = await uploadSong(file);
      if (res && res.status === 'ok') {
        // Replace temp with server item
        const serverItem = { id: String(res.name + "_" + Date.now()), name: res.name, path: res.path, origin: 'remote', createdAt: new Date().toISOString() };
        // remove first occurrence of tempId
        playlist = playlist.filter(p => p.id !== tempId);
        playlist.unshift(serverItem);
        renderPlaylist();
        saveLocalPlaylist();
        // cache remote file
        try {
          const blob = await fetch("/stream/" + serverItem.path).then(r => r.blob());
          await saveFileToIDB(serverItem.id, blob);
        } catch(e){ console.warn('cache server file failed', e); }
      } else {
        alert('Upload failed');
      }
    } catch (e) {
      console.error('upload failed', e);
      alert('Upload failed: ' + e.message);
    }
  }

  // ==== Event handlers: file input / drag&drop ====
  fileInput.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    addFileLocal(f);
  });

  document.body.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.body.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.type.startsWith('audio/')) addFileLocal(f);
  });

  // play/pause/mute/volume/seek/loop
  playBtn.addEventListener('click', async () => { if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume(); audio.play(); startVisuals(); });
  pauseBtn.addEventListener('click', () => { audio.pause(); });
  muteBtn.addEventListener('click', () => { audio.muted = !audio.muted; muteBtn.textContent = audio.muted ? 'Unmute' : 'Mute'; });
  volumeEl.addEventListener('input', (e)=> { audio.volume = parseFloat(e.target.value); });

  seekBtn.addEventListener('click', () => {
    const s = parseFloat(seekSec.value) || 0;
    if (audio.duration && s <= audio.duration) audio.currentTime = s;
  });
  loopToggle.addEventListener('change', (e)=> { audio.loop = e.target.checked; });

  audio.addEventListener('loadedmetadata', () => { durationEl.textContent = timeFmt(audio.duration); try { ensureAudioCtx(); } catch(e){console.warn(e);} });
  audio.addEventListener('timeupdate', () => { currentEl.textContent = timeFmt(audio.currentTime); });
  audio.addEventListener('ended', () => { if (!audio.loop) stopVisuals(); });

  // viz controls
  vizSelect.addEventListener('change', (e)=> { vizMode = e.target.value; });
  sensitivityEl.addEventListener('input', (e)=> { sensitivity = parseFloat(e.target.value); });

  window.addEventListener('resize', () => { resizeCanvas(); });

  // keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); if (audio.paused) playBtn.click(); else pauseBtn.click(); }
    if (e.key.toLowerCase() === 'm') muteBtn.click();
    if (e.key === 'ArrowRight') audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
    if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
  });

  // refresh/save buttons
  refreshBtn.addEventListener('click', () => { loadLocalPlaylist(); });
  saveBtn.addEventListener('click', async () => {
    const toSave = playlist.map(p => ({ name: p.name, path: p.path }));
    try {
      await savePlaylistToServer(toSave);
      alert('Playlist saved to server.');
    } catch (e) { alert('Save failed: ' + e.message); }
  });

  // playlist click (play / cache / rename / delete)
  playlistEl.addEventListener('click', async (e) => {
    const btn = e.target;
    if (btn.classList.contains('play-song')) {
      const id = String(btn.dataset.id);
      const item = playlist.find(p => String(p.id) === id);
      if (item) await playItem(item);
    } else if (btn.classList.contains('cache-song')) {
      const id = String(btn.dataset.id);
      const item = playlist.find(p => String(p.id) === id);
      if (item && item.origin === 'remote') {
        try {
          const blob = await fetch("/stream/" + item.path).then(r => r.blob());
          await saveFileToIDB(item.id, blob);
          alert(`Cached ${item.name} for offline use.`);
        } catch (e) { alert('Cache failed: '+e.message); }
      } else alert('Already local or cannot cache.');
    } else if (btn.classList.contains('rename')) {
      const id = String(btn.dataset.id);
      const item = playlist.find(p => String(p.id) === id);
      if (!item) return;
      const newName = prompt("Rename song:", item.name);
      if (!newName) return;
      try {
        const res = await renameSongOnServer(id, newName);
        if (res && res.status === 'renamed') {
          item.name = newName;
          item.path = res.path || item.path;
          renderPlaylist();
          saveLocalPlaylist();
          // if playing update src
          if (audio.dataset.id == id) {
            audio.src = "/stream/" + item.path;
          }
        } else {
          alert('Rename failed.');
        }
      } catch (e) { alert('Rename failed: ' + e.message); }
    } else if (btn.classList.contains('delete')) {
      const id = String(btn.dataset.id);
      const item = playlist.find(p => String(p.id) === id);
      if (!item) return;
      if (!confirm(`Delete "${item.name}"? This will remove the file from server.`)) return;
      try {
        const res = await deleteSongOnServer(id);
        if (res && res.status === 'deleted') {
          playlist = playlist.filter(p => String(p.id) !== id);
          renderPlaylist();
          saveLocalPlaylist();
          // stop if that was playing
          if (audio.dataset.id == id) {
            audio.pause(); audio.src = '';
            songName.textContent = 'No file loaded';
          }
        } else {
          alert('Delete failed');
        }
      } catch (e) { alert('Delete failed: ' + e.message); }
    }
  });

  // Drag & drop reorder logic inside playlist container
  let dragEl = null;
  playlistEl.addEventListener('dragstart', (e) => {
    dragEl = e.target.closest('.playlist-item');
    if (!dragEl) return;
    e.dataTransfer.effectAllowed = 'move';
  });

  playlistEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    const target = e.target.closest('.playlist-item');
    if (!target || !dragEl || target === dragEl) return;
    const rect = target.getBoundingClientRect();
    const after = (e.clientY - rect.top) > (rect.height / 2);
    playlistEl.insertBefore(dragEl, after ? target.nextSibling : target);
  });

  playlistEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragEl = null;
    // compute new order and send to server
    const order = [...playlistEl.querySelectorAll('.playlist-item')].map(el => el.dataset.id);
    try {
      await reorderOnServer(order);
      // reorder local playlist to match
      playlist = order.map(id => playlist.find(p => String(p.id) === String(id))).filter(Boolean);
      renderPlaylist();
      saveLocalPlaylist();
    } catch (err) {
      console.warn('reorder failed', err);
    }
  });

  // init
  (async function init() {
    resizeCanvas();
    await loadLocalPlaylist();
    const last = await getMeta('lastPlayed');
    if (last) {
      const item = playlist.find(p=>String(p.id) === String(last));
      if (item) songName.textContent = item.name;
    }
    document.addEventListener('click', () => { if (!audioCtx) ensureAudioCtx(); }, { once:true });
  })();

  // helpers
  window.DW = { playlist, renderPlaylist, saveLocalPlaylist, playItem, addFileLocal };

  // service worker registration
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(()=> console.log('SW registered')).catch(console.warn);
  }

})();
