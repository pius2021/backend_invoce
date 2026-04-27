import express from "express";
import multer from "multer";
import fs from "fs";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import mime from "mime";
import Lens from "chrome-lens-ocr";
import { pdf } from "pdf-to-img";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createWorker } from "tesseract.js";
import { createCanvas } from "canvas";
import { createRequire } from "module";

import mysql from "mysql2/promise";
import cors from "cors";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

// MySQL connection
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 3306
};

// Ensure uploads directory exists
const UPLOAD_DIR = "/tmp/uploads/";
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

const upload = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (ALLOWED_TYPES.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported file type: ${file.mimetype}`), false);
        }
    },
});

// AI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function safeUnlink(filePath) {
    try { fs.unlinkSync(filePath); } catch (_) {}
}

const SYSTEM_INSTRUCTION = `You are an AI system designed to extract structured data from invoices.
Analyze the uploaded invoice carefully and extract ONLY the required fields listed below. 
Return the output strictly in valid JSON format.`;

// ================= EXTRACT =================
app.post("/extract", upload.any(), async(req, res) => {
    console.log(`Api is called with file: ${req.files?.[0]?.originalname || "No file"}`);

    const file = req.files[0] ?? null;

    if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
    }

    try {
        const fileData = fs.readFileSync(file.path);
        const base64Data = fileData.toString("base64");
        const mimeType = file.mimetype;

        const response = await ai.models.generateContent({
            // gemini-2.5-pro-preview-05-06
            // gemini-3.1-pro-preview
            model: "gemini-2.0-flash",
            config: {
                systemInstruction: SYSTEM_INSTRUCTION,
            },
            contents: [{
                role: "user",
                parts: [{
                        inlineData: {
                            mimeType: mimeType,
                            data: base64Data,
                        },
                    },
                    {
                        text: "Extract all invoice data and return as JSON.",
                    },
                ],
            }, ],
        });

        const text = response.text;

        let json;
        try {
            json = JSON.parse(text);
        } catch {
            const match = text.match(/\{[\s\S]*\}/);
            json = match ? JSON.parse(match[0]) : { raw: text };
        }

        res.json(json);
    } catch (error) {
        console.error("Extraction error:", error);
        res.status(500).json({ error: "Extraction failed", details: error.message });
    } finally {
        safeUnlink(file.path);
    }
});

// Multer error handler
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || err.message?.startsWith("Unsupported")) {
        return res.status(400).json({ error: err.message });
    }
    next(err);
});

// OCR
const lens = new Lens();

async function extractPdfText(buffer) {
    let fullText = "";

    const pages = await pdf(buffer, { scale: 2.5 });

    for await (const pageImage of pages) {
        const result = await lens.scanByBuffer(pageImage, "image/png");
        const pageText = result.segments.map(segment => segment.text).join("\n");
        fullText += pageText + "\n";
    }

    return fullText;
}

// Parse
function normalizeStationName(rawStation) {
    return rawStation
        .replace(/[|*_]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function parseTable(text) {
    const lines = text.split("\n").map(line => line.trim()).filter(Boolean);

    const data = [];

    for (const line of lines) {
        const nums = line.match(/\d+/g) || [];

        const stationMatch = line.match(/^[^\d]+/);
        const station = stationMatch ? normalizeStationName(stationMatch[0]) : "";

        if (nums.length >= 9 && station) {
            data.push({
                station,
                electric_fan: +nums[0],
                sewing_machine: +nums[1],
                ewp: +nums[2],
                small_appliances: +nums[3],
                water_heater: +nums[4],
                room_cooler_small: +nums[5],
                room_cooler_big: +nums[6],
                water_cooler: +nums[7],
                lighting: +nums[8],
            });
        }
    }

    return data;
}

// Validation
function normalizeFreightRateRow(row = {}) {
    return {
        station: String(row.station ?? "").trim(),
        electric_fan: Number(row.electric_fan ?? 0),
        sewing_machine: Number(row.sewing_machine ?? 0),
        ewp: Number(row.ewp ?? 0),
        small_appliances: Number(row.small_appliances ?? 0),
        water_heater: Number(row.water_heater ?? 0),
        room_cooler_small: Number(row.room_cooler_small ?? 0),
        room_cooler_big: Number(row.room_cooler_big ?? 0),
        water_cooler: Number(row.water_cooler ?? 0),
        lighting: Number(row.lighting ?? 0)
    };
}

function validateFreightRateRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
        return "At least one row is required.";
    }

    for (const [index, rawRow] of rows.entries()) {
        const row = normalizeFreightRateRow(rawRow);

        if (!row.station) {
            return `Row ${index + 1}: station is required.`;
        }
    }

    return null;
}

// Insert
async function insertFreightRateRows(rows) {
    const normalizedRows = rows.map(normalizeFreightRateRow);
    const connection = await mysql.createConnection(dbConfig);

    try {
        for (const row of normalizedRows) {
            await connection.execute(
                `INSERT INTO freight_rates
                (station, electric_fan, sewing_machine, ewp, small_appliances, water_heater,
                room_cooler_small, room_cooler_big, water_cooler, lighting)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                    row.station,
                    row.electric_fan,
                    row.sewing_machine,
                    row.ewp,
                    row.small_appliances,
                    row.water_heater,
                    row.room_cooler_small,
                    row.room_cooler_big,
                    row.water_cooler,
                    row.lighting
                ]
            );
        }
    } finally {
        await connection.end();
    }

    return normalizedRows;
}

// Upload route
app.post("/upload_freight_rate", upload.single("pdf"), async(req, res) => {
    const filePath = req.file?.path;

    if (!filePath) {
        return res.status(400).json({ error: "No PDF uploaded" });
    }

    try {
        const dataBuffer = fs.readFileSync(filePath);

        const text = await extractPdfText(dataBuffer);
        const extractedData = parseTable(text);

        res.json({
            message: "PDF processed successfully",
            rows: extractedData,
            totalRows: extractedData.length
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to process PDF" });
    } finally {
        safeUnlink(filePath);
    }
});

app.post("/upload/confirm", async(req, res) => {
    try {
        const rows = Array.isArray(req.body) ? req.body : req.body?.rows;
        const validationError = validateFreightRateRows(rows);

        if (validationError) {
            return res.status(400).json({ error: validationError });
        }

        const savedRows = await insertFreightRateRows(rows);

        res.json({
            message: "Edited data saved successfully",
            rowsInserted: savedRows.length
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to save data" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));