# app.py
import os
import sqlite3
from pathlib import Path
from flask import Flask, request, jsonify, send_from_directory, g, abort, Response

BASE = Path(__file__).resolve().parent
WEB_DIR = BASE / "web"
UPLOAD_DIR = WEB_DIR / "uploads"
DB_PATH = BASE / "playlist.db"

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=str(WEB_DIR), static_url_path="")

# ---- Database helpers ----
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )""")
    db.commit()

@app.teardown_appcontext
def close_db(exception):
    db = getattr(g, "_db", None)
    if db is not None:
        db.close()

# ---- Routes: static UI ----
@app.route("/")
def index():
    return send_from_directory(str(WEB_DIR), "index.html")

@app.route("/<path:filename>")
def static_files(filename):
    target = WEB_DIR / filename
    if target.exists():
        return send_from_directory(str(WEB_DIR), filename)
    abort(404)

# ---- Upload endpoint (raw bytes + header X-Filename) ----
@app.route("/upload", methods=["POST"])
def upload():
    filename = request.headers.get("X-Filename") or "upload.bin"
    filename = os.path.basename(filename)
    safe_name = filename
    save_path = UPLOAD_DIR / safe_name
    counter = 1
    while save_path.exists():
        name, ext = os.path.splitext(filename)
        safe_name = f"{name}_{counter}{ext}"
        save_path = UPLOAD_DIR / safe_name
        counter += 1

    data = request.get_data()
    with open(save_path, "wb") as f:
        f.write(data)

    db = get_db()
    rel_path = f"uploads/{safe_name}"
    db.execute("INSERT INTO playlist (name, path) VALUES (?, ?)", (safe_name, rel_path))
    db.commit()

    return jsonify({"status": "ok", "path": rel_path, "name": safe_name})

# ---- Streaming with Range support ----
@app.route("/stream/<path:filepath>")
def stream(filepath):
    full = WEB_DIR / filepath
    if not full.exists():
        return abort(404)

    file_size = full.stat().st_size
    range_header = request.headers.get("Range", None)
    if range_header:
        # parse Range header: bytes=start-end
        range_str = range_header.strip().lower()
        if not range_str.startswith("bytes="):
            return abort(416)
        range_parts = range_str.replace("bytes=", "").split("-")
        try:
            start = int(range_parts[0]) if range_parts[0] else 0
        except:
            start = 0
        end = int(range_parts[1]) if len(range_parts) > 1 and range_parts[1] else file_size - 1
        if end >= file_size:
            end = file_size - 1
        if start > end:
            return abort(416)

        length = end - start + 1
        with open(full, "rb") as f:
            f.seek(start)
            chunk = f.read(length)

        rv = Response(chunk, 206, mimetype="application/octet-stream", direct_passthrough=True)
        rv.headers.add("Content-Range", f"bytes {start}-{end}/{file_size}")
        rv.headers.add("Accept-Ranges", "bytes")
        rv.headers.add("Content-Length", str(length))
        # Attempt to hint audio content type by extension
        ext = full.suffix.lower()
        if ext in [".mp3"]:
            rv.headers["Content-Type"] = "audio/mpeg"
            rv.mimetype = "audio/mpeg"
        elif ext in [".ogg", ".oga"]:
            rv.headers["Content-Type"] = "audio/ogg"
            rv.mimetype = "audio/ogg"
        elif ext in [".wav"]:
            rv.headers["Content-Type"] = "audio/wav"
            rv.mimetype = "audio/wav"
        else:
            # default to octet-stream (browser can still handle)
            pass
        return rv
    # no range header -> serve the full file
    return send_from_directory(str(WEB_DIR), filepath)

# ---- Playlist endpoints ----
@app.route("/playlist", methods=["GET"])
def get_playlist():
    db = get_db()
    rows = db.execute("SELECT id, name, path, created_at FROM playlist ORDER BY created_at DESC").fetchall()
    out = []
    for r in rows:
        out.append({"id": r["id"], "name": r["name"], "path": r["path"], "createdAt": r["created_at"], "origin": "remote"})
    return jsonify(out)

@app.route("/save-playlist", methods=["POST"])
def save_playlist():
    data = request.get_json() or {}
    songs = data.get("songs", [])
    db = get_db()
    # naive approach: wipe and insert in order
    db.execute("DELETE FROM playlist")
    for s in songs:
        name = s.get("name")
        path = s.get("path")
        if name and path:
            db.execute("INSERT INTO playlist (name, path) VALUES (?, ?)", (name, path))
    db.commit()
    return jsonify({"status": "playlist_saved"})

@app.route("/playlist/delete", methods=["POST"])
def delete_song():
    data = request.get_json() or {}
    song_id = data.get("id")
    if song_id is None:
        return jsonify({"error": "missing id"}), 400
    db = get_db()
    row = db.execute("SELECT path FROM playlist WHERE id=?", (song_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    file_path = WEB_DIR / row["path"]
    try:
        if file_path.exists():
            file_path.unlink()
    except Exception as e:
        # log but continue
        print("delete file error:", e)
    db.execute("DELETE FROM playlist WHERE id=?", (song_id,))
    db.commit()
    return jsonify({"status": "deleted"})

@app.route("/playlist/rename", methods=["POST"])
def rename_song():
    data = request.get_json() or {}
    song_id = data.get("id")
    new_name = data.get("name")
    if not new_name:
        return jsonify({"error": "invalid name"}), 400
    db = get_db()
    row = db.execute("SELECT path FROM playlist WHERE id=?", (song_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    old_rel = row["path"]
    old_full = WEB_DIR / old_rel
    # keep extension
    _, ext = os.path.splitext(old_rel)
    new_filename = new_name + ext
    new_rel = f"uploads/{new_filename}"
    new_full = WEB_DIR / new_rel
    # avoid overwriting
    counter = 1
    base_new = new_filename
    while new_full.exists():
        name_only, ext2 = os.path.splitext(base_new)
        candidate = f"{name_only}_{counter}{ext2}"
        new_full = WEB_DIR / f"uploads/{candidate}"
        new_rel = f"uploads/{candidate}"
        counter += 1
    try:
        os.rename(old_full, new_full)
    except Exception as e:
        print("rename error:", e)
        return jsonify({"error": "rename failed"}), 500
    db.execute("UPDATE playlist SET name=?, path=? WHERE id=?", (new_name, new_rel, song_id))
    db.commit()
    return jsonify({"status": "renamed", "path": new_rel})

@app.route("/playlist/reorder", methods=["POST"])
def reorder_playlist():
    data = request.get_json() or {}
    order = data.get("order", [])
    if not isinstance(order, list):
        return jsonify({"error": "invalid order"}), 400
    db = get_db()
    rows = []
    for song_id in order:
        r = db.execute("SELECT name, path FROM playlist WHERE id=?", (song_id,)).fetchone()
        if r:
            rows.append((r["name"], r["path"]))
    # rebuild table in new order
    db.execute("DELETE FROM playlist")
    for name, path in rows:
        db.execute("INSERT INTO playlist (name, path) VALUES (?, ?)", (name, path))
    db.commit()
    return jsonify({"status": "reordered"})

# create DB on first run
with app.app_context():
    init_db()

if __name__ == "__main__":
    app.run("127.0.0.1", 8080, debug=True)
