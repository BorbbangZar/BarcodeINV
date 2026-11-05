# INVC Barcode Workspace

หน้าเว็บ HTTPS สำหรับนำไฟล์งานจากระบบ INVC ไปสแกน Barcode บนมือถือ แล้วส่งไฟล์ผลลัพธ์กลับเข้าเว็บ INVC เดิมเพื่อตรวจสอบก่อนอัปเดต SQL Server

## หลักความปลอดภัย

- ไม่มี connection string, SQL credential หรือ API ภายในอยู่ใน repository
- ไฟล์รายการยาอ่านในเบราว์เซอร์และเก็บใน IndexedDB ของอุปกรณ์เท่านั้น
- ภาพจากกล้องประมวลผลในอุปกรณ์ด้วย BarcodeDetector หรือ ZXing
- ส่งออกเฉพาะรายการที่ Barcode เปลี่ยนแปลง
- การตรวจซ้ำและเขียน SQL ต้องเกิดในเว็บ INVC ภายในองค์กร

## ทดสอบ

1. เปิดเว็บผ่าน HTTPS หรือ localhost
2. กด `นำเข้าไฟล์งาน`
3. เลือก `examples/INVC-Barcode-Work-Sample.json`
4. เปิดการ์ดรายการแล้วสแกนหรือกรอก Barcode ที่ check digit ถูกต้อง
5. กด `ส่งออกผล`

## GitHub Pages

เผยแพร่จาก branch `main` และ directory `/ (root)` หน้าเว็บใช้ path แบบ relative จึงทำงานได้ทั้งโดเมนหลักและ project site

## ไฟล์แลกเปลี่ยน

รายละเอียดอยู่ใน [docs/FILE-CONTRACT.md](docs/FILE-CONTRACT.md)
