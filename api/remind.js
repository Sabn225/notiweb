const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    })
  });
}

export default async function handler(req, res) {
  const db = admin.firestore();
  try {
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Ho_Chi_Minh"}));
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;
    
    const jsDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const currentDay = jsDays[now.getDay()];
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    const classesSnap = await db.collection("classes").get();
    let pushData = null;
    let teachersUpdate = {};

    classesSnap.forEach(doc => {
      const cls = doc.data();
      if (cls.teacherAttendance && cls.teacherAttendance[todayStr]) return;

      if (cls.schedule && Array.isArray(cls.schedule)) {
        cls.schedule.forEach(s => {
          if (s.day === currentDay && s.time) {
            const match = /^(\d{1,2}):(\d{2})/.exec(s.time.trim());
            if (!match) return;
            const startMinutes = Number(match[1]) * 60 + Number(match[2]);
            const elapsed = nowMinutes - startMinutes;

            // Nhắc nhở mốc 5 phút và 40 phút (Hiện đúng 2 lần)
            if ((elapsed >= 5 && elapsed < 10) || (elapsed >= 40 && elapsed < 45)) {
              pushData = { 
                title: `⏳ Lớp ${cls.name} cần điểm danh!`, 
                body: "⚠️ Lớp học đã bắt đầu xin hãy điểm danh học sinh và chấm công (thông báo này chỉ hiện 2 lần sau 2 lần sẽ cảnh báo đỏ)" 
              };
            }
            // Cảnh báo đỏ mốc 45 phút và tự động lưu vi phạm
            else if (elapsed >= 45 && elapsed < 50) {
              pushData = { 
                title: "🔴 CẢNH BÁO ĐỎ", 
                body: `Lớp ${cls.name} đã học 45 phút chưa chấm công. Hệ thống đã tự động ghi nhận 1 lỗi vi phạm!` 
              };
              if (s.teacher) {
                const recordKey = `${doc.id}_${todayStr}`;
                if (!teachersUpdate[s.teacher]) teachersUpdate[s.teacher] = { records: {} };
                teachersUpdate[s.teacher].records[recordKey] = { className: cls.name, date: todayStr, time: s.time };
              }
            }
          }
        });
      }
    });

    if (!pushData) return res.status(200).json({ message: "Không có sự kiện" });

    if (Object.keys(teachersUpdate).length > 0) {
      await db.collection("meta").doc("violations").set({ teachers: teachersUpdate }, { merge: true });
    }

    const usersSnap = await db.collection("users").get();
    const tokens = [];
    usersSnap.forEach(doc => { if (doc.data().fcmToken) tokens.push(doc.data().fcmToken); });

    if (tokens.length > 0) {
      await admin.messaging().sendEachForMulticast({ tokens, notification: pushData });
    }

    res.status(200).json({ message: "Đã xử lý thông báo và cảnh báo", data: pushData });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
