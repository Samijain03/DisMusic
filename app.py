# app.py
import eventlet
eventlet.monkey_patch()

from dotenv import load_dotenv
load_dotenv() # This loads the .env file on your local machine

import os
import time
from pathlib import Path
from flask import Flask, request, jsonify, send_from_directory, g, abort, Response, redirect
from werkzeug.utils import secure_filename
import magic
from tinytag import TinyTag
from flask_socketio import SocketIO, emit
from flask_sqlalchemy import SQLAlchemy
import boto3
from botocore.client import Config
from botocore.exceptions import ClientError
from io import BytesIO

# --- 1. Load Environment Variables ---
# These are NOW loaded from your .env file locally, 
# or from Render's environment when deployed.
DATABASE_URL = os.environ.get('DATABASE_URL')
S3_BUCKET = os.environ.get('S3_BUCKET')
S3_KEY = os.environ.get('S3_KEY')
S3_SECRET = os.environ.get('S3_SECRET')
S3_ENDPOINT_URL = os.environ.get('S3_ENDPOINT_URL')

if not all([DATABASE_URL, S3_BUCKET, S3_KEY, S3_SECRET, S3_ENDPOINT_URL]):
    raise EnvironmentError("Missing required environment variables. Did you create your .env file?")

# --- 2. Flask App Setup ---
BASE = Path(__file__).resolve().parent
WEB_DIR = BASE / "web"
MAX_UPLOAD_MB = 30
ALLOWED_AUDIO_MIME_TYPES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/x-m4a']
ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp']

app = Flask(__name__, static_folder=str(WEB_DIR), static_url_path="")
app.config['MAX_CONTENT_LENGTH'] = MAX_UPLOAD_MB * 1024 * 1024

# --- 3. Database Setup (PostgreSQL) ---
app.config['SQLALCHEMY_DATABASE_URI'] = DATABASE_URL
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
db = SQLAlchemy(app)

# --- 4. S3 Client Setup (Backblaze, etc.) ---
s3 = boto3.client(
    's3',
    endpoint_url=S3_ENDPOINT_URL,
    aws_access_key_id=S3_KEY,
    aws_secret_access_key=S3_SECRET,
    config=Config(signature_version='s3v4')
)

# --- 5. Database Model ---
class Playlist(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.Text, nullable=False) # Original filename
    path = db.Column(db.Text, nullable=False, unique=True) # S3 Key (e.g., "uploads/song.mp3")
    title = db.Column(db.Text)
    artist = db.Column(db.Text)
    album = db.Column(db.Text)
    duration = db.Column(db.Float)
    has_art = db.Column(db.Integer, default=0)
    ordering = db.Column(db.Integer, default=0)
    created_at = db.Column(db.DateTime, server_default=db.func.now())

# --- 6. SocketIO Setup & Handlers ---
socketio = SocketIO(app, async_mode='eventlet') 
server_state = {
    "current_song_id": None, "is_playing": False,
    "current_time": 0, "last_update_time": time.time()
}

@socketio.on('connect')
def handle_connect():
    print(f"Client connected: {request.sid}")
    state_to_send = server_state.copy()
    if server_state["is_playing"]:
        time_elapsed = time.time() - server_state["last_update_time"]
        adjusted_time = server_state["current_time"] + time_elapsed
        state_to_send["current_time"] = adjusted_time
    emit('state_update', state_to_send)

@socketio.on('player_action')
def handle_player_action(data):
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
        server_state["current_time"] = data.get("time", 0)
    elif action == "CHANGE_SONG":
        server_state["is_playing"] = True
        server_state["current_song_id"] = data.get("song_id")
        server_state["current_time"] = 0
    else:
        return
    server_state["last_update_time"] = time.time()
    socketio.emit('state_update', server_state)

@socketio.on('disconnect')
def handle_disconnect():
    print(f"Client disconnected: {request.sid}")

# --- 7. Static Routes (Serving the frontend) ---
@app.route("/")
def index():
    return send_from_directory(str(WEB_DIR), "index.html")

@app.route("/<path:filename>")
def static_files(filename):
    target = WEB_DIR / filename
    if target.exists():
        # Prevent access to sensitive files
        if filename in ["app.py", "requirements.txt", "README.md", ".env"]:
            return abort(404)
        return send_from_directory(str(WEB_DIR), filename)
    abort(404)

# --- 8. API: File Upload (to S3) ---
@app.route("/upload", methods=["POST"])
def upload():
    filename = request.headers.get("X-Filename") or "upload.bin"
    filename = secure_filename(filename)
    if not filename: return jsonify({"error": "Invalid filename"}), 400

    data = request.get_data()
    if not data: return jsonify({"error": "No data received"}), 400

    file_mime_type = magic.from_buffer(data, mime=True)
    if file_mime_type not in ALLOWED_AUDIO_MIME_TYPES:
        return jsonify({"error": f"File type not allowed: {file_mime_type}"}), 400

    # Find a unique name
    safe_name = filename
    s3_path = f"uploads/{safe_name}"
    counter = 1
    while True:
        try:
            s3.head_object(Bucket=S3_BUCKET, Key=s3_path)
            # File exists, try a new name
            name, ext = os.path.splitext(filename)
            safe_name = f"{name}_{counter}{ext}"
            s3_path = f"uploads/{safe_name}"
            counter += 1
        except ClientError as e:
            if e.response['Error']['Code'] == '404': break # Good, name is unique
            else: return jsonify({"error": "S3 check failed"}), 500
    
    # Upload to S3
    try:
        s3.upload_fileobj(
            BytesIO(data), S3_BUCKET, s3_path,
            ExtraArgs={'ContentType': file_mime_type}
        )
    except Exception as e:
        print(f"S3 upload error: {e}")
        return jsonify({"error": "File upload to S3 failed"}), 500

    # Get metadata
    try:
        tag = TinyTag.get(file_obj=BytesIO(data)) 
        title = tag.title or os.path.splitext(safe_name)[0].replace('_', ' ').capitalize()
        artist, album, duration = tag.artist, tag.album, tag.duration
        image_data = tag.get_image()
    except Exception as e:
        print(f"TinyTag error: {e}")
        title = os.path.splitext(safe_name)[0].replace('_', ' ').capitalize()
        artist, album, duration, image_data = None, None, None, None

    # Save to Postgres
    max_order_result = db.session.query(db.func.max(Playlist.ordering)).scalar()
    next_order = (max_order_result or 0) + 1
    new_song = Playlist(
        name=safe_name, path=s3_path, title=title, artist=artist,
        album=album, duration=duration, ordering=next_order, has_art=0
    )
    db.session.add(new_song)
    db.session.commit()
    
    song_id = new_song.id
    has_art = 0

    if image_data:
        try:
            art_s3_path = f"art/{song_id}.jpg"
            s3.upload_fileobj(
                BytesIO(image_data), S3_BUCKET, art_s3_path,
                ExtraArgs={'ContentType': 'image/jpeg'}
            )
            new_song.has_art = 1
            has_art = 1
            db.session.commit()
        except Exception as e:
            print(f"Art save error: {e}")

    # Return new song object to client
    return jsonify({
        "id": song_id, "name": safe_name, "path": s3_path,
        "title": title, "artist": artist, "album": album,
        "duration": duration, "has_art": has_art, "origin": "remote",
    })

# --- 9. API: File Streaming (from S3) ---
# This generates a secure, temporary link for the private S3 file
@app.route("/stream/<path:filepath>")
def stream(filepath):
    if ".." in filepath: return abort(404)
    try:
        # Generate a temporary (1 hr) URL for the browser to use
        url = s3.generate_presigned_url(
            'get_object',
            Params={'Bucket': S3_BUCKET, 'Key': filepath},
            ExpiresIn=3600  # Valid for 1 hour
        )
        # Redirect the browser to that temporary URL
        return redirect(url)
    except Exception as e:
        print(f"S3 presign error: {e}")
        return abort(404)

# This generates a secure, temporary link for the private S3 art file
@app.route("/art/<int:song_id>.jpg")
def get_art(song_id):
    song = db.session.get(Playlist, song_id)
    if not song or not song.has_art: return abort(404)
    try:
        url = s3.generate_presigned_url(
            'get_object',
            Params={'Bucket': S3_BUCKET, 'Key': f"art/{song_id}.jpg"},
            ExpiresIn=3600 # Valid for 1 hour
        )
        return redirect(url)
    except Exception as e:
        print(f"S3 art presign error: {e}")
        return abort(404)

# --- 10. API: Playlist Management (Postgres) ---
@app.route("/playlist", methods=["GET"])
def get_playlist():
    rows = Playlist.query.order_by(Playlist.ordering.asc()).all()
    out = [{"id": r.id, "name": r.name, "path": r.path, "title": r.title,
            "artist": r.artist, "album": r.album, "duration": r.duration,
            "has_art": r.has_art, "origin": "remote",
            "created_at": r.created_at.isoformat()} for r in rows]
    return jsonify(out)

@app.route("/playlist/upload-art", methods=["POST"])
def upload_art():
    song_id = request.form.get("id")
    file = request.files.get("file")
    if not song_id or not file: return jsonify({"error": "missing id or file"}), 400
    song = db.session.get(Playlist, int(song_id))
    if not song: return jsonify({"error": "song not found"}), 404
    
    file_data = file.read()
    file.seek(0)
    file_mime_type = magic.from_buffer(file_data, mime=True)
    if file_mime_type not in ALLOWED_IMAGE_MIME_TYPES:
        return jsonify({"error": f"File type not allowed: {file_mime_type}"}), 400
    
    try:
        # Upload the art file to S3
        s3.upload_fileobj(
            BytesIO(file_data), S3_BUCKET, f"art/{song_id}.jpg",
            ExtraArgs={'ContentType': file_mime_type}
        )
        # Update the database
        song.has_art = 1
        db.session.commit()
        return jsonify({"status": "art_uploaded", "id": song_id})
    except Exception as e:
        print(f"Art upload error: {e}")
        return jsonify({"error": "art upload failed"}), 500

@app.route("/playlist/delete", methods=["POST"])
def delete_song():
    song_id = (request.get_json() or {}).get("id")
    if not song_id: return jsonify({"error": "missing id"}), 400
    
    song = db.session.get(Playlist, int(song_id))
    if not song: return jsonify({"error": "not found"}), 404
    
    try:
        # Delete the song file from S3
        s3.delete_object(Bucket=S3_BUCKET, Key=song.path)
        if song.has_art:
            # Delete the art file from S3
            s3.delete_object(Bucket=S3_BUCKET, Key=f"art/{song.id}.jpg")
    except Exception as e:
        print(f"S3 delete error: {e}") # Log error but continue
    
    # Delete the song record from Postgres
    db.session.delete(song)
    db.session.commit()
    return jsonify({"status": "deleted"})

@app.route("/playlist/rename", methods=["POST"])
def rename_song():
    data = request.get_json() or {}
    song_id, new_name = data.get("id"), data.get("name")
    if not new_name: return jsonify({"error": "invalid name"}), 400
    
    song = db.session.get(Playlist, int(song_id))
    if not song: return jsonify({"error": "not found"}), 404
    
    song.title = new_name
    db.session.commit()
    return jsonify({"status": "renamed", "title": new_name})

@app.route("/playlist/reorder", methods=["POST"])
def reorder_playlist():
    order = (request.get_json() or {}).get("order", [])
    if not isinstance(order, list): return jsonify({"error": "invalid order"}), 400
    
    try:
        # Update the ordering for each song
        for index, song_id in enumerate(order):
            song = db.session.get(Playlist, int(song_id))
            if song: song.ordering = index
        db.session.commit()
        return jsonify({"status": "reordered"})
    except Exception as e:
        db.session.rollback()
        print(f"Reorder error: {e}")
        return jsonify({"error": "reorder failed"}), 500

# --- 11. Create Database Tables ---
# This will run when the app starts, ensuring tables exist.
# `create_all()` is safe and won't re-create existing tables.
with app.app_context():
    db.create_all()

# --- 12. Run the App (for development or production) ---
if __name__ == "__main__":
    # This block runs when you execute `python app.py`
    print("Starting Flask-SocketIO development server at http://127.0.0.1:8080")
    socketio.run(app, "127.0.0.1", 8080, debug=True)
else:
    # This block runs when Gunicorn starts the app on Render
    # The `app:app` in your start command points Gunicorn here.
    # We pass the Flask 'app' object to SocketIO to wrap it.
    app = socketio.init_app(app)