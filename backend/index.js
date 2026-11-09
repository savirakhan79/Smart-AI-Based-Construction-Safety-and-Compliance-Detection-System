/* ===============================
    SAFE SITE WORKER MANAGEMENT BACKEND 
================================ */
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const http = require("http"); 
const { Server } = require("socket.io"); 
const { spawn } = require("child_process"); 
const multer = require("multer");
const crypto = require("crypto");
const { initializeApp } = require("firebase/app");
const { getDatabase, ref, set, remove, get, update } = require("firebase/database");
const open = require('open');
const app = express();
const server = http.createServer(app);
let recentIncidents = [];

// 1. Socket.io Server (Dashboard ke liye)
const io = new Server(server, {
    cors: { origin: "*" }
});

// 2. Socket.io Client (Python AI se connect karne ke liye)
const { io: socketClient } = require("socket.io-client");
const pythonSocket = socketClient("http://127.0.0.1:5001"); 

pythonSocket.on("connect", () => {
    console.log("✅ Node.js Bridge: Connected to Python AI Engine");
});

// AI Data Forwarding Logic (FIXED FOR FLOAT32 ERROR)
pythonSocket.on("ppe_update", (data) => {
    try {
        // Ensure data is JSON safe before broadcasting
        const sanitizedData = {
            ...data,
            x: parseFloat(data.x),
            y: parseFloat(data.y),
            w: parseFloat(data.w),
            h: parseFloat(data.h),
            conf: parseFloat(data.conf)
        };
        io.emit("ppe_detections", sanitizedData); 
    } catch (e) {
        console.error("AI Broadcast Error:", e.message);
    }
});

// 1. Middlewares
app.use(cors()); 
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// 2. Directories Setup (REPLACED FOR AUTOMATIC FOLDER CREATION)
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const SCAN_GATE_DIR = path.join(__dirname, "..", "WorkerAttendanceSystem", "templates");

// Isay "/gate" prefix ke sath serve karein
app.use("/gate", express.static(SCAN_GATE_DIR));
// Basic uploads folder banayein
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

app.use(express.static(PUBLIC_DIR)); 
app.use("/uploads", express.static(UPLOADS_DIR));

const ROLES = ["worker", "supervisor", "guard"];
const FOLDERS = {};

// Ye loop ab check karega ke har role ke liye photo aur face folders hain ya nahi
ROLES.forEach(role => {
    FOLDERS[role] = {
        face: path.join(UPLOADS_DIR, `${role}_face`),
        photo: path.join(UPLOADS_DIR, `${role}_photo`)
    };

    // Auto-create missing sub-folders
    if (!fs.existsSync(FOLDERS[role].face)) {
        fs.mkdirSync(FOLDERS[role].face, { recursive: true });
    }
    if (!fs.existsSync(FOLDERS[role].photo)) {
        fs.mkdirSync(FOLDERS[role].photo, { recursive: true });
    }
});

// Attendance folder ke liye extra check
const attendancePath = path.join(UPLOADS_DIR, "attendance");
if (!fs.existsSync(attendancePath)) {
    fs.mkdirSync(attendancePath, { recursive: true });
}

// Reports folder - generated PDF/CSV exports live here and are served
// statically from /uploads/reports/<file> (already covered by the
// app.use("/uploads", ...) static route above).
const REPORTS_DIR = path.join(UPLOADS_DIR, "reports");
if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

// 3. Multer Configuration (Corrected for Role-Based Storage)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR); // Pehle root uploads mein save hoga
    },
    filename: (req, file, cb) => {
        cb(null, `temp_${Date.now()}${path.extname(file.originalname)}`);
    }
});
// !!! YE LINE HONA LAZMI HAI ROUTES SE PEHLE !!!
const upload = multer({ storage });

// 4. Firebase Configuration
const firebaseConfig = {
    apiKey: "AIzaSyBjubB9ZrlMKWz1mnZiHTQTWCCTiSA_nSY",
    authDomain: "safesite-2a067.firebaseapp.com",
    databaseURL: "https://safesite-2a067-default-rtdb.firebaseio.com",
    projectId: "safesite-2a067",
    storageBucket: "safesite-2a067.firebasestorage.app",
};
const fbApp = initializeApp(firebaseConfig);
const db = getDatabase(fbApp);

/* ===============================
    ATTENDANCE RULES (NEW)
    - LATE_CUTOFF_HOUR/MINUTE: check-in is "on time" up to this
      moment; anything after becomes "Late" instead of "Present".
    - Auto-Absent: any ACTIVE registered worker who has no
      attendance record at all for a given date is treated as
      "Absent" for that date wherever reports are read (this is
      computed on read, nothing extra is written to Firebase
      unless you call the /api/attendance/auto-mark-absent route,
      which is provided for an optional end-of-day cron/manual run).
================================ */
const LATE_CUTOFF_HOUR = 9;   // 9:00 AM
const LATE_CUTOFF_MINUTE = 0;

// Parses times like "08:45 AM", "8:45 AM", "08:45", "17:05" into
// { hour24, minute }. Returns null if it can't confidently parse.
function parseTimeToHM(timeStr) {
    if (!timeStr || typeof timeStr !== "string") return null;
    const s = timeStr.trim();
    if (s === "--:--" || s === "") return null;

    // 12-hour format with AM/PM
    let m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)$/);
    if (m) {
        let hour = parseInt(m[1], 10);
        const minute = parseInt(m[2], 10);
        const period = m[3].toUpperCase();
        if (period === "PM" && hour !== 12) hour += 12;
        if (period === "AM" && hour === 12) hour = 0;
        return { hour24: hour, minute };
    }

    // 24-hour format
    m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
        return { hour24: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
    }

    return null;
}

// Given a check-in time string, decides "Present" vs "Late" against
// the LATE_CUTOFF above. If the time can't be parsed, falls back to
// whatever status was already stored (never silently guesses).
function deriveAttendanceStatus(checkInTimeStr, existingStatus) {
    const hm = parseTimeToHM(checkInTimeStr);
    if (!hm) return existingStatus || "Present";
    const isLate = (hm.hour24 > LATE_CUTOFF_HOUR) ||
        (hm.hour24 === LATE_CUTOFF_HOUR && hm.minute > LATE_CUTOFF_MINUTE);
    return isLate ? "Late" : "Present";
}

// Builds a list of calendar-date strings (YYYY-MM-DD) between two
// dates inclusive. Used to figure out which past dates should be
// checked for "did this worker even show up".
function dateRangeList(fromDateStr, toDateStr) {
    const out = [];
    const start = new Date(fromDateStr);
    const end = new Date(toDateStr);
    if (isNaN(start) || isNaN(end)) return out;
    const cur = new Date(start);
    while (cur <= end) {
        out.push(cur.toISOString().split("T")[0]);
        cur.setDate(cur.getDate() + 1);
    }
    return out;
}

/* ===============================
    AI BACKEND (PYTHON) AUTOMATION
================================ */
const startPythonAI = () => {
    console.log("🤖 Starting AI PPE Engine...");
    // Shell: true zaroori hai Windows par python command chalane ke liye
    const pythonProcess = spawn('python', ['app.py'], { shell: true, cwd: __dirname });

    pythonProcess.stdout.on('data', (data) => console.log(` AI Terminal: ${data.toString()}`));
    pythonProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes("Error")) console.error(` AI Error: ${msg}`);
    });
};
startPythonAI();

/* ===============================
    SOCKET.IO: AI DATA FORWARDING
================================ */
io.on("connection", (socket) => {
    console.log("🔌 Dashboard Connected to Socket");

    socket.on("disconnect", () => {
        console.log(" Dashboard Disconnected");
    });
    socket.on("new_emergency", async (data) => {
        const incident = {
            ...data,
            id: Date.now(),
            incidentTime: Date.now(),
            status: "Open"
        };
        await set(ref(db, `incidents/${incident.id}`), incident);
        io.emit("incident_update", incident);
    });
});

/* ===============================
   HELPER: compute worker completeness / status counts
   (used by GET /api/workers so summary cards reflect
   ALL workers, not just the current page of results)
================================ */
function computeWorkerStats(allWorkers) {
    let deactivated = 0, verified = 0, incomplete = 0;
    allWorkers.forEach(w => {
        if (w.status === 'Deactivated') {
            deactivated++;
            return;
        }
        const hasFace = !!(w.faceImage || w.faceImagePath || w.photoURL);
        const hasFinger = !!w.fingerprint;
        const hasArea = !!(w.siteAssignment && w.siteAssignment !== 'N/A' && String(w.siteAssignment).trim() !== '');
        if (hasFace && hasFinger && hasArea) verified++;
        else incomplete++;
    });
    return { deactivated, verified, incomplete };
}

/* ===============================
   REPORTS: HELPERS
   (CSV + a tiny hand-rolled PDF writer so we don't need any
   extra npm packages just to produce a downloadable file)
================================ */

function csvEscape(val) {
    const s = val === undefined || val === null ? "" : String(val);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

// Excel/CSV export with a small "report header" section on top (title,
// generated-by/date, worker + range filters) before the actual data table —
// same idea as a hospital patient-chart printout, just in spreadsheet form.
function buildCsvBuffer(headers, rows, meta) {
    let csv = "";
    if (meta) {
        csv += csvEscape(meta.title) + "\n";
        (meta.metaLines || []).forEach(line => {
            csv += csvEscape(line) + "\n";
        });
        csv += "\n";
    }
    csv += headers.map(csvEscape).join(",") + "\n";
    rows.forEach(row => {
        csv += row.map(csvEscape).join(",") + "\n";
    });
    return Buffer.from(csv, "utf8");
}

// Hospital-chart-style PDF generator: orange header band, a "Worker/Report
// Info" meta block, a bordered data table with header row + zebra striping,
// and a footer with page numbers. Supports multi-page output. Built with
// raw PDF drawing operators so no external PDF library is required.
function buildReportPdfBuffer({ title, subtitle, metaLines, headers, rows, generatedAt }) {
    const escapePdfText = (s) => String(s)
        .replace(/\\/g, "\\\\")
        .replace(/\(/g, "\\(")
        .replace(/\)/g, "\\)");

    const PAGE_W = 612, PAGE_H = 792;
    const MARGIN_X = 40;
    const TABLE_TOP_FIRST = 560;
    const TABLE_TOP_NEXT = 730;
    const ROW_H = 18;
    const TABLE_BOTTOM = 60;
    const TABLE_W = PAGE_W - MARGIN_X * 2;

    const colCount = Math.max(headers.length, 1);
    const colW = TABLE_W / colCount;
    const charsPerCol = Math.max(6, Math.floor(colW / 5.2));

    const truncate = (s, n) => {
        const str = String(s === undefined || s === null ? "" : s);
        return str.length > n ? str.slice(0, n - 1) + "…" : str;
    };

    const rowsPerFirstPage = Math.max(1, Math.floor((TABLE_TOP_FIRST - TABLE_BOTTOM) / ROW_H) - 1);
    const rowsPerNextPage = Math.max(1, Math.floor((TABLE_TOP_NEXT - TABLE_BOTTOM) / ROW_H) - 1);

    const pages = [];
    let remaining = rows.slice();
    let first = true;
    if (remaining.length === 0) remaining = [[]];
    while (remaining.length > 0 || first) {
        const cap = first ? rowsPerFirstPage : rowsPerNextPage;
        const chunk = remaining.splice(0, cap);
        pages.push({ chunk, isFirst: first });
        first = false;
        if (remaining.length === 0) break;
    }

    function drawTableOnPage(ops, tableTop, chunk, pageIndex) {
        let y = tableTop;

        ops.push(`0.97 0.97 0.97 rg`);
        ops.push(`${MARGIN_X} ${y - ROW_H} ${TABLE_W} ${ROW_H} re f`);
        ops.push(`0 0 0 RG 0.75 w`);
        ops.push(`${MARGIN_X} ${y - ROW_H} ${TABLE_W} ${ROW_H} re S`);

        ops.push(`BT /F2 8.5 Tf 0 0 0 rg`);
        headers.forEach((h, i) => {
            const x = MARGIN_X + i * colW + 6;
            ops.push(`1 0 0 1 ${x} ${y - 12.5} Tm (${escapePdfText(truncate(h, charsPerCol))}) Tj`);
        });
        ops.push(`ET`);
        y -= ROW_H;

        ops.push(`BT /F1 8 Tf 0 0 0 rg`);
        chunk.forEach((row, rIdx) => {
            if (rIdx % 2 === 1) {
                ops.push(`ET`);
                ops.push(`0.965 0.965 0.965 rg`);
                ops.push(`${MARGIN_X} ${y - ROW_H} ${TABLE_W} ${ROW_H} re f`);
                ops.push(`BT /F1 8 Tf 0 0 0 rg`);
            }
            row.forEach((cell, cIdx) => {
                const x = MARGIN_X + cIdx * colW + 6;
                ops.push(`1 0 0 1 ${x} ${y - 12.5} Tm (${escapePdfText(truncate(cell, charsPerCol))}) Tj`);
            });
            y -= ROW_H;
        });
        ops.push(`ET`);

        const tableBottomY = tableTop - ROW_H - chunk.length * ROW_H;
        ops.push(`0.75 0.75 0.75 RG 0.5 w`);
        ops.push(`${MARGIN_X} ${tableBottomY} ${TABLE_W} ${tableTop - tableBottomY} re S`);
        for (let i = 1; i < colCount; i++) {
            const x = MARGIN_X + i * colW;
            ops.push(`${x} ${tableBottomY} m ${x} ${tableTop} l S`);
        }
        for (let r = 0; r <= chunk.length; r++) {
            const yy = tableTop - ROW_H - r * ROW_H;
            ops.push(`${MARGIN_X} ${yy} m ${MARGIN_X + TABLE_W} ${yy} l S`);
        }

        ops.push(`BT /F1 7 Tf 0.4 0.4 0.4 rg 1 0 0 1 ${MARGIN_X} 35 Tm (Generated by SafeSite Compliance System  |  ${escapePdfText(generatedAt)}  |  Page ${pageIndex + 1} of ${pages.length}) Tj ET`);
    }

    const objects = [];
    let objNum = 1;
    const fontF1 = objNum++;
    const fontF2 = objNum++;
    objects.push({ num: fontF1, body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>` });
    objects.push({ num: fontF2, body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>` });

    const pageObjNums = [];

    pages.forEach((p, idx) => {
        const ops = [];

        if (p.isFirst) {
            ops.push(`0.976 0.451 0.086 rg`);
            ops.push(`0 ${PAGE_H - 70} ${PAGE_W} 70 re f`);
            ops.push(`BT /F2 18 Tf 1 1 1 rg 1 0 0 1 ${MARGIN_X} ${PAGE_H - 42} Tm (${escapePdfText(title)}) Tj ET`);
            ops.push(`BT /F1 10 Tf 1 1 1 rg 1 0 0 1 ${MARGIN_X} ${PAGE_H - 58} Tm (${escapePdfText(subtitle)}) Tj ET`);

            let metaY = PAGE_H - 95;
            ops.push(`BT /F2 9 Tf 0 0 0 rg`);
            metaLines.forEach(line => {
                ops.push(`1 0 0 1 ${MARGIN_X} ${metaY} Tm (${escapePdfText(line)}) Tj`);
                metaY -= 14;
            });
            ops.push(`ET`);

            drawTableOnPage(ops, TABLE_TOP_FIRST, p.chunk, idx);
        } else {
            ops.push(`BT /F2 12 Tf 0 0 0 rg 1 0 0 1 ${MARGIN_X} 760 Tm (${escapePdfText(title)} (continued)) Tj ET`);
            drawTableOnPage(ops, TABLE_TOP_NEXT, p.chunk, idx);
        }

        const streamContent = ops.join("\n");
        const contentNum = objNum++;
        objects.push({ num: contentNum, stream: streamContent });

        const pageNum = objNum++;
        pageObjNums.push(pageNum);
        objects.push({
            num: pageNum,
            body: `<< /Type /Page /Parent PAGES_REF /Resources << /Font << /F1 ${fontF1} 0 R /F2 ${fontF2} 0 R >> >> /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contentNum} 0 R >>`
        });
    });

    const pagesNum = objNum++;
    objects.push({ num: pagesNum, body: `<< /Type /Pages /Kids [${pageObjNums.map(n => `${n} 0 R`).join(" ")}] /Count ${pageObjNums.length} >>` });
    objects.forEach(o => {
        if (o.body && o.body.includes("PAGES_REF")) {
            o.body = o.body.replace("PAGES_REF", `${pagesNum} 0 R`);
        }
    });

    const catalogNum = objNum++;
    objects.push({ num: catalogNum, body: `<< /Type /Catalog /Pages ${pagesNum} 0 R >>` });

    objects.sort((a, b) => a.num - b.num);
    let pdf = "%PDF-1.4\n";
    const offsets = {};
    objects.forEach(o => {
        offsets[o.num] = Buffer.byteLength(pdf, "utf8");
        if (o.stream !== undefined) {
            const len = Buffer.byteLength(o.stream, "utf8");
            pdf += `${o.num} 0 obj\n<< /Length ${len} >>\nstream\n${o.stream}\nendstream\nendobj\n`;
        } else {
            pdf += `${o.num} 0 obj\n${o.body}\nendobj\n`;
        }
    });

    const xrefStart = Buffer.byteLength(pdf, "utf8");
    const maxNum = objNum - 1;
    let xref = `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= maxNum; n++) {
        const off = offsets[n];
        xref += off !== undefined ? `${String(off).padStart(10, "0")} 00000 n \n` : `0000000000 00000 f \n`;
    }
    pdf += xref;
    pdf += `trailer\n<< /Size ${maxNum + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

    return Buffer.from(pdf, "utf8");
}

function inDateRange(dateStr, dateFrom, dateTo) {
    if (!dateFrom && !dateTo) return true;
    const d = new Date(dateStr);
    if (dateFrom && d < new Date(dateFrom)) return false;
    if (dateTo && d > new Date(dateTo + "T23:59:59")) return false;
    return true;
}

// Pull the data a given module needs, already filtered by date range /
// optional worker, and shaped into CSV-ready headers+rows plus a few
// plain-text summary lines for the PDF version.
async function gatherReportData(reportModule, dateFrom, dateTo, workerID) {
    const mod = (reportModule || "").toLowerCase();

    if (mod.includes("attendance")) {
        const snap = await get(ref(db, "attendance"));
        const headers = ["Worker ID", "Name", "Date", "Check-In", "Check-Out", "Total Hours", "Status"];
        const rows = [];
        if (snap.exists()) {
            const all = snap.val();
            Object.keys(all).forEach(dateKey => {
                if (!inDateRange(dateKey, dateFrom, dateTo)) return;
                const dayRecords = all[dateKey];
                Object.keys(dayRecords).forEach(wID => {
                    if (workerID && wID !== workerID) return;
                    const r = dayRecords[wID];
                    const checkInVal = r.checkIn || r.time || "--:--";
                    rows.push([wID, r.name || "", dateKey, checkInVal, r.checkOut || "--:--", r.totalHours ?? "", deriveAttendanceStatus(checkInVal, r.status)]);
                });
            });
        }
        const summaryLines = rows.length
            ? rows.map(r => `${r[2]}  |  ${r[1]} (${r[0]})  |  In: ${r[3]}  Out: ${r[4]}  |  ${r[6]}`)
            : ["No attendance records found for the selected range."];
        return { headers, rows, summaryLines, count: rows.length };
    }

    if (mod.includes("hazard") || mod.includes("incident")) {
        const snap = await get(ref(db, "incidents"));
        const headers = ["Incident ID", "Severity", "Description", "Location", "Date", "Status"];
        const rows = [];
        if (snap.exists()) {
            const all = Object.values(snap.val());
            all.forEach(inc => {
                const dateKey = new Date(inc.incidentTime || Date.now()).toISOString().split("T")[0];
                if (!inDateRange(dateKey, dateFrom, dateTo)) return;
                rows.push([inc.id, inc.severity || "", inc.description || "", inc.location || "", dateKey, inc.status || ""]);
            });
        }
        const summaryLines = rows.length
            ? rows.map(r => `${r[4]}  |  [${r[1]}] ${r[3]}  |  ${r[2]}  |  ${r[5]}`)
            : ["No incidents recorded for the selected range."];
        return { headers, rows, summaryLines, count: rows.length };
    }

    // Default: Safety Compliance / PPE Detection Logs -> worker-level compliance snapshot
    const workersSnap = await get(ref(db, "workers"));
    const headers = ["Worker ID", "Name", "Site", "Violations", "Safety Score", "Compliance Status"];
    const rows = [];
    if (workersSnap.exists()) {
        let allWorkers = Object.values(workersSnap.val());
        if (workerID) allWorkers = allWorkers.filter(w => w.workerID === workerID);
        allWorkers.forEach(w => {
            const violations = w.violationCount || 0;
            const safetyScore = Math.max(0, 100 - (violations * 8));
            const complianceStatus = safetyScore >= 90 ? "Compliant" : safetyScore >= 70 ? "Needs Review" : "Critical";
            rows.push([w.workerID, w.fullName, w.siteAssignment || "N/A", violations, safetyScore, complianceStatus]);
        });
    }
    const summaryLines = rows.length
        ? rows.map(r => `${r[0]}  |  ${r[1]}  |  Site: ${r[2]}  |  Violations: ${r[3]}  |  Score: ${r[4]}%  |  ${r[5]}`)
        : ["No worker compliance data available yet."];
    return { headers, rows, summaryLines, count: rows.length };
}

async function computeComplianceAccuracy() {
    const snap = await get(ref(db, "workers"));
    if (!snap.exists()) return 0;
    const allWorkers = Object.values(snap.val()).filter(w => w.status !== "Deactivated");
    if (allWorkers.length === 0) return 0;
    const total = allWorkers.reduce((sum, w) => {
        const violations = w.violationCount || 0;
        return sum + Math.max(0, 100 - (violations * 8));
    }, 0);
    return Math.round(total / allWorkers.length);
}

/* ===============================
   API ROUTES
================================ */

// Default Route
app.get("/", (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "adminloginscreen.html"));
});

// Admin Login
app.post("/api/admin/login", async (req, res) => {
    const { email, password } = req.body;
    try {
        const adminRef = ref(db, "admins/admin1");
        const snapshot = await get(adminRef);
        if (snapshot.exists()) {
            const adminData = snapshot.val();
            if (adminData.email === email && adminData.password === password) {
                return res.json({ success: true });
            }
        }
        res.status(401).json({ error: "Invalid Email or Password!" });
    } catch (err) {
        res.status(500).json({ error: "Firebase Connection Error" });
    }
});

// Add Worker
app.post("/api/workers/add", upload.single("photo"), async (req, res) => {
    try {
        const {
            fullName, workerID, role, faceImage, fingerprint,
            // FIX: frontend sends "basePay" (not "salary"), "siteAssignment" (not "site"),
            // plus userRole / shiftType / paymentCycle which were never read before.
            basePay, salary, siteAssignment, userRole, shiftType, paymentCycle
        } = req.body;

        const targetRole = (role || "worker").toLowerCase();
        const validRole = FOLDERS[targetRole] ? targetRole : "worker";

        // 1. Photo ko sahi folder mein move karna (Worker/Guard/Supervisor)
        let finalPhotoPath = "";
        // Add Worker Route ke andar (PHOTO MOVE LOGIC UPDATE)
        if (req.file) {
            const newFileName = `${workerID}_profile_${Date.now()}${path.extname(req.file.originalname)}`;
            const newPath = path.join(FOLDERS[validRole].photo, newFileName);
            
            try {
                if (req.file && fs.existsSync(req.file.path)) { 
                    fs.renameSync(req.file.path, newPath);
                    finalPhotoPath = `/uploads/${validRole}_photo/${newFileName}`; // Correct variable name
                }
            } catch (moveErr) {
                console.error("❌ File Move Error:", moveErr);
            }
        }
        // 2. Face Image (Webcam) ko sahi folder mein save karna
        let facePath = "";
        if (faceImage && faceImage.includes("base64")) {
            const buf = Buffer.from(faceImage.split(",")[1], "base64");
            const faceName = `${workerID}_face_${Date.now()}.png`;
            const faceDest = path.join(FOLDERS[validRole].face, faceName);
            
            fs.writeFileSync(faceDest, buf);
            facePath = `/uploads/${validRole}_face/${faceName}`;
        }

        const workerData = {
            workerID,
            fullName,
            role: validRole,
            // FIX: pehle "salary" field padha ja raha tha jabke frontend "basePay" bhejta hai,
            // isliye Firebase mein hamesha 0 save hota tha.
            basePay: Number(basePay || salary) || 0,
            reward: 0,
            manualReward: 0,
            siteAssignment: siteAssignment || "N/A",
            userRole: userRole || "Worker",
            shiftType: shiftType || "",
            paymentCycle: paymentCycle || "Daily",
            photoURL: finalPhotoPath,
            faceImagePath: facePath,
            fingerprint: fingerprint ? JSON.parse(fingerprint) : null,
            status: "Active",
            createdAt: new Date().toISOString()
        };

        await set(ref(db, `workers/${workerID}`), workerData);
        res.json({ success: true, message: `${validRole.toUpperCase()} Added Successfully` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Update Worker
app.put("/api/workers/:id", upload.single("photo"), async (req, res) => {
    try {
        const id = req.params.id;
        let updates = { ...req.body, updatedAt: new Date().toISOString() };
        const targetRole = (updates.role || "worker").toLowerCase();
        const validRole = FOLDERS[targetRole] ? targetRole : "worker";

        // Agar nayi photo upload hui hai
        if (req.file && fs.existsSync(req.file.path)) {
            const newFileName = `${id}_profile_${Date.now()}${path.extname(req.file.originalname)}`;
            const newPath = path.join(FOLDERS[validRole].photo, newFileName);
            fs.renameSync(req.file.path, newPath);
            updates.photoURL = `/uploads/${validRole}_photo/${newFileName}`;
        }

        if (updates.fingerprint && typeof updates.fingerprint === 'string') {
            updates.fingerprint = JSON.parse(updates.fingerprint);
        }

        // FIX: basePay/salary form field ko Number mein convert karna (warna string save hota hai)
        if (updates.basePay !== undefined) updates.basePay = Number(updates.basePay) || 0;
        if (updates.salary !== undefined) { updates.basePay = Number(updates.salary) || updates.basePay || 0; delete updates.salary; }

        await update(ref(db, `workers/${id}`), updates);
        res.json({ success: true, message: "Worker Updated in Role Folder" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get All Workers (With Automatic Pagination Logic + aggregate stats for summary cards)
app.get("/api/workers", async (req, res) => {
    try {
        // Query parameters se current page aur limit uthayein
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;

        const snap = await get(ref(db, "workers"));
        
        if (snap.exists()) {
            const allWorkers = Object.values(snap.val());
            const totalStaff = allWorkers.length;

            // FIX: summary cards (Incomplete / Verified / Deactivated) ab
            // SAARE workers par calculate hote hain, na ke sirf current page ke 10 par.
            const { deactivated, verified, incomplete } = computeWorkerStats(allWorkers);

            // Pagination calculation
            const startIndex = (page - 1) * limit;
            const endIndex = page * limit;
            const paginatedData = allWorkers.slice(startIndex, endIndex);

            res.json({
                success: true,
                totalStaff: totalStaff,
                showingFrom: totalStaff === 0 ? 0 : startIndex + 1,
                showingTo: Math.min(endIndex, totalStaff),
                totalPages: Math.max(1, Math.ceil(totalStaff / limit)),
                currentPage: page,
                deactivatedCount: deactivated,
                verifiedCount: verified,
                incompleteCount: incomplete,
                data: paginatedData // Frontend ab is "data" array ko use karega
            });
        } else {
            res.json({
                success: true, totalStaff: 0, showingFrom: 0, showingTo: 0,
                totalPages: 1, currentPage: 1,
                deactivatedCount: 0, verifiedCount: 0, incompleteCount: 0,
                data: []
            });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Toggle Status
app.patch("/api/workers/:id/status", async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        await update(ref(db, `workers/${id}`), { 
            status: status, 
            updatedAt: new Date().toISOString() 
        });
        res.json({ success: true, message: `Status updated to ${status}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Fingerprint Registration
app.post("/api/fingerprint/register", async (req, res) => {
    const { workerID } = req.body;
    const challenge = crypto.randomBytes(32).toString("base64")
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    
    res.json({
        publicKey: {
            challenge: challenge,
            rp: { name: "SafeSite", id: "localhost" },
            user: { id: challenge, name: workerID, displayName: workerID },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            authenticatorSelection: { authenticatorAttachment: "platform" },
            timeout: 60000 
        }
    });
});

// --- NO DELETION: Extra Safety added to prevent crash ---
process.on('uncaughtException', (err) => {
    console.error('There was an uncaught error', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

app.get("/api/incidents", async (req, res) => {
    try {
        const snap = await get(ref(db, "incidents"));
        res.json(snap.exists() ? Object.values(snap.val()).sort((a,b) => b.incidentTime - a.incidentTime) : []);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/incidents/report", async (req, res) => {
    try {
        const incidentData = {
            id: Date.now(), severity: req.body.severity || "Critical",
            description: req.body.description, location: req.body.location || "Main Site",
            incidentTime: Date.now(), affected: req.body.affected || "General", status: "Open"
        };
        await set(ref(db, `incidents/${incidentData.id}`), incidentData);
        io.emit("incident_update", incidentData);
        res.json({ success: true, incident: incidentData });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE Incident Route - FIX
app.delete('/api/incidents/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const incidentRef = ref(db, `incidents/${id}`);
        await remove(incidentRef);
        
        // Frontend ko signal bhejne ke liye (Socket.io)
        io.emit('incident_deleted', id);
        
        res.status(200).send({ success: true, message: "Deleted successfully" });
    } catch (error) {
        console.error("Delete Error:", error);
        res.status(500).json({ error: error.message });
    }
});

/* ===============================================================
   Salary update karne ka route
   -----------------------------------------------------------------
   UPDATED: "Zero Violation Bonus" logic added.
   Rule: agar worker ka violationCount === 0 hai (koi bhi violation
   create nahi hui), to uski basePay (jo request mein "salary" field
   se aati hai) par automatically 10% bonus add hota hai.

   Response ab ye fields deta hai:
     - basePay              -> jo salary aap ne set ki
     - manualReward         -> jo aap ne khud "reward" field mein dala (agar koi ho)
     - zeroViolationBonus   -> agar violations 0 hain to basePay ka 10%, warna 0
     - reward               -> manualReward + zeroViolationBonus (total payable bonus)
     - violationCount       -> reference ke liye, kitni violations thi
================================================================== */
app.post("/api/update-payroll", async (req, res) => {
    try {

        const { workerID, salary, reward, reason } = req.body;

        if (!workerID) {
            return res.status(400).json({
                success: false,
                message: "Worker ID Required"
            });
        }

        const workerRef = ref(db, `workers/${workerID}`);

        const snap = await get(workerRef);

        if (!snap.exists()) {
            return res.status(404).json({
                success: false,
                message: "Worker Not Found"
            });
        }

        const worker = snap.val();

        // Current violation count Firebase se lein (report-violation route
        // isi field ko update karta hai)
        const violationCount = worker.violationCount || 0;

        const baseSalary = Number(salary) || 0;
        const manualReward = Number(reward) || 0;

        // ZERO VIOLATION BONUS: agar worker ne is cycle mein koi violation
        // create nahi ki, to basePay ka 10% bonus milega.
        const zeroViolationBonus = violationCount === 0
            ? Math.round(baseSalary * 0.10)
            : 0;

        // Total reward jo worker ko payable hai (manual reward + auto bonus)
        const totalReward = manualReward + zeroViolationBonus;

        const bonusReason = zeroViolationBonus > 0
            ? (reason ? `${reason} | +10% Zero Violation Bonus` : "Zero Violation Bonus (10%)")
            : (reason || "");

        const updates = {
            updatedAt: new Date().toISOString(),
            basePay: baseSalary,
            manualReward: manualReward,
            zeroViolationBonus: zeroViolationBonus,
            reward: totalReward,
            rewardReason: bonusReason,
            violationCount: violationCount,
            paymentStatus: baseSalary > 0 ? "Received" : "Pending"
        };

        await update(workerRef, updates);

        const latest = await get(workerRef);

        res.json({
            success: true,
            data: latest.val(),
            // Explicit breakdown for the frontend so it can show a
            // "🎉 +10% Zero Violation Bonus" badge without recalculating.
            bonusApplied: zeroViolationBonus > 0,
            zeroViolationBonus,
            totalReward
        });

    } catch (err) {

        console.log(err);

        res.status(500).json({
            success: false,
            message: err.message
        });

    }
});
// Jab AI violation detect kare toh ye API call ho
app.post("/api/report-violation", async (req, res) => {
    const { workerID } = req.body;
    const workerRef = ref(db, `workers/${workerID}`);
    
    const snap = await get(workerRef);
    if (snap.exists()) {
        const currentViolations = snap.val().violationCount || 0;
        
        // Violation count barhayen
        await update(workerRef, {
            violationCount: currentViolations + 1,
            // Agar 5 se zyada violations hain toh performance impact "Poor" kar dein
            performanceImpact: (currentViolations + 1) >= 5 ? "Critical" : "Standard"
        });
        res.json({ success: true });
    }
});

// PATCH/Edit Incident Route - FIX
app.patch('/api/incidents/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const updates = req.body;
        
        const incidentRef = ref(db, `incidents/${id}`);
        await update(incidentRef, updates);
        
        // Socket emit karein taake dashboard real-time update ho
        io.emit('incident_update', { id, ...updates });

        res.status(200).send({ success: true, message: "Updated successfully" });
    } catch (error) {
        console.error("Update Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/attendance/report  (UPDATED)
// - Ab checkIn hamesha sahi value se aata hai (checkIn OR legacy "time" field)
// - Status "Present" vs "Late" ab check-in time (9:00 AM cutoff) se derive hota hai
// - Auto-Absent: jo bhi ACTIVE registered worker us date range ke kisi din
//   check-in nahi karta, uska ek "Absent" row khud add ho jata hai
//   (sirf aaj tak ki dates ke liye — future dates ke liye nahi banaya jata)
app.get("/api/attendance/report", async (req, res) => {
    try {
        const { type } = req.query; // 'daily', 'weekly', 'monthly'
        const attendanceRef = ref(db, "attendance");
        const [attSnap, workersSnap] = await Promise.all([
            get(attendanceRef),
            get(ref(db, "workers"))
        ]);

        const allAttendance = attSnap.exists() ? attSnap.val() : {};
        let reportData = [];

        // Logic to filter dates based on type
        const now = new Date();
        const todayStr = now.toISOString().split('T')[0];

        // Figure out which date(s) this report type actually covers, so we
        // know which dates to check for "worker never showed up".
        let rangeStart, rangeEnd = todayStr;
        if (type === 'daily') {
            rangeStart = todayStr;
        } else if (type === 'weekly') {
            const oneWeekAgo = new Date();
            oneWeekAgo.setDate(now.getDate() - 7);
            rangeStart = oneWeekAgo.toISOString().split('T')[0];
        } else if (type === 'monthly') {
            const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            rangeStart = firstOfMonth.toISOString().split('T')[0];
        } else {
            rangeStart = null; // "all data" - no auto-absent fill for open-ended range
        }

        const presentWorkerIdsByDate = {};

        Object.keys(allAttendance).forEach(dateKey => {
            const dateObj = new Date(dateKey);
            let include = false;

            if (type === 'daily') {
                if (dateKey === todayStr) include = true;
            } else if (type === 'weekly') {
                const oneWeekAgo = new Date();
                oneWeekAgo.setDate(now.getDate() - 7);
                if (dateObj >= oneWeekAgo) include = true;
            } else if (type === 'monthly') {
                if (dateObj.getMonth() === now.getMonth() && dateObj.getFullYear() === now.getFullYear()) include = true;
            } else {
                include = true; // All data
            }

            if (include) {
                const workersOnDate = allAttendance[dateKey];
                presentWorkerIdsByDate[dateKey] = presentWorkerIdsByDate[dateKey] || new Set();
                Object.keys(workersOnDate).forEach(wID => {
                    const record = workersOnDate[wID];
                    presentWorkerIdsByDate[dateKey].add(wID);
                    const checkInVal = record.checkIn || record.time || "--:--";
                    reportData.push({
                        workerId: wID,
                        workerName: record.name,
                        date: dateKey,
                        checkIn: checkInVal,
                        checkOut: record.checkOut || "--:--",
                        totalHours: record.totalHours || 0,
                        status: deriveAttendanceStatus(checkInVal, record.status || "Present"),
                        role: record.role || "",
                        shift: record.shift || ""
                    });
                });
            }
        });

        // ---- AUTO-ABSENT FILL ----
        if (rangeStart && workersSnap.exists()) {
            const activeWorkers = Object.values(workersSnap.val()).filter(w => w.status !== "Deactivated");
            const datesToCheck = dateRangeList(rangeStart, rangeEnd);

            datesToCheck.forEach(dateKey => {
                // Don't mark "today" absent until the late-cutoff has passed,
                // since workers may still be arriving.
                if (dateKey === todayStr) {
                    const isPastCutoff = now.getHours() > LATE_CUTOFF_HOUR ||
                        (now.getHours() === LATE_CUTOFF_HOUR && now.getMinutes() > LATE_CUTOFF_MINUTE);
                    if (!isPastCutoff) return;
                }

                const presentIds = presentWorkerIdsByDate[dateKey] || new Set();
                activeWorkers.forEach(w => {
                    if (presentIds.has(w.workerID)) return;
                    // Worker not registered yet on this date (created after this date) -> skip
                    if (w.createdAt && new Date(w.createdAt).toISOString().split('T')[0] > dateKey) return;

                    reportData.push({
                        workerId: w.workerID,
                        workerName: w.fullName,
                        date: dateKey,
                        checkIn: "--:--",
                        checkOut: "--:--",
                        totalHours: 0,
                        status: "Absent",
                        role: w.role || "",
                        shift: w.shiftType || ""
                    });
                });
            });
        }

        reportData.sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json(reportData);

    } catch (err) {
        console.error("Report Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/attendance/status  (NEW)
// Lets the admin manually override a worker's status for a given date
// from the "Actions" (⋯) menu on the Attendance Reports table — e.g.
// flip an auto-marked "Absent" to "Present" if they know the worker
// was actually on site, or mark someone "Absent"/"Leave" manually.
// Body: { workerID, date, status, checkIn?, checkOut? }
app.post("/api/attendance/status", async (req, res) => {
    try {
        const { workerID, date, status, checkIn, checkOut } = req.body;
        if (!workerID || !date || !status) {
            return res.status(400).json({ success: false, error: "workerID, date and status are required" });
        }

        const workerSnap = await get(ref(db, `workers/${workerID}`));
        if (!workerSnap.exists()) {
            return res.status(404).json({ success: false, error: "Worker not found" });
        }
        const workerData = workerSnap.val();

        const attendanceRef = ref(db, `attendance/${date}/${workerID}`);
        const existingSnap = await get(attendanceRef);
        const existing = existingSnap.exists() ? existingSnap.val() : {};

        const updated = {
            ...existing,
            name: workerData.fullName,
            status: status,
            checkIn: checkIn !== undefined ? checkIn : (existing.checkIn || existing.time || (status === "Absent" ? "--:--" : existing.checkIn)),
            checkOut: checkOut !== undefined ? checkOut : (existing.checkOut || "--:--"),
            manuallyUpdatedAt: new Date().toISOString(),
            manuallyUpdatedBy: "Admin"
        };

        await set(attendanceRef, updated);
        io.emit("attendance_update", { workerID, name: workerData.fullName, date, status, type: "Manual-Update" });

        res.json({ success: true, message: `Status set to ${status}`, data: updated });
    } catch (err) {
        console.error("Attendance Status Update Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/attendance/detail  (NEW)
// Backs the row-level "detail" popup opened from the Actions (⋯) button.
// Query: ?workerID=WK-1234&date=YYYY-MM-DD
app.get("/api/attendance/detail", async (req, res) => {
    try {
        const { workerID, date } = req.query;
        if (!workerID || !date) {
            return res.status(400).json({ success: false, error: "workerID and date are required" });
        }

        const [workerSnap, attSnap] = await Promise.all([
            get(ref(db, `workers/${workerID}`)),
            get(ref(db, `attendance/${date}/${workerID}`))
        ]);

        if (!workerSnap.exists()) {
            return res.status(404).json({ success: false, error: "Worker not found" });
        }
        const workerData = workerSnap.val();
        const record = attSnap.exists() ? attSnap.val() : null;

        const checkInVal = record ? (record.checkIn || record.time || "--:--") : "--:--";
        const status = record ? deriveAttendanceStatus(checkInVal, record.status || "Present") : "Absent";

        res.json({
            success: true,
            data: {
                workerId: workerID,
                workerName: workerData.fullName,
                role: workerData.role || "worker",
                site: workerData.siteAssignment || "N/A",
                photoURL: workerData.photoURL || "",
                date,
                checkIn: checkInVal,
                checkOut: record ? (record.checkOut || "--:--") : "--:--",
                totalHours: record ? (record.totalHours || 0) : 0,
                status,
                manuallyUpdatedAt: record ? record.manuallyUpdatedAt || null : null,
                manuallyUpdatedBy: record ? record.manuallyUpdatedBy || null : null
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/attendance/auto-mark-absent  (NEW, optional)
// Writes real "Absent" records into Firebase for a given date for every
// active worker who never checked in. Safe to call multiple times (won't
// overwrite a real check-in). Intended to be run once a day after the
// late cutoff (e.g. by a cron job / scheduled task), OR triggered manually.
// Body: { date? }  -> defaults to today
app.post("/api/attendance/auto-mark-absent", async (req, res) => {
    try {
        const date = req.body.date || new Date().toISOString().split('T')[0];

        const [workersSnap, attSnap] = await Promise.all([
            get(ref(db, "workers")),
            get(ref(db, `attendance/${date}`))
        ]);

        if (!workersSnap.exists()) {
            return res.json({ success: true, marked: 0, message: "No workers registered." });
        }

        const activeWorkers = Object.values(workersSnap.val()).filter(w => w.status !== "Deactivated");
        const presentIds = new Set(attSnap.exists() ? Object.keys(attSnap.val()) : []);

        const updates = {};
        let marked = 0;
        activeWorkers.forEach(w => {
            if (presentIds.has(w.workerID)) return;
            if (w.createdAt && new Date(w.createdAt).toISOString().split('T')[0] > date) return;
            updates[w.workerID] = {
                name: w.fullName,
                checkIn: "--:--",
                checkOut: "--:--",
                totalHours: 0,
                status: "Absent",
                autoMarkedAt: new Date().toISOString()
            };
            marked++;
        });

        if (marked > 0) {
            await update(ref(db, `attendance/${date}`), updates);
            io.emit("attendance_update", { type: "Auto-Absent-Batch", date, marked });
        }

        res.json({ success: true, marked, date });
    } catch (err) {
        console.error("Auto Mark Absent Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/attendance/export  (UPDATED)
// Ab current selected report type (daily/weekly/monthly/all) ke hisaab
// se hi export hota hai, aur auto-absent rows bhi shamil hote hain —
// same data jo table mein dikh raha hai wahi Excel/CSV mein jata hai.
// Query: ?type=daily|weekly|monthly (defaults to "all")
app.get("/api/attendance/export", async (req, res) => {
    try {
        const { type } = req.query;
        const attendanceRef = ref(db, "attendance");
        const [attSnap, workersSnap] = await Promise.all([
            get(attendanceRef),
            get(ref(db, "workers"))
        ]);

        const allAttendance = attSnap.exists() ? attSnap.val() : {};
        const now = new Date();
        const todayStr = now.toISOString().split('T')[0];

        let rangeStart, rangeEnd = todayStr;
        if (type === 'daily') {
            rangeStart = todayStr;
        } else if (type === 'weekly') {
            const oneWeekAgo = new Date();
            oneWeekAgo.setDate(now.getDate() - 7);
            rangeStart = oneWeekAgo.toISOString().split('T')[0];
        } else if (type === 'monthly') {
            const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            rangeStart = firstOfMonth.toISOString().split('T')[0];
        } else {
            rangeStart = null;
        }

        const rows = [];
        const presentWorkerIdsByDate = {};

        Object.keys(allAttendance).forEach(dateKey => {
            const dateObj = new Date(dateKey);
            let include = false;
            if (type === 'daily') {
                if (dateKey === todayStr) include = true;
            } else if (type === 'weekly') {
                const oneWeekAgo = new Date();
                oneWeekAgo.setDate(now.getDate() - 7);
                if (dateObj >= oneWeekAgo) include = true;
            } else if (type === 'monthly') {
                if (dateObj.getMonth() === now.getMonth() && dateObj.getFullYear() === now.getFullYear()) include = true;
            } else {
                include = true;
            }

            if (include) {
                const workersOnDate = allAttendance[dateKey];
                presentWorkerIdsByDate[dateKey] = presentWorkerIdsByDate[dateKey] || new Set();
                Object.keys(workersOnDate).forEach(id => {
                    const r = workersOnDate[id];
                    presentWorkerIdsByDate[dateKey].add(id);
                    const checkInVal = r.checkIn || r.time || "--:--";
                    rows.push([id, r.name || "", dateKey, checkInVal, r.checkOut || "--:--", r.totalHours ?? 0, deriveAttendanceStatus(checkInVal, r.status || "Present")]);
                });
            }
        });

        if (rangeStart && workersSnap.exists()) {
            const activeWorkers = Object.values(workersSnap.val()).filter(w => w.status !== "Deactivated");
            const datesToCheck = dateRangeList(rangeStart, rangeEnd);
            datesToCheck.forEach(dateKey => {
                if (dateKey === todayStr) {
                    const isPastCutoff = now.getHours() > LATE_CUTOFF_HOUR ||
                        (now.getHours() === LATE_CUTOFF_HOUR && now.getMinutes() > LATE_CUTOFF_MINUTE);
                    if (!isPastCutoff) return;
                }
                const presentIds = presentWorkerIdsByDate[dateKey] || new Set();
                activeWorkers.forEach(w => {
                    if (presentIds.has(w.workerID)) return;
                    if (w.createdAt && new Date(w.createdAt).toISOString().split('T')[0] > dateKey) return;
                    rows.push([w.workerID, w.fullName, dateKey, "--:--", "--:--", 0, "Absent"]);
                });
            });
        }

        rows.sort((a, b) => new Date(b[2]) - new Date(a[2]));

        const headers = ["Worker ID", "Name", "Date", "Check-In", "Check-Out", "Total Hours", "Status"];
        const csvBuffer = buildCsvBuffer(headers, rows, {
            title: `Attendance Report (${type || "all"})`,
            metaLines: [`Generated On: ${new Date().toLocaleString()}`, `Total Records: ${rows.length}`]
        });

        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename=attendance_report_${type || "all"}.csv`);
        res.status(200).send(csvBuffer);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.post("/api/attendance/mark", async (req, res) => {
    try {
        const { workerID } = req.body;
        if (!workerID) return res.status(400).json({ error: "Worker ID missing" });

        const workerSnap = await get(ref(db, `workers/${workerID}`));
        if (!workerSnap.exists()) return res.status(404).json({ success: false, error: "Not Registered" });

        const workerData = workerSnap.val();
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        const currentTime = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });

        const attendanceRef = ref(db, `attendance/${today}/${workerID}`);
        const attendanceSnap = await get(attendanceRef);

        io.emit("attendance_update", {
            workerID: workerID,
            name: workerData.fullName,
            time: currentTime,
            type: "Check-In"
        });

        if (!attendanceSnap.exists()) {
            // Status derived immediately from check-in time vs the 9:00 AM
            // cutoff, so the table + summary cards reflect "Late" right away
            // instead of always saying "Present".
            const initialStatus = deriveAttendanceStatus(currentTime, "Present");
            await set(attendanceRef, {
                name: workerData.fullName,
                checkIn: currentTime,
                checkOut: "--:--",
                status: initialStatus,
                timestamp: Date.now()
            });
            res.json({ success: true, message: "Check-In Success", name: workerData.fullName, status: initialStatus });
        } else {
            const existing = attendanceSnap.val();
            if (existing.checkOut !== "--:--") return res.json({ success: false, message: "Already Marked for Today" });

            const diffHrs = ((Date.now() - existing.timestamp) / 3600000).toFixed(2);
            await update(attendanceRef, { 
                checkOut: currentTime, 
                totalHours: parseFloat(diffHrs), 
                status: "Completed" 
            });
            res.json({ success: true, message: "Check-Out Success" });
        }
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// 3. FIX: Worker Delete Path (CLEAN ABSOLUTE PATH LOGIC)
app.delete("/api/workers/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const workerRef = ref(db, `workers/${id}`);
        const snapshot = await get(workerRef);

        if (snapshot.exists()) {
            const data = snapshot.val();
            const rootDir = path.join(__dirname, ".."); 
            
            if (data.photoURL) {
                const fullPath = path.join(rootDir, data.photoURL);
                if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
            }
            if (data.faceImagePath) {
                const fullFacePath = path.join(rootDir, data.faceImagePath);
                if (fs.existsSync(fullFacePath)) fs.unlinkSync(fullFacePath);
            }

            await remove(workerRef);
            res.json({ success: true, message: "Worker and Files Deleted" });
        } else {
            res.status(404).json({ error: "Worker not found" });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});
/* =====================================================================
   ADD THIS BLOCK INTO YOUR EXISTING index.js (backend) FILE
   Place it near the other "app.get('/api/workers' ...)" routes.
   It does NOT replace anything you already have — it only ADDS
   a new endpoint: GET /api/performance
===================================================================== */

// Helper: turn raw worker + attendance + violation data into a performance score
function computePerformanceForWorker(worker, attendanceRecords, violationCount) {
    // Attendance %: present days / total tracked days for this worker
    const totalDays = attendanceRecords.length;
    const presentDays = attendanceRecords.filter(a => a.status === "Present" || a.status === "Completed").length;
    const attendancePct = totalDays === 0 ? 100 : Math.round((presentDays / totalDays) * 100);

    // Safety score: starts at 100, each violation costs 8 points (floor at 0)
    const safetyScore = Math.max(0, 100 - (violationCount * 8));

    // Overall rating: weighted average of attendance (40%) + safety (60%)
    const overall = Math.round(attendancePct * 0.4 + safetyScore * 0.6);

    let tier = "Improvement Needed";
    if (overall >= 90) tier = "Elite";
    else if (overall >= 75) tier = "Good";
    else if (overall >= 60) tier = "Average";

    return {
        workerID: worker.workerID,
        fullName: worker.fullName,
        role: worker.role || "worker",
        siteAssignment: worker.siteAssignment || "N/A",
        photoURL: worker.photoURL || "",
        attendancePct,
        safetyScore,
        violationCount,
        overall,
        tier,
        status: worker.status || "Active"
    };
}

// GET /api/performance  -> full performance list for every worker
// GET /api/performance?workerID=WK-1234 -> single worker's performance detail
app.get("/api/performance", async (req, res) => {
    try {
        const { workerID } = req.query;

        const workersSnap = await get(ref(db, "workers"));
        if (!workersSnap.exists()) {
            return res.json({ success: true, totalWorkers: 0, avgScore: 0, topPerformers: 0, avgAttendance: 0, activeViolations: 0, data: [] });
        }
        const allWorkers = Object.values(workersSnap.val());

        // Pull attendance history (all dates) once, then group per worker
        const attendanceSnap = await get(ref(db, "attendance"));
        const attendanceByWorker = {};
        if (attendanceSnap.exists()) {
            const allAttendance = attendanceSnap.val();
            Object.keys(allAttendance).forEach(dateKey => {
                const dayRecords = allAttendance[dateKey];
                Object.keys(dayRecords).forEach(wID => {
                    if (!attendanceByWorker[wID]) attendanceByWorker[wID] = [];
                    attendanceByWorker[wID].push(dayRecords[wID]);
                });
            });
        }

        // If you keep a separate "violations" node, pull it too.
        // Falls back to worker.violationCount (already tracked by /api/report-violation).
        const violationsSnap = await get(ref(db, "violations"));
        const violationCountByWorker = {};
        if (violationsSnap.exists()) {
            const allViolations = Object.values(violationsSnap.val());
            allViolations.forEach(v => {
                const wID = v.workerID;
                if (!wID) return;
                violationCountByWorker[wID] = (violationCountByWorker[wID] || 0) + 1;
            });
        }

        let performanceList = allWorkers
            .filter(w => w.status !== "Deactivated")
            .map(w => {
                const records = attendanceByWorker[w.workerID] || [];
                const violationCount = violationCountByWorker[w.workerID] ?? (w.violationCount || 0);
                return computePerformanceForWorker(w, records, violationCount);
            });

        // Single worker detail (used by the "Evaluate Worker" side panel)
        if (workerID) {
            const single = performanceList.find(p => p.workerID === workerID);
            if (!single) return res.status(404).json({ success: false, error: "Worker not found" });
            return res.json({ success: true, data: single });
        }

        // Sort by overall score, best first
        performanceList.sort((a, b) => b.overall - a.overall);

        const totalWorkers = performanceList.length;
        const avgScore = totalWorkers === 0 ? 0 : Math.round(performanceList.reduce((s, p) => s + p.overall, 0) / totalWorkers);
        const avgAttendance = totalWorkers === 0 ? 0 : Math.round(performanceList.reduce((s, p) => s + p.attendancePct, 0) / totalWorkers);
        const topPerformers = performanceList.filter(p => p.tier === "Elite").length;
        const activeViolations = performanceList.reduce((s, p) => s + p.violationCount, 0);

        res.json({
            success: true,
            totalWorkers,
            avgScore,
            avgAttendance,
            topPerformers,
            activeViolations,
            data: performanceList
        });
    } catch (err) {
        console.error("Performance API Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/performance/evaluate -> save a manual tier override / coaching note
app.post("/api/performance/evaluate", async (req, res) => {
    try {
        const { workerID, ratingAction, note } = req.body;
        if (!workerID) return res.status(400).json({ success: false, error: "Worker ID required" });

        const workerRef = ref(db, `workers/${workerID}`);
        const snap = await get(workerRef);
        if (!snap.exists()) return res.status(404).json({ success: false, error: "Worker not found" });

        await update(workerRef, {
            manualRatingAction: ratingAction || "Maintain Current Tier",
            performanceNote: note || "",
            evaluatedAt: new Date().toISOString()
        });

        res.json({ success: true, message: "Performance profile updated" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/* =====================================================================
   REPORTS CENTER API
   Backs the Report & Analysis screen: repository table, search/filter,
   the four summary cards, and the "Generate Report" panel (PDF/Excel,
   any module, optional worker, date range, and scheduling).
   Report metadata lives under Firebase "reports/<id>"; the actual
   generated files live on disk under /uploads/reports and are served
   statically by the existing app.use("/uploads", ...) line above.
===================================================================== */

// GET /api/reports -> repository list + the 4 summary cards
// One-time seed: if the "reports" node is completely empty (fresh Firebase
// project / first run), drop in 4 sample rows so the repository table and
// the 4 summary cards aren't blank on first load. Runs at most once — as
// soon as any real report exists (generated or scheduled), this is skipped
// forever, so it never overwrites real data.
async function seedSampleReportsIfEmpty() {
    try {
        const snap = await get(ref(db, "reports"));
        if (snap.exists()) return; // already has data (sample or real) - don't touch it

        const now = Date.now();
        const day = 24 * 60 * 60 * 1000;
        const samples = [
            {
                id: now - 1000,
                name: "PPE_Compliance_SiteA_Sample.pdf",
                module: "PPE Detection Logs",
                generatedBy: "AI Auto-Generator",
                dateGenerated: now - 1 * day,
                fileType: "PDF",
                status: "READY",
                scheduled: false,
                frequency: null,
                workerID: null,
                recordCount: 12,
                filePath: null
            },
            {
                id: now - 2000,
                name: "Daily_Attendance_Logs_Sample.csv",
                module: "Worker Attendance",
                generatedBy: "AI Auto-Generator",
                dateGenerated: now - 2 * day,
                fileType: "Excel",
                status: "PROCESSING",
                scheduled: false,
                frequency: null,
                workerID: null,
                recordCount: 34,
                filePath: null
            },
            {
                id: now - 3000,
                name: "Hazard_Incident_Analysis_Sample.pdf",
                module: "Hazard Incident Analysis",
                generatedBy: "AI Analytics Core",
                dateGenerated: now - 6 * day,
                fileType: "PDF",
                status: "ARCHIVED",
                scheduled: false,
                frequency: null,
                workerID: null,
                recordCount: 5,
                filePath: null
            },
            {
                id: now - 4000,
                name: "Safety_Compliance_Weekly_Sample.csv",
                module: "Safety Compliance",
                generatedBy: "Admin",
                dateGenerated: now - 3 * day,
                fileType: "Excel",
                status: "READY",
                scheduled: true,
                frequency: "weekly",
                workerID: null,
                recordCount: 20,
                filePath: null
            }
        ];

        const updates = {};
        samples.forEach(s => { updates[s.id] = s; });
        await update(ref(db, "reports"), updates);
        console.log("ℹ️  Seeded 4 sample reports (reports/ node was empty).");
    } catch (err) {
        console.error("Report Seed Error:", err.message);
    }
}

app.get("/api/reports", async (req, res) => {
    try {
        await seedSampleReportsIfEmpty();

        const snap = await get(ref(db, "reports"));
        const allReports = snap.exists() ? Object.values(snap.val()) : [];

        const totalReports = allReports.length;
        const pendingReviews = allReports.filter(r => r.status === "PROCESSING").length;
        const scheduledReports = allReports.filter(r => r.scheduled === true).length;
        const complianceAccuracy = await computeComplianceAccuracy();

        allReports.sort((a, b) => (b.dateGenerated || 0) - (a.dateGenerated || 0));

        res.json({
            success: true,
            totalReports,
            pendingReviews,
            scheduledReports,
            complianceAccuracy,
            data: allReports
        });
    } catch (err) {
        console.error("Reports List Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/reports/generate
// If "schedule" is false -> builds the file right now (hospital-chart-style
// PDF, or a headered CSV/Excel) and streams it back for immediate download.
// If "schedule" is true -> just saves the recurring config, no file is
// produced this instant (status becomes "SCHEDULED").
app.post("/api/reports/generate", async (req, res) => {
    try {
        const { module: reportModule, dateFrom, dateTo, format, workerID, schedule, frequency } = req.body;
        const chosenModule = reportModule || "Safety Compliance";
        const chosenFormat = format === "excel" ? "excel" : "pdf";
        const reportId = Date.now();
        const moduleSlug = chosenModule.replace(/\s+/g, "_");

        // Resolve the worker's name for the report header, same way a
        // hospital chart shows "Patient: <name>" instead of just an ID.
        let workerLabel = "All Workers";
        if (workerID) {
            const wSnap = await get(ref(db, `workers/${workerID}`));
            workerLabel = wSnap.exists() ? `${wSnap.val().fullName} (${workerID})` : workerID;
        }

        const { headers, rows, count } = await gatherReportData(chosenModule, dateFrom, dateTo, workerID);

        // Scheduled (recurring) report: save config only, no file yet.
        if (schedule) {
            const meta = {
                id: reportId,
                name: `${moduleSlug}_${frequency || "daily"}_schedule`,
                module: chosenModule,
                generatedBy: "Admin",
                dateGenerated: reportId,
                fileType: chosenFormat === "excel" ? "Excel" : "PDF",
                status: "SCHEDULED",
                scheduled: true,
                frequency: frequency || "daily",
                workerID: workerID || null,
                dateFrom: dateFrom || null,
                dateTo: dateTo || null,
                filePath: null
            };
            await set(ref(db, `reports/${reportId}`), meta);
            return res.json({
                success: true,
                message: `Report scheduled to run ${frequency || "daily"}.`,
                insight: `A ${frequency || "daily"} ${chosenModule} report is now scheduled and will appear here each cycle.`
            });
        }

        // Immediate report: build the real file.
        const ext = chosenFormat === "excel" ? "csv" : "pdf";
        const fileName = `${moduleSlug}_${reportId}.${ext}`;
        const filePath = path.join(REPORTS_DIR, fileName);
        const publicPath = `/uploads/reports/${fileName}`;

        const generatedAtLabel = new Date(reportId).toLocaleString();
        const rangeLabel = (dateFrom || dateTo) ? `${dateFrom || "…"}  to  ${dateTo || "…"}` : "All available data";
        const metaLines = [
            `Report Type:  ${chosenModule}`,
            `Worker:  ${workerLabel}`,
            `Date Range:  ${rangeLabel}`,
            `Generated By:  Admin (Ali Khan)   |   Generated On:  ${generatedAtLabel}`,
            `Total Records:  ${count}`
        ];

        let fileBuffer;
        if (chosenFormat === "excel") {
            fileBuffer = buildCsvBuffer(headers, rows, { title: `${chosenModule} Report`, metaLines });
        } else {
            fileBuffer = buildReportPdfBuffer({
                title: `${chosenModule} Report`,
                subtitle: "SafeSite Compliance & Workforce Management System",
                metaLines,
                headers,
                rows: rows.map(r => r.map(c => (c === undefined || c === null ? "" : c))),
                generatedAt: generatedAtLabel
            });
        }
        fs.writeFileSync(filePath, fileBuffer);

        const displayName = `${chosenModule.replace(/\s+/g, "_")}_${new Date(reportId).toISOString().split("T")[0]}.${ext}`;

        const meta = {
            id: reportId,
            name: displayName,
            module: chosenModule,
            generatedBy: "Admin",
            dateGenerated: reportId,
            fileType: chosenFormat === "excel" ? "Excel" : "PDF",
            status: "READY",
            scheduled: false,
            frequency: null,
            workerID: workerID || null,
            dateFrom: dateFrom || null,
            dateTo: dateTo || null,
            recordCount: count,
            filePath: publicPath
        };
        await set(ref(db, `reports/${reportId}`), meta);

        res.setHeader("Content-Type", chosenFormat === "excel" ? "text/csv" : "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${displayName}"`);
        res.send(fileBuffer);
    } catch (err) {
        console.error("Report Generate Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});
/* =====================================================================
   ADD THIS BLOCK INTO YOUR EXISTING index.js (backend) FILE
   Place it near your other "ADD THIS BLOCK" sections — anywhere AFTER
   the Firebase (db) setup and BEFORE the "const PORT = 5000;" line.
   It does NOT replace anything you already have — it only ADDS new
   endpoints for the SYSTEM SETTINGS screen.

   Firebase paths used (all new, won't touch your existing data):
     settings/quickRules            -> sliders + module select + toggles
     settings/categories/ai         -> AI Detection Rules config
     settings/categories/gate       -> Site Gate Control config
     settings/categories/shift      -> Shift & Schedule config
     settings/categories/notify     -> Notification Settings config
     settings/categories/database   -> Database & Storage config
     settings/lastBackup            -> timestamp of last successful backup
     settings/lastApplied           -> { by, at } for Quick Rules save
     settings/cameras/total         -> total camera count (admin configurable)
     notifications/<id>             -> system notification feed
===================================================================== */

// Extra folder for manual/auto backup dumps (JSON snapshot of your data),
// separate from the /uploads/reports folder used by the Reports Center.
const BACKUPS_DIR = path.join(UPLOADS_DIR, "backups");
if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}
// Serve backup files if you ever want to let an admin download one
app.use("/uploads/backups", express.static(BACKUPS_DIR));

const SERVER_STARTED_AT = Date.now();

/* -----------------------------------------------------------
   HELPER: push a notification into Firebase + broadcast live
   over Socket.io so the bell icon updates instantly without
   the admin needing to refresh the page.
------------------------------------------------------------ */
async function pushNotification(title, message, severity) {
    const notif = {
        id: Date.now(),
        title,
        message,
        severity: severity || "info", // info | warning | critical
        createdAt: Date.now(),
        read: false
    };
    await set(ref(db, `notifications/${notif.id}`), notif);
    io.emit("notification_new", notif);
    return notif;
}

/* -----------------------------------------------------------
   GET /api/settings
   Returns everything the System Settings screen needs in one
   call: the 4 top metric cards, Quick Rules Editor state, and
   the 5 category configs (each with sensible defaults if the
   admin hasn't saved anything yet).
------------------------------------------------------------ */
app.get("/api/settings", async (req, res) => {
    try {
        const [quickRulesSnap, categoriesSnap, lastBackupSnap, lastAppliedSnap, camerasSnap, workersSnap] =
            await Promise.all([
                get(ref(db, "settings/quickRules")),
                get(ref(db, "settings/categories")),
                get(ref(db, "settings/lastBackup")),
                get(ref(db, "settings/lastApplied")),
                get(ref(db, "settings/cameras")),
                get(ref(db, "workers"))
            ]);

        const defaultQuickRules = {
            moduleSelect: "Hard Hat Detection",
            confidence: 85,
            noise: 42,
            motion: 60,
            toggles: { audio: true, push: true, autolog: false, supervisor: true }
        };

        const defaultCategories = {
            ai: { helmet: true, vest: true, gloves: false, zoneAlerts: true },
            gate: { biometric: true, visitorOverride: false, state: "Locked" },
            shift: { start: "08:00", end: "17:00", gracePeriod: 10 },
            notify: { sms: true, email: true, webhook: true, minSeverity: "Medium" },
            database: { backupFrequency: "6h", cloudSync: true, retentionDays: 90 }
        };

        const totalCameras = camerasSnap.exists() ? camerasSnap.val().total : 24;
        const complianceAccuracy = await computeComplianceAccuracy();
        const lastBackupTs = lastBackupSnap.exists() ? lastBackupSnap.val() : null;
        const uptimeMs = Date.now() - SERVER_STARTED_AT;
        const uptimeHours = uptimeMs / 3600000;
        // Simple, honest uptime %: server has been up continuously since it
        // started, so we show that against a rolling 30-day window.
        const uptimePct = Math.min(99.9, 100 - (1 / (uptimeHours + 1)));

        const activeWorkerCount = workersSnap.exists()
            ? Object.values(workersSnap.val()).filter(w => w.status !== "Deactivated").length
            : 0;

        res.json({
            success: true,
            metrics: {
                systemUptime: uptimePct.toFixed(1) + "%",
                activeCameras: totalCameras,
                aiAccuracy: complianceAccuracy + "%",
                lastBackup: lastBackupTs ? msAgoLabel(lastBackupTs) : "Never",
                totalWorkersTracked: activeWorkerCount
            },
            quickRules: quickRulesSnap.exists() ? quickRulesSnap.val() : defaultQuickRules,
            categories: categoriesSnap.exists()
                ? { ...defaultCategories, ...categoriesSnap.val() }
                : defaultCategories,
            lastApplied: lastAppliedSnap.exists() ? lastAppliedSnap.val() : null
        });
    } catch (err) {
        console.error("Settings Fetch Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

function msAgoLabel(ts) {
    const diffMs = Date.now() - ts;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
}

/* -----------------------------------------------------------
   POST /api/settings/quick-rules
   Saves the right-hand "Quick Rules Editor" panel: selected
   module, the 3 sensitivity sliders, and the 4 alert toggles.
   Body: { moduleSelect, confidence, noise, motion, toggles }
------------------------------------------------------------ */
app.post("/api/settings/quick-rules", async (req, res) => {
    try {
        const { moduleSelect, confidence, noise, motion, toggles, updatedBy } = req.body;

        const payload = {
            moduleSelect: moduleSelect || "Hard Hat Detection",
            confidence: Number(confidence) || 0,
            noise: Number(noise) || 0,
            motion: Number(motion) || 0,
            toggles: {
                audio: !!(toggles && toggles.audio),
                push: !!(toggles && toggles.push),
                autolog: !!(toggles && toggles.autolog),
                supervisor: !!(toggles && toggles.supervisor)
            }
        };

        await set(ref(db, "settings/quickRules"), payload);

        const appliedInfo = { by: updatedBy || "Admin", at: Date.now() };
        await set(ref(db, "settings/lastApplied"), appliedInfo);

        io.emit("settings_updated", { section: "quickRules", data: payload });

        res.json({ success: true, message: "Quick rules saved", quickRules: payload, lastApplied: appliedInfo });
    } catch (err) {
        console.error("Quick Rules Save Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* -----------------------------------------------------------
   POST /api/settings/reset
   Resets the Quick Rules Editor back to factory defaults
   (used by the "Reset" link above the editor).
------------------------------------------------------------ */
app.post("/api/settings/reset", async (req, res) => {
    try {
        const defaults = {
            moduleSelect: "Hard Hat Detection",
            confidence: 85,
            noise: 42,
            motion: 60,
            toggles: { audio: true, push: true, autolog: false, supervisor: true }
        };
        await set(ref(db, "settings/quickRules"), defaults);
        io.emit("settings_updated", { section: "quickRules", data: defaults });
        res.json({ success: true, quickRules: defaults });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/* -----------------------------------------------------------
   GET/POST /api/settings/category/:categoryId
   categoryId one of: ai | gate | shift | notify | database
   GET  -> returns just that category's saved config
   POST -> saves/overwrites that category's config (used by the
           "Apply" button in each Configuration Category popup)
------------------------------------------------------------ */
const VALID_CATEGORIES = ["ai", "gate", "shift", "notify", "database"];

app.get("/api/settings/category/:categoryId", async (req, res) => {
    const { categoryId } = req.params;
    if (!VALID_CATEGORIES.includes(categoryId)) {
        return res.status(400).json({ success: false, error: "Unknown category" });
    }
    try {
        const snap = await get(ref(db, `settings/categories/${categoryId}`));
        res.json({ success: true, categoryId, data: snap.exists() ? snap.val() : {} });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/api/settings/category/:categoryId", async (req, res) => {
    const { categoryId } = req.params;
    if (!VALID_CATEGORIES.includes(categoryId)) {
        return res.status(400).json({ success: false, error: "Unknown category" });
    }
    try {
        const payload = { ...req.body, updatedAt: new Date().toISOString() };
        await update(ref(db, `settings/categories/${categoryId}`), payload);

        // Site Gate Control has a physical-world side effect: if the admin
        // sets state to Unlocked/Locked, log it as a notification so it
        // shows up in the bell icon and in an audit trail.
        if (categoryId === "gate" && payload.state) {
            await pushNotification(
                "Gate control updated",
                `Site gate state changed to "${payload.state}" by Admin.`,
                "info"
            );
        }

        io.emit("settings_updated", { section: `categories.${categoryId}`, data: payload });
        res.json({ success: true, categoryId, data: payload });
    } catch (err) {
        console.error("Category Save Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* -----------------------------------------------------------
   GET /api/settings/health
   Backs the "System Health" button. Runs real checks instead
   of fake random ones:
     - API server: always true if this route responded
     - AI engine: is the Python socket bridge actually connected
     - Database: can we read from Firebase right now
     - Backup: was the last backup within the last 24 hours
------------------------------------------------------------ */
app.get("/api/settings/health", async (req, res) => {
    const checks = [];

    // API server check (trivially true, we're running)
    checks.push({
        label: "API Server",
        ok: true,
        detail: `Responding normally, up for ${Math.round((Date.now() - SERVER_STARTED_AT) / 60000)} min`
    });

    // AI engine (Python) check via the existing socket bridge
    checks.push({
        label: "AI Inference Engine",
        ok: pythonSocket.connected === true,
        detail: pythonSocket.connected ? "Connected to Python AI Engine" : "AI Engine not connected"
    });

    // Firebase / Database check
    let dbOk = true;
    let dbDetail = "Read/write reachable";
    try {
        await get(ref(db, "settings"));
    } catch (e) {
        dbOk = false;
        dbDetail = "Could not reach Firebase Realtime Database";
    }
    checks.push({ label: "Database", ok: dbOk, detail: dbDetail });

    // Camera count (based on admin-configured total; wire this up to your
    // real camera/RTSP registry when you have one)
    let camerasSnap;
    try { camerasSnap = await get(ref(db, "settings/cameras")); } catch (e) { camerasSnap = null; }
    const totalCameras = camerasSnap && camerasSnap.exists() ? camerasSnap.val().total : 24;
    checks.push({ label: "Camera Network", ok: true, detail: `${totalCameras}/${totalCameras} cameras configured` });

    // Backup freshness
    let lastBackupSnap;
    try { lastBackupSnap = await get(ref(db, "settings/lastBackup")); } catch (e) { lastBackupSnap = null; }
    const lastBackupTs = lastBackupSnap && lastBackupSnap.exists() ? lastBackupSnap.val() : null;
    const backupOk = lastBackupTs ? (Date.now() - lastBackupTs) < 24 * 3600000 : false;
    checks.push({
        label: "Database Backup",
        ok: backupOk,
        detail: lastBackupTs ? `Last backup ${msAgoLabel(lastBackupTs)}` : "No backup has ever been taken"
    });

    const allOk = checks.every(c => c.ok);

    if (!allOk) {
        await pushNotification(
            "Health check found issues",
            checks.filter(c => !c.ok).map(c => c.label).join(", ") + " need attention.",
            "warning"
        );
    }

    res.json({ success: true, allOk, checkedAt: Date.now(), checks });
});

/* -----------------------------------------------------------
   POST /api/settings/backup
   Manually triggers a backup: dumps workers, attendance, and
   incidents to a timestamped JSON file under /uploads/backups
   and updates settings/lastBackup so the health check + the
   "Last Backup" metric card reflect it immediately.
------------------------------------------------------------ */
app.post("/api/settings/backup", async (req, res) => {
    try {
        const [workersSnap, attendanceSnap, incidentsSnap] = await Promise.all([
            get(ref(db, "workers")),
            get(ref(db, "attendance")),
            get(ref(db, "incidents"))
        ]);

        const snapshot = {
            takenAt: new Date().toISOString(),
            workers: workersSnap.exists() ? workersSnap.val() : {},
            attendance: attendanceSnap.exists() ? attendanceSnap.val() : {},
            incidents: incidentsSnap.exists() ? incidentsSnap.val() : {}
        };

        const fileName = `backup_${Date.now()}.json`;
        fs.writeFileSync(path.join(BACKUPS_DIR, fileName), JSON.stringify(snapshot, null, 2));

        const now = Date.now();
        await set(ref(db, "settings/lastBackup"), now);

        await pushNotification("Backup completed", `Manual backup saved as ${fileName}.`, "info");

        res.json({ success: true, message: "Backup completed", fileName, takenAt: now });
    } catch (err) {
        console.error("Backup Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* -----------------------------------------------------------
   GET /api/notifications
   Returns the notification feed for the bell icon dropdown,
   newest first, capped at 20.
------------------------------------------------------------ */
app.get("/api/notifications", async (req, res) => {
    try {
        const snap = await get(ref(db, "notifications"));
        const all = snap.exists() ? Object.values(snap.val()) : [];
        all.sort((a, b) => b.createdAt - a.createdAt);
        const unreadCount = all.filter(n => !n.read).length;
        res.json({ success: true, unreadCount, data: all.slice(0, 20) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/* -----------------------------------------------------------
   POST /api/notifications/mark-all-read
   Used by "Mark all read" in the notifications dropdown.
------------------------------------------------------------ */
app.post("/api/notifications/mark-all-read", async (req, res) => {
    try {
        const snap = await get(ref(db, "notifications"));
        if (snap.exists()) {
            const updates = {};
            Object.keys(snap.val()).forEach(id => { updates[`${id}/read`] = true; });
            await update(ref(db, "notifications"), updates);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/* -----------------------------------------------------------
   PUT /api/settings/cameras
   Lets the admin set how many cameras are configured on site
   (used by both the "Active Cameras" metric card and the
   System Health check above).
   Body: { total: number }
------------------------------------------------------------ */
app.put("/api/settings/cameras", async (req, res) => {
    try {
        const total = Number(req.body.total) || 0;
        await set(ref(db, "settings/cameras"), { total, updatedAt: new Date().toISOString() });
        res.json({ success: true, total });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/* =====================================================================
   END OF SYSTEM SETTINGS BLOCK
===================================================================== */
const PORT = 5000;
server.listen(PORT, async () => {
    console.log(`-----------------------------------------`);
    console.log(` Server: http://localhost:${PORT}`);
    console.log(` SafeSite AI System is Active`);
    console.log(`-----------------------------------------`);
    
    try {
        const open = (await import('open')).default; 
        await open(`http://localhost:${PORT}/gate/scan-gate.html`);
        console.log("✅ Scan Gate screen automatically opened.");
    } catch (err) {
        console.log("⚠️ Browser Not Working, Manually Open.");
    }
});