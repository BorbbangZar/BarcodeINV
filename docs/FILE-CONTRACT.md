# INVC Barcode File Contract v1

## ไฟล์งานจากระบบ INVC

ชื่อแนะนำ: `INVC-Barcode-Work-{batchId}.json`

```json
{
  "schema": "invc-barcode-work/v1",
  "batchId": "ค่าที่ไม่ซ้ำ",
  "exportedAt": "ISO-8601",
  "warehouse": "medicine",
  "warehouseLabel": "คลังยา",
  "operator": "ชื่อผู้ปฏิบัติงาน",
  "items": []
}
```

ฟิลด์สำคัญของแต่ละรายการ:

- `tradeRecordNumber` — DRUG_VN.RECORD_NUMBER
- `code` — WORKING_CODE
- `manufacturerCode` — MANUFAC_CODE ที่ใช้จับคู่บริษัทผู้ผลิต
- `packRatio` — PACK_RATIO ที่ใช้จับคู่ขนาดบรรจุ
- `currentBarcode` — ค่า BAR_CODE ณ เวลาส่งออก
- `lots` — รายการ INV_MD_C ที่ตรงกับรหัส ผู้ผลิต และขนาดบรรจุ

## ไฟล์ผลลัพธ์กลับเข้า INVC

```json
{
  "schema": "invc-barcode-result/v1",
  "batchId": "ต้องตรงกับไฟล์งาน",
  "warehouse": "medicine",
  "exportedAt": "ISO-8601",
  "resultCount": 1,
  "results": [
    {
      "tradeRecordNumber": 1001,
      "workingCode": "2000580",
      "manufacturerCode": "M0001",
      "packRatio": 1,
      "expectedBarcode": "",
      "newBarcode": "8851234567893",
      "scannedAt": "ISO-8601",
      "operator": "ผู้ทดสอบ"
    }
  ]
}
```

## กติกาฝั่งเว็บ INVC ก่อนอัปเดต

1. ตรวจ schema และ batchId
2. ตรวจ Barcode 8, 12 หรือ 13 หลักและ check digit
3. ตรวจ Barcode ไม่ซ้ำกับรายการอื่น
4. ตรวจ `tradeRecordNumber`, `workingCode`, `manufacturerCode` และ `packRatio` ตรงกับฐานข้อมูลปัจจุบัน
5. ตรวจ `expectedBarcode` ยังตรงกับค่าปัจจุบัน เพื่อป้องกันข้อมูลทับกัน
6. แสดง preview ค่าเดิมและค่าใหม่
7. อัปเดต DRUG_VN ระเบียนที่เลือก และ INV_MD_C ทุก Lot ที่ตรงตาม WORKING_CODE + MANUFAC_CODE + PACK_RATIO ภายใน transaction
8. บันทึก Audit log ผู้ใช้ เวลา Batch ID ค่าเดิมและค่าใหม่
