import "dotenv/config";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../generated/prisma/client";

const adapter = new PrismaMariaDb({
  // DB อยู่เครื่องเดียวกับ server (XAMPP) → ค่าเริ่มต้นใช้ 127.0.0.1 ไม่ต้องระบุ IP ตายตัว
  host: process.env.DATABASE_HOST || "127.0.0.1",
  port: Number(process.env.DATABASE_PORT) || 3306,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,

  charset: "utf8",
  
  connectionLimit: 5,
});
const prisma = new PrismaClient({ adapter });

export { prisma };