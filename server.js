import bcrypt from "bcryptjs";
import cors from "cors";
import crypto from "crypto";
import dotenv from "dotenv";
import express from "express";
import { MongoClient } from "mongodb";

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DATABASE = process.env.MONGODB_DATABASE || "tuition_tracker_new";
const MONGODB_COLLECTION = process.env.MONGODB_COLLECTION || "tuitions";
const PORT = process.env.PORT || 3000;

if (!MONGODB_URI) {
  throw new Error("Missing MONGODB_URI. Create a .env file with your MongoDB connection string.");
}

const app = express();
const client = new MongoClient(MONGODB_URI);

// ── DB Connection ──────────────────────────────────────────────────────────────

let isConnected = false;

async function connectDB() {
  if (!isConnected) {
    await client.connect();
    await client.db(MONGODB_DATABASE).collection(MONGODB_COLLECTION)
      .createIndex({ code: 1 }, { unique: true });
    isConnected = true;
    console.log(`Connected to MongoDB: ${MONGODB_DATABASE}`);
  }
}

// ── Middleware ─────────────────────────────────────────────────────────────────

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

// ── Health Check ───────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ ok: true, database: MONGODB_DATABASE, collection: MONGODB_COLLECTION });
});

// ── Tuitions ───────────────────────────────────────────────────────────────────

// Create or update a tuition
app.post("/tuitions", async (req, res, next) => {
  try {
    const tuition = req.body;

    if (!tuition?.code || typeof tuition.code !== "string") {
      return res.status(400).json({ error: "Tuition code is required." });
    }

    const databaseName = req.header("X-Tuition-Database") || MONGODB_DATABASE;
    const collectionName = req.header("X-Tuition-Collection") || MONGODB_COLLECTION;

    if (databaseName !== MONGODB_DATABASE || collectionName !== MONGODB_COLLECTION) {
      return res.status(400).json({
        error: "Unexpected database target.",
        expected: { databaseName: MONGODB_DATABASE, collectionName: MONGODB_COLLECTION }
      });
    }

    const collection = client.db(MONGODB_DATABASE).collection(MONGODB_COLLECTION);
    const now = new Date();
    const document = { ...tuition, syncedAt: now, updatedAt: now };

    const result = await collection.updateOne(
      { code: tuition.code },
      {
        $set: document,
        $setOnInsert: { insertedAt: now }
      },
      { upsert: true }
    );

    res.status(result.upsertedId ? 201 : 200).json({
      ok: true,
      code: tuition.code,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      upsertedId: result.upsertedId
    });
  } catch (error) { next(error); }
});

// Get all tuitions, optionally filtered by userId
app.get("/tuitions", async (req, res, next) => {
  try {
    const { userId } = req.query;
    const collection = client.db(MONGODB_DATABASE).collection(MONGODB_COLLECTION);
    const filter = userId ? { "members.userId": userId } : {};
    const tuitions = await collection
      .find(filter)
      .sort({ updatedAt: -1 })
      .toArray();
    res.json(tuitions);
  } catch (error) { next(error); }
});

// Get a single tuition by code
app.get("/tuitions/:code", async (req, res, next) => {
  try {
    const collection = client.db(MONGODB_DATABASE).collection(MONGODB_COLLECTION);
    const tuition = await collection.findOne({ code: req.params.code });
    if (!tuition) return res.status(404).json({ error: "Tuition not found." });
    res.json(tuition);
  } catch (error) { next(error); }
});

// Delete a tuition by code
app.delete("/tuitions/:code", async (req, res, next) => {
  try {
    const collection = client.db(MONGODB_DATABASE).collection(MONGODB_COLLECTION);
    await collection.deleteOne({ code: req.params.code });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// Leave a tuition (remove userId from members array)
app.post("/tuitions/leave", async (req, res, next) => {
  try {
    const { code, userId } = req.body;
    if (!code || !userId) {
      return res.status(400).json({ error: "code and userId are required." });
    }
    const collection = client.db(MONGODB_DATABASE).collection(MONGODB_COLLECTION);
    await collection.updateOne(
      { code },
      { $pull: { members: { userId } } }
    );
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ── Auth ───────────────────────────────────────────────────────────────────────

// Register with email + password (hashes password, stores in MongoDB)
async function handleRegister(req, res, next) {
  try {
    const { userId, email, password } = req.body;
    if (!userId || !email || !password) {
      return res.status(400).json({ error: "userId, email, and password are required." });
    }

    const collection = client.db(MONGODB_DATABASE).collection("users");

    const existing = await collection.findOne({ email });
    if (existing && existing.userId !== userId) {
      return res.status(409).json({ error: "Email already registered." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date();

    await collection.updateOne(
      { userId },
      {
        $set: {
          userId,
          provider: "email",
          email,
          passwordHash,
          updatedAt: now
        },
        $setOnInsert: { createdAt: now }
      },
      { upsert: true }
    );

    res.json({ ok: true, userId, provider: "email", email });
  } catch (error) { next(error); }
}

app.post("/auth/register", handleRegister);
app.post("/auth/signup", handleRegister);
app.post("/auth/email", handleRegister);

// Login with email + password
async function handleLogin(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required." });
    }

    const collection = client.db(MONGODB_DATABASE).collection("users");
    const user = await collection.findOne({ email });

    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    res.json({ ok: true, userId: user.userId, email: user.email, provider: user.provider });
  } catch (error) { next(error); }
}

app.post("/auth/login", handleLogin);
app.post("/auth/signin", handleLogin);

// Forgot password — generate token and return it directly (no email)
async function handleForgotPassword(req, res, next) {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "email is required." });
    }

    const collection = client.db(MONGODB_DATABASE).collection("users");
    const user = await collection.findOne({ email });

    // Always respond 200 to avoid leaking which emails are registered
    if (!user) {
      return res.json({ ok: true });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await collection.updateOne(
      { email },
      { $set: { resetToken: token, resetTokenExpiresAt: expiresAt } }
    );

    res.json({ ok: true, resetToken: token });
  } catch (error) { next(error); }
}

app.post("/auth/forgot-password", handleForgotPassword);
app.post("/auth/password-reset", handleForgotPassword);
app.post("/auth/request-password-reset", handleForgotPassword);

// Reset password — verify token and update password
async function handleResetPassword(req, res, next) {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: "token and password are required." });
    }

    const collection = client.db(MONGODB_DATABASE).collection("users");
    const user = await collection.findOne({
      resetToken: token,
      resetTokenExpiresAt: { $gt: new Date() }
    });

    if (!user) {
      return res.status(400).json({ error: "Invalid or expired reset token." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await collection.updateOne(
      { resetToken: token },
      {
        $set: { passwordHash, updatedAt: new Date() },
        $unset: { resetToken: "", resetTokenExpiresAt: "" }
      }
    );

    res.json({ ok: true });
  } catch (error) { next(error); }
}

app.post("/auth/reset-password", handleResetPassword);
app.post("/auth/password-reset/confirm", handleResetPassword);

// Link Apple or Email account to anonymous userId
app.post("/auth/link", async (req, res, next) => {
  try {
    const { userId, provider, email, providerUserId } = req.body;
    if (!userId || !provider) {
      return res.status(400).json({ error: "userId and provider are required." });
    }
    const collection = client.db(MONGODB_DATABASE).collection("users");
    const now = new Date();
    await collection.updateOne(
      { userId },
      {
        $set: {
          userId,
          provider,
          email: email || null,
          providerUserId: providerUserId || null,
          updatedAt: now
        },
        $setOnInsert: { createdAt: now }
      },
      { upsert: true }
    );
    res.json({ ok: true, userId, provider });
  } catch (error) { next(error); }
});

// Get user account info
app.get("/auth/user/:userId", async (req, res, next) => {
  try {
    const collection = client.db(MONGODB_DATABASE).collection("users");
    const user = await collection.findOne({ userId: req.params.userId });
    if (!user) return res.status(404).json({ error: "User not found." });
    res.json(user);
  } catch (error) { next(error); }
});

// Delete account and all associated data (required by Apple)
app.delete("/auth/user/:userId", async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ error: "userId is required." });
    }

    const db = client.db(MONGODB_DATABASE);

    // 1. Remove user from all tuitions they are a member of
    await db.collection(MONGODB_COLLECTION).updateMany(
      { "members.userId": userId },
      { $pull: { members: { userId } } }
    );

    // 2. Delete tuitions that now have no members (orphaned tuitions)
    await db.collection(MONGODB_COLLECTION).deleteMany({
      members: { $size: 0 }
    });

    // 3. Delete the user record
    await db.collection("users").deleteOne({ userId });

    res.json({ ok: true, message: "Account and all associated data deleted." });
  } catch (error) { next(error); }
});

// ── Error Handler ──────────────────────────────────────────────────────────────

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || "Something went wrong." });
});

// ── Export for Vercel ──────────────────────────────────────────────────────────

export default app;