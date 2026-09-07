const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    })
  });
}

export default async function handler(req, res) {
  const db = admin.firestore();
  
  // Quét danh sách Token thiết bị của giáo viên đã lưu
  const usersSnap = await db.collection("users").get();
  const tokens = [];
  usersSnap.forEach(doc => { 
    if (doc.data().fcmToken) tokens.push(doc.data().fcmToken); 
  });

  if (tokens.length > 0) {
    // Bắn thông báo Push ngầm xuống thiết bị
    await admin.messaging().sendEachForMulticast({
      tokens: tokens,
      notification: { 
        title: "⏳ Đến giờ điểm danh!", 
        body: "Có lớp học đã bắt đầu quá 5 phút, vui lòng điểm danh và chấm công." 
      }
    });
  }
  
  res.status(200).json({ message: "Đã quét và gửi thông báo thành công" });
}