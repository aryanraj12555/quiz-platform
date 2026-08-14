const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const app = express();

/*
=========================================================
SERVER PORT
=========================================================

Local computer:
    PORT = 3000

Render:
    PORT is automatically provided by Render.
*/
const PORT = process.env.PORT || 3000;


/*
=========================================================
DATABASE
=========================================================
*/

const dbPath =
    process.env.DATABASE_PATH ||
    path.join(__dirname, "quiz.db");

const db =
    new Database(dbPath);


/*
=========================================================
MIDDLEWARE
=========================================================
*/

app.use(
    express.json({
        limit: "10mb"
    })
);

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);


/*
=========================================================
DATABASE TABLES
=========================================================
*/

db.exec(`
    CREATE TABLE IF NOT EXISTS quizzes (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        share_code TEXT UNIQUE NOT NULL,

        title TEXT NOT NULL,

        description TEXT DEFAULT '',

        questions TEXT NOT NULL,

        time_limit INTEGER NOT NULL,

        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );


    CREATE TABLE IF NOT EXISTS attempts (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        quiz_id INTEGER NOT NULL,

        participant_name TEXT DEFAULT 'Anonymous',

        answers TEXT NOT NULL,

        question_times TEXT NOT NULL,

        score INTEGER NOT NULL,

        total INTEGER NOT NULL,

        accuracy REAL NOT NULL,

        time_taken INTEGER NOT NULL,

        feedback TEXT DEFAULT '',

        submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (quiz_id)
            REFERENCES quizzes(id)
    );
`);


/*
=========================================================
HELPERS
=========================================================
*/

function generateShareCode() {

    return crypto
        .randomBytes(6)
        .toString("base64url");

}


function formatSeconds(seconds) {

    seconds =
        Number(seconds) || 0;

    const minutes =
        Math.floor(seconds / 60);

    const remaining =
        seconds % 60;

    return (
        `${minutes}m ` +
        `${String(remaining).padStart(2, "0")}s`
    );

}


/*
=========================================================
HEALTH CHECK
=========================================================

Useful for Render and for testing whether the
server is alive.
=========================================================
*/

app.get(
    "/api/health",
    (req, res) => {

        res.json({
            success: true,
            message: "Quiz server is running.",
            time: new Date().toISOString()
        });

    }
);


/*
=========================================================
CREATE QUIZ
=========================================================
*/

app.post(
    "/api/quizzes",
    (req, res) => {

        try {

            const {
                title,
                description,
                questions,
                timeLimit
            } = req.body;


            /*
            ---------- VALIDATION ----------
            */

            if (
                !title ||
                typeof title !== "string" ||
                !title.trim()
            ) {

                return res.status(400).json({

                    error:
                        "Quiz title is required."

                });

            }


            if (
                !Array.isArray(questions) ||
                questions.length === 0
            ) {

                return res.status(400).json({

                    error:
                        "No questions were provided."

                });

            }


            if (
                questions.length > 200
            ) {

                return res.status(400).json({

                    error:
                        "Maximum 200 questions allowed."

                });

            }


            /*
            ---------- QUESTION VALIDATION ----------
            */

            for (
                let i = 0;
                i < questions.length;
                i++
            ) {

                const q =
                    questions[i];


                if (
                    !q ||
                    typeof q.question !== "string" ||
                    !q.question.trim() ||
                    !Array.isArray(q.options) ||
                    q.options.length < 2
                ) {

                    return res.status(400).json({

                        error:
                            `Question ${i + 1} is invalid.`

                    });

                }


                /*
                Correct answer is ZERO-BASED:

                0 = first option
                1 = second option
                2 = third option
                etc.
                */

                if (
                    q.correctAnswer === undefined ||
                    q.correctAnswer === null ||
                    !Number.isInteger(
                        Number(q.correctAnswer)
                    ) ||
                    Number(q.correctAnswer) < 0 ||
                    Number(q.correctAnswer) >=
                        q.options.length
                ) {

                    return res.status(400).json({

                        error:
                            `Question ${i + 1} has an invalid correct answer.`

                    });

                }

            }


            /*
            ---------- TIMER ----------
            */

            const finalTimeLimit =
                Math.max(
                    30,
                    Number(timeLimit) || 600
                );


            /*
            ---------- UNIQUE SHARE CODE ----------
            */

            let shareCode;


            do {

                shareCode =
                    generateShareCode();

            } while (

                db.prepare(`
                    SELECT id
                    FROM quizzes
                    WHERE share_code = ?
                `).get(shareCode)

            );


            /*
            ---------- SAVE QUIZ ----------
            */

            const result =
                db.prepare(`
                    INSERT INTO quizzes
                    (
                        share_code,
                        title,
                        description,
                        questions,
                        time_limit
                    )
                    VALUES (?, ?, ?, ?, ?)
                `).run(

                    shareCode,

                    title.trim(),

                    description || "",

                    JSON.stringify(
                        questions
                    ),

                    finalTimeLimit

                );


            /*
            ---------- RESPONSE ----------
            */

            res.json({

                success: true,

                quizId:
                    result.lastInsertRowid,

                shareCode,

                timeLimit:
                    finalTimeLimit

            });

        }

        catch (error) {

            console.error(
                "CREATE QUIZ ERROR:",
                error
            );

            res.status(500).json({

                error:
                    "Failed to create quiz."

            });

        }

    }
);


/*
=========================================================
GET QUIZ
=========================================================

The correct answers are deliberately removed before
sending the quiz to the participant.
=========================================================
*/

app.get(
    "/api/quizzes/:code",
    (req, res) => {

        try {

            const quiz =
                db.prepare(`
                    SELECT
                        id,
                        title,
                        description,
                        questions,
                        time_limit
                    FROM quizzes
                    WHERE share_code = ?
                `).get(
                    req.params.code
                );


            if (!quiz) {

                return res.status(404).json({

                    error:
                        "Quiz not found."

                });

            }


            const questions =
                JSON.parse(
                    quiz.questions
                );


            /*
            Remove correctAnswer before
            sending questions to participants.
            */

            const safeQuestions =
                questions.map(
                    q => ({

                        id:
                            q.id,

                        question:
                            q.question,

                        options:
                            q.options

                    })
                );


            res.json({

                id:
                    quiz.id,

                title:
                    quiz.title,

                description:
                    quiz.description,

                timeLimit:
                    quiz.time_limit,

                questions:
                    safeQuestions

            });

        }

        catch (error) {

            console.error(
                "GET QUIZ ERROR:",
                error
            );

            res.status(500).json({

                error:
                    "Could not load quiz."

            });

        }

    }
);


/*
=========================================================
SUBMIT QUIZ
=========================================================
*/

app.post(
    "/api/quizzes/:code/submit",
    (req, res) => {

        try {

            const quiz =
                db.prepare(`
                    SELECT *
                    FROM quizzes
                    WHERE share_code = ?
                `).get(
                    req.params.code
                );


            if (!quiz) {

                return res.status(404).json({

                    error:
                        "Quiz not found."

                });

            }


            const questions =
                JSON.parse(
                    quiz.questions
                );


            const {
                participantName,
                answers,
                questionTimes,
                timeTaken,
                feedback
            } = req.body;


            /*
            ---------- CALCULATE SCORE ----------
            */

            let score = 0;


            questions.forEach(
                q => {

                    const userAnswer =
                        answers?.[q.id];


                    if (
                        userAnswer !== undefined &&
                        Number(userAnswer) ===
                            Number(q.correctAnswer)
                    ) {

                        score++;

                    }

                }
            );


            const total =
                questions.length;


            /*
            ---------- ACCURACY ----------
            */

            const accuracy =
                Number(
                    (
                        (score / total) *
                        100
                    ).toFixed(2)
                );


            /*
            ---------- SAFE TIME ----------
            */

            const safeTime =
                Math.min(

                    quiz.time_limit,

                    Math.max(
                        0,
                        Number(timeTaken) || 0
                    )

                );


            /*
            ---------- SAVE ATTEMPT ----------
            */

            const result =
                db.prepare(`
                    INSERT INTO attempts
                    (
                        quiz_id,
                        participant_name,
                        answers,
                        question_times,
                        score,
                        total,
                        accuracy,
                        time_taken,
                        feedback
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(

                    quiz.id,

                    participantName ||
                        "Anonymous",

                    JSON.stringify(
                        answers || {}
                    ),

                    JSON.stringify(
                        questionTimes || {}
                    ),

                    score,

                    total,

                    accuracy,

                    safeTime,

                    feedback || ""

                );


            /*
            ---------- RESPONSE ----------
            */

            res.json({

                success: true,

                attemptId:
                    result.lastInsertRowid,

                score,

                total,

                accuracy,

                timeTaken:
                    safeTime

            });

        }

        catch (error) {

            console.error(
                "SUBMIT QUIZ ERROR:",
                error
            );

            res.status(500).json({

                error:
                    "Failed to submit quiz."

            });

        }

    }
);


/*
=========================================================
DASHBOARD
=========================================================
*/

app.get(
    "/api/quizzes/:code/dashboard",
    (req, res) => {

        try {

            const quiz =
                db.prepare(`
                    SELECT *
                    FROM quizzes
                    WHERE share_code = ?
                `).get(
                    req.params.code
                );


            if (!quiz) {

                return res.status(404).json({

                    error:
                        "Quiz not found."

                });

            }


            /*
            ---------- ATTEMPTS ----------
            */

            const attempts =
                db.prepare(`
                    SELECT
                        id,
                        participant_name,
                        score,
                        total,
                        accuracy,
                        time_taken,
                        question_times,
                        feedback,
                        submitted_at

                    FROM attempts

                    WHERE quiz_id = ?

                    ORDER BY submitted_at DESC
                `).all(
                    quiz.id
                );


            /*
            ---------- STATISTICS ----------
            */

            const statistics =
                db.prepare(`
                    SELECT

                        COUNT(*)
                            AS attempts,

                        AVG(accuracy)
                            AS average_accuracy,

                        AVG(time_taken)
                            AS average_time,

                        MAX(score)
                            AS highest_score

                    FROM attempts

                    WHERE quiz_id = ?
                `).get(
                    quiz.id
                );


            /*
            ---------- RESPONSE ----------
            */

            res.json({

                quiz: {

                    title:
                        quiz.title,

                    description:
                        quiz.description,

                    shareCode:
                        quiz.share_code,

                    timeLimit:
                        quiz.time_limit,

                    questionCount:
                        JSON.parse(
                            quiz.questions
                        ).length

                },

                statistics,

                attempts

            });

        }

        catch (error) {

            console.error(
                "DASHBOARD ERROR:",
                error
            );

            res.status(500).json({

                error:
                    "Could not load dashboard."

            });

        }

    }
);


/*
=========================================================
EXPORT CSV
=========================================================
*/

app.get(
    "/api/quizzes/:code/export",
    (req, res) => {

        try {

            const quiz =
                db.prepare(`
                    SELECT *
                    FROM quizzes
                    WHERE share_code = ?
                `).get(
                    req.params.code
                );


            if (!quiz) {

                return res
                    .status(404)
                    .send(
                        "Quiz not found"
                    );

            }


            const attempts =
                db.prepare(`
                    SELECT

                        participant_name,
                        score,
                        total,
                        accuracy,
                        time_taken,
                        feedback,
                        submitted_at

                    FROM attempts

                    WHERE quiz_id = ?

                    ORDER BY submitted_at DESC
                `).all(
                    quiz.id
                );


            let csv =
                "Participant,Score,Total,Accuracy,Time Taken,Feedback,Submitted At\n";


            attempts.forEach(
                a => {

                    const row = [

                        a.participant_name,

                        a.score,

                        a.total,

                        a.accuracy + "%",

                        formatSeconds(
                            a.time_taken
                        ),

                        a.feedback,

                        a.submitted_at

                    ].map(
                        value => {

                            return (
                                `"${String(
                                    value ?? ""
                                ).replace(
                                    /"/g,
                                    '""'
                                )}"`
                            );

                        }
                    );


                    csv +=
                        row.join(",") +
                        "\n";

                }
            );


            res.setHeader(
                "Content-Type",
                "text/csv"
            );


            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${quiz.share_code}-results.csv"`
            );


            res.send(csv);

        }

        catch (error) {

            console.error(
                "EXPORT ERROR:",
                error
            );

            res.status(500).send(
                "Export failed."
            );

        }

    }
);


/*
=========================================================
DELETE QUIZ
=========================================================
*/

app.delete(
    "/api/quizzes/:code",
    (req, res) => {

        try {

            const quiz =
                db.prepare(`
                    SELECT id
                    FROM quizzes
                    WHERE share_code = ?
                `).get(
                    req.params.code
                );


            if (!quiz) {

                return res.status(404).json({

                    error:
                        "Quiz not found."

                });

            }


            /*
            Delete attempts first because
            they reference the quiz.
            */

            db.prepare(`
                DELETE FROM attempts
                WHERE quiz_id = ?
            `).run(
                quiz.id
            );


            db.prepare(`
                DELETE FROM quizzes
                WHERE id = ?
            `).run(
                quiz.id
            );


            res.json({

                success:
                    true

            });

        }

        catch (error) {

            console.error(
                "DELETE QUIZ ERROR:",
                error
            );

            res.status(500).json({

                error:
                    "Could not delete quiz."

            });

        }

    }
);


/*
=========================================================
START SERVER
=========================================================
*/

app.listen(
    PORT,
    () => {

        console.log(`
========================================
       🧠 QUIZ PLATFORM
========================================

Server running on:
http://localhost:${PORT}

Database:
${dbPath}

Environment:
${process.env.NODE_ENV || "development"}

========================================
        `);

    }
);