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
    // 1. Lấy giờ Việt Nam và lùi lại 5 phút để tìm mốc giờ bắt đầu của lớp
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Ho_Chi_Minh"}));
    const targetTimeObj = new Date(now.getTime() - 5 * 60000);
    
    const dayIndex = targetTimeObj.getDay();
    const days = ["CN", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"]; 
    const currentDay = days[dayIndex];
    
    const targetHour = targetTimeObj.getHours().toString().padStart(2, '0');
    const targetMin = targetTimeObj.getMinutes().toString().padStart(2, '0');
    const targetTimeStr = `${targetHour}:${targetMin}`; // Ví dụ: "18:00"

    // 2. Quét các lớp học đang lưu trên Firestore
    const classesSnap = await db.collection("classes").get();
    let classesToRemind = [];

    classesSnap.forEach(doc => {
      const cls = doc.data();
      if (cls.schedule && Array.isArray(cls.schedule)) {
        // So khớp Thứ và Giờ (VD: Lịch ghi "18:00-19:30" sẽ khớp với "18:00")
        const match = cls.schedule.find(s => s.day === currentDay && (s.time || "").startsWith(targetTimeStr));
        if (match) {
          classesToRemind.push({ name: cls.name, teacher: match.teacher });
        }
      }
    });

    // Nếu không có lớp nào vừa bắt đầu 5 phút trước -> Bỏ qua
    if (classesToRemind.length === 0) {
      return res.status(200).json({ message: `Không có lớp nào bắt đầu lúc ${targetTimeStr} ${currentDay}.` });
    }

    // 3. CÓ LỚP! Bắt đầu lấy Token và bắn thông báo
    const usersSnap = await db.collection("users").get();
    const tokens = [];
    usersSnap.forEach(doc => { 
      if (doc.data().fcmToken) tokens.push(doc.data().fcmToken); 
    });

    if (tokens.length > 0) {
      const classNames = classesToRemind.map(c => c.name).join(", ");
      await admin.messaging().sendEachForMulticast({
        tokens: tokens,
        notification: { 
          title: "⏳ Đến giờ điểm danh!", 
          body: `Lớp ${classNames} đã bắt đầu được 5 phút. Thầy cô vào điểm danh nhé!` 
        }
      });
    }
    
    res.status(200).json({ message: "Đã gửi thông báo thành công", classes: classesToRemind });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
