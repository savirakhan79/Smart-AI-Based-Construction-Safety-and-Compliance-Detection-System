import cv2
from ultralytics import YOLO
from flask import Flask, request, jsonify
from flask_socketio import SocketIO
from flask_cors import CORS
import os
import numpy as np
from deepface import DeepFace
import requests
from datetime import datetime
import threading
import time
import gc
import smtplib
from email.message import EmailMessage

app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# ================= PATHS =================
BASE_DIR = r"C:\Users\HP\Desktop\Admin panel\backend\uploads"
VIOLATION_DIR = r"C:\Users\HP\Desktop\Admin panel\backend\logs\violations"

if not os.path.exists(VIOLATION_DIR):
    os.makedirs(VIOLATION_DIR)

known_db_path = BASE_DIR

EMAIL_FROM = os.environ.get("SAFESITE_EMAIL_FROM", "")
EMAIL_TO = os.environ.get("SAFESITE_EMAIL_TO", "")
EMAIL_APP_PASSWORD = os.environ.get("SAFESITE_EMAIL_APP_PASSWORD", "")

PERSON_MODEL_PATH = "yolov8n.pt"
PPE_MODEL_PATH = os.environ.get("SAFESITE_PPE_MODEL_PATH", "")  # e.g. "ppe_best.pt"

try:
    model = YOLO(PERSON_MODEL_PATH)
    print("✅ Person/Object Model Loaded Successfully")
except Exception as e:
    model = None
    print(f"❌ YOLO Loading Error: {e}")

ppe_model = None
PPE_CLASSES = set()
if PPE_MODEL_PATH and os.path.exists(PPE_MODEL_PATH):
    try:
        ppe_model = YOLO(PPE_MODEL_PATH)
        PPE_CLASSES = {n.lower() for n in ppe_model.names.values()}
        print(f"✅ PPE Model Loaded — classes: {PPE_CLASSES}")
    except Exception as e:
        print(f"❌ PPE Model Loading Error: {e}")
else:
    print("⚠️  No custom PPE model configured (SAFESITE_PPE_MODEL_PATH). "
          "Helmet/vest violations will NOT be real until you plug in a "
          "model trained on 'helmet' / 'no-helmet' / 'vest' / 'no-vest' classes. "
          "Person detection will still run so cameras show live boxes.")


# ============== ATTENDANCE API ==============
@app.route('/mark_attendance', methods=['POST'])
def mark_attendance():
    if 'photo' not in request.files:
        return jsonify({"status": "Error", "message": "No photo received"})

    file = request.files['photo']
    temp_path = "live_capture.jpg"
    file.save(temp_path)

    identified_worker = "Unknown"
    img_bgr = cv2.imread(temp_path)

    try:
        results = DeepFace.find(
            img_path=temp_path,
            db_path=known_db_path,
            model_name="VGG-Face",
            enforce_detection=False,
            silent=True
        )
        if len(results) > 0 and not results[0].empty:
            match_path = results[0].iloc[0]['identity']
            filename = os.path.basename(match_path)
            identified_worker = filename.split("_")[0]
            print(f"✅ Face Recognized: {identified_worker}")
    except Exception as e:
        print(f"🔥 Face Matching Error: {e}")

    has_helmet = False
    if img_bgr is not None and ppe_model is not None:
        yolo_results = ppe_model(img_bgr, verbose=False)
        for r in yolo_results:
            for box in r.boxes:
                label = ppe_model.names[int(box.cls[0])].lower()
                if "helmet" in label and "no" not in label:
                    has_helmet = True

    response_data = {"status": "Failed", "message": "Unknown Person", "worker": "Unknown"}

    if identified_worker != "Unknown":
        try:
            requests.post("http://localhost:5000/api/attendance/mark",
                          json={"workerID": identified_worker}, timeout=3)
            response_data = {"status": "Success", "message": f"Welcome {identified_worker}", "worker": identified_worker}

            if ppe_model is not None and not has_helmet:
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                violation_file = os.path.join(VIOLATION_DIR, f"{identified_worker}_no_helmet_{timestamp}.jpg")
                cv2.imwrite(violation_file, img_bgr)
                print(f"📸 Violation Saved: {violation_file}")
        except Exception as e:
            response_data = {"status": "Warning", "message": "Node.js Offline", "worker": identified_worker}

    if os.path.exists(temp_path):
        os.remove(temp_path)

    return jsonify(response_data)


# ================= LIVE MONITORING =================
last_alert_time = 0
alert_lock = threading.Lock()

PROCESS_WIDTH = 1280
PROCESS_HEIGHT = 720
PROCESS_EVERY_N_FRAMES = 2
ALERT_COOLDOWN_SECONDS = 30
FALL_ASPECT_RATIO = 1.4  # width/height threshold heuristic — see note below

# FIX (core bug): pehle sirf 2 video files khulti thin aur sirf un 2 cam_id
# (1, 2) ko events milte thay. Frontend mein CAM-01 se CAM-10 tak hain, jinme
# se kai ek hi 2 video files reuse kar rahe hain. Ab hum har UNIQUE video file
# ko sirf EK BAAR decode + YOLO run karte hain (perf ke liye), phir uske
# result us file ko use karne wale SAARE cam_id ko bhej dete hain.
SOURCE_FILES = {
    "src_a": r"C:\Users\HP\Desktop\Admin panel\public\cnstructionside.mp4",
    "src_b": r"C:\Users\HP\Desktop\Admin panel\public\constructioncopy.mp4",
}

# Frontend ki video assignment ke mutabiq (live monitoring.html dekh kar map kiya gaya)
CAM_SOURCE_MAP = {
    "01": "src_a",
    "02": "src_b",
    "03": "src_a",
    "04": "src_b",
    "05": "src_b",
    "06": "src_a",
    "07": "src_b",
    "08": "src_a",
    "09": "src_b",
    "10": "src_a",
}


def cams_for_source(source_key):
    return [cam for cam, src in CAM_SOURCE_MAP.items() if src == source_key]


def maybe_send_alert(subject, body):
    global last_alert_time
    with alert_lock:
        now = time.time()
        if now - last_alert_time <= ALERT_COOLDOWN_SECONDS:
            return
        last_alert_time = now
    send_emergency_alert(subject, body)


def run_live_monitoring():
    if model is None:
        print("❌ Cannot start monitoring — object detection model failed to load.")
        return

    caps = {key: cv2.VideoCapture(path) for key, path in SOURCE_FILES.items()}
    print("🎥 AI Monitoring Started for all mapped cameras...")

    frame_counter = 0

    while True:
        for source_key, cap in caps.items():
            try:
                ret, frame = cap.read()
            except (cv2.error, SystemError, MemoryError) as e:
                print(f"⚠️ Frame read error on {source_key}: {e}")
                gc.collect()
                ret, frame = False, None

            if not ret or frame is None:
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                continue

            orig_h, orig_w = frame.shape[:2]

            try:
                frame = cv2.resize(frame, (PROCESS_WIDTH, PROCESS_HEIGHT))
            except cv2.error as e:
                print(f"⚠️ Resize error on {source_key}: {e}")
                continue

            frame_counter += 1
            if frame_counter % PROCESS_EVERY_N_FRAMES != 0:
                continue

            try:
                results = model(frame, conf=0.5, verbose=False)
            except Exception as e:
                print(f"⚠️ YOLO inference error: {e}")
                continue

            target_cams = cams_for_source(source_key)
            if not target_cams:
                del results
                continue

            for r in results:
                for box in r.boxes:
                    label = model.names[int(box.cls[0])].lower()
                    x1, y1, x2, y2 = box.xyxy[0].tolist()

                    # FIX: coords ab NORMALIZED (0-1 fraction) hain, frontend
                    # `data.x * 100 + '%'` isi format ki demand karta hai.
                    nx = max(0.0, min(1.0, x1 / PROCESS_WIDTH))
                    ny = max(0.0, min(1.0, y1 / PROCESS_HEIGHT))
                    nw = max(0.0, min(1.0, (x2 - x1) / PROCESS_WIDTH))
                    nh = max(0.0, min(1.0, (y2 - y1) / PROCESS_HEIGHT))

                    if label == 'person':
                        # Agar custom PPE model laga hai to uska result use hota,
                        # yahan hum kam-se-kam har person box bhejte hain taake
                        # box overlay har camera par nazar aaye (blue = tracked).
                        emit_label = 'person'
                        emit_type = 'info'

                        # Heuristic fall-detection: agar koi dedicated model nahi hai
                        # to lying-down person ka box normal khadi person se kaafi
                        # zyada CHAURA hota hai (width > height). Yeh sirf ek
                        # approximation hai, asal accident/fall model ka replacement nahi.
                        box_w, box_h = (x2 - x1), (y2 - y1)
                        if box_h > 0 and (box_w / box_h) > FALL_ASPECT_RATIO:
                            emit_label = 'fall-detected'
                            emit_type = 'emergency'

                        for cam_id in target_cams:
                            socketio.emit('ppe_detections', {
                                'cam_id': cam_id,
                                'label': emit_label,
                                'x': nx, 'y': ny, 'w': nw, 'h': nh,
                            })

                        if emit_type == 'emergency':
                            maybe_send_alert(
                                "🚨 EMERGENCY: SafeSite AI Alert",
                                f"Warning: FALL DETECTED on CAM-{target_cams[0]} at "
                                f"{datetime.now().strftime('%H:%M:%S')}"
                            )
                            for cam_id in target_cams:
                                socketio.emit('emergency_status', {
                                    'active': True, 'cam_id': cam_id, 'type': 'fall-detected'
                                })

                    elif label in PPE_CLASSES:
                        # Custom PPE model ke actual classes (e.g. no-helmet, no-vest)
                        for cam_id in target_cams:
                            socketio.emit('ppe_detections', {
                                'cam_id': cam_id,
                                'label': label,
                                'x': nx, 'y': ny, 'w': nw, 'h': nh,
                            })

            del results
        time.sleep(0.03)


def send_emergency_alert(subject, body):
    if not (EMAIL_FROM and EMAIL_TO and EMAIL_APP_PASSWORD):
        print("⚠️ Email alert skipped — SAFESITE_EMAIL_* environment variables not set.")
        return

    msg = EmailMessage()
    msg.set_content(body)
    msg['Subject'] = subject
    msg['From'] = EMAIL_FROM
    msg['To'] = EMAIL_TO

    try:
        with smtplib.SMTP_SSL('smtp.gmail.com', 465) as smtp:
            smtp.login(EMAIL_FROM, EMAIL_APP_PASSWORD)
            smtp.send_message(msg)
            print("📩 Alert Email Sent Successfully!")
    except Exception as e:
        print(f"❌ Email Error: {e}")


if __name__ == '__main__':
    # FIX: thread ab yahan, main guard ke andar, saari functions/models define
    # hone ke BAAD start hota hai — pehle module-level par start hota tha jo
    # send_emergency_alert define hone se pehle bhi race condition ban sakta tha.
    threading.Thread(target=run_live_monitoring, daemon=True).start()
    print("🚀 Master AI Server (Face Attendance + Multi-Cam Monitoring) running on 5001")
    socketio.run(app, port=5001, debug=False, allow_unsafe_werkzeug=True)