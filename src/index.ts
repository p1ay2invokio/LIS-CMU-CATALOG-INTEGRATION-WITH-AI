import { prisma } from "../../app/lib/prisma"
import { Server } from 'socket.io'
import express from 'express'
import cors from 'cors'
import { createServer } from "node:http"
import jwt from 'jsonwebtoken'
import multer from 'multer'
import dotenv from 'dotenv'
import { GoogleGenAI } from '@google/genai'
import fs from 'fs'
import https from 'https'

let env = dotenv.config().parsed

const ai = new GoogleGenAI({ apiKey: env?.GEMINI_API_KEY })

const upload = multer({
  storage: multer.memoryStorage()
})

const httpsOptions = {
  key: fs.readFileSync("./cert/key.pem"),
  cert: fs.readFileSync("./cert/cert.pem"),
};

const app = express()
let server = https.createServer(app)
let io = new Server(server, {
  cors: {
    origin: "*"
  }
})

app.use(cors())
app.use(express.json())

app.get("/", (req, res) => {
  res.status(200).send({ message: "okay" })
})

/**
 * ตัดคำเลขเรียกหนังสือจากฟิลด์ 082 (DDC) ตามช่องว่าง
 * ตัวอย่าง: "959.351 ก27 ม.ป.ป"
 * -> call_nmbr1 = "959.351"
 * -> call_nmbr2 = "ก27"
 * -> call_nmbr3 = "ม.ป.ป" (หรือ 2560)
 * ถ้าไม่ได้กรอกตัวไหนให้ใส่ค่าว่าง ("")
 */
function parseCallNumberFrom082(raw082?: string | null) {
  const trimmed = (raw082 || "").trim()
  if (!trimmed) {
    return { call_nmbr1: "", call_nmbr2: "", call_nmbr3: "" }
  }
  const parts = trimmed.split(/\s+/)
  return {
    call_nmbr1: (parts[0] || "").slice(0, 20),
    call_nmbr2: (parts[1] || "").slice(0, 20),
    call_nmbr3: parts.length > 2 ? parts.slice(2).join(" ").slice(0, 20) : "",
  }
}

/**
 * ตัดคำลักษณะทางกายภาพจากฟิลด์ 300 ตามเครื่องหมาย ISBD (: และ ;)
 * ตัวอย่าง: "389 หน้า : ภาพประกอบ ; 22 ซม"
 * -> a: "389 หน้า" (จำนวนหน้า - 300 $a)
 * -> b: "ภาพประกอบ" (ภาพประกอบ/ลักษณะรูปเล่ม - 300 $b)
 * -> c: "22 ซม" (ขนาดตัวเล่ม - 300 $c)
 */
function parsePhysicalDescription(raw300?: string | null) {
  const trimmed = (raw300 || "").trim()
  if (!trimmed) {
    return { a: "", b: "", c: "" }
  }

  let a = ""
  let b = ""
  let c = ""

  if (trimmed.includes(";") && trimmed.includes(":")) {
    const colonIdx = trimmed.indexOf(":")
    const semiIdx = trimmed.indexOf(";")
    if (colonIdx < semiIdx) {
      a = trimmed.substring(0, colonIdx).trim()
      b = trimmed.substring(colonIdx + 1, semiIdx).trim()
      c = trimmed.substring(semiIdx + 1).trim()
    } else {
      a = trimmed.substring(0, semiIdx).trim()
      c = trimmed.substring(semiIdx + 1, colonIdx).trim()
      b = trimmed.substring(colonIdx + 1).trim()
    }
  } else if (trimmed.includes(":")) {
    const colonIdx = trimmed.indexOf(":")
    a = trimmed.substring(0, colonIdx).trim()
    b = trimmed.substring(colonIdx + 1).trim()
  } else if (trimmed.includes(";")) {
    const semiIdx = trimmed.indexOf(";")
    a = trimmed.substring(0, semiIdx).trim()
    c = trimmed.substring(semiIdx + 1).trim()
  } else {
    a = trimmed
  }

  return { a, b, c }
}

app.post("/login", async (req, res) => {

  let { student_id } = req.body

  let staff = await prisma.staff.findFirst({
    where: {
      username: student_id
    }
  })

  if (!staff) {
    return res.status(200).send({ logged: false, message: "Student ID is not correct!" })
  } else {
    const staffRole = typeof staff.role === "number" ? staff.role : Number(staff.role) || 0
    const payload = {
      userid: staff.userid,
      username: staff.username,
      first_name: staff.first_name,
      last_name: staff.last_name,
      role: staffRole,
      admin_flg: staff.admin_flg,
      catalog_flg: staff.catalog_flg,
    }
    let gen_jwt = jwt.sign(payload, "liscmubadboy", { expiresIn: '7d' })

    return res.status(200).send({
      logged: true,
      token: gen_jwt,
      role: staffRole,
      user: payload,
      message: "ok"
    })
  }
})

// Helper ตรวจสอบ JWT Token และดึงข้อมูลผู้ใช้งาน
function getAuthUser(req: express.Request): any | null {
  let token: string | undefined
  const authHeader = req.headers.authorization
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    token = authHeader.slice(7).trim()
  } else if (typeof req.query.token === "string") {
    token = req.query.token
  } else if (req.body && typeof req.body.token === "string") {
    token = req.body.token
  }

  if (!token) return null

  try {
    const decoded: any = jwt.verify(token, "liscmubadboy")
    return decoded
  } catch {
    return null
  }
}

// Middleware / Helper ตรวจสอบสิทธิ์เฉพาะ Role 1 (ผู้ดูแลระบบ)
function requireRole1(req: express.Request, res: express.Response): any | null {
  const user = getAuthUser(req)
  if (!user) {
    res.status(401).send({
      success: false,
      message: "กรุณาเข้าสู่ระบบก่อนทำรายการ (Unauthorized)"
    })
    return null
  }

  const role = Number(user.role)
  if (role !== 1) {
    res.status(403).send({
      success: false,
      message: "สิทธิ์ไม่เพียงพอ: เฉพาะผู้ใช้งาน Role 1 (ผู้ดูแลระบบ) เท่านั้นที่สามารถดำเนินการนี้ได้ (Forbidden)"
    })
    return null
  }

  return user
}

app.get('/collections', async (req, res) => {
  try {
    let collections = await prisma.collection_dm.findMany({
      orderBy: { code: 'asc' }
    })
    res.status(200).send(collections)
  } catch (error: any) {
    console.error("Error fetching collections:", error)
    res.status(500).send({ message: "Failed to fetch collections", error: error?.message })
  }
})

app.get('/materials', async (req, res) => {
  try {
    let materials = await prisma.material_type_dm.findMany({
      orderBy: { code: 'asc' }
    })
    res.status(200).send(materials)
  } catch (error: any) {
    console.error("Error fetching materials:", error)
    res.status(500).send({ message: "Failed to fetch materials", error: error?.message })
  }
})

app.get('/stats', async (req, res) => {
  try {
    const totalTitles = await prisma.biblio.count()
    const totalCopies = await prisma.biblio_copy.count()
    const pendingTitles = await prisma.biblio.count({
      where: { status: 'รอตรวจสอบ' }
    })
    const completedTitles = await prisma.biblio.count({
      where: { status: 'เสร็จสิ้น' }
    })

    // คำนวณจำนวนเล่มของรายการที่รอตรวจสอบ
    const pendingBiblios = await prisma.biblio.findMany({
      where: { status: 'รอตรวจสอบ' },
      select: { bibid: true }
    })
    const pendingBibids = pendingBiblios.map(b => b.bibid)
    const pendingCopies = await prisma.biblio_copy.count({
      where: { bibid: { in: pendingBibids } }
    })

    res.status(200).send({
      totalTitles,
      totalCopies,
      pendingTitles,
      pendingCopies,
      completedTitles,
    })
  } catch (error: any) {
    console.error("Error fetching stats:", error)
    res.status(500).send({ message: "Failed to fetch stats", error: error?.message })
  }
})

app.get('/books', async (req, res) => {
  try {
    let books = await prisma.biblio.findMany({
      orderBy: { bibid: 'desc' }
    })

    // ดึง ISBN จาก biblio_field (tag 20)
    let isbns = await prisma.biblio_field.findMany({
      where: { tag: 20, subfield_cd: 'a' }
    })
    let isbnMap = new Map(isbns.map(f => [f.bibid, f.field_data]))

    // ดึงประเภททรัพยากร
    let materials = await prisma.material_type_dm.findMany()
    let matMap = new Map(materials.map(m => [m.code, m.description]))

    // ดึง Copies ทั้งหมดของแต่ละ bibid
    let allCopies = await prisma.biblio_copy.findMany({
      orderBy: { copyid: 'asc' }
    })
    let copyMap = new Map<number, typeof allCopies>()
    for (const c of allCopies) {
      const arr = copyMap.get(c.bibid) || []
      arr.push(c)
      copyMap.set(c.bibid, arr)
    }

    let enrichedBooks = books.map((b) => {
      const bookCopies = copyMap.get(b.bibid) || []
      const barcodes = bookCopies.map(c => c.barcode_nmbr)
      return {
        ...b,
        status: b.status || "รอตรวจสอบ",
        isbn: isbnMap.get(b.bibid) || "-",
        category: matMap.get(b.material_cd) || "หนังสือ",
        copyCount: bookCopies.length,
        copies: bookCopies,
        barcodes: barcodes,
        barcode: barcodes[0] || "-",
      }
    })

    res.status(200).send(enrichedBooks)
  } catch (error: any) {
    console.error("Error fetching books:", error)
    res.status(500).send({ message: "Failed to fetch books", error: error?.message })
  }
})

// ตรวจสอบว่า ISBN มีอยู่ในฐานข้อมูลแล้วหรือไม่
app.get('/book/check-isbn', async (req, res) => {
  try {
    const rawIsbn = (req.query.isbn as string) || ''
    const cleanIsbn = rawIsbn.replace(/[-\s]/g, '').trim()

    if (!cleanIsbn) {
      return res.status(200).send({ exists: false })
    }

    // ดึงระเบียน tag 20 ทั้งหมด
    const isbnFields = await prisma.biblio_field.findMany({
      where: { tag: 20, subfield_cd: 'a' }
    })

    const matchedField = isbnFields.find(f => {
      const fClean = (f.field_data || '').replace(/[-\s]/g, '').trim()
      return fClean && fClean === cleanIsbn
    })

    if (!matchedField) {
      return res.status(200).send({ exists: false })
    }

    const existingBook = await prisma.biblio.findUnique({
      where: { bibid: matchedField.bibid }
    })

    if (!existingBook) {
      return res.status(200).send({ exists: false })
    }

    const copies = await prisma.biblio_copy.findMany({
      where: { bibid: existingBook.bibid },
      orderBy: { copyid: 'asc' }
    })

    const material = await prisma.material_type_dm.findUnique({
      where: { code: existingBook.material_cd }
    })

    const collection = await prisma.collection_dm.findUnique({
      where: { code: existingBook.collection_cd }
    })

    return res.status(200).send({
      exists: true,
      book: {
        ...existingBook,
        isbn: matchedField.field_data,
        material: material?.description || "หนังสือ",
        collection: collection?.description || "ทั่วไป",
        copyCount: copies.length,
        barcodes: copies.map(c => c.barcode_nmbr),
        copies,
      }
    })
  } catch (error: any) {
    console.error("Error checking ISBN:", error)
    return res.status(500).send({ exists: false, error: error?.message })
  }
})

// ดึงประวัติการลงรายการทรัพยากรสารสนเทศ (Cataloging History & Logs)
// Join biblio, biblio_copy, staff กรองตาม biblio_copy.staff_id = userid
app.get('/history', async (req, res) => {
  try {
    let targetUserId: number | null = null

    if (req.query.userid) {
      targetUserId = parseInt(String(req.query.userid), 10)
    } else if (req.headers.authorization) {
      try {
        const token = req.headers.authorization.replace(/^Bearer\s+/i, '')
        const decoded: any = jwt.verify(token, "liscmubadboy")
        if (decoded && decoded.userid) {
          targetUserId = Number(decoded.userid)
        }
      } catch (err) {
        // ignore invalid token
      }
    }

    if (!targetUserId || isNaN(targetUserId)) {
      return res.status(200).send({
        success: true,
        stats: {
          todayCount: 0,
          weekCount: 0,
          monthCount: 0,
          totalCount: 0,
          pendingCount: 0,
          completedCount: 0,
        },
        staffInfo: null,
        history: [],
      })
    }

    // Join biblio, biblio_copy, staff โดยดูว่า biblio_copy.staff_id ตรงกับ userid ที่ส่งมา
    const joinedRows: any[] = await prisma.$queryRawUnsafe(`
      SELECT 
        bc.bibid,
        bc.copyid,
        bc.create_dt AS copy_create_dt,
        bc.copy_desc,
        bc.barcode_nmbr,
        bc.status_cd,
        bc.staff_id,
        b.title,
        b.author,
        b.call_nmbr1,
        b.call_nmbr2,
        b.call_nmbr3,
        b.material_cd,
        b.collection_cd,
        b.status,
        b.create_dt AS biblio_create_dt,
        b.last_change_dt,
        s.userid AS staff_userid,
        s.username AS staff_username,
        s.last_name AS staff_name,
        s.first_name AS staff_firstname
      FROM biblio_copy bc
      INNER JOIN biblio b ON bc.bibid = b.bibid
      LEFT JOIN staff s ON bc.staff_id = s.userid
      WHERE bc.staff_id = ?
      ORDER BY bc.create_dt DESC, bc.copyid DESC
    `, targetUserId)

    const materials = await prisma.material_type_dm.findMany()
    const materialMap = new Map(materials.map(m => [m.code, m.description]))

    const collections = await prisma.collection_dm.findMany()
    const collectionMap = new Map(collections.map(c => [c.code, c.description]))

    const bibids = Array.from(new Set(joinedRows.map(r => r.bibid)))
    const isbnFields = bibids.length > 0 ? await prisma.biblio_field.findMany({
      where: { bibid: { in: bibids }, tag: 20, subfield_cd: 'a' }
    }) : []
    const isbnMap = new Map(isbnFields.map(f => [f.bibid, f.field_data]))

    const staffRecord = await prisma.staff.findUnique({
      where: { userid: targetUserId }
    })
    const staffInfo = staffRecord ? {
      userid: staffRecord.userid,
      username: staffRecord.username,
      name: staffRecord.last_name || staffRecord.username,
      firstName: staffRecord.first_name || "",
    } : null

    // คำนวณสถิติเฉพาะของ staff คนนี้
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const startOfWeek = new Date(now)
    startOfWeek.setDate(now.getDate() - now.getDay())
    startOfWeek.setHours(0, 0, 0, 0)
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

    let todayCount = 0
    let weekCount = 0
    let monthCount = 0
    let pendingCount = 0
    let completedCount = 0

    const historyItems = joinedRows.map(r => {
      const copyDate = new Date(r.copy_create_dt)
      if (copyDate >= startOfToday) todayCount++
      if (copyDate >= startOfWeek) weekCount++
      if (copyDate >= startOfMonth) monthCount++

      const itemStatus = r.status || "รอตรวจสอบ"
      if (itemStatus === "รอตรวจสอบ") pendingCount++
      if (itemStatus === "เสร็จสิ้น") completedCount++

      return {
        bibid: r.bibid,
        copyid: r.copyid,
        id: `B${String(r.bibid).padStart(3, '0')}`,
        copyBadge: `ฉบับที่ ${r.copyid}`,
        title: r.title || "ไม่มีชื่อเรื่อง",
        author: r.author || "-",
        isbn: isbnMap.get(r.bibid) || "-",
        callNumber: [r.call_nmbr1, r.call_nmbr2, r.call_nmbr3].filter(Boolean).join(" ") || "-",
        category: materialMap.get(r.material_cd) || "หนังสือ",
        collection: collectionMap.get(r.collection_cd) || "ทั่วไป",
        status: itemStatus,
        barcode: r.barcode_nmbr || "-",
        copyDesc: r.copy_desc || `ฉบับที่ ${r.copyid}`,
        staffId: r.staff_id,
        staffName: r.staff_name || r.staff_username || `เจ้าหน้าที่ (ID: ${r.staff_id})`,
        staffUsername: r.staff_username || "-",
        createDate: r.copy_create_dt,
        copyCreateDate: r.copy_create_dt,
        biblioCreateDate: r.biblio_create_dt,
      }
    })

    res.status(200).send({
      success: true,
      stats: {
        todayCount,
        weekCount,
        monthCount,
        totalCount: historyItems.length,
        pendingCount,
        completedCount,
      },
      staffInfo,
      history: historyItems,
    })
  } catch (error: any) {
    console.error("Error fetching catalog history:", error)
    res.status(500).send({ success: false, message: "Failed to fetch catalog history", error: error?.message })
  }
})

// ดึงข้อมูลรายละเอียดหนังสือรายเล่ม (Book Detail)
app.get('/book/:id', async (req, res) => {
  try {
    const bibid = parseInt(req.params.id, 10)
    if (isNaN(bibid)) {
      return res.status(400).send({ success: false, message: "รหัสหนังสือไม่ถูกต้อง (Invalid bibid)" })
    }

    const book = await prisma.biblio.findUnique({
      where: { bibid }
    })

    if (!book) {
      return res.status(404).send({ success: false, message: "ไม่พบข้อมูลหนังสือเล่มนี้ในระบบ" })
    }

    // ดึงข้อมูล MARC 21 จาก biblio_field
    const fields = await prisma.biblio_field.findMany({
      where: { bibid },
      orderBy: [{ tag: 'asc' }, { fieldid: 'asc' }]
    })

    // ดึงข้อมูลตัวเล่มทั้งหมด (Copies)
    const copies = await prisma.biblio_copy.findMany({
      where: { bibid },
      orderBy: { copyid: 'asc' }
    })

    // ดึงชื่อประเภททรัพยากร
    const material = await prisma.material_type_dm.findUnique({
      where: { code: book.material_cd }
    })

    // ดึงชื่อสถานที่จัดเก็บ/คอลเลกชัน
    const collection = await prisma.collection_dm.findUnique({
      where: { code: book.collection_cd }
    })

    // ดึงข้อมูลผู้บันทึก/แก้ไขล่าสุด
    const staffUser = await prisma.staff.findUnique({
      where: { userid: book.last_change_userid }
    })

    // ดึงรายชื่อ staff ทั้งหมดเพื่อแมปกับ staff_id ของแต่ละ copy
    const staffList = await prisma.staff.findMany()
    const staffMap = new Map(staffList.map(s => [s.userid, {
      name: s.last_name || s.username,
      username: s.username,
      firstName: s.first_name || '',
    }]))

    const enrichedCopies = copies.map(c => {
      const staffMember = c.staff_id ? staffMap.get(c.staff_id) : null
      return {
        ...c,
        staffName: staffMember?.name || (c.staff_id ? `เจ้าหน้าที่ (ID: ${c.staff_id})` : staffUser?.last_name || staffUser?.username || "-"),
        staffUsername: staffMember?.username || staffUser?.username || "-",
      }
    })

    // ตารางคำอธิบาย MARC 21 Tags
    const MARC_TAG_NAMES: Record<number, string> = {
      10: "LC Control Number (หมายเลขควบคุม LC)",
      20: "ISBN (เลขมาตรฐานสากลประจำหนังสือ)",
      50: "LC Call Number (เลขเรียกหนังสือรัฐสภาอเมริกัน)",
      82: "Dewey Call Number (เลขหมู่ดิวอี้ DDC)",
      100: "Main Entry - Personal Name (ผู้แต่งหลัก)",
      245: "Title Statement (ชื่อเรื่องและการแจ้งความรับผิดชอบ)",
      250: "Edition Statement (ครั้งที่พิมพ์)",
      260: "Publication, Distribution (ข้อมูลการพิมพ์)",
      300: "Physical Description (ลักษณะทางกายภาพ)",
      500: "General Note (หมายเหตุทั่วไป)",
      520: "Summary, etc. (บทคัดย่อ / สาระสังเขป)",
      650: "Subject Added Entry (หัวเรื่อง)",
      700: "Added Entry - Personal Name (ผู้แต่งร่วม)",
      902: "Cover Image (ภาพปก)",
    }

    const enrichedFields = fields.map(f => ({
      ...f,
      tagName: MARC_TAG_NAMES[f.tag] || `Tag ${f.tag}`,
    }))

    // สรุปข้อมูลสำหรับแสดงผล
    const getField = (tag: number, subfield = 'a') =>
      fields.find(f => f.tag === tag && f.subfield_cd === subfield)?.field_data || ''

    let rawPhysicalExtent = getField(300, 'a')
    let rawPhysicalFormat = getField(300, 'b')
    let rawPhysicalSize = getField(300, 'c')

    // ถ้าข้อมูลเดิมใน 300 $a ยังไม่ได้แยก subfield (มี : หรือ ;) และยังไม่มี $b หรือ $c ให้แยกคำอัตโนมัติสำหรับแสดงผล
    if ((!rawPhysicalFormat || !rawPhysicalSize) && (rawPhysicalExtent.includes(':') || rawPhysicalExtent.includes(';'))) {
      const parsed300 = parsePhysicalDescription(rawPhysicalExtent)
      if (parsed300.a) rawPhysicalExtent = parsed300.a
      if (!rawPhysicalFormat && parsed300.b) rawPhysicalFormat = parsed300.b
      if (!rawPhysicalSize && parsed300.c) rawPhysicalSize = parsed300.c
    }

    const marcData = {
      isbn: getField(20, 'a'),
      lcCallNumber: getField(50, 'a'),
      deweyCallNumber: getField(82, 'a') || [book.call_nmbr1, book.call_nmbr2, book.call_nmbr3].filter(Boolean).join(' ') || '',
      author: getField(100, 'a') || book.author || '',
      title: getField(245, 'a') || book.title || '',
      edition: getField(250, 'a'),
      publicationPlace: getField(260, 'a'),
      publisher: getField(260, 'b'),
      publicationYear: getField(260, 'c') || book.call_nmbr3 || '',
      physicalExtent: rawPhysicalExtent,
      physicalFormat: rawPhysicalFormat,
      physicalSize: rawPhysicalSize,
      summary: getField(520, 'a'),
      subjects: [
        book.topic1,
        book.topic2,
        book.topic3,
        book.topic4,
        book.topic5,
        ...fields.filter(f => f.tag === 650).map(f => f.field_data)
      ].filter(Boolean) as string[],
      coAuthors: fields.filter(f => f.tag === 700).map(f => f.field_data).filter(Boolean) as string[],
    }

    res.status(200).send({
      success: true,
      data: {
        ...book,
        material: material?.description || "หนังสือ",
        collection: collection?.description || "ทั่วไป",
        staffName: staffUser?.last_name || staffUser?.username || "ผู้ดูแลระบบ",
        copies: enrichedCopies,
        copyCount: enrichedCopies.length,
        barcodes: enrichedCopies.map(c => c.barcode_nmbr),
        fields: enrichedFields,
        marc: marcData,
      }
    })
  } catch (error: any) {
    console.error("Error fetching book detail:", error)
    res.status(500).send({ success: false, message: "เกิดข้อผิดพลาดในการดึงข้อมูลรายละเอียดหนังสือ", error: error?.message })
  }
})

app.post('/book', async (req, res) => {
  try {
    const body = req.body || {}
    const {
      title,
      author,
      resourceType,
      location,
      deweyCallNumber,
      callNumber,
      lcCallItem,
      lcCallClass,
      publicationYear,
      publicationPlace,
      publisher,
      edition,
      isbn,
      physicalExtent,
      physicalFormat,
      physicalSize,
      summary,
      subject1,
      subject2,
      coAuthor1,
      coAuthor2,
      showInOpac,
      userid,
      barcode_nmbr,
      copy_desc,
      copiesCount,
      copies,
      status,
    } = body

    if (!title || !author) {
      return res.status(400).send({
        success: false,
        message: "กรุณาระบุชื่อเรื่องและชื่อผู้แต่ง (title and author are required)"
      })
    }

    const now = new Date()
    const parsedMaterialCd = Number(resourceType) || 2
    const parsedCollectionCd = Number(location) || 2
    const parsedUserId = Number(userid) || 1
    const numCopies = Math.max(1, parseInt(copiesCount || copies || "1", 10) || 1)
    // เมื่อเพิ่มหนังสือเข้าไป สถานะการตรวจสอบจะเป็น "รอตรวจสอบ" เสมอ
    const bookStatus = "รอตรวจสอบ"

    // แยกเลขเรียกหนังสือจาก 082 ตามช่องว่าง (หรือใช้ค่าที่ส่งมาโดยตรง)
    // ตัวอย่าง: "959.351 ก27 ม.ป.ป" -> call_nmbr1 = "959.351", call_nmbr2 = "ก27", call_nmbr3 = "ม.ป.ป"
    // ถ้าไม่ได้กรอกตัวไหนให้ใส่ค่าว่าง
    const raw082 = (deweyCallNumber !== undefined && deweyCallNumber !== null)
      ? String(deweyCallNumber)
      : (callNumber !== undefined && callNumber !== null ? String(callNumber) : "")
    const parsedCallNumbers = parseCallNumberFrom082(raw082)

    const finalCall1 = body.call_nmbr1 !== undefined ? String(body.call_nmbr1 || "").slice(0, 20) : parsedCallNumbers.call_nmbr1
    const finalCall2 = body.call_nmbr2 !== undefined ? String(body.call_nmbr2 || "").slice(0, 20) : (parsedCallNumbers.call_nmbr2 || String(lcCallItem || lcCallClass || "").slice(0, 20))
    const finalCall3 = body.call_nmbr3 !== undefined ? String(body.call_nmbr3 || "").slice(0, 20) : parsedCallNumbers.call_nmbr3

    // 1. บันทึกลงตาราง biblio
    const newBiblio = await prisma.biblio.create({
      data: {
        create_dt: now,
        last_change_dt: now,
        last_change_userid: parsedUserId,
        material_cd: parsedMaterialCd,
        collection_cd: parsedCollectionCd,
        call_nmbr1: finalCall1,
        call_nmbr2: finalCall2,
        call_nmbr3: finalCall3,
        title: String(title),
        title_remainder: "",
        responsibility_stmt: "",
        author: String(author),
        topic1: subject1 ? String(subject1) : "",
        topic2: subject2 ? String(subject2) : "",
        topic3: "",
        topic4: "",
        topic5: "",
        opac_flg: showInOpac === false ? "N" : "Y",
        has_cover: "N",
        status: bookStatus,
      }
    })

    const bibid = newBiblio.bibid

    // 2. บันทึกลงตาราง biblio_field (MARC 21 Tags)
    // ยกเว้น 082, 100, 245, และ 650 เนื่องจากบันทึกเข้าฟิลด์ของตาราง biblio แล้ว (call_nmbr1-3, author, title, topic1-5)
    const fieldsToInsert: { tag: number; subfield_cd: string; field_data: string }[] = []

    if (edition) fieldsToInsert.push({ tag: 250, subfield_cd: "a", field_data: String(edition).trim() })
    if (isbn) fieldsToInsert.push({ tag: 20, subfield_cd: "a", field_data: String(isbn).trim() })
    if (lcCallItem || lcCallClass) fieldsToInsert.push({ tag: 50, subfield_cd: "a", field_data: String(lcCallItem || lcCallClass).trim() })
    if (publicationPlace) fieldsToInsert.push({ tag: 260, subfield_cd: "a", field_data: String(publicationPlace).trim() })
    if (publisher) fieldsToInsert.push({ tag: 260, subfield_cd: "b", field_data: String(publisher).trim() })
    // แยกข้อมูลลักษณะทางกายภาพ 300 เป็น $a, $b, $c ตามเครื่องหมาย : และ ; เช่น "389 หน้า : ภาพประกอบ ; 22 ซม"
    const parsed300 = parsePhysicalDescription(physicalExtent)
    const finalPhysicalExtent = parsed300.a
    const finalPhysicalFormat = String(physicalFormat || "").trim() || parsed300.b
    const finalPhysicalSize = String(physicalSize || "").trim() || parsed300.c

    if (finalPhysicalExtent) fieldsToInsert.push({ tag: 300, subfield_cd: "a", field_data: finalPhysicalExtent })
    if (finalPhysicalFormat) fieldsToInsert.push({ tag: 300, subfield_cd: "b", field_data: finalPhysicalFormat })
    if (finalPhysicalSize) fieldsToInsert.push({ tag: 300, subfield_cd: "c", field_data: finalPhysicalSize })
    if (summary) fieldsToInsert.push({ tag: 520, subfield_cd: "a", field_data: String(summary).trim() })
    if (coAuthor1) fieldsToInsert.push({ tag: 700, subfield_cd: "a", field_data: String(coAuthor1).trim() })
    if (coAuthor2) fieldsToInsert.push({ tag: 700, subfield_cd: "a", field_data: String(coAuthor2).trim() })

    for (let i = 0; i < fieldsToInsert.length; i++) {
      const f = fieldsToInsert[i]
      await prisma.biblio_field.create({
        data: {
          bibid,
          fieldid: i + 1,
          tag: f.tag,
          ind1_cd: "N",
          ind2_cd: "N",
          subfield_cd: f.subfield_cd,
          field_data: f.field_data,
        }
      })
    }

    // 3. บันทึกลงตาราง biblio_copy (สร้าง Copy ตามจำนวนที่ระบุ พร้อม Barcode อัตโนมัติ)
    const allCopies = await prisma.biblio_copy.findMany({ select: { barcode_nmbr: true } })
    let maxBarcode = 0
    for (const c of allCopies) {
      const num = parseInt(c.barcode_nmbr, 10)
      if (!isNaN(num) && num > maxBarcode) {
        maxBarcode = num
      }
    }

    const createdCopies = []
    for (let c = 1; c <= numCopies; c++) {
      let barcodeStr = ""
      if (c === 1 && barcode_nmbr) {
        barcodeStr = String(barcode_nmbr)
      } else {
        maxBarcode++
        barcodeStr = String(maxBarcode).padStart(3, '0')
      }

      const copyRecord = await prisma.biblio_copy.create({
        data: {
          bibid,
          copyid: c,
          create_dt: now,
          copy_desc: copy_desc ? (numCopies > 1 ? `${copy_desc} (ฉบับที่ ${c})` : String(copy_desc)) : (numCopies > 1 ? `ฉบับที่ ${c}` : ""),
          barcode_nmbr: barcodeStr,
          status_cd: "in",
          status_begin_dt: now,
          due_back_dt: null,
          mbrid: null,
          renewal_count: 0,
          staff_id: parsedUserId,
        }
      })
      createdCopies.push(copyRecord)
    }

    res.status(201).send({
      success: true,
      message: `ลงรายการหนังสือสำเร็จ (${numCopies} ฉบับ/เล่ม)`,
      bibid,
      copyCount: numCopies,
      barcodes: createdCopies.map(c => c.barcode_nmbr),
      barcode: createdCopies[0]?.barcode_nmbr,
      status: bookStatus,
      data: newBiblio,
    })
  } catch (error: any) {
    console.error("Error creating book:", error)
    res.status(500).send({
      success: false,
      message: "เกิดข้อผิดพลาดในการบันทึกข้อมูลลงฐานข้อมูล",
      error: error?.message,
    })
  }
})

// อัปเดตสถานะการตรวจสอบ (Verify/Approve Status - เฉพาะ Role 1)
app.patch('/book/:id/status', async (req, res) => {
  try {
    const authUser = requireRole1(req, res)
    if (!authUser) return

    const bibid = parseInt(req.params.id, 10)
    const { status } = req.body

    if (!status) {
      return res.status(400).send({ success: false, message: "Status is required" })
    }

    const updated = await prisma.biblio.update({
      where: { bibid },
      data: {
        status,
        last_change_dt: new Date(),
        last_change_userid: authUser.userid || 1,
      }
    })

    res.status(200).send({
      success: true,
      message: `อัปเดตสถานะเป็น "${status}" เรียบร้อยแล้ว`,
      data: updated
    })
  } catch (error: any) {
    console.error("Error updating book status:", error)
    res.status(500).send({ success: false, message: "Failed to update book status", error: error?.message })
  }
})

// เพิ่ม Copy ใหม่ให้กับหนังสือที่มีอยู่แล้ว
app.post('/book/:id/copy', async (req, res) => {
  try {
    const bibid = parseInt(req.params.id, 10)
    const now = new Date()

    const existingCopies = await prisma.biblio_copy.findMany({
      where: { bibid },
      orderBy: { copyid: 'desc' }
    })
    const nextCopyId = (existingCopies[0]?.copyid || 0) + 1

    const allCopies = await prisma.biblio_copy.findMany({ select: { barcode_nmbr: true } })
    let maxBarcode = 0
    for (const c of allCopies) {
      const num = parseInt(c.barcode_nmbr, 10)
      if (!isNaN(num) && num > maxBarcode) {
        maxBarcode = num
      }
    }
    const assignedBarcode = req.body.barcode_nmbr || String(maxBarcode + 1).padStart(3, '0')

    const newCopy = await prisma.biblio_copy.create({
      data: {
        bibid,
        copyid: nextCopyId,
        create_dt: now,
        copy_desc: req.body.copy_desc || `ฉบับที่ ${nextCopyId}`,
        barcode_nmbr: String(assignedBarcode),
        status_cd: "in",
        status_begin_dt: now,
        due_back_dt: null,
        mbrid: null,
        renewal_count: 0,
        staff_id: Number(req.body.userid) || 1,
      }
    })

    // อัปเดตข้อมูลการแก้ไขล่าสุดใน biblio
    const parsedCopyUserId = Number(req.body.userid) || 1
    await prisma.biblio.update({
      where: { bibid },
      data: {
        last_change_dt: now,
        last_change_userid: parsedCopyUserId,
      }
    })

    res.status(201).send({
      success: true,
      message: `เพิ่มตัวเล่มฉบับที่ ${nextCopyId} สำเร็จ (Barcode: ${assignedBarcode})`,
      copy: newCopy
    })
  } catch (error: any) {
    console.error("Error adding copy:", error)
    res.status(500).send({ success: false, message: "Failed to add copy", error: error?.message })
  }
})

// ลบหนังสือและตัวเล่มทั้งหมด (Delete Book & All Associated Copies - เฉพาะ Role 1)
app.delete('/book/:id', async (req, res) => {
  try {
    const authUser = requireRole1(req, res)
    if (!authUser) return

    const bibid = parseInt(req.params.id, 10)
    if (isNaN(bibid)) {
      return res.status(400).send({ success: false, message: "รหัสหนังสือไม่ถูกต้อง (Invalid bibid)" })
    }

    const existingBook = await prisma.biblio.findUnique({
      where: { bibid }
    })

    if (!existingBook) {
      return res.status(404).send({ success: false, message: "ไม่พบหนังสือที่ต้องการลบในระบบ" })
    }

    // นับจำนวน copy ที่จะถูกลบ
    const copyCount = await prisma.biblio_copy.count({
      where: { bibid }
    })

    // ลบข้อมูลที่เกี่ยวข้องทั้งหมด:
    // 1. biblio_hold (ถ้ามี)
    await prisma.biblio_hold.deleteMany({ where: { bibid } })

    // 2. biblio_copy (ตัวเล่ม/copies ทั้งหมด)
    const deletedCopies = await prisma.biblio_copy.deleteMany({ where: { bibid } })

    // 3. biblio_field (MARC Tags ทั้งหมด)
    await prisma.biblio_field.deleteMany({ where: { bibid } })

    // 4. biblio_status_hist (ลบผ่าน raw SQL เพราะตารางนี้ ignore ใน prisma)
    await prisma.$executeRawUnsafe("DELETE FROM biblio_status_hist WHERE bibid = ?", bibid).catch(() => { })

    // 5. biblio (หนังสือหลัก)
    await prisma.biblio.delete({ where: { bibid } })

    res.status(200).send({
      success: true,
      message: `ลบหนังสือ "${existingBook.title}" และตัวเล่ม (Copies) ทั้งหมด ${deletedCopies.count} เล่มเรียบร้อยแล้ว`,
      bibid,
      deletedCopiesCount: deletedCopies.count,
    })
  } catch (error: any) {
    console.error("Error deleting book:", error)
    res.status(500).send({
      success: false,
      message: "เกิดข้อผิดพลาดในการลบหนังสือ",
      error: error?.message,
    })
  }
})

// ลบตัวเล่มเฉพาะฉบับ (Delete Individual Copy - เฉพาะ Role 1)
app.delete('/book/:id/copy/:copyid', async (req, res) => {
  try {
    const authUser = requireRole1(req, res)
    if (!authUser) return

    const bibid = parseInt(req.params.id, 10)
    const copyid = parseInt(req.params.copyid, 10)

    if (isNaN(bibid) || isNaN(copyid)) {
      return res.status(400).send({
        success: false,
        message: "รหัสหนังสือหรือรหัสตัวเล่มไม่ถูกต้อง (Invalid bibid or copyid)"
      })
    }

    const existingCopy = await prisma.biblio_copy.findUnique({
      where: {
        bibid_copyid: { bibid, copyid }
      }
    })

    if (!existingCopy) {
      return res.status(404).send({
        success: false,
        message: "ไม่พบข้อมูลตัวเล่มที่ต้องการลบในระบบ"
      })
    }

    const existingBook = await prisma.biblio.findUnique({
      where: { bibid }
    })

    // ลบการจองที่เกี่ยวข้องกับตัวเล่มนี้ใน biblio_hold (ถ้ามี)
    await prisma.biblio_hold.deleteMany({
      where: { bibid, copyid }
    }).catch(() => { })

    // ลบประวัติสถานะใน biblio_status_hist (ถ้ามี)
    await prisma.$executeRawUnsafe("DELETE FROM biblio_status_hist WHERE bibid = ? AND copyid = ?", bibid, copyid).catch(() => { })

    // ลบตัวเล่มออกจาก biblio_copy
    await prisma.biblio_copy.delete({
      where: {
        bibid_copyid: { bibid, copyid }
      }
    })

    // ตรวจสอบจำนวนตัวเล่มที่เหลือของหนังสือเล่มนี้
    const remainingCopies = await prisma.biblio_copy.count({
      where: { bibid }
    })

    // ถ้าไม่มีตัวเล่ม (Copy) หลงเหลืออยู่แล้ว หมายความว่าไม่มีหนังสือนี้อยู่กับเราแล้ว ให้ลบ biblio และข้อมูลที่เกี่ยวข้องทั้งหมดออก
    if (remainingCopies === 0) {
      // ลบข้อมูลที่เกี่ยวข้องทั้งหมดของ biblio นี้
      await prisma.biblio_field.deleteMany({ where: { bibid } }).catch(() => { })
      await prisma.biblio_hold.deleteMany({ where: { bibid } }).catch(() => { })
      await prisma.$executeRawUnsafe("DELETE FROM biblio_status_hist WHERE bibid = ?", bibid).catch(() => { })
      await prisma.biblio.delete({ where: { bibid } }).catch(() => { })

      return res.status(200).send({
        success: true,
        message: `ลบตัวเล่มฉบับสุดท้าย (Barcode: ${existingCopy.barcode_nmbr}) เรียบร้อยแล้ว และได้ลบหนังสือ "${existingBook?.title || ''}" ออกจากระบบเนื่องจากไม่มีตัวเล่มคงเหลือ`,
        bibid,
        copyid,
        barcode: existingCopy.barcode_nmbr,
        bookDeleted: true,
        remainingCopies: 0,
      })
    }

    // ปรับปรุงเวลาแก้ไขล่าสุดของหนังสือในกรณีที่ยังมีตัวเล่มอื่นเหลืออยู่
    await prisma.biblio.update({
      where: { bibid },
      data: {
        last_change_dt: new Date(),
        last_change_userid: authUser.userid || 1,
      }
    }).catch(() => { })

    res.status(200).send({
      success: true,
      message: `ลบตัวเล่มฉบับที่ ${copyid} (Barcode: ${existingCopy.barcode_nmbr}) เรียบร้อยแล้ว`,
      bibid,
      copyid,
      barcode: existingCopy.barcode_nmbr,
      bookDeleted: false,
      remainingCopies,
    })
  } catch (error: any) {
    console.error("Error deleting book copy:", error)
    res.status(500).send({
      success: false,
      message: "เกิดข้อผิดพลาดในการลบตัวเล่ม",
      error: error?.message,
    })
  }
})

// แก้ไขข้อมูลบรรณานุกรมของหนังสือ (Edit Book - เฉพาะ Role 1)
app.put('/book/:id', async (req, res) => {
  try {
    const authUser = requireRole1(req, res)
    if (!authUser) return

    const bibid = parseInt(req.params.id, 10)
    if (isNaN(bibid)) {
      return res.status(400).send({ success: false, message: "รหัสหนังสือไม่ถูกต้อง (Invalid bibid)" })
    }

    const existingBook = await prisma.biblio.findUnique({
      where: { bibid }
    })

    if (!existingBook) {
      return res.status(404).send({ success: false, message: "ไม่พบหนังสือที่ต้องการแก้ไขในระบบ" })
    }

    const body = req.body || {}
    const {
      title,
      author,
      resourceType,
      location,
      deweyCallNumber,
      callNumber,
      lcCallItem,
      lcCallClass,
      publicationYear,
      publicationPlace,
      publisher,
      edition,
      isbn,
      physicalExtent,
      physicalFormat,
      physicalSize,
      summary,
      subject1,
      subject2,
      coAuthor1,
      coAuthor2,
      showInOpac,
      status,
    } = body

    if (!title || !author) {
      return res.status(400).send({
        success: false,
        message: "กรุณาระบุชื่อเรื่องและชื่อผู้แต่ง (title and author are required)"
      })
    }

    const now = new Date()
    const parsedMaterialCd = resourceType !== undefined ? (Number(resourceType) || existingBook.material_cd) : existingBook.material_cd
    const parsedCollectionCd = location !== undefined ? (Number(location) || existingBook.collection_cd) : existingBook.collection_cd
    const updatedStatus = status || existingBook.status

    // 1. จัดการเลขเรียกหนังสือจาก 082 ตามช่องว่าง (หรือใช้ค่าที่ส่งมาโดยตรง)
    let updatedCall1 = existingBook.call_nmbr1
    let updatedCall2 = existingBook.call_nmbr2
    let updatedCall3 = existingBook.call_nmbr3

    if (body.call_nmbr1 !== undefined || body.call_nmbr2 !== undefined || body.call_nmbr3 !== undefined) {
      if (body.call_nmbr1 !== undefined) updatedCall1 = String(body.call_nmbr1 || "").slice(0, 20)
      if (body.call_nmbr2 !== undefined) updatedCall2 = String(body.call_nmbr2 || "").slice(0, 20)
      if (body.call_nmbr3 !== undefined) updatedCall3 = String(body.call_nmbr3 || "").slice(0, 20)
    } else if (deweyCallNumber !== undefined || callNumber !== undefined) {
      const raw082 = deweyCallNumber !== undefined ? String(deweyCallNumber || "") : String(callNumber || "")
      const parsedCallNumbers = parseCallNumberFrom082(raw082)
      updatedCall1 = parsedCallNumbers.call_nmbr1
      updatedCall2 = parsedCallNumbers.call_nmbr2 || (lcCallItem !== undefined || lcCallClass !== undefined ? String(lcCallItem || lcCallClass || "").slice(0, 20) : "")
      updatedCall3 = parsedCallNumbers.call_nmbr3
    }

    // 1. อัปเดตตาราง biblio
    const updatedBiblio = await prisma.biblio.update({
      where: { bibid },
      data: {
        last_change_dt: now,
        last_change_userid: authUser.userid || 1,
        title: String(title),
        author: String(author),
        material_cd: parsedMaterialCd,
        collection_cd: parsedCollectionCd,
        call_nmbr1: updatedCall1,
        call_nmbr2: updatedCall2,
        call_nmbr3: updatedCall3,
        topic1: subject1 !== undefined ? String(subject1) : existingBook.topic1,
        topic2: subject2 !== undefined ? String(subject2) : existingBook.topic2,
        opac_flg: showInOpac !== undefined ? (showInOpac === false ? "N" : "Y") : existingBook.opac_flg,
        status: updatedStatus,
      }
    })

    // 2. อัปเดตตาราง biblio_field
    // ลบ MARC tags เดิมที่เกี่ยวข้องกับฟิลด์เหล่านี้ เพื่อเขียนค่าใหม่
    // ยกเว้น 082, 100, 245, 650 ตามเงื่อนไขของระบบ (เพราะบันทึกเข้าตาราง biblio แล้ว)
    const editableTags = [20, 50, 250, 260, 300, 520, 700]
    await prisma.biblio_field.deleteMany({
      where: {
        bibid,
        tag: { in: editableTags }
      }
    })

    // ตรวจสอบและลบ 082, 100, 245, 650 ที่อาจหลงเหลือใน biblio_field
    await prisma.biblio_field.deleteMany({
      where: {
        bibid,
        tag: { in: [82, 100, 245, 650] }
      }
    }).catch(() => {})

    // รวบรวมฟิลด์ใหม่ที่จะบันทึก
    const fieldsToInsert: { tag: number; subfield_cd: string; field_data: string }[] = []

    if (edition) fieldsToInsert.push({ tag: 250, subfield_cd: "a", field_data: String(edition).trim() })
    if (isbn) fieldsToInsert.push({ tag: 20, subfield_cd: "a", field_data: String(isbn).trim() })
    if (lcCallItem || lcCallClass) fieldsToInsert.push({ tag: 50, subfield_cd: "a", field_data: String(lcCallItem || lcCallClass).trim() })
    if (publicationPlace) fieldsToInsert.push({ tag: 260, subfield_cd: "a", field_data: String(publicationPlace).trim() })
    if (publisher) fieldsToInsert.push({ tag: 260, subfield_cd: "b", field_data: String(publisher).trim() })
    // แยกข้อมูลลักษณะทางกายภาพ 300 เป็น $a, $b, $c ตามเครื่องหมาย : และ ; เช่น "389 หน้า : ภาพประกอบ ; 22 ซม"
    const parsed300 = parsePhysicalDescription(physicalExtent)
    const finalPhysicalExtent = parsed300.a
    const finalPhysicalFormat = String(physicalFormat || "").trim() || parsed300.b
    const finalPhysicalSize = String(physicalSize || "").trim() || parsed300.c

    if (finalPhysicalExtent) fieldsToInsert.push({ tag: 300, subfield_cd: "a", field_data: finalPhysicalExtent })
    if (finalPhysicalFormat) fieldsToInsert.push({ tag: 300, subfield_cd: "b", field_data: finalPhysicalFormat })
    if (finalPhysicalSize) fieldsToInsert.push({ tag: 300, subfield_cd: "c", field_data: finalPhysicalSize })
    if (summary) fieldsToInsert.push({ tag: 520, subfield_cd: "a", field_data: String(summary).trim() })
    if (coAuthor1) fieldsToInsert.push({ tag: 700, subfield_cd: "a", field_data: String(coAuthor1).trim() })
    if (coAuthor2) fieldsToInsert.push({ tag: 700, subfield_cd: "a", field_data: String(coAuthor2).trim() })

    // หา fieldid สูงสุดเดิมที่มีอยู่
    const remainingFields = await prisma.biblio_field.findMany({
      where: { bibid },
      orderBy: { fieldid: 'desc' },
      take: 1
    })
    let currentFieldId = (remainingFields[0]?.fieldid || 0) + 1

    for (const f of fieldsToInsert) {
      await prisma.biblio_field.create({
        data: {
          bibid,
          fieldid: currentFieldId++,
          tag: f.tag,
          ind1_cd: "N",
          ind2_cd: "N",
          subfield_cd: f.subfield_cd,
          field_data: f.field_data,
        }
      })
    }

    res.status(200).send({
      success: true,
      message: `บันทึกการแก้ไขข้อมูลหนังสือ "${updatedBiblio.title}" เรียบร้อยแล้ว`,
      book: updatedBiblio,
    })
  } catch (error: any) {
    console.error("Error updating book:", error)
    res.status(500).send({
      success: false,
      message: "เกิดข้อผิดพลาดในการแก้ไขข้อมูลหนังสือ",
      error: error?.message,
    })
  }
})


app.post("/askai", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "ไม่พบไฟล์รูปภาพ (No image uploaded)" })
    }

    let sessionId = req.body.sessionId
    if (!sessionId) {
      return res.status(400).json({ success: false, message: "ไม่พบรหัสเซสชัน (sessionId is required)" })
    }

    const base64 = req.file.buffer.toString("base64")

    let response: any = await ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: [
        {
          inlineData: {
            mimeType: req.file.mimetype || 'image/jpeg',
            data: base64
          }
        },
        {
          text: `คุณคือผู้เชี่ยวชาญการลงรายการบรรณานุกรมตามมาตรฐาน MARC 21 ของห้องสมุด
จงอ่านข้อมูลจากภาพ (ซึ่งอาจเป็นหน้าปก หน้าปกใน หรือหน้าข้อมูลทางบรรณานุกรม CIP / ข้อมูลลิขสิทธิ์ของหนังสือ) อย่างละเอียด
โดยเฉพาะตัวอักษรขนาดเล็กและตัวเลขในกรอบข้อมูลทางบรรณานุกรม CIP

กรุณาสกัดข้อมูลและตอบกลับเป็น JSON เท่านั้นตามรูปแบบตัวอย่างนี้:
{
  "020": "9744840013",
  "050": "CB428",
  "082": "909.83",
  "100": "ชัยวัฒน์ คุประตกุล",
  "245": "ประวัติศาสตร์อนาคต",
  "250": "พิมพ์ครั้งที่ 2",
  "260_1": "กรุงเทพฯ",
  "260_2": "สารคดี",
  "260_3": "2545",
  "300": "192 หน้า",
  "650_1": "การเปลี่ยนแปลงทางสังคม",
  "650_2": "วิทยาศาสตร์ กับมนุษย์",
  "700_1": "-",
  "700_2": "-"
}
ใส่ให้ครบทุก tag ถ้าฟิลด์ใดมีหลายตัวให้ใส่ _ แล้วตามด้วยเลขตามตัวอย่าง (เช่น 260_1 สถานที่, 260_2 สำนักพิมพ์, 260_3 ปีพิมพ์, 650_1, 650_2, 700_1, 700_2)
หากหาข้อมูลใดไม่พบให้ใส่ค่า "-" หรือเว้นว่างไว้`
        }
      ],
      config: {
        responseMimeType: "application/json",
      }
    })

    let rawText = response.text ? response.text.trim() : "{}"
    if (rawText.startsWith("```json")) {
      rawText = rawText.replace(/^```json/, "").replace(/```$/, "").trim()
    } else if (rawText.startsWith("```")) {
      rawText = rawText.replace(/^```/, "").replace(/```$/, "").trim()
    }

    let data = JSON.parse(rawText)

    let provide = {
      data,
      useageToken: response.usageMetadata?.totalTokenCount || 0,
      model: response.modelVersion || 'gemini'
    }

    console.log("COME HERE")
    console.log(sessionId, provide)

    io.to(sessionId).emit("ai:answer", provide)

    res.status(200).send(provide)
  } catch (error: any) {
    console.error("Error in /askai:", error)
    res.status(500).send({
      success: false,
      message: "เกิดข้อผิดพลาดในการประมวลผลด้วย AI",
      error: error?.message || String(error)
    })
  }
})

io.on("connection", (socket) => {
  console.log(socket.id)

  // socket.on('')

  socket.on("computer-join-room", async (username) => {
    socket.join(username)
    ;(socket as any).roomName = username
    ;(socket as any).role = "computer"

    console.log(`[computer] ${socket.id} joined room ${username}`)

    socket.emit("computer-join-room:success", username)

    // Check if phone is already in room and inform computer
    try {
      const sockets = await io.in(username).fetchSockets()
      const hasPhone = sockets.some((s: any) => s.role === "phone")
      socket.emit("phone-status", { connected: hasPhone })
    } catch {
      // ignore
    }
  })

  socket.on("phone-join-room", (username) => {
    socket.join(username)
    ;(socket as any).roomName = username
    ;(socket as any).role = "phone"

    console.log(`[phone] ${socket.id} joined room ${username}`)

    socket.emit("phone-join-room:success", username)

    // แจ้งเตือนไปยังคอมพิวเตอร์ในห้องว่าโทรศัพท์เชื่อมต่อสำเร็จแล้ว
    io.to(username).emit("phone-connected", { username, socketId: socket.id })
  })

  socket.on("check-phone-status", async (username) => {
    try {
      const sockets = await io.in(username).fetchSockets()
      const hasPhone = sockets.some((s: any) => s.role === "phone")
      socket.emit("phone-status", { connected: hasPhone })
    } catch (e) {
      console.error("Error checking phone status:", e)
    }
  })

  socket.on("disconnect", async () => {
    console.log(`${socket.id} disconnect`)
    const room = (socket as any).roomName
    const role = (socket as any).role

    if (room && role === "phone") {
      try {
        const sockets = await io.in(room).fetchSockets()
        const hasOtherPhone = sockets.some((s: any) => s.role === "phone" && s.id !== socket.id)
        if (!hasOtherPhone) {
          io.to(room).emit("phone-disconnected", { room })
        }
      } catch {
        io.to(room).emit("phone-disconnected", { room })
      }
    }
  })
})

server.listen(3001, () => {
  console.log("Server is running on port 3001")
})