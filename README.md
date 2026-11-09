# Smart AI-Based Construction Safety & Compliance Detection System

An intelligent Final Year Project (FYP) for real-time construction site safety monitoring using AI and Computer Vision.

This system automatically detects safety violations, ensures PPE compliance, and manages workers efficiently to reduce accidents on construction sites.

### Key Features
- **Live AI Monitoring:** Real-time video analysis for safety detection
- **PPE Compliance Detection:** Automatically detects Helmet, Safety Vest, and Safety Gear using YOLOv11
- **Violation Management:** Auto-logging of safety violations with evidence
- **Worker Attendance System:** Complete Worker Attendance & Management
- **Salary & Payroll Module:** Automated salary calculation
- **Admin Dashboard:** Analytics, reports, and live alerts
- **Cloud Database:** Real-time data syncing with Firebase

### Tech Stack
- **Frontend:** HTML5, CSS3, JavaScript
- **Backend:** Node.js, Express.js
- **AI / Computer Vision:** Python, YOLOv11, OpenCV
- **Database:** Firebase (Firestore / Realtime Database)
- **Other:** Git, GitHub, Firebase Authentication

### Project Structure
- `WorkerAttendanceSystem` - Worker management module
- `backend` - Server, APIs, and AI integration
- `public` - Frontend UI / Dashboard

### How to Run Locally
```bash
# Clone the repo
git clone https://github.com/savirakhan79/Smart-AI-Based-Construction-Safety-and-Compliance-Detection-System.git

# Install backend dependencies
cd backend
npm install
npm start
