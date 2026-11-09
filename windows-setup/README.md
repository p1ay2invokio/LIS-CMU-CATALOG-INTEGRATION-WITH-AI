# LIS CMU Catalog: ตัวติดตั้งสำหรับ Windows (กดครั้งเดียว)

## เตรียมบน Mac (ทำครั้งเดียว)
1. `cp config.example.ini config.ini` แล้วกรอก
   - `CLOUDFLARE_TOKEN`: เอามาจาก Cloudflare Zero Trust > Networks > Tunnels > (tunnel เดิม) > Configure > Install connector โดยก๊อปเฉพาะ token ยาวๆ ที่อยู่หลังคำว่า `service install`
   - `GEMINI_API_KEY` (ถ้าไม่กรอก build script จะดึงจาก `app/.env` ให้เอง)
2. เอาไฟล์ export ฐานข้อมูล (`.sql`) ไปวางใน `database/`
3. (ไม่บังคับ) วางไฟล์เว็บ PHP เช่น OpenBiblio ใน `htdocs/`
4. รัน `./build-setup.sh` (ดาวน์โหลดโปรแกรมตอนติดตั้งบน Windows) หรือ `./build-setup.sh --offline` (รวมตัวติดตั้งทุกตัวไว้ในไฟล์ zip เลย ขนาดประมาณ 250 MB)
5. จะได้ไฟล์ `dist/LIS-Catalog-Setup.zip`

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
| Cloudflare Tunnel | Windows Service `cloudflared` (ใช้ token อย่างเดียว ไม่ต้อง login) |

ใน Cloudflare Zero Trust ให้ตั้ง Public Hostname ของ tunnel ชี้ไปที่ `http://localhost:3001`

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
