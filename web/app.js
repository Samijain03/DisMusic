/* web/app.js
   Full client-side logic with Flask-SocketIO synchronization.
   - All playback controls are server-authoritative.
   - Client emits 'player_action' and listens for 'state_update'.
*/

(() => {
  // ---- NEW: Socket.IO setup ----
  const socket = io();
  let isSyncing = false; // Lock to prevent event feedback loops

  // ---- NEW: Non-blocking toast notification function ----
  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('show');
    }, 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => {
        if (document.body.contains(toast)) {
          document.body.removeChild(toast);
        }
      }, 300);
    }, 3000);
  }

  // ---- Flask server API (UNCHANGED) ----
  // These functions (uploadSong, loadPlaylistFromServer, etc.)
  // are still used for managing the playlist, just not for playback.
  async function uploadSong(file) {
    const buf = await file.arrayBuffer();
    const res = await fetch("/upload", {
      method: "POST",
      headers: { "X-Filename": file.name },
      body: buf
    });
    return await res.json(); 
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
  const loopToggle = document.getElementById("loopToggle");
  const songName = document.getElementById("songName");
  const playlistEl = document.getElementById("playlist");
  const refreshBtn = document.getElementById("refreshList");
  const vizSelect = document.getElementById("vizSelect");
  const sensitivityEl = document.getElementById("sensitivity");
  const songArtist = document.getElementById("songArtist");
  const songAlbum = document.getElementById("songAlbum");
  const albumArt = document.getElementById("albumArt");
  const audioOutputEl = document.getElementById("audioOutput");
  const seekBar = document.getElementById("seekBar");
  const currentTimeEl = document.getElementById("currentTime");
  const durationTimeEl = document.getElementById("durationTime");
  const artUploader = document.getElementById("artUploader");

  const canvas = document.getElementById("visual");
  const ctx = canvas.getContext("2d");

  let audioCtx = null, sourceNode = null, analyser = null, dataArray = null, freqArray = null, rafId = null;
  let vizMode = vizSelect.value || 'wave';
  let sensitivity = parseFloat(sensitivityEl.value) || 1.0;

  let playlist = [];

  // IndexedDB helpers (no changes)
  function openDB() { /* ... no change ... */ 
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
  async function saveFileToIDB(id, blob) { /* ... no change ... */ 
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put({ id, blob });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function getFileFromIDB(id) { /* ... no change ... */
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('files','readonly');
      const req = tx.objectStore('files').get(id);
      req.onsuccess = () => res(req.result ? req.result.blob : null);
      req.onerror = () => rej(req.error);
    });
  }
  async function saveMeta(k, v) { /* ... no change ... */
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('meta','readwrite');
      tx.objectStore('meta').put({ k, v });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function getMeta(k) { /* ... no change ... */
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('meta','readonly');
      const req = tx.objectStore('meta').get(k);
      req.onsuccess = () => res(req.result ? req.result.v : null);
      req.onerror = () => rej(req.error);
    });
  }
  // --- end IDB ---

  function timeFmt(t) {
    if (!isFinite(t) || isNaN(t)) return "0:00";
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  // --- Visualizer functions (AudioContext FIX 1) ---
  function ensureAudioCtx() { 
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    // --- START FIX ---
    // Resume context if it was suspended by browser
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    // --- END FIX ---

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
  function resizeCanvas() { /* ... no change ... */ 
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w > 0 && h > 0) {
        canvas.width = Math.max(300, Math.floor(w * dpr));
        canvas.height = Math.max(120, Math.floor(h * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }
  function draw() { /* ... no change ... */
    if (!analyser || canvas.clientWidth === 0) return;
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

  // ==== UI: render playlist (no changes) ====
  function renderPlaylist() {
    playlistEl.innerHTML = '';
    playlist.forEach(item => {
      const el = document.createElement('div');
      el.className = 'playlist-item';
      el.draggable = true;
      el.dataset.id = String(item.id);
      const title = item.title || item.name;
      const artist = item.artist || 'Unknown Artist';
      el.innerHTML = `
        <div class="song-row-inner">
          <div class="song-info">
            <div class="song-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
            <div class="song-artist" title="${escapeHtml(artist)}">${escapeHtml(artist)}</div>
          </div>
          <div class="song-actions">
            <button class="btn small play-song" data-id="${item.id}">Play</button>
            <button class="btn small cache-song" data-id="${item.id}">Cache</button>
            <button class="btn small upload-art" data-id="${item.id}">🖼️ Art</button>
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

  // ==== Play item (Helper function) ====
  // This function is now ONLY for loading the song data.
  // It does NOT emit any events.
  async function playItem(item) {
    if (!item) return;
    songName.textContent = item.title || item.name;
    songArtist.textContent = item.artist || '---';
    songAlbum.textContent = item.album || '---';

    if (item.has_art) {
      albumArt.src = `/art/${item.id}.jpg?t=${new Date().getTime()}`;
      albumArt.style.display = 'block';
    } else {
      albumArt.src = '';
      albumArt.style.display = 'none';
    }

    try {
      const cached = await getFileFromIDB(item.id);
      if (cached) {
        const url = URL.createObjectURL(cached);
        audio.src = url;
        audio.dataset.id = item.id;
        return; // Return promise, don't play
      }
    } catch (e) { console.warn('IDB check failed', e); }
    
    audio.src = "/stream/" + item.path;
    audio.dataset.id = item.id;
    
    if (item.origin === 'remote') {
      fetch("/stream/" + item.path).then(r => r.blob()).then(b => saveFileToIDB(item.id, b)).catch(e => console.warn('cache failed', e));
    }
    // Return a promise that resolves when metadata is loaded
    return new Promise((resolve) => {
        audio.addEventListener('loadedmetadata', resolve, { once: true });
    });
  }

  // ==== Load/Save playlist (no changes) ====
  async function loadLocalPlaylist() {
    try {
      const serverList = await loadPlaylistFromServer();
      if (Array.isArray(serverList) && serverList.length) {
        playlist = serverList.map(s => ({...s, id: String(s.id) }));
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

  // ==== Add file (no changes) ====
  async function addFileLocal(file) {
    const tempId = `temp_${Date.now()}_${file.name}`;
    const tempItem = { 
      id: tempId, name: file.name, path: URL.createObjectURL(file), 
      title: 'Uploading...', artist: file.name, album: '', 
      origin: 'local', size: file.size, createdAt: new Date().toISOString() 
    };
    playlist.unshift(tempItem);
    renderPlaylist();
    
    try {
      const res = await uploadSong(file);
      if (res && res.id) {
        const serverItem = { ...res, id: String(res.id), origin: 'remote' };
        const tempIndex = playlist.findIndex(p => p.id === tempId);
        if (tempIndex > -1) {
          playlist[tempIndex] = serverItem;
        } else {
          playlist = playlist.filter(p => p.id !== tempId);
          playlist.unshift(serverItem);
        }
        renderPlaylist();
        saveLocalPlaylist(); 
        try {
          await saveFileToIDB(serverItem.id, file);
        } catch(e){ console.warn('cache server file failed', e); }
      } else {
        showToast('Upload failed: ' + (res.error || 'Unknown error'));
        playlist = playlist.filter(p => p.id !== tempId);
        renderPlaylist();
      }
    } catch (e) {
      console.error('upload failed', e);
      showToast('Upload failed: ' + e.message);
      playlist = playlist.filter(p => p.id !== tempId);
      renderPlaylist();
    }
  }

  // ==== Event handlers: file input / drag&drop (no changes) ====
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

  // ---- NEW: SocketIO Event Listener ----
  // This is the single source of truth for the player
  socket.on('state_update', (state) => {
    console.log("Received state update:", state);
    
    isSyncing = true; // Set lock
    
    const item = playlist.find(p => String(p.id) === String(state.current_song_id));
    
    if (item) {
        // --- 1. Load song if different ---
        if (audio.dataset.id !== String(item.id)) {
            console.log("Sync: Changing song");
            playItem(item).then(() => {
                // After loading, apply the state
                applyPlayerState(state);
            });
            return; // Wait for song to load
        }
        
        // --- 2. Apply the state (play, pause, seek) ---
        applyPlayerState(state);
        
    } else {
        // Song isn't in our playlist, so stop.
        audio.pause();
        songName.textContent = 'No file loaded';
        songArtist.textContent = '---';
        songAlbum.textContent = '---';
        albumArt.style.display = 'none';
        currentTimeEl.textContent = '0:00';
        durationTimeEl.textContent = '0:00';
        seekBar.value = 0;
        seekBar.max = 0;
    }

    // Release the lock
    setTimeout(() => { isSyncing = false; }, 50); // Short delay
  });

  // --- NEW: Helper to apply state from server ---
  function applyPlayerState(state) {
    // --- 2a. Seek ---
    const timeDiff = Math.abs(audio.currentTime - state.current_time);
    // Only seek if server is > 2s different, to avoid jitter
    if (timeDiff > 2.0) {
        console.log(`Sync: Seeking from ${audio.currentTime} to ${state.current_time}`);
        audio.currentTime = state.current_time;
    }
    
    // --- 2b. Play/Pause ---
    if (state.is_playing && audio.paused) {
        console.log("Sync: Playing");
        audio.play().catch(e => console.warn("Sync play failed", e));
        startVisuals();
    } else if (!state.is_playing && !audio.paused) {
        console.log("Sync: Pausing");
        audio.pause();
    }

    // Update UI (redundant if timeupdate is firing, but good fallback)
    seekBar.value = Math.floor(audio.currentTime);
    currentTimeEl.textContent = timeFmt(audio.currentTime);
  }

  // ---- MODIFIED: Playback controls now EMIT events (AUTOPLAY FIX 2) ----
  playBtn.addEventListener('click', async () => { 
    if (isSyncing) return;
    
    let songId = audio.dataset.id;
    // If no song is loaded, play the first in the playlist
    if (!songId && playlist.length > 0) {
        songId = playlist[0].id;
        // Need to load it first
        await playItem(playlist[0]);
    }
    
    if (!songId) return; // No song to play

    // --- START FIX ---
    // Optimistically play locally to satisfy browser autoplay policy
    audio.play().catch(e => console.warn("Autoplay failed", e));
    startVisuals();
    // --- END FIX ---

    console.log("Emitting PLAY");
    socket.emit('player_action', {
        action: "PLAY",
        song_id: songId,
        time: audio.currentTime
    });
  });

  pauseBtn.addEventListener('click', () => { 
    if (isSyncing) return;
    console.log("Emitting PAUSE");
    socket.emit('player_action', {
        action: "PAUSE",
        song_id: audio.dataset.id,
        time: audio.currentTime
    });
  });

  seekBar.addEventListener('input', () => {
    // We update the local time display immediately for responsiveness
    currentTimeEl.textContent = timeFmt(seekBar.value);
  });
  
  seekBar.addEventListener('change', () => { // 'change' fires on mouse up
    if (isSyncing) return;
    
    console.log("Emitting SEEK");
    socket.emit('player_action', {
        action: "SEEK",
        song_id: audio.dataset.id,
        time: parseFloat(seekBar.value)
    });
    // Set local audio time immediately
    audio.currentTime = seekBar.value;
  });

  // --- Local-only controls (no changes) ---
  muteBtn.addEventListener('click', () => { 
    audio.muted = !audio.muted; 
    muteBtn.textContent = audio.muted ? 'Unmute' : 'Mute'; 
  });
  volumeEl.addEventListener('input', (e)=> { audio.volume = parseFloat(e.target.value); });
  loopToggle.addEventListener('change', (e)=> { audio.loop = e.target.checked; });
  
  // --- Audio element listeners (only for UI updates) ---
  audio.addEventListener('loadedmetadata', () => { 
      durationTimeEl.textContent = timeFmt(audio.duration); 
      seekBar.max = Math.floor(audio.duration);
      try { ensureAudioCtx(); } catch(e){console.warn(e);} 
  });

  audio.addEventListener('timeupdate', () => { 
    // This runs constantly. We don't want to seek if the user is dragging.
    if (!isSyncing) {
        currentTimeEl.textContent = timeFmt(audio.currentTime); 
        seekBar.value = Math.floor(audio.currentTime);
    }
  });
  
  audio.addEventListener('ended', () => { 
      if (!audio.loop) {
          stopVisuals();
          // If not looping, just emit a pause event at the end
          if (!isSyncing) {
            socket.emit('player_action', {
                action: "PAUSE",
                song_id: audio.dataset.id,
                time: audio.duration
            });
          }
      }
  });

  // viz controls (no changes)
  vizSelect.addEventListener('change', (e)=> { vizMode = e.target.value; });
  sensitivityEl.addEventListener('input', (e)=> { sensitivity = parseFloat(e.target.value); });
  window.addEventListener('resize', () => { if(rafId) resizeCanvas(); });

  // keyboard shortcuts (MODIFIED for sync)
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { 
        e.preventDefault(); 
        if (audio.paused) playBtn.click(); 
        else pauseBtn.click(); 
    }
    if (e.key.toLowerCase() === 'm') muteBtn.click();
    
    // Seek shortcuts should also emit
    if (e.key === 'ArrowRight') {
        const newTime = Math.min(audio.duration || 0, audio.currentTime + 5);
        audio.currentTime = newTime; // Local update
        socket.emit('player_action', { action: "SEEK", song_id: audio.dataset.id, time: newTime });
    }
    if (e.key === 'ArrowLeft') {
        const newTime = Math.max(0, audio.currentTime - 5);
        audio.currentTime = newTime; // Local update
        socket.emit('player_action', { action: "SEEK", song_id: audio.dataset.id, time: newTime });
    }
  });

  // refresh/save buttons (no changes)
  refreshBtn.addEventListener('click', () => { loadLocalPlaylist(); });

  // Audio Output Device (no changes)
  async function loadAudioDevices() { /* ... no change ... */ 
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      console.warn('enumerateDevices not supported.');
      audioOutputEl.style.display = 'none';
      return;
    }
    if (typeof audio.setSinkId !== 'function') {
      console.warn('setSinkId not supported.');
      audioOutputEl.style.display = 'none';
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioDevices = devices.filter(d => d.kind === 'audiooutput');
      audioOutputEl.innerHTML = '<option value="default">Default Output</option>';
      audioDevices.forEach(device => {
        const opt = document.createElement('option');
        opt.value = device.deviceId;
        opt.textContent = device.label || `Output ${audioOutputEl.options.length}`;
        audioOutputEl.appendChild(opt);
      });
    } catch (e) {
      console.error('Failed to get audio devices', e);
    }
  }
  audioOutputEl.addEventListener('change', async (e) => { /* ... no change ... */ 
    try {
      await audio.setSinkId(e.target.value);
      console.log(`Audio output set to: ${e.target.value}`);
    } catch (e) {
      console.error('Failed to set audio output', e);
    }
  });

  // Art Uploader (MODIFIED to use showToast)
  artUploader.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const songId = e.target.dataset.songId; 
    if (!file || !songId) return;
    const formData = new FormData();
    formData.append('id', songId);
    formData.append('file', file);
    try {
      const res = await fetch('/playlist/upload-art', {
        method: 'POST',
        body: formData 
      });
      const result = await res.json();
      if (res.ok && result.status === 'art_uploaded') {
        // --- START FIX ---
        // alert('Album art updated!'); // REMOVED
        showToast('Album art updated!'); // ADDED
        // --- END FIX ---
        const item = playlist.find(p => String(p.id) === String(songId));
        if (item) {
          item.has_art = 1;
        }
        if (audio.dataset.id === songId) {
          albumArt.src = `/art/${songId}.jpg?t=${new Date().getTime()}`;
          albumArt.style.display = 'block';
        }
      } else {
        // alert('Art upload failed: ' + (result.error || 'Unknown error')); // REMOVED
        showToast('Art upload failed: ' + (result.error || 'Unknown error')); // ADDED
      }
    } catch (err) {
      console.error('Art upload fetch error:', err);
      // alert('Art upload failed: ' + err.message); // REMOVED
      showToast('Art upload failed: ' + err.message); // ADDED
    }
    e.target.value = null;
    e.target.dataset.songId = '';
  });

  // --- MODIFIED: playlist click handler (AUTOPLAY FIX 3) ---
  playlistEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn || isSyncing) return;

    const id = String(btn.dataset.id);
    const item = playlist.find(p => String(p.id) === id);
    if (!item) return;

    if (btn.classList.contains('play-song')) {
      console.log("Emitting CHANGE_SONG");
      
      // --- START FIX ---
      // We must load and play the item *locally* first to be inside the click gesture
      await playItem(item); 
      audio.play().catch(e => console.warn("Autoplay failed", e));
      startVisuals();
      // --- END FIX ---

      socket.emit('player_action', {
          action: "CHANGE_SONG", // This action now just informs others
          song_id: id
      });
    
    } else if (btn.classList.contains('cache-song')) {
      // This is a local-only action, no change
      if (item.origin === 'remote') {
        try {
          const blob = await fetch("/stream/" + item.path).then(r => r.blob());
          await saveFileToIDB(item.id, blob);
          showToast(`Cached ${item.title || item.name} for offline use.`);
        } catch (e) { showToast('Cache failed: '+e.message); }
      } else showToast('Already local or cannot cache.');
    
    } else if (btn.classList.contains('upload-art')) {
      // This is a local-only action, no change
      artUploader.dataset.songId = id; 
      artUploader.click();
    
    } else if (btn.classList.contains('rename')) {
      // This is a playlist management action, no change
      const currentTitle = item.title || item.name;
      const newName = prompt("Rename song:", currentTitle);
      if (!newName || newName === currentTitle) return;
      try {
        const res = await renameSongOnServer(id, newName);
        if (res && res.status === 'renamed') {
          item.title = res.title;
          renderPlaylist();
          saveLocalPlaylist();
          if (audio.dataset.id == id) {
            songName.textContent = item.title;
          }
        } else {
          showToast('Rename failed.');
        }
      } catch (e) { showToast('Rename failed: ' + e.message); }
    
    } else if (btn.classList.contains('delete')) {
      // This is a playlist management action, no change
      if (!confirm(`Delete "${item.title || item.name}"? This will remove the file from server.`)) return;
      try {
        const res = await deleteSongOnServer(id);
        if (res && res.status === 'deleted') {
          playlist = playlist.filter(p => String(p.id) !== id);
          renderPlaylist();
          saveLocalPlaylist();
          
          // If the deleted song was playing, we need to tell the server to stop
          if (audio.dataset.id == id) {
              socket.emit('player_action', {
                  action: "PAUSE",
                  song_id: null,
                  time: 0
              });
              // The server's 'state_update' will handle the UI cleanup
          }
        } else {
          showToast('Delete failed');
        }
      } catch (e) { showToast('Delete failed: ' + e.message); }
    }
  });

  // Drag & drop reorder logic (no changes)
  let dragEl = null;
  playlistEl.addEventListener('dragstart', (e) => { /* ... no change ... */ 
    dragEl = e.target.closest('.playlist-item');
    if (!dragEl) return;
    e.dataTransfer.effectAllowed = 'move';
  });
  playlistEl.addEventListener('dragover', (e) => { /* ... no change ... */ 
    e.preventDefault();
    const target = e.target.closest('.playlist-item');
    if (!target || !dragEl || target === dragEl) return;
    const rect = target.getBoundingClientRect();
    const after = (e.clientY - rect.top) > (rect.height / 2);
    playlistEl.insertBefore(dragEl, after ? target.nextSibling : target);
  });
  playlistEl.addEventListener('drop', async (e) => { /* ... no change ... */ 
    e.preventDefault();
    dragEl = null;
    const order = [...playlistEl.querySelectorAll('.playlist-item')].map(el => el.dataset.id);
    try {
      await reorderOnServer(order);
      playlist = order.map(id => playlist.find(p => String(p.id) === String(id))).filter(Boolean);
      saveLocalPlaylist();
    } catch (err) { 
      console.warn('reorder failed', err);
      loadLocalPlaylist();
    }
  });

  // init (AudioContext FIX 2)
  (async function init() {
    resizeCanvas();
    // Load playlist first, so we have it when the connect event fires
    await loadLocalPlaylist(); 
    
    // The 'connect' event from socket.io will now handle
    // syncing the player state, so we don't need to load 'lastPlayed' here.
    
    loadAudioDevices();
    
    // --- START FIX ---
    document.addEventListener('click', () => { 
        if (!audioCtx) {
          ensureAudioCtx(); 
        } else if (audioCtx.state === 'suspended') {
          audioCtx.resume(); // Explicitly resume on first click
        }
        loadAudioDevices();
    }, { once:true });
    // --- END FIX ---
  })();

  // helpers (no changes)
  window.DW = { playlist, renderPlaylist, saveLocalPlaylist, playItem, addFileLocal };

  // service worker registration (no change)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(()=> console.log('SW registered')).catch(console.warn);
  }

})();