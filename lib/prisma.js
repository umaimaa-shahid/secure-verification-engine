const { PrismaClient } = require("@prisma/client");

if (!process.env.DATABASE_URL) {
	throw new Error("DATABASE_URL must be set to your Supabase PostgreSQL connection string");
}

const prisma = new PrismaClient();

module.exports = prisma;
