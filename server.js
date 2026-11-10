const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is missing. Add your Supabase PostgreSQL connection string to Render Environment Variables.");
    process.exit(1);
}

// Supabase Session Pooler connection. Keep DATABASE_URL private on the server.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

app.use(express.json({ limit: "10mb" }));
app.use(express.static(__dirname));

function generateShareCode() {
    return crypto.randomBytes(6).toString("base64url");
}

function formatSeconds(seconds) {
    seconds = Number(seconds) || 0;
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return `${minutes}m ${String(remaining).padStart(2, "0")}s`;
}

function parseJsonObject(value, fallback = {}) {
    if (value && typeof value === "object") return value;
    if (typeof value === "string") {
        try { return JSON.parse(value); } catch { return fallback; }
    }
    return fallback;
}

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/health", async (req, res) => {
    try {
        await pool.query("SELECT 1");
        res.json({ success: true, message: "Quiz server and PostgreSQL are running.", time: new Date().toISOString() });
    } catch (error) {
        console.error("HEALTH CHECK ERROR:", error);
        res.status(503).json({ success: false, error: "Database connection unavailable." });
    }
});

// CREATE QUIZ
app.post("/api/quizzes", async (req, res) => {
    try {
        const { title, description, questions, timeLimit } = req.body || {};

        if (!title || typeof title !== "string" || !title.trim()) {
            return res.status(400).json({ error: "Quiz title is required." });
        }
        if (!Array.isArray(questions) || questions.length === 0) {
            return res.status(400).json({ error: "No questions were provided." });
        }
        if (questions.length > 200) {
            return res.status(400).json({ error: "Maximum 200 questions allowed." });
        }

        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            if (!q || typeof q.question !== "string" || !q.question.trim()) {
                return res.status(400).json({ error: `Question ${i + 1} is invalid.` });
            }
            if (!Array.isArray(q.options) || q.options.length < 2) {
                return res.status(400).json({ error: `Question ${i + 1} must have at least 2 options.` });
            }
            if (q.correctAnswer === undefined || q.correctAnswer === null) {
                return res.status(400).json({ error: `Question ${i + 1} has no correct answer.` });
            }
            const answer = Number(q.correctAnswer);
            if (!Number.isInteger(answer) || answer < 0 || answer >= q.options.length) {
                return res.status(400).json({ error: `Question ${i + 1} has an invalid correct answer.` });
            }
        }

        const finalTimeLimit = Math.max(30, Number(timeLimit) || 600);
        let savedQuiz;
        // Retry in the extremely unlikely event that a generated share code already exists.
        for (let attempt = 0; attempt < 5; attempt++) {
            const shareCode = generateShareCode();
            try {
                const result = await pool.query(
                    `INSERT INTO public.quizzes (share_code, title, description, questions, time_limit)
                     VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
                    [shareCode, title.trim(), description || "", JSON.stringify(questions), finalTimeLimit]
                );
                savedQuiz = { id: result.rows[0].id, shareCode };
                break;
            } catch (error) {
                if (error.code !== "23505" || attempt === 4) throw error;
            }
        }

        res.json({ success: true, quizId: savedQuiz.id, shareCode: savedQuiz.shareCode, timeLimit: finalTimeLimit });
    } catch (error) {
        console.error("CREATE QUIZ ERROR:", error);
        res.status(500).json({ error: "Failed to create quiz." });
    }
});

// GET QUIZ (never send correct answers to participants)
app.get("/api/quizzes/:code", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, title, description, questions, time_limit
             FROM public.quizzes WHERE share_code = $1`,
            [req.params.code]
        );
        const quiz = result.rows[0];
        if (!quiz) return res.status(404).json({ error: "Quiz not found." });

        const questions = parseJsonObject(quiz.questions, []);
        const safeQuestions = questions.map(q => ({ id: q.id, question: q.question, options: q.options }));
        res.json({
            id: quiz.id,
            title: quiz.title,
            description: quiz.description,
            timeLimit: quiz.time_limit,
            questions: safeQuestions
        });
    } catch (error) {
        console.error("GET QUIZ ERROR:", error);
        res.status(500).json({ error: "Could not load quiz." });
    }
});

// SUBMIT QUIZ
app.post("/api/quizzes/:code/submit", async (req, res) => {
    try {
        const quizResult = await pool.query(
            `SELECT id, questions, time_limit FROM public.quizzes WHERE share_code = $1`,
            [req.params.code]
        );
        const quiz = quizResult.rows[0];
        if (!quiz) return res.status(404).json({ error: "Quiz not found." });

        const questions = parseJsonObject(quiz.questions, []);
        const { participantName, answers, questionTimes, timeTaken, feedback } = req.body || {};

        if (!participantName || typeof participantName !== "string" || !participantName.trim()) {
            return res.status(400).json({ error: "Please enter your name before submitting the quiz." });
        }

        let score = 0;
        questions.forEach(q => {
            const userAnswer = answers?.[q.id];
            if (userAnswer !== undefined && Number(userAnswer) === Number(q.correctAnswer)) score++;
        });

        const total = questions.length;
        const accuracy = total > 0 ? Number(((score / total) * 100).toFixed(2)) : 0;
        const safeTime = Math.min(Number(quiz.time_limit), Math.max(0, Number(timeTaken) || 0));

        const result = await pool.query(
            `INSERT INTO public.attempts
             (quiz_id, participant_name, answers, question_times, score, total, accuracy, time_taken, feedback)
             VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9)
             RETURNING id`,
            [quiz.id, participantName.trim(), JSON.stringify(answers || {}), JSON.stringify(questionTimes || {}), score, total, accuracy, safeTime, feedback || ""]
        );

        res.json({ success: true, attemptId: result.rows[0].id, score, total, accuracy, timeTaken: safeTime });
    } catch (error) {
        console.error("SUBMIT QUIZ ERROR:", error);
        res.status(500).json({ error: "Failed to submit quiz." });
    }
});

// DASHBOARD
app.get("/api/quizzes/:code/dashboard", async (req, res) => {
    try {
        const quizResult = await pool.query(
            `SELECT id, title, description, share_code, time_limit, questions
             FROM public.quizzes WHERE share_code = $1`,
            [req.params.code]
        );
        const quiz = quizResult.rows[0];
        if (!quiz) return res.status(404).json({ error: "Quiz not found." });

        const [attemptsResult, statisticsResult] = await Promise.all([
            pool.query(
                `SELECT id, participant_name, answers, score, total, accuracy, time_taken,
                        question_times, feedback, submitted_at
                 FROM public.attempts WHERE quiz_id = $1 ORDER BY submitted_at DESC`,
                [quiz.id]
            ),
            pool.query(
                `SELECT COUNT(*)::int AS attempts,
                        AVG(accuracy) AS average_accuracy,
                        AVG(time_taken) AS average_time,
                        MAX(score) AS highest_score
                 FROM public.attempts WHERE quiz_id = $1`,
                [quiz.id]
            )
        ]);

        const questions = parseJsonObject(quiz.questions, []);
        res.json({
            quiz: {
                title: quiz.title,
                description: quiz.description,
                shareCode: quiz.share_code,
                timeLimit: quiz.time_limit,
                questionCount: questions.length,
                questions: questions.map(q => ({
                    id: q.id,
                    question: q.question,
                    options: q.options,
                    correctAnswer: q.correctAnswer
                }))
            },
            statistics: statisticsResult.rows[0],
            attempts: attemptsResult.rows
        });
    } catch (error) {
        console.error("DASHBOARD ERROR:", error);
        res.status(500).json({ error: "Could not load dashboard." });
    }
});

// EXPORT CSV
app.get("/api/quizzes/:code/export", async (req, res) => {
    try {
        const quizResult = await pool.query(
            `SELECT id, share_code FROM public.quizzes WHERE share_code = $1`,
            [req.params.code]
        );
        const quiz = quizResult.rows[0];
        if (!quiz) return res.status(404).send("Quiz not found");

        const attemptsResult = await pool.query(
            `SELECT participant_name, score, total, accuracy, time_taken, feedback, submitted_at
             FROM public.attempts WHERE quiz_id = $1 ORDER BY submitted_at DESC`,
            [quiz.id]
        );

        let csv = "Participant,Score,Total,Accuracy,Time Taken,Feedback,Submitted At\n";
        attemptsResult.rows.forEach(a => {
            const row = [
                a.participant_name,
                a.score,
                a.total,
                `${a.accuracy}%`,
                formatSeconds(a.time_taken),
                a.feedback,
                a.submitted_at
            ].map(value => `"${String(value ?? "").replace(/"/g, '""')}"`);
            csv += row.join(",") + "\n";
        });

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${quiz.share_code}-results.csv"`);
        res.send(csv);
    } catch (error) {
        console.error("EXPORT ERROR:", error);
        res.status(500).send("Export failed.");
    }
});

// DELETE QUIZ (attempts are deleted automatically by ON DELETE CASCADE)
app.delete("/api/quizzes/:code", async (req, res) => {
    try {
        const result = await pool.query(
            `DELETE FROM public.quizzes WHERE share_code = $1 RETURNING id`,
            [req.params.code]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: "Quiz not found." });
        res.json({ success: true });
    } catch (error) {
        console.error("DELETE QUIZ ERROR:", error);
        res.status(500).json({ error: "Could not delete quiz." });
    }
});

app.use("/api", (req, res) => {
    res.status(404).json({ error: "API endpoint not found." });
});

async function startServer() {
    try {
        await pool.query("SELECT 1");
        console.log("Connected to Supabase PostgreSQL.");
        app.listen(PORT, () => {
            console.log(`Quiz server running on port ${PORT}`);
        });
    } catch (error) {
        console.error("Could not connect to Supabase PostgreSQL:", error.message);
        process.exit(1);
    }
}

startServer();

process.on("SIGTERM", async () => {
    await pool.end();
    process.exit(0);
});
