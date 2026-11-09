# LIS CMU Catalog: ตัวติดตั้งสำหรับ Windows (กดครั้งเดียว)

## เตรียมบน Mac (ทำครั้งเดียว)
1. วางไฟล์ `.json` ของ Cloudflare Tunnel ไว้ในโฟลเดอร์ `cloudflared/`
   - ถ้าบน Mac มี `~/.cloudflared/<Tunnel-UUID>.json` อยู่แล้ว ตอนรัน `./build-setup.sh` สคริปต์จะก๊อปปี้มาใส่ใน `cloudflared/` ให้อัตโนมัติ
2. `cp config.example.ini config.ini` แล้วตรวจสอบค่า
   - `CLOUDFLARE_HOSTNAME`: โดเมนที่ใช้ชี้เข้า tunnel (ค่าเริ่มต้น `api.liscmu.online`)
   - `GEMINI_API_KEY` (ถ้าไม่กรอก build script จะดึงจาก `app/.env` ให้เอง)
   - `CLOUDFLARE_TOKEN`: เว้นว่างไว้ได้เลยเมื่อใช้ไฟล์ `.json` (หรือใส่เฉพาะกรณีต้องการใช้ Zero Trust token)
3. เอาไฟล์ export ฐานข้อมูล (`.sql`) ไปวางใน `database/`
4. (ไม่บังคับ) วางไฟล์เว็บ PHP เช่น OpenBiblio ใน `htdocs/`
5. รัน `./build-setup.sh` (ดาวน์โหลดโปรแกรมตอนติดตั้งบน Windows) หรือ `./build-setup.sh --offline` (รวมตัวติดตั้งทุกตัวไว้ในไฟล์ zip เลย ขนาดประมาณ 250 MB)
6. จะได้ไฟล์ `dist/LIS-Catalog-Setup.zip`

## บนเครื่อง Windows
1. แตกไฟล์ zip
2. **ดับเบิลคลิก `SETUP.bat`** แล้วกด Yes ตอนที่ระบบขอสิทธิ์ Admin
3. รอจนขึ้นข้อความ `SETUP COMPLETE`

หลังจากนั้นทุกอย่างจะเปิดเองอัตโนมัติทุกครั้งที่เปิดเครื่อง โดยไม่ต้อง login ก็ได้

| ส่วนประกอบ | ทำงานแบบ |
|---|---|
| MySQL (XAMPP 1.8.3) | Windows Service `mysql` |
| Apache (XAMPP) | Windows Service `Apache2.4` |
| Server (Bun, พอร์ต 3001) | Task Scheduler `LIS-Catalog-Server` (รันด้วยบัญชี SYSTEM และเปิดใหม่เองถ้าล่ม) |
| Cloudflare Tunnel | Windows Service `cloudflared` (ใช้ไฟล์ `.json` + `config.yml` ที่สร้างให้อัตโนมัติ ไม่ต้องใช้ Zero Trust และไม่ต้อง login) |

## จัดการหลังติดตั้ง (`C:\LISCatalog`)
- `STATUS.bat`: ดูสถานะของทุกส่วน และ log ล่าสุด
- `START.bat`, `STOP.bat`, `RESTART.bat`: เปิด ปิด หรือรีสตาร์ททุกส่วน
- log ของ server อยู่ที่ `C:\LISCatalog\logs\server.log`

## อัปเดตโค้ด
แก้โค้ดบน Mac แล้วรัน `./build-setup.sh` ใหม่ จากนั้นเอาไปแตกบน Windows แล้วกด `SETUP.bat` อีกครั้ง
ตัวติดตั้งจะข้ามขั้นตอนที่ทำไปแล้ว อัปเดตเฉพาะโค้ด และ**ไม่ import ฐานข้อมูลทับข้อมูลเดิม**

## หมายเหตุ
- ต้องใช้ Windows 10 (1809) ขึ้นไป แบบ 64-bit
- ต้องต่ออินเทอร์เน็ตตอนติดตั้ง เพราะต้องรัน `bun install`
- ถ้าพอร์ต 3306 หรือ 80 มีโปรแกรมอื่นใช้อยู่ ตัวติดตั้งจะแจ้งเตือน
- ถ้าตั้ง `DB_PASSWORD` ไว้ อย่าลืมแก้รหัสผ่านใน config ของ OpenBiblio ให้ตรงกันด้วย
