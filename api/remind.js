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

// Bộ lọc AI mini: Chuyển tên "Cô Minh Ngọc" thành "minhngoc" để khớp với account
function normalizeName(name) {
  if (!name) return "";
  return name.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Xóa dấu tiếng Việt
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]/g, "") // Xóa khoảng trắng
    .replace(/^(co|thay|gv)/, ""); // Xóa chữ cô, thầy
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

    // 1. Tải danh sách Token phân loại theo Account
    const usersSnap = await db.collection("users").get();
    const userTokens = {}; 
    usersSnap.forEach(doc => {
      const data = doc.data();
      if (data.fcmToken && data.email) {
        // Cắt đuôi email để lấy username (VD: baoloc@... -> baoloc)
        const username = data.email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, "");
        if (!userTokens[username]) userTokens[username] = [];
        userTokens[username].push(data.fcmToken);
      }
    });

    // Hàm lấy token đích danh của 1 giáo viên (Sử dụng so sánh chính xác 100%)
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

    // 2. QUÉT CHẤM CÔNG (Chỉ gửi đích danh giáo viên phụ trách)
    const classesSnap = await db.collection("classes").get();
    const classDocs = [];
    classesSnap.forEach(doc => classDocs.push({ id: doc.id, ...doc.data() }));

    classDocs.forEach(cls => {
      if (cls.teacherAttendance && cls.teacherAttendance[todayStr]) return;
      if (cls.schedule && Array.isArray(cls.schedule)) {
        cls.schedule.forEach(s => {
          if (s.day === currentDay && s.time) {
            const match = /^(\d{1,2}):(\d{2})/.exec(s.time.trim());
            if (!match) return;
            const startMinutes = Number(match[1]) * 60 + Number(match[2]);
            const elapsed = nowMinutes - startMinutes;
            
            let pushData = null;
            if ((elapsed >= 5 && elapsed < 10) || (elapsed >= 40 && elapsed < 45)) {
              pushData = { title: `⏳ Lớp ${cls.name} cần điểm danh!`, body: "⚠️ Lớp học đã bắt đầu xin hãy điểm danh học sinh và chấm công." };
            } else if (elapsed >= 45 && elapsed < 50) {
              pushData = { title: "🔴 CẢNH BÁO ĐỎ", body: `Lớp ${cls.name} đã học 45 phút chưa chấm công. Ghi nhận 1 lỗi vi phạm!` };
              if (s.teacher) {
                const recordKey = `${cls.id}_${todayStr}`;
                if (!teachersUpdate[s.teacher]) teachersUpdate[s.teacher] = { records: {} };
                teachersUpdate[s.teacher].records[recordKey] = { className: cls.name, date: todayStr, time: s.time };
              }
            }

            // Gửi báo động CHỈ cho tài khoản của giáo viên đó
            if (pushData && s.teacher) {
              const targets = getTokensForTeacher(s.teacher);
              targets.forEach(token => {
                messagesToSend.push({ token: token, notification: pushData });
              });
            }
          }
        });
      }
    });

    // 3. QUÉT THÔNG BÁO THÊM/XÓA HỌC SINH (Trong 5 phút qua)
    const fiveMinsAgo = Date.now() - 5 * 60 * 1000;
    const notifSnap = await db.collection("studentNotifications").where("createdAt", ">=", fiveMinsAgo).get();

    if (!notifSnap.empty) {
      // Tìm Token của tài khoản ngocanh
      const adminTokens = [];
      Object.keys(userTokens).forEach(uname => {
        if (uname === "ngocanh" || uname === "ngocanh@ducstar.edu") {
          adminTokens.push(...userTokens[uname]);
        }
      });

      notifSnap.forEach(doc => {
        const notif = doc.data();
        const actionText = notif.type === "removed" ? "➖ Học sinh nghỉ" : "➕ Học sinh mới";
        const bodyText = `${notif.className ? "Lớp " + notif.className + " · " : ""}Thực hiện bởi ${(notif.byUser || "?").split("@")[0]}`;

        // 3.1 Bắn thông báo cho quản lý (ngocanh) về TẤT CẢ biến động
        adminTokens.forEach(token => {
          messagesToSend.push({
            token: token,
            notification: { title: `${actionText}: ${notif.studentName}`, body: bodyText }
          });
        });

        // 3.2 Bắn thông báo ĐÍCH DANH cho Giáo viên chủ nhiệm của lớp đó
        if (notif.className) {
          const targetClass = classDocs.find(c => c.name.toLowerCase() === notif.className.trim().toLowerCase());
          if (targetClass && targetClass.schedule) {
            const teachers = new Set();
            targetClass.schedule.forEach(s => { if (s.teacher) teachers.add(s.teacher); });
            
            teachers.forEach(tName => {
              const targets = getTokensForTeacher(tName);
              targets.forEach(token => {
                messagesToSend.push({
                  token: token,
                  notification: { title: `${actionText}: ${notif.studentName}`, body: bodyText }
                });
              });
            });
          }
        }
      });
    }

    // 4. LƯU VI PHẠM & GỬI THÔNG BÁO TỔNG
    if (Object.keys(teachersUpdate).length > 0) {
      await db.collection("meta").doc("violations").set({ teachers: teachersUpdate }, { merge: true });
    }

    if (messagesToSend.length > 0) {
      await admin.messaging().sendEach(messagesToSend);
    }

    res.status(200).json({ message: "Đã phân luồng gửi thành công", msgs: messagesToSend.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
