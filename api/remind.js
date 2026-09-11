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

function normalizeName(name) {
  if (!name) return "";
  return name.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") 
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]/g, "") 
    .replace(/^(co|thay|gv)/, ""); 
}

export default async function handler(req, res) {
  const db = admin.firestore();
  try {
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Ho_Chi_Minh"}));
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;
    
    const jsDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const currentDay = jsDays[now.getDay()];

    const usersSnap = await db.collection("users").get();
    const userTokens = {}; 
    usersSnap.forEach(doc => {
      const data = doc.data();
      if (data.fcmToken && data.email) {
        const username = data.email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, "");
        if (!userTokens[username]) userTokens[username] = [];
        userTokens[username].push(data.fcmToken);
      }
    });

    const getTokensForTeacher = (teacherName) => {
      const normName = normalizeName(teacherName);
      let tokens = [];
      Object.keys(userTokens).forEach(uname => {
        if (normName === uname) {
          tokens.push(...userTokens[uname]);
        }
      });
      return tokens;
    };

    const messagesToSend = [];
    let teachersUpdate = {};

    const classesSnap = await db.collection("classes").get();
    classesSnap.forEach(doc => {
      const cls = doc.data();
      if (cls.teacherAttendance && cls.teacherAttendance[todayStr]) return;
      
      if (cls.schedule && Array.isArray(cls.schedule)) {
        cls.schedule.forEach(s => {
          if (s.day === currentDay && s.time && s.teacher) {
            const match = /^(\d{1,2}):(\d{2})/.exec(s.time.trim());
            if (!match) return;
            const startMinutes = Number(match[1]) * 60 + Number(match[2]);
            const elapsed = nowMinutes - startMinutes;
            
            let pushData = null;
            if ((elapsed >= 5 && elapsed < 10) || (elapsed >= 40 && elapsed < 45)) {
              pushData = { 
                title: `⏳ Lớp ${cls.name} cần điểm danh!`, 
                body: "⚠️ Lớp học đã bắt đầu xin hãy điểm danh học sinh và chấm công (thông báo này chỉ hiện 2 lần sau 2 lần sẽ cảnh báo đỏ)" 
              };
            }
            else if (elapsed >= 45 && elapsed < 50) {
              pushData = { 
                title: "🔴 CẢNH BÁO ĐỎ", 
                body: `Lớp ${cls.name} đã học 45 phút chưa chấm công. Hệ thống đã tự động ghi nhận 1 lỗi vi phạm!` 
              };
              const recordKey = `${doc.id}_${todayStr}`;
              if (!teachersUpdate[s.teacher]) teachersUpdate[s.teacher] = { records: {} };
              teachersUpdate[s.teacher].records[recordKey] = { className: cls.name, date: todayStr, time: s.time };
            }

            if (pushData) {
              const targets = getTokensForTeacher(s.teacher);
              targets.forEach(token => {
                messagesToSend.push({ token: token, notification: pushData });
              });
            }
          }
        });
      }
    });

    const fiveMinsAgo = Date.now() - 5 * 60 * 1000;
    const notifSnap = await db.collection("studentNotifications").where("createdAt", ">=", fiveMinsAgo).get();

    if (!notifSnap.empty) {
      const adminTokens = [];
      Object.keys(userTokens).forEach(uname => {
        if (uname === "ngocanh" || uname === "ngocanh@ducstar.edu") {
          adminTokens.push(...userTokens[uname]);
        }
      });

      if (adminTokens.length > 0) {
        if (notifSnap.size > 3) {
          adminTokens.forEach(token => {
            messagesToSend.push({
              token: token,
              notification: { title: "🔄 Nhập liệu hàng loạt", body: `Hệ thống vừa ghi nhận ${notifSnap.size} học sinh mới/nghỉ được cập nhật.` }
            });
          });
        } else {
          notifSnap.forEach(doc => {
            const notif = doc.data();
            const actionText = notif.type === "removed" ? "➖ Học sinh nghỉ" : "➕ Học sinh mới";
            const bodyText = `${notif.className ? "Lớp " + notif.className + " · " : ""}Thực hiện bởi ${(notif.byUser || "?").split("@")[0]}`;
            adminTokens.forEach(token => {
              messagesToSend.push({ token: token, notification: { title: `${actionText}: ${notif.studentName}`, body: bodyText } });
            });
          });
        }
      }
    }

    if (Object.keys(teachersUpdate).length > 0) {
      await db.collection("meta").doc("violations").set({ teachers: teachersUpdate }, { merge: true });
    }

    if (messagesToSend.length > 0) {
      await admin.messaging().sendEach(messagesToSend); 
    }

    res.status(200).json({ message: "Hoàn tất", msgs: messagesToSend.length });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
