import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { MongoClient } from "mongodb";

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DATABASE = process.env.MONGODB_DATABASE || "tuition_tracker_new";
const MONGODB_COLLECTION = process.env.MONGODB_COLLECTION || "tuitions";

if (!MONGODB_URI) {
  throw new Error("Missing MONGODB_URI. Create Backend/.env from .env.example.");
}

const app = express();
const client = new MongoClient(MONGODB_URI);

let isConnected = false;

async function connectDB() {
  if (!isConnected) {
    await client.connect();
    await client.db(MONGODB_DATABASE).collection(MONGODB_COLLECTION)
      .createIndex({ code: 1 }, { unique: true });
    isConnected = true;
  }
}

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    next(error);
  }
});

app.get("/health", (_request, response) => {
  response.json({ ok: true, database: MONGODB_DATABASE, collection: MONGODB_COLLECTION });
});

app.post("/tuitions", async (request, response, next) => {
  try {
    const tuition = request.body;

    if (!tuition?.code || typeof tuition.code !== "string") {
      response.status(400).json({ error: "Tuition code is required." });
      return;
    }

    const databaseName = request.header("X-Tuition-Database") || MONGODB_DATABASE;
    const collectionName = request.header("X-Tuition-Collection") || MONGODB_COLLECTION;

    if (databaseName !== MONGODB_DATABASE || collectionName !== MONGODB_COLLECTION) {
      response.status(400).json({
        error: "Unexpected database target.",
        expected: { databaseName: MONGODB_DATABASE, collectionName: MONGODB_COLLECTION }
      });
      return;
    }

    const collection = client.db(MONGODB_DATABASE).collection(MONGODB_COLLECTION);
    const now = new Date();
    const document = {
      ...tuition,
      syncedAt: now,
      updatedAt: now
    };

    const result = await collection.updateOne(
      { code: tuition.code },
      {
        $set: document,
        $setOnInsert: { insertedAt: now }
      },
      { upsert: true }
    );

    response.status(result.upsertedId ? 201 : 200).json({
      ok: true,
      code: tuition.code,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      upsertedId: result.upsertedId
    });
  } catch (error) {
    next(error);
  }
});

app.get("/tuitions", async (request, response, next) => {
  try {
    const { userId } = request.query;
    const collection = client.db(MONGODB_DATABASE).collection(MONGODB_COLLECTION);

    const filter = userId ? { "members.userId": userId } : {};
    const tuitions = await collection
      .find(filter)
      .sort({ updatedAt: -1 })
      .toArray();

    response.json(tuitions);
  } catch (error) { next(error); }
});

app.post("/tuitions/leave", async (request, response, next) => {
  try {
    const { code, userId } = request.body;

    if (!code || !userId) {
      return response.status(400).json({ error: "code and userId are required." });
    }

    const collection = client.db(MONGODB_DATABASE).collection(MONGODB_COLLECTION);

    await collection.updateOne(
      { code },
      { $pull: { members: { userId } } }
    );

    response.json({ ok: true });
  } catch (error) { next(error); }
});

app.get("/tuitions/:code", async (request, response, next) => {
  try {
    const collection = client.db(MONGODB_DATABASE).collection(MONGODB_COLLECTION);
    const tuition = await collection.findOne({ code: request.params.code });
    if (!tuition) return response.status(404).json({ error: "Tuition not found." });
    response.json(tuition);
  } catch (error) { next(error); }
});

app.delete("/tuitions/:code", async (request, response, next) => {
  try {
    const collection = client.db(MONGODB_DATABASE).collection(MONGODB_COLLECTION);
    await collection.deleteOne({ code: request.params.code });
    response.json({ ok: true });
  } catch (error) { next(error); }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: error.message });
});

export default app;
