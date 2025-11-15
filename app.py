# app.py
import os
import sqlite3
import time  # NEW: Import time
from pathlib import Path
from flask import Flask, request, jsonify, send_from_directory, g, abort, Response
from werkzeug.utils import secure_filename
import magic
from tinytag import TinyTag
from flask_socketio import SocketIO, emit  # NEW: Import SocketIO

# --- Constants ---
BASE = Path(__file__).resolve().parent
WEB_DIR = BASE / "web"
UPLOAD_DIR = WEB_DIR / "uploads"
ART_DIR = WEB_DIR / "art"
DB_PATH = BASE / "playlist.db"

# Max upload 30MB (adjust as needed)
MAX_UPLOAD_MB = 30
ALLOWED_AUDIO_MIME_TYPES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/x-m4a']
ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp']

# Create directories
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
ART_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=str(WEB_DIR), static_url_path="")
app.config['MAX_CONTENT_LENGTH'] = MAX_UPLOAD_MB * 1024 * 1024

# NEW: Initialize SocketIO
# We use eventlet for async operations
socketio = SocketIO(app, async_mode='eventlet') 

# NEW: Server-side "Authoritative" Player State
# This is the single source of truth for all clients.
server_state = {
    "current_song_id": None,
    "is_playing": False,
    "current_time": 0,
    "last_update_time": time.time() # Server time of last action
}

# --- Database helpers (NO CHANGES) ---
def get_db():
    db = getattr(g, "_db", None)
    if db is None:
        db = g._db = sqlite3.connect(str(DB_PATH))
        db.row_factory = sqlite3.Row
    return db

def init_db():
    db = get_db()
    db.execute("""
    CREATE TABLE IF NOT EXISTS playlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT,
        artist TEXT,
        album TEXT,
        duration REAL,
        has_art INTEGER DEFAULT 0,
        ordering INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )""")
    db.commit()

@app.teardown_appcontext
def close_db(exception):
    db = getattr(g, "_db", None)
    if db is not None:
        db.close()

# --- Routes: static UI (NO CHANGES) ----
@app.route("/")
def index():
    return send_from_directory(str(WEB_DIR), "index.html")

@app.route("/<path:filename>")
def static_files(filename):
    target = WEB_DIR / filename
    if target.exists():
        if filename in ["app.py", "playlist.db", "app.pyc"]: # Added .pyc
            return abort(404)
        return send_from_directory(str(WEB_DIR), filename)
    abort(404)

# --- Upload endpoint (NO CHANGES) ----
@app.route("/upload", methods=["POST"])
def upload():
    filename = request.headers.get("X-Filename") or "upload.bin"
    filename = secure_filename(filename)
    if not filename:
        return jsonify({"error": "Invalid filename"}), 400

    data = request.get_data()
    if not data:
        return jsonify({"error": "No data received"}), 400

    file_mime_type = magic.from_buffer(data, mime=True)
    if file_mime_type not in ALLOWED_AUDIO_MIME_TYPES:
        return jsonify({"error": f"File type not allowed: {file_mime_type}"}), 400

    safe_name = filename
    save_path = UPLOAD_DIR / safe_name
    counter = 1
    while save_path.exists():
        name, ext = os.path.splitext(filename)
        safe_name = f"{name}_{counter}{ext}"
        save_path = UPLOAD_DIR / safe_name
        counter += 1

    with open(save_path, "wb") as f:
        f.write(data)

    try:
        tag = TinyTag.get(str(save_path)) 
        title = tag.title or os.path.splitext(safe_name)[0].replace('_', ' ').capitalize()
        artist = tag.artist
        album = tag.album
        duration = tag.duration
        image_data = None
        # Use get_image() which is the modern TinyTag API
        image_data = tag.get_image() 
            
    except Exception as e:
        print(f"TinyTag error: {e}")
        title = os.path.splitext(safe_name)[0].replace('_', ' ').capitalize()
        artist, album, duration, image_data = None, None, None, None

    db = get_db()
    rel_path = f"uploads/{safe_name}"
    
    max_order = db.execute("SELECT MAX(ordering) as max FROM playlist").fetchone()
    next_order = (max_order['max'] or 0) + 1

    cursor = db.execute(
        "INSERT INTO playlist (name, path, title, artist, album, duration, ordering) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (safe_name, rel_path, title, artist, album, duration, next_order)
    )
    song_id = cursor.lastrowid
    has_art = 0

    if image_data:
        try:
            art_path = ART_DIR / f"{song_id}.jpg"
            with open(art_path, "wb") as art_file:
                art_file.write(image_data)
            db.execute("UPDATE playlist SET has_art=1 WHERE id=?", (song_id,))
            has_art = 1
        except Exception as e:
            print(f"Art save error: {e}")

    db.commit()

    new_song = {
        "id": song_id, "name": safe_name, "path": rel_path,
        "title": title, "artist": artist, "album": album,
        "duration": duration, "has_art": has_art, "origin": "remote",
        "createdAt": "now" # This field isn't in DB but client expects it
    }
    return jsonify(new_song)

# --- Streaming with Range support (NO CHANGES) ----
@app.route("/stream/<path:filepath>")
def stream(filepath):
    if ".." in filepath:
        return abort(404)
    full = WEB_DIR / filepath
    if not full.exists():
        return abort(404)
    file_size = full.stat().st_size
    range_header = request.headers.get("Range", None)
    if range_header:
        range_str = range_header.strip().lower()
        if not range_str.startswith("bytes="): return abort(416)
        range_parts = range_str.replace("bytes=", "").split("-")
        try: start = int(range_parts[0]) if range_parts[0] else 0
        except: start = 0
        end = int(range_parts[1]) if len(range_parts) > 1 and range_parts[1] else file_size - 1
        if end >= file_size: end = file_size - 1
        if start > end: return abort(416)
        length = end - start + 1
        with open(full, "rb") as f:
            f.seek(start)
            chunk = f.read(length)
        rv = Response(chunk, 206, mimetype="application/octet-stream", direct_passthrough=True)
        rv.headers.add("Content-Range", f"bytes {start}-{end}/{file_size}")
        rv.headers.add("Accept-Ranges", "bytes")
        rv.headers.add("Content-Length", str(length))
        ext = full.suffix.lower()
        if ext in [".mp3"]: rv.mimetype = "audio/mpeg"
        elif ext in [".ogg", ".oga"]: rv.mimetype = "audio/ogg"
        elif ext in [".wav"]: rv.mimetype = "audio/wav"
        return rv
    return send_from_directory(str(WEB_DIR), filepath)

# --- Playlist endpoints (NO CHANGES) ----
@app.route("/playlist", methods=["GET"])
def get_playlist():
    db = get_db()
    rows = db.execute(
        "SELECT id, name, path, title, artist, album, duration, has_art, created_at FROM playlist ORDER BY ordering ASC"
    ).fetchall()
    out = []
    for r in rows:
        out.append({**dict(r), "origin": "remote"})
    return jsonify(out)

@app.route("/playlist/upload-art", methods=["POST"])
def upload_art():
    song_id = request.form.get("id")
    file = request.files.get("file")

    if not song_id or not file:
        return jsonify({"error": "missing id or file"}), 400
    file_data = file.read()
    file.seek(0) 
    file_mime_type = magic.from_buffer(file_data, mime=True)
    if file_mime_type not in ALLOWED_IMAGE_MIME_TYPES:
        return jsonify({"error": f"File type not allowed: {file_mime_type}"}), 400
    try:
        art_path = ART_DIR / f"{song_id}.jpg"
        with open(art_path, "wb") as f:
            f.write(file_data)
        db = get_db()
        db.execute("UPDATE playlist SET has_art=1 WHERE id=?", (song_id,))
        db.commit()
        return jsonify({"status": "art_uploaded", "id": song_id})
    except Exception as e:
        print(f"Art upload error: {e}")
        return jsonify({"error": "art upload failed"}), 500

@app.route("/playlist/delete", methods=["POST"])
def delete_song():
    data = request.get_json() or {}
    song_id = data.get("id")
    if song_id is None: return jsonify({"error": "missing id"}), 400
    db = get_db()
    row = db.execute("SELECT path, has_art FROM playlist WHERE id=?", (song_id,)).fetchone()
    if not row: return jsonify({"error": "not found"}), 404
    file_path = WEB_DIR / row["path"]
    try:
        if file_path.exists(): file_path.unlink()
    except Exception as e: print("delete file error:", e)
    if row["has_art"]:
        try:
            art_path = ART_DIR / f"{song_id}.jpg"
            if art_path.exists(): art_path.unlink()
        except Exception as e: print("delete art error:", e)
    db.execute("DELETE FROM playlist WHERE id=?", (song_id,))
    db.commit()
    return jsonify({"status": "deleted"})

@app.route("/playlist/rename", methods=["POST"])
def rename_song():
    data = request.get_json() or {}
    song_id = data.get("id")
    new_name = data.get("name") # This is now the 'title'
    if not new_name: return jsonify({"error": "invalid name"}), 400
    db = get_db()
    db.execute("UPDATE playlist SET title=? WHERE id=?", (new_name, song_id))
    db.commit()
    return jsonify({"status": "renamed", "title": new_name})

@app.route("/playlist/reorder", methods=["POST"])
def reorder_playlist():
    data = request.get_json() or {}
    order = data.get("order", [])
    if not isinstance(order, list): return jsonify({"error": "invalid order"}), 400
    db = get_db()
    try:
        for index, song_id in enumerate(order):
            clean_id = int(song_id)
            db.execute("UPDATE playlist SET ordering=? WHERE id=?", (index, clean_id))
        db.commit()
        return jsonify({"status": "reordered"})
    except Exception as e:
        db.rollback()
        print(f"Reorder error: {e}")
        return jsonify({"error": "reorder failed"}), 500

# --- NEW: SocketIO Event Handlers for Syncing ---

@socketio.on('connect')
def handle_connect():
    """When a new user connects, send them the current player state."""
    print(f"Client connected: {request.sid}")
    
    # If a song is playing, we need to adjust its 'current_time'
    # to account for the time elapsed since the last action.
    state_to_send = server_state.copy()
    if server_state["is_playing"]:
        time_elapsed = time.time() - server_state["last_update_time"]
        adjusted_time = server_state["current_time"] + time_elapsed
        state_to_send["current_time"] = adjusted_time
        
    emit('state_update', state_to_send)


@socketio.on('player_action')
def handle_player_action(data):
    """
    When a client sends an action (play, pause, seek, change_song),
    update the server's state and broadcast it to ALL clients.
    """
    global server_state
    action = data.get("action")
    
    print(f"Action from {request.sid}: {data}")

    if action == "PLAY":
        server_state["is_playing"] = True
        server_state["current_song_id"] = data.get("song_id")
        server_state["current_time"] = data.get("time", 0)
    
    elif action == "PAUSE":
        server_state["is_playing"] = False
        server_state["current_time"] = data.get("time", server_state["current_time"])

    elif action == "SEEK":
        # Only update time, don't change play state
        server_state["current_time"] = data.get("time", 0)

    elif action == "CHANGE_SONG":
        server_state["is_playing"] = True # Assume we auto-play new songs
        server_state["current_song_id"] = data.get("song_id")
        server_state["current_time"] = 0 # Start from beginning
    
    else:
        return # Unknown action

    # IMPORTANT: Update the server time for this action
    server_state["last_update_time"] = time.time()

    # Broadcast the NEW state to ALL connected clients
    socketio.emit('state_update', server_state)

@socketio.on('disconnect')
def handle_disconnect():
    print(f"Client disconnected: {request.sid}")


# --- Main execution ---
# create DB on first run
with app.app_context():
    init_db()

if __name__ == "__main__":
    # NEW: Use socketio.run() and specify 'eventlet'
    # This is for DEVELOPMENT ONLY.
    print("Starting Flask-SocketIO development server with eventlet at http://127.0.0.1:8080")
    socketio.run(app, "127.0.0.1", 8080, debug=True)